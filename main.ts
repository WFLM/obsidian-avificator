import {
  AbstractInputSuggest,
  Plugin,
  TFile,
  Notice,
  App,
  Editor,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  Modal,
  Platform,
  PluginSettingTab,
  Setting,
  FileSystemAdapter,
  TAbstractFile,
  debounce,
  getLinkpath,
  moment,
  setTooltip,
  type Debouncer,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { noteClosedMessage, parseFileUriList, vaultRelativePath } from "./dropped-files";
import { InsertWindow, dropMayAddFiles, pasteMayAddFiles } from "./insert-window";
import {
  buildFileStem,
  filterTemplateSuggestions,
  findPartialVariable,
  findUnknownVariable,
  insertVariable,
  keepFileStem,
  templateSuggestions,
  type FileNameValues,
  type TemplateSuggestion,
} from "./file-name";
import {
  isFileNameTaken,
  linkPathPointsTo,
  replaceImageEmbedLinks,
  type LinkReplacementResult,
} from "./link-utils";
import {
  FORMAT_EXTENSIONS,
  IMAGE_FORMATS,
  canConvert,
  formatForExtension,
  isAnimatedPng,
  multiFrameKind,
  type ImageFormat,
  type MultiFrameKind,
} from "./formats";
import { buildConvertArgs, buildFrameCountArgs } from "./magick-args";
import {
  describeMagickError,
  describeMagickSupport,
  isMagickReadError,
  parseFormatList,
  parseFrameCount,
  type FormatSupport,
  type MagickStatus,
} from "./magick-support";
import {
  DEFAULT_SETTINGS,
  MODES,
  effectiveActions,
  isAnimatedImageAction,
  isMode,
  normalizeFileNameTemplate,
  normalizeMagickPath,
  parseSettings,
  validateMaxImageSize,
  validateQuality,
  type AVIFPluginSettings,
  type AnimatedImageAction,
  type FormatActions,
  type Mode,
} from "./settings";

const execFileAsync = promisify(execFile);
const CONVERSION_TIMEOUT_MS = 120_000;
const MAGICK_CHECK_TIMEOUT_MS = 10_000;
const MAGICK_CHECK_DELAY_MS = 500;
const MOMENT_FORMAT_URL = "https://momentjs.com/docs/#/displaying/format/";
const LINK_RETRY_COUNT = 10;
const LINK_RETRY_DELAY_MS = 250;
// How long after a paste or drop new images are taken for the pasted or
// dropped ones. Each such image starts the wait over, so that saving many
// dropped images can take longer, but only up to the maximum.
const INSERT_WINDOW_MS = 10_000;
const INSERT_WINDOW_MAX_MS = 60_000;
// How long after a conversion ends its output is still not taken for a new
// image, in case the vault reports it late.
const OWN_OUTPUT_GRACE_MS = 30_000;

// Only these formats are checked against ImageMagick: AVIF images are only
// renamed and never read by it.
const CONVERTIBLE_FORMATS = IMAGE_FORMATS.filter(canConvert);

const MODE_LABELS: Record<Mode, string> = {
  convert: "Convert to AVIF",
  rename: "Rename only",
  off: "Off",
};

const ANIMATED_IMAGE_ACTION_LABELS: Record<AnimatedImageAction, string> = {
  ask: "Ask every time",
  rename: "Rename only",
  skip: "Leave as is",
};

// Why an image of a format with Convert on can't be converted.
type ConversionObstacle = MultiFrameKind | "unreadable";

const FORMAT_ACTION_LABELS: Record<keyof FormatActions, string> = {
  rename: "Rename",
  convert: "Convert",
};

const MULTI_FRAME_TEXT: Record<
  MultiFrameKind,
  { title: string; state: string; loss: string }
> = {
  animated: {
    title: "Animated image",
    state: "is animated",
    loss: "Converting it to AVIF would lose the animation.",
  },
  pages: {
    title: "Multi-page image",
    state: "has several pages",
    loss: "Converting it to AVIF would lose all pages but the first.",
  },
};

interface OutputTarget {
  fileName: string;
  vaultPath: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Obsidian's Editor can't map screen coordinates to text, so ask its CodeMirror
// view. This is the note's view even when a table cell is being edited, and
// the one the Editor inserts into.
function moveCursorToDrop(evt: DragEvent, editor: Editor): void {
  const view = (editor as Editor & { cm?: EditorView }).cm;
  const offset = view?.posAtCoords({ x: evt.clientX, y: evt.clientY });
  if (offset !== null && offset !== undefined) {
    editor.setCursor(editor.offsetToPos(offset));
  }
}

// Obsidian types moment as a namespace, which TypeScript 7 won't call, but at
// runtime it is the moment function.
const momentFromDate = moment as unknown as (date: Date) => {
  format(format: string): string;
};

function fileNameValues(title: string, original: string, date: Date): FileNameValues {
  return {
    title,
    original,
    formatDate: (format) => momentFromDate(date).format(format),
  };
}

// Puts every line of a setting description in its own block, so that several
// sentences don't run together.
function descLines(...lines: string[]): DocumentFragment {
  return createFragment((fragment) => {
    for (const line of lines) fragment.createDiv({ text: line });
  });
}

export default class AVIFOnInsertPlugin extends Plugin {
  settings: AVIFPluginSettings = { ...DEFAULT_SETTINGS };
  private readonly noteQueues = new Map<string, Promise<void>>();
  private readonly reservedOutputPaths = new Set<string>();
  // AVIF files this plugin is writing, each with the conversion that writes
  // it. AVIF is an input format too, so without this the plugin would rename
  // its own output.
  private readonly ownOutputPaths = new Map<string, symbol>();
  private readonly insertWindow = new InsertWindow(INSERT_WINDOW_MS, INSERT_WINDOW_MAX_MS);
  private statusBarItem: HTMLElement | null = null;

  // Serializes read-modify-write operations per note so concurrent image
  // conversions (e.g. dropping several images at once) can't race on the
  // same note content and overwrite each other's link replacement.
  private queueNoteOperation<T>(notePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.noteQueues.get(notePath) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.noteQueues.set(notePath, settled);
    void settled.then(() => {
      if (this.noteQueues.get(notePath) === settled) {
        this.noteQueues.delete(notePath);
      }
    });
    return run;
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new AVIFSettingTab(this.app, this));

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("mod-clickable");
    this.statusBarItem.setAttribute("aria-label", "AVIFicator mode");
    this.statusBarItem.setAttribute("data-tooltip-position", "top");
    this.registerDomEvent(this.statusBarItem, "click", (evt) => this.showModeMenu(evt));
    this.updateStatusBar();

    // The status bar can be hidden, so modes can also be switched with commands.
    for (const mode of MODES) {
      this.addCommand({
        id: `switch-mode-${mode}`,
        name: `Switch mode to ${MODE_LABELS[mode]}`,
        callback: async () => {
          await this.setMode(mode);
          new Notice(`AVIFicator mode: ${MODE_LABELS[mode]}`);
        },
      });
    }

    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt, _editor, info) => {
        if (info.file && (!evt.clipboardData || pasteMayAddFiles(evt.clipboardData))) {
          this.insertWindow.open(info.file.path, Date.now());
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-drop", (evt, editor, info) =>
        this.handleEditorDrop(evt, editor, info)
      )
    );

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          void this.handleCreatedFile(file).catch((error: unknown) => {
            console.error("AVIF create handler failed", {
              error,
              filePath: file.path,
            });
          });
        })
      );
    });
  }

  async setMode(mode: Mode): Promise<void> {
    this.settings.mode = mode;
    this.updateStatusBar();
    await this.saveSettings();
  }

  private showModeMenu(evt: MouseEvent): void {
    const menu = new Menu();
    for (const mode of MODES) {
      menu.addItem((item) =>
        item
          .setTitle(MODE_LABELS[mode])
          .setChecked(this.settings.mode === mode)
          .onClick(() => this.setMode(mode))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  updateStatusBar(): void {
    this.statusBarItem?.setText(`AVIF: ${this.settings.mode}`);
    this.statusBarItem?.toggle(this.settings.showStatusBar);
  }

  private async handleCreatedFile(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) return;
    if (this.ownOutputPaths.delete(file.path)) return;
    // The mode is read when the image arrives, so switching modes doesn't
    // affect images that are already queued.
    const plan = this.planImage(file.extension);
    if (!plan) return;

    // Only images just pasted or dropped into a note are processed, not ones
    // that sync brings in while the note is open. The note is the one they
    // went into, which may not be the active one.
    const notePath = this.insertWindow.notePathAt(Date.now());
    const sourceNote = notePath ? this.app.vault.getFileByPath(notePath) : null;
    if (!sourceNote || sourceNote.extension !== "md") return;
    this.insertWindow.extend(Date.now());

    const { format, actions } = plan;
    await this.queueNoteOperation(sourceNote.path, () =>
      actions.convert
        ? this.convertLinkedImage(file, sourceNote, format, actions.rename)
        : this.renameLinkedImage(file, sourceNote)
    );
  }

  // What to do with a new image with this extension, or null if nothing.
  private planImage(
    extension: string
  ): { format: ImageFormat; actions: FormatActions } | null {
    const format = formatForExtension(extension);
    if (!format) return null;
    const actions = effectiveActions(this.settings.mode, this.settings.formats[format]);
    return actions.rename || actions.convert ? { format, actions } : null;
  }

  // When a drop carries file:/// addresses, as drags from a file manager do on
  // Linux with Wayland, Obsidian inserts them as text, or as a Markdown link
  // if the drop has other plain text, instead of copying the files, even if
  // the files come with them. Such images are copied into the vault here
  // instead. Obsidian copies them itself only if the plain text is the address,
  // and the result of copying them here is the same.
  private handleEditorDrop(
    evt: DragEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo
  ): void {
    const dataTransfer = evt.dataTransfer;
    const note = info.file;
    if (note && dataTransfer && dropMayAddFiles(dataTransfer)) {
      this.insertWindow.open(note.path, Date.now());
    }
    if (
      evt.defaultPrevented ||
      !dataTransfer ||
      !note ||
      !this.settings.importDroppedFileLinks ||
      this.settings.mode === "off" ||
      // With this key held, Obsidian links to files instead of copying them.
      (Platform.isMacOS ? evt.altKey : evt.ctrlKey)
    ) {
      return;
    }

    // Images are copied even if their format is unchecked, as Obsidian would
    // copy them, and then left as they are.
    const filePaths = parseFileUriList(dataTransfer.getData("text/uri-list"));
    if (!filePaths?.every((filePath) => formatForExtension(extname(filePath).slice(1)))) {
      return;
    }

    evt.preventDefault();
    moveCursorToDrop(evt, editor);
    void this.importDroppedImages(filePaths, editor, info, note);
  }

  private async importDroppedImages(
    filePaths: string[],
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
    note: TFile
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;

    for (const [index, filePath] of filePaths.entries()) {
      try {
        const file = await this.importDroppedImage(adapter, filePath, note);
        // Copying takes a moment, and the editor may show another note by now.
        if (info.file !== note) {
          const skippedCount = filePaths.length - index - 1;
          new Notice(noteClosedMessage(note.basename, file.name, skippedCount));
          return;
        }
        const link = this.app.fileManager.generateMarkdownLink(file, note.path);
        const separator = index < filePaths.length - 1 ? "\n" : "";
        editor.replaceSelection(`!${link}${separator}`);
      } catch (error: unknown) {
        console.error("Could not copy the dropped image", { error, filePath });
        new Notice(`Could not copy ${basename(filePath)} into the vault`);
      }
    }
  }

  // An image that is already in the vault is only linked, as Obsidian does.
  private async importDroppedImage(
    adapter: FileSystemAdapter,
    filePath: string,
    note: TFile
  ): Promise<TFile> {
    const vaultPath = vaultRelativePath(adapter.getBasePath(), filePath);
    const existing = vaultPath === null ? null : this.app.vault.getAbstractFileByPath(vaultPath);
    if (existing instanceof TFile) return existing;

    const data = await readFile(filePath);
    const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment(
      basename(filePath),
      note.path
    );
    // Reading a large or remote file may outlast the wait started by the drop.
    this.insertWindow.open(note.path, Date.now());
    return this.app.vault.createBinary(attachmentPath, new Uint8Array(data).buffer);
  }

  private async convertLinkedImage(
    file: TFile,
    sourceNote: TFile,
    format: ImageFormat,
    rename: boolean
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("AVIF conversion requires a desktop file-system vault");
      return;
    }

    let outputTarget: OutputTarget | null = null;
    let linkUpdated = false;
    const conversion = Symbol(file.path);

    try {
      const isLinked = await this.waitForImageLink(sourceNote, file.path);
      if (!isLinked) return;

      const obstacle = await this.findConversionObstacle(adapter, file, format);
      if (obstacle) {
        await this.handleUnconvertibleImage(file, sourceNote, obstacle, rename);
        return;
      }

      outputTarget = await this.reserveOutputTarget(file, sourceNote, "avif", rename);
      this.ownOutputPaths.set(outputTarget.vaultPath, conversion);

      await execFileAsync(
        this.settings.magickPath,
        buildConvertArgs(
          adapter.getFullPath(file.path),
          adapter.getFullPath(outputTarget.vaultPath),
          this.settings
        ),
        {
          timeout: CONVERSION_TIMEOUT_MS,
          windowsHide: true,
        }
      );

      if (!(await adapter.exists(outputTarget.vaultPath))) {
        throw new Error(`ImageMagick did not create ${outputTarget.vaultPath}`);
      }

      linkUpdated = await this.replaceLinkWithRetry(
        sourceNote,
        file.path,
        outputTarget.fileName
      );
      if (!linkUpdated) {
        await this.removeGeneratedOutput(adapter, outputTarget.vaultPath);
        new Notice("AVIF link was not updated; the original image was preserved");
        return;
      }

      await this.app.fileManager.trashFile(file);
      new Notice(`Converted: ${outputTarget.fileName}`);
    } catch (error: unknown) {
      if (outputTarget && !linkUpdated) {
        await this.removeGeneratedOutputSafely(adapter, outputTarget.vaultPath);
      }

      console.error("AVIF conversion failed", {
        error,
        imagePath: file.path,
        notePath: sourceNote.path,
      });
      new Notice(
        linkUpdated
          ? "AVIF was created, but the original image could not be removed"
          : "AVIF conversion failed; the original image was preserved"
      );
    } finally {
      if (outputTarget) {
        const { vaultPath } = outputTarget;
        this.reservedOutputPaths.delete(vaultPath);
        // The vault reports the output once ImageMagick creates it, which may
        // be after the conversion ends. If it never does, for example because
        // the conversion failed, the path is forgotten, unless a later
        // conversion writes to it by then.
        window.setTimeout(() => {
          if (this.ownOutputPaths.get(vaultPath) === conversion) {
            this.ownOutputPaths.delete(vaultPath);
          }
        }, OWN_OUTPUT_GRACE_MS);
      }
    }
  }

  // AVIF keeps only the first frame visible, so animated and multi-page
  // images are never converted. Neither are images ImageMagick can't open.
  private async findConversionObstacle(
    adapter: FileSystemAdapter,
    file: TFile,
    format: ImageFormat
  ): Promise<ConversionObstacle | null> {
    let frameCount: number;
    try {
      const { stdout } = await execFileAsync(
        this.settings.magickPath,
        buildFrameCountArgs(adapter.getFullPath(file.path)),
        // Some formats are read in full even with -ping, so this may take as
        // long as the conversion.
        { timeout: CONVERSION_TIMEOUT_MS, windowsHide: true }
      );
      frameCount = parseFrameCount(stdout) ?? 1;
    } catch (error: unknown) {
      // If ImageMagick is missing or doesn't run, the conversion fails as a
      // whole and the original is kept.
      if (!isMagickReadError(error)) throw error;
      console.warn("ImageMagick could not open the image", { error, imagePath: file.path });
      return "unreadable";
    }

    const kind = multiFrameKind(format, frameCount);
    if (kind) return kind;

    // ImageMagick counts only the first frame of an animated PNG.
    if (format === "PNG") {
      const bytes = new Uint8Array(await this.app.vault.readBinary(file));
      if (isAnimatedPng(bytes)) return "animated";
    }
    return null;
  }

  // Does what is left when an image can't be converted: renaming, if it is on
  // for the format.
  private async handleUnconvertibleImage(
    file: TFile,
    sourceNote: TFile,
    obstacle: ConversionObstacle,
    rename: boolean
  ): Promise<void> {
    if (obstacle === "unreadable") {
      if (rename) {
        new Notice(`Can't convert ${file.name}: ImageMagick couldn't open it. Renaming only.`);
        await this.renameLinkedImage(file, sourceNote);
      } else {
        new Notice(`Left as is: ImageMagick couldn't open ${file.name}`);
      }
      return;
    }
    if (!rename) {
      new Notice(`Left as is: ${file.name} ${MULTI_FRAME_TEXT[obstacle].state}`);
      return;
    }

    let action = this.settings.animatedImageAction;
    if (action === "ask") {
      action = await askMultiFrameAction(this.app, file.name, obstacle);
    } else if (action === "skip") {
      new Notice(`Left as is: ${file.name} ${MULTI_FRAME_TEXT[obstacle].state}`);
    }

    if (action === "rename") {
      await this.renameLinkedImage(file, sourceNote);
    }
  }

  // Vault.rename doesn't touch links, so the note is updated here the same
  // way as after a conversion, and the rename is undone if that fails.
  private async renameLinkedImage(file: TFile, sourceNote: TFile): Promise<void> {
    const originalPath = file.path;
    let outputTarget: OutputTarget | null = null;
    let renamed = false;

    try {
      const isLinked = await this.waitForImageLink(sourceNote, originalPath);
      if (!isLinked) return;

      outputTarget = await this.reserveOutputTarget(
        file,
        sourceNote,
        file.extension.toLowerCase()
      );
      // The template gives the name the image already has, or one that
      // differs only in case. Links ignore case, so they would still point to
      // the image and couldn't be told apart from links to the new name.
      if (outputTarget.vaultPath.toLowerCase() === originalPath.toLowerCase()) return;
      await this.app.vault.rename(file, outputTarget.vaultPath);
      renamed = true;

      const linkUpdated = await this.replaceLinkWithRetry(
        sourceNote,
        originalPath,
        outputTarget.fileName
      );
      if (!linkUpdated) {
        throw new Error(`Link to ${originalPath} was not updated`);
      }

      new Notice(`Renamed: ${outputTarget.fileName}`);
    } catch (error: unknown) {
      const nameKept = !renamed || (await this.restoreOriginalNameSafely(file, originalPath));

      console.error("Image rename failed", {
        error,
        imagePath: originalPath,
        notePath: sourceNote.path,
      });
      new Notice(
        nameKept
          ? "Image rename failed; the original name was kept"
          : `Image rename failed, and ${file.name} couldn't get its original name back. Check its link in the note.`
      );
    } finally {
      if (outputTarget) {
        this.reservedOutputPaths.delete(outputTarget.vaultPath);
      }
    }
  }

  private async restoreOriginalNameSafely(file: TFile, originalPath: string): Promise<boolean> {
    try {
      await this.app.vault.rename(file, originalPath);
      return true;
    } catch (restoreError: unknown) {
      console.error("Failed to restore the original image name", {
        restoreError,
        imagePath: file.path,
        originalPath,
      });
      return false;
    }
  }

  // Without renaming, the output keeps the image's own name.
  private async reserveOutputTarget(
    file: TFile,
    sourceNote: TFile,
    extension: string,
    rename = true
  ): Promise<OutputTarget> {
    const folderPath = file.path.substring(0, file.path.lastIndexOf("/") + 1);
    const values = fileNameValues(sourceNote.basename, file.basename, new Date());
    const vaultPaths = this.app.vault.getFiles().map((candidate) => candidate.path);

    for (let attempt = 0; ; attempt += 1) {
      const stem = rename
        ? buildFileStem(this.settings.fileNameTemplate, values, {
            attempt,
            replaceSpaces: this.settings.replaceSpaces,
          })
        : keepFileStem(file.basename, attempt);
      const fileName = `${stem}.${extension}`;
      const vaultPath = folderPath + fileName;
      // An image may keep its own name, or change only its case, which file
      // systems that ignore case report as taken.
      const isOwnPath = vaultPath.toLowerCase() === file.path.toLowerCase();
      const isFree =
        isOwnPath ||
        (!isFileNameTaken(fileName, vaultPaths) &&
          !(await this.app.vault.adapter.exists(vaultPath)));

      // Other images may be getting names at the same time, in any folder.
      if (isFree && !isFileNameTaken(fileName, [...this.reservedOutputPaths])) {
        this.reservedOutputPaths.add(vaultPath);
        return { fileName, vaultPath };
      }
    }
  }

  private async waitForImageLink(note: TFile, imagePath: string): Promise<boolean> {
    const imageName = imagePath.slice(imagePath.lastIndexOf("/") + 1);
    for (let attempt = 0; attempt < LINK_RETRY_COUNT; attempt += 1) {
      const content = await this.app.vault.read(note);
      const result = this.replaceImageLinks(content, note, imagePath, imageName);
      if (result.replacementCount > 0) return true;

      if (attempt < LINK_RETRY_COUNT - 1) {
        await wait(LINK_RETRY_DELAY_MS);
      }
    }
    return false;
  }

  private async replaceLinkWithRetry(
    note: TFile,
    originalPath: string,
    outputFileName: string
  ): Promise<boolean> {
    for (let attempt = 0; attempt < LINK_RETRY_COUNT; attempt += 1) {
      const currentContent = await this.app.vault.read(note);
      const preview = this.replaceImageLinks(
        currentContent,
        note,
        originalPath,
        outputFileName
      );

      if (preview.replacementCount > 0) {
        let replacementCount = 0;
        await this.app.vault.process(note, (latestContent) => {
          const result = this.replaceImageLinks(
            latestContent,
            note,
            originalPath,
            outputFileName
          );
          replacementCount = result.replacementCount;
          return result.content;
        });
        if (replacementCount > 0) return true;
      }

      if (attempt < LINK_RETRY_COUNT - 1) {
        await wait(LINK_RETRY_DELAY_MS);
      }
    }
    return false;
  }

  private replaceImageLinks(
    content: string,
    note: TFile,
    originalPath: string,
    outputFileName: string
  ): LinkReplacementResult {
    return replaceImageEmbedLinks(content, outputFileName, (target) =>
      this.linkResolvesToPath(target, note, originalPath)
    );
  }

  // Works by path rather than TFile so that links can still be matched to an
  // image that has already been renamed away from that path.
  private linkResolvesToPath(target: string, note: TFile, filePath: string): boolean {
    const decodedTarget = this.decodeLinkTarget(target);
    const linkPath = getLinkpath(decodedTarget)
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "");
    const destination = this.app.metadataCache.getFirstLinkpathDest(linkPath, note.path);

    if (destination) {
      return destination.path === filePath;
    }
    return linkPathPointsTo(linkPath, note.path, filePath);
  }

  private decodeLinkTarget(target: string): string {
    try {
      return decodeURIComponent(target);
    } catch {
      return target;
    }
  }

  private async removeGeneratedOutput(
    adapter: FileSystemAdapter,
    outputPath: string
  ): Promise<void> {
    if (await adapter.exists(outputPath)) {
      await adapter.remove(outputPath);
    }
  }

  private async removeGeneratedOutputSafely(
    adapter: FileSystemAdapter,
    outputPath: string
  ): Promise<void> {
    try {
      await this.removeGeneratedOutput(adapter, outputPath);
    } catch (cleanupError: unknown) {
      console.error("Failed to remove generated AVIF output", {
        cleanupError,
        outputPath,
      });
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class MultiFrameImageModal extends Modal {
  private readonly fileName: string;
  private readonly kind: MultiFrameKind;
  private readonly onChoose: (action: "rename" | "skip") => void;
  // Closing the window without choosing leaves the image as is.
  private action: "rename" | "skip" = "skip";

  constructor(
    app: App,
    fileName: string,
    kind: MultiFrameKind,
    onChoose: (action: "rename" | "skip") => void
  ) {
    super(app);
    this.fileName = fileName;
    this.kind = kind;
    this.onChoose = onChoose;
  }

  onOpen(): void {
    const text = MULTI_FRAME_TEXT[this.kind];
    this.setTitle(text.title);
    this.contentEl.createEl("p", {
      text: `"${this.fileName}" ${text.state}. ${text.loss}`,
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("Rename only")
          .setCta()
          .onClick(() => {
            this.action = "rename";
            this.close();
          })
      )
      .addButton((button) =>
        button.setButtonText("Leave as is").onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onChoose(this.action);
  }
}

function askMultiFrameAction(
  app: App,
  fileName: string,
  kind: MultiFrameKind
): Promise<"rename" | "skip"> {
  return new Promise((resolve) => {
    new MultiFrameImageModal(app, fileName, kind, resolve).open();
  });
}

// Shows template variables while the user types "{" in the template field.
class TemplateVariableSuggest extends AbstractInputSuggest<TemplateSuggestion> {
  private readonly templateInputEl: HTMLInputElement;

  constructor(app: App, templateInputEl: HTMLInputElement) {
    super(app, templateInputEl);
    this.templateInputEl = templateInputEl;
  }

  protected getSuggestions(): TemplateSuggestion[] {
    const partial = findPartialVariable(this.templateInputEl.value, this.cursor());
    if (!partial) return [];

    const now = new Date();
    return filterTemplateSuggestions(
      templateSuggestions((format) => momentFromDate(now).format(format)),
      partial.query
    );
  }

  renderSuggestion(suggestion: TemplateSuggestion, el: HTMLElement): void {
    el.addClass("mod-complex");
    const contentEl = el.createDiv({ cls: "suggestion-content" });
    contentEl.createDiv({ cls: "suggestion-title", text: suggestion.variable });
    contentEl.createDiv({ cls: "suggestion-note", text: suggestion.description });
  }

  selectSuggestion(suggestion: TemplateSuggestion): void {
    const cursor = this.cursor();
    const partial = findPartialVariable(this.templateInputEl.value, cursor);
    if (!partial) return;

    const result = insertVariable(
      this.templateInputEl.value,
      partial,
      cursor,
      suggestion.variable
    );
    this.setValue(result.value);
    this.templateInputEl.setSelectionRange(result.cursor, result.cursor);
    // The text component saves the setting on input events.
    this.templateInputEl.dispatchEvent(new Event("input"));
    this.close();
  }

  private cursor(): number {
    return this.templateInputEl.selectionStart ?? this.templateInputEl.value.length;
  }
}

class AVIFSettingTab extends PluginSettingTab {
  plugin: AVIFOnInsertPlugin;
  private magickCheckId = 0;
  // Checks ImageMagick shortly after the path is edited.
  private checkMagickLater: Debouncer<[], void> | null = null;

  constructor(app: App, plugin: AVIFOnInsertPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    // A check left over from before a redraw would make the new one's result
    // look outdated, leaving the status at "Checking ImageMagick...".
    this.checkMagickLater?.cancel();
    containerEl.empty();

    new Setting(containerEl)
      .setName("Mode")
      .setDesc("What to do with images you add to notes.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(MODE_LABELS)
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            if (isMode(value)) {
              await this.plugin.setMode(value);
              // The format table dims the columns this mode ignores.
              this.display();
            }
          })
      );

    new Setting(containerEl)
      .setName("Show mode in status bar")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showStatusBar)
          .onChange(async (value) => {
            this.plugin.settings.showStatusBar = value;
            this.plugin.updateStatusBar();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Copy dragged images (file:/// links)")
      .setDesc(
        descLines(
          "Dragging an image from a file manager sometimes inserts a file:/// link instead of the image.",
          "With this on, the image is copied into the vault."
        )
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.importDroppedFileLinks)
          .onChange(async (value) => {
            this.plugin.settings.importDroppedFileLinks = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("File names").setHeading();

    const templateSetting = new Setting(containerEl)
      .setName("File name template")
      .setClass("avificator-template-setting")
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            descLines(
              "{title} — note title",
              "{original} — original file name",
              "{date:FORMAT} — date and time, e.g. {date:YYYY-MM-DD}",
              "{counter} — 000, or 001, 002… if the name is taken",
              "Type { to pick a variable."
            )
          );
          fragment.createDiv({
            cls: "avificator-desc-group",
            text: "Date: YYYY year, MM month, DD day",
          });
          fragment.createDiv({
            text: "Time: HH hours, mm minutes, ss seconds, SSS milliseconds",
          });
          fragment
            .createDiv()
            .createEl("a", { text: "More date formats", href: MOMENT_FORMAT_URL });
        })
      );
    const templatePreviewEl = templateSetting.descEl.createDiv({
      cls: ["avificator-desc-group", "mod-success"],
    });
    const updateTemplatePreview = () => {
      const stem = buildFileStem(
        this.plugin.settings.fileNameTemplate,
        fileNameValues("My note", "IMG_1234", new Date()),
        { attempt: 0, replaceSpaces: this.plugin.settings.replaceSpaces }
      );
      templatePreviewEl.setText(`Example: ${stem}.avif`);
    };
    templateSetting.addText((text) => {
      new TemplateVariableSuggest(this.app, text.inputEl);
      return text
        .setPlaceholder(DEFAULT_SETTINGS.fileNameTemplate)
        .setValue(this.plugin.settings.fileNameTemplate)
        .onChange(async (value) => {
          const template = normalizeFileNameTemplate(value);
          const unknownVariable = findUnknownVariable(template);
          templateSetting.setErrorMessage?.(
            unknownVariable ? `Unknown variable ${unknownVariable}` : null
          );
          if (unknownVariable) return;

          this.plugin.settings.fileNameTemplate = template;
          await this.plugin.saveSettings();
          updateTemplatePreview();
        });
    });
    updateTemplatePreview();

    new Setting(containerEl)
      .setName("Replace spaces with underscores")
      .setDesc("My note → My_note")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.replaceSpaces)
          .onChange(async (value) => {
            this.plugin.settings.replaceSpaces = value;
            await this.plugin.saveSettings();
            updateTemplatePreview();
          })
      );

    new Setting(containerEl)
      .setName("Conversion")
      .setDesc("Used in Convert to AVIF mode for formats with Convert checked.")
      .setHeading();

    const qualitySetting = new Setting(containerEl)
      .setName("Image quality")
      .setDesc(descLines("From 0 (lowest) to 100 (highest).", "Default is 80."));
    qualitySetting.addText((text) =>
      text
        .setPlaceholder("Enter quality (0-100)")
        .setValue(this.plugin.settings.quality.toString())
        .onChange(async (value) => {
          const quality =
            value.trim() === "" ? null : validateQuality(Number(value));
          // setErrorMessage exists since Obsidian 1.13; older versions just
          // skip saving the invalid value.
          qualitySetting.setErrorMessage?.(
            quality === null ? "Enter a whole number from 0 to 100" : null
          );
          if (quality === null) return;

          this.plugin.settings.quality = quality;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl)
      .setName("Remove metadata")
      .setDesc(
        descLines(
          "Removes GPS location, camera details, and other EXIF data.",
          "Color profiles are kept."
        )
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.stripMetadata)
          .onChange(async (value) => {
            this.plugin.settings.stripMetadata = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Limit image size")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.limitImageSize)
          .onChange(async (value) => {
            this.plugin.settings.limitImageSize = value;
            await this.plugin.saveSettings();
            // Show or hide the maximum size field.
            this.display();
          })
      );

    if (this.plugin.settings.limitImageSize) {
      const maxSizeSetting = new Setting(containerEl)
        .setName("Maximum size")
        .setDesc(descLines("Longer side in pixels.", "Default is 2000."));
      maxSizeSetting.addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.maxImageSize.toString())
          .setValue(this.plugin.settings.maxImageSize.toString())
          .onChange(async (value) => {
            const maxImageSize =
              value.trim() === "" ? null : validateMaxImageSize(Number(value));
            maxSizeSetting.setErrorMessage?.(
              maxImageSize === null ? "Enter a whole number greater than 0" : null
            );
            if (maxImageSize === null) return;

            this.plugin.settings.maxImageSize = maxImageSize;
            await this.plugin.saveSettings();
          })
      );
    }

    new Setting(containerEl)
      .setName("When you add an animated or multi-page image")
      .setDesc("Such images can't be converted to AVIF.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(ANIMATED_IMAGE_ACTION_LABELS)
          .setValue(this.plugin.settings.animatedImageAction)
          .onChange(async (value) => {
            if (isAnimatedImageAction(value)) {
              this.plugin.settings.animatedImageAction = value;
              await this.plugin.saveSettings();
            }
          })
      );

    const magickPathSetting = new Setting(containerEl)
      .setName("ImageMagick path")
      .setDesc(
        descLines(
          "Set the full path if magick isn't found.",
          "For example, /opt/homebrew/bin/magick."
        )
      );
    const magickStatusEl = magickPathSetting.descEl.createDiv();
    const formatNameEls = new Map<ImageFormat, HTMLElement>();
    // Goes at the end of the format table, which is built further down.
    const formatsNoteEl = createDiv({ cls: ["avificator-formats-note", "mod-warning"] });
    const showMagickStatus = () =>
      this.showMagickStatus(magickStatusEl, formatNameEls, formatsNoteEl);
    const checkMagickLater = debounce(
      () => void showMagickStatus(),
      MAGICK_CHECK_DELAY_MS,
      true
    );
    this.checkMagickLater = checkMagickLater;
    magickPathSetting.addText((text) =>
      text
        .setPlaceholder(DEFAULT_SETTINGS.magickPath)
        .setValue(this.plugin.settings.magickPath)
        .onChange(async (value) => {
          this.plugin.settings.magickPath = normalizeMagickPath(value);
          await this.plugin.saveSettings();
          checkMagickLater();
        })
    );

    new Setting(containerEl)
      .setName("Input formats")
      .setHeading();
    // A compact table of checkboxes rather than two toggles per format, in a
    // setting card like the items around it.
    const formatsEl = containerEl.createDiv({ cls: ["setting-item", "avificator-formats"] });
    // Dim the columns that the current mode ignores.
    formatsEl.toggleClass("mod-no-rename", this.plugin.settings.mode === "off");
    formatsEl.toggleClass("mod-no-convert", this.plugin.settings.mode !== "convert");
    const actionLabels = Object.entries(FORMAT_ACTION_LABELS) as [
      keyof FormatActions,
      string,
    ][];
    const tableEl = formatsEl.createDiv({ cls: "avificator-formats-table" });
    const headerEl = tableEl.createDiv({ cls: "avificator-formats-row" });
    headerEl.createDiv();
    for (const [action, label] of actionLabels) {
      headerEl.createDiv({
        cls: ["avificator-formats-header", `avificator-formats-${action}`],
        text: label,
      });
    }
    for (const format of IMAGE_FORMATS) {
      // A row of its own, so it can be highlighted under the pointer.
      const rowEl = tableEl.createDiv({
        cls: ["avificator-formats-row", "avificator-format-row"],
      });
      const nameEl = rowEl.createDiv();
      nameEl.createSpan({ text: format });
      nameEl.createSpan({
        cls: "avificator-format-extensions",
        text: FORMAT_EXTENSIONS[format].map((extension) => `.${extension}`).join(" "),
      });
      formatNameEls.set(format, nameEl);

      for (const [action, label] of actionLabels) {
        const cellEl = rowEl.createDiv({ cls: `avificator-formats-${action}` });
        if (action === "convert" && !canConvert(format)) {
          const noneEl = cellEl.createSpan({ cls: "avificator-formats-none", text: "—" });
          setTooltip(noneEl, `${format} images are only renamed`);
          continue;
        }
        const checkbox = cellEl.createEl("input", {
          type: "checkbox",
          attr: { "aria-label": `${label} ${format}` },
        });
        checkbox.checked = this.plugin.settings.formats[format][action];
        checkbox.addEventListener("change", () => {
          this.plugin.settings.formats[format][action] = checkbox.checked;
          void this.plugin.saveSettings();
        });
      }
    }
    formatsEl.appendChild(formatsNoteEl);

    void showMagickStatus();
  }

  private async showMagickStatus(
    statusEl: HTMLElement,
    formatNameEls: Map<ImageFormat, HTMLElement>,
    formatsNoteEl: HTMLElement
  ): Promise<void> {
    // Typing in the path field can start several checks; show only the last.
    const checkId = ++this.magickCheckId;
    statusEl.setText("Checking ImageMagick...");

    // Formats are checked whether they are on or not, so the status shows what
    // ImageMagick can do rather than what is selected.
    const { status, formats } = await checkMagick(
      this.plugin.settings.magickPath,
      CONVERTIBLE_FORMATS
    );
    if (checkId !== this.magickCheckId) return;

    statusEl.empty();
    for (const line of status) {
      statusEl.createDiv({
        text: line.text,
        cls: line.ok ? "mod-success" : "mod-warning",
      });
    }

    // Without a format list (ImageMagick not found), the status says it all.
    const unreadable = CONVERTIBLE_FORMATS.filter(
      (format) => formats.size > 0 && !formats.get(format)?.read
    );
    for (const [format, nameEl] of formatNameEls) {
      nameEl.toggleClass("mod-warning", unreadable.includes(format));
    }
    formatsNoteEl.empty();
    if (unreadable.length > 0) {
      formatsNoteEl.append(
        descLines(
          "ImageMagick can't read the formats in orange.",
          "Such images can only be renamed."
        )
      );
    }
  }
}

async function checkMagick(
  magickPath: string,
  inputFormats: readonly string[]
): Promise<{ status: MagickStatus; formats: Map<string, FormatSupport> }> {
  const options = { timeout: MAGICK_CHECK_TIMEOUT_MS, windowsHide: true };
  try {
    const [version, formatList] = await Promise.all([
      execFileAsync(magickPath, ["-version"], options),
      execFileAsync(magickPath, ["-list", "format"], options),
    ]);
    const formats = parseFormatList(formatList.stdout);
    return {
      status: describeMagickSupport(version.stdout, formats, inputFormats),
      formats,
    };
  } catch (error: unknown) {
    return { status: describeMagickError(error), formats: new Map() };
  }
}
