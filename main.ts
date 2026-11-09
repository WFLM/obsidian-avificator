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
  normalizePath,
  setTooltip,
  type Debouncer,
  type FileStats,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import {
  dropInsertsAddresses,
  parseFileUriList,
  vaultRelativePath,
} from "./dropped-files";
import { InsertWindow, dropFileCount, pasteFileCount } from "./insert-window";
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
  findImageEmbedTargets,
  findLinkTargets,
  isFileNameTaken,
  replaceImageEmbedLinks,
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
import { keepEmbedsInQuotes } from "./quote-embeds";
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
  ENCODING_SPEEDS,
  isEncodingSpeed,
  parseSettings,
  validateMaxImageSize,
  validateQuality,
  type AVIFicatorSettings,
  type AnimatedImageAction,
  type EncodingSpeed,
  type FormatActions,
  type Mode,
} from "./settings";

const execFileAsync = promisify(execFile);
// Only for a hung ImageMagick: at the Slow speed a large photo takes minutes.
const CONVERSION_TIMEOUT_MS = 600_000;
const MAGICK_CHECK_TIMEOUT_MS = 10_000;
const MAGICK_CHECK_DELAY_MS = 500;
const MOMENT_FORMAT_URL = "https://momentjs.com/docs/#/displaying/format/";
// Obsidian links a new image right after saving it; the wait allows for a
// slow disk.
const LINK_RETRY_COUNT = 20;
const LINK_RETRY_DELAY_MS = 250;
// How long to wait for the next pasted or dropped image, and for all of them.
const INSERT_WINDOW_MS = 10_000;
const INSERT_WINDOW_MAX_MS = 60_000;

const ORIGINAL_KEPT_FOR_LINKS = "The original was kept: other links point to it.";

// AVIF is only renamed, so ImageMagick never reads it.
const CONVERTIBLE_FORMATS = IMAGE_FORMATS.filter(canConvert);

const MODE_LABELS: Record<Mode, string> = {
  convert: "Convert to AVIF",
  rename: "Rename only",
  off: "Off",
};

const ENCODING_SPEED_LABELS: Record<EncodingSpeed, string> = {
  8: "Fast",
  6: "Normal",
  4: "Slow",
};

const ANIMATED_IMAGE_ACTION_LABELS: Record<AnimatedImageAction, string> = {
  ask: "Ask every time",
  rename: "Rename only",
  skip: "Leave as is",
};

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

// Obsidian's Editor can't map screen coordinates to text, but its CodeMirror
// view can, even while a table cell is edited. As in CodeMirror's own drop
// handling, the nearest position is taken, so no selected text is replaced.
function moveCursorToDrop(evt: DragEvent, editor: Editor): void {
  const view = (editor as Editor & { cm?: EditorView }).cm;
  if (!view) return;
  const offset = view.posAtCoords({ x: evt.clientX, y: evt.clientY }, false);
  editor.setCursor(editor.offsetToPos(offset));
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

// One block per line, so that sentences don't run together.
function descLines(...lines: string[]): DocumentFragment {
  return createFragment((fragment) => {
    for (const line of lines) fragment.createDiv({ text: line });
  });
}

export default class AVIFicatorPlugin extends Plugin {
  settings: AVIFicatorSettings = { ...DEFAULT_SETTINGS };
  private readonly noteQueues = new Map<string, Promise<void>>();
  private readonly reservedOutputPaths = new Set<string>();
  private readonly insertWindow = new InsertWindow(INSERT_WINDOW_MS, INSERT_WINDOW_MAX_MS);
  private statusBarItem: HTMLElement | null = null;

  // One operation per note at a time, so that images dropped together don't
  // overwrite each other's link changes.
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

    this.addSettingTab(new AVIFicatorSettingTab(this.app, this));

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("mod-clickable");
    this.statusBarItem.setAttribute("aria-label", "AVIFicator mode");
    this.statusBarItem.setAttribute("data-tooltip-position", "top");
    this.registerDomEvent(this.statusBarItem, "click", (evt) => this.showModeMenu(evt));
    this.updateStatusBar();

    // The status bar can be hidden, so commands can switch modes too.
    for (const mode of MODES) {
      this.addCommand({
        id: `switch-mode-${mode}`,
        name: `Switch mode: ${MODE_LABELS[mode]}`,
        callback: async () => {
          await this.setMode(mode);
          new Notice(`AVIFicator mode: ${MODE_LABELS[mode]}`);
        },
      });
    }

    this.registerEditorExtension(keepEmbedsInQuotes);

    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt, _editor, info) => {
        // Another plugin has already handled this paste.
        if (evt.defaultPrevented) return;
        // No preventDefault(): Obsidian still pastes the files itself.
        const fileCount = evt.clipboardData ? pasteFileCount(evt.clipboardData) : 1;
        if (info.file && fileCount > 0) {
          this.insertWindow.open(info.file.path, fileCount, Date.now());
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
    // The plugin's own AVIF output, which it would otherwise rename.
    if (this.reservedOutputPaths.has(file.path)) return;
    // Every new image, even one left alone, takes the place of a pasted or
    // dropped file; other files, such as synced notes, don't.
    if (!formatForExtension(file.extension)) return;
    const notePath = this.insertWindow.take(Date.now());
    // Read now, so switching modes doesn't affect queued images.
    const plan = this.planImage(file.extension);
    if (!notePath || !plan) return;
    const sourceNote = this.app.vault.getFileByPath(notePath);
    if (!sourceNote || sourceNote.extension !== "md") return;

    const { format, actions } = plan;
    await this.queueNoteOperation(sourceNote.path, () =>
      actions.convert
        ? this.convertLinkedImage(file, sourceNote, format, actions.rename)
        : this.renameLinkedImage(file, sourceNote)
    );
  }

  private planImage(
    extension: string
  ): { format: ImageFormat; actions: FormatActions } | null {
    const format = formatForExtension(extension);
    if (!format) return null;
    const actions = effectiveActions(this.settings.mode, this.settings.formats[format]);
    return actions.rename || actions.convert ? { format, actions } : null;
  }

  // On Linux with Wayland, Obsidian may insert the file:/// addresses of
  // dragged files as text instead of copying them. Only then does the plugin
  // copy them itself.
  private handleEditorDrop(
    evt: DragEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo
  ): void {
    const dataTransfer = evt.dataTransfer;
    const note = info.file;
    // Another plugin has handled this drop, so Obsidian adds no files.
    if (evt.defaultPrevented || !dataTransfer || !note) return;

    const filePaths = this.droppedImagesToCopy(evt, dataTransfer);
    if (filePaths) {
      evt.preventDefault();
      moveCursorToDrop(evt, editor);
      void this.importDroppedImages(filePaths, editor, info, note);
      return;
    }
    const fileCount = dropFileCount(dataTransfer);
    if (fileCount > 0) {
      this.insertWindow.open(note.path, fileCount, Date.now());
    }
  }

  // The images to copy into the vault, or null if Obsidian should handle the
  // drop itself.
  private droppedImagesToCopy(evt: DragEvent, dataTransfer: DataTransfer): string[] | null {
    if (
      !this.settings.importDroppedFileLinks ||
      this.settings.mode === "off" ||
      // With this key held, Obsidian links to files instead of copying them.
      (Platform.isMacOS ? evt.altKey : evt.ctrlKey)
    ) {
      return null;
    }

    const uriList = dataTransfer.getData("text/uri-list");
    if (!dropInsertsAddresses(uriList, dataTransfer.getData("text/plain"))) return null;
    // Unchecked formats are copied too, as Obsidian would, and left alone.
    const filePaths = parseFileUriList(uriList);
    return filePaths?.every((filePath) => formatForExtension(extname(filePath).slice(1)))
      ? filePaths
      : null;
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
        const file = await this.importDroppedImage(adapter, filePath, info, note);
        // Copying takes a moment, and the editor may show another note by now.
        if (!file || info.file !== note) {
          new Notice(
            `${note.basename} is no longer open, so the dropped images weren't added to it`
          );
          return;
        }
        const link = this.app.fileManager.generateMarkdownLink(file, note.path);
        // Obsidian puts a blank line between dropped files.
        const separator = index < filePaths.length - 1 ? "\n\n" : "";
        editor.replaceSelection(`!${link}${separator}`);
      } catch (error: unknown) {
        console.error("Could not copy the dropped image", { error, filePath });
        new Notice(`Could not copy ${basename(filePath)} into the vault`);
      }
    }
  }

  // An image already in the vault is only linked, as Obsidian does. A copy
  // made after the editor switched notes is removed, so none is left unlinked.
  private async importDroppedImage(
    adapter: FileSystemAdapter,
    filePath: string,
    info: MarkdownView | MarkdownFileInfo,
    note: TFile
  ): Promise<TFile | null> {
    const vaultPath = vaultRelativePath(adapter.getBasePath(), filePath);
    // Vault paths have the same Unicode form and spaces as Obsidian gives them.
    const existing =
      vaultPath === null ? null : this.app.vault.getAbstractFileByPath(normalizePath(vaultPath));
    if (existing instanceof TFile) return existing;

    const data = await readFile(filePath);
    const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment(
      basename(filePath),
      note.path
    );
    if (info.file !== note) return null;
    // Reading a large file may take a while, so the wait starts only now.
    this.insertWindow.open(note.path, 1, Date.now());
    const copy = await this.app.vault.createBinary(attachmentPath, new Uint8Array(data).buffer);
    if (info.file === note) return copy;
    // Nothing links to this fresh copy, so it isn't trashed. The dragged file
    // itself stays where it was.
    await this.app.vault.delete(copy);
    return null;
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
    let outputFile: TFile | null = null;
    let linkUpdated = false;

    try {
      if (!(await this.waitForImageLinks(sourceNote, file))) return;
      if (this.isLinkedFromOtherNotes(file, sourceNote)) return;

      const obstacle = await this.findConversionObstacle(adapter, file, format);
      if (obstacle) {
        await this.handleUnconvertibleImage(file, sourceNote, obstacle, rename);
        return;
      }

      outputTarget = await this.reserveOutputTarget(file, sourceNote, "avif", rename);
      const originalPath = file.path;
      const originalStat = { ...file.stat };
      outputFile = await this.createAvif(
        adapter.getFullPath(file.path),
        outputTarget.vaultPath
      );

      // Slow encoding leaves time to edit or move the image. The AVIF would
      // then be outdated, or in the old folder.
      if (await this.hasChanged(file, originalPath, originalStat)) {
        await this.removeGeneratedOutput(outputFile);
        new Notice(`Left as is: ${file.name} was changed or moved during conversion`);
        return;
      }

      linkUpdated = await this.replaceImageLinks(
        sourceNote,
        file,
        originalPath,
        outputTarget.fileName
      );
      if (!linkUpdated) {
        await this.removeGeneratedOutput(outputFile);
        new Notice("AVIF link was not updated; the original image was preserved");
        return;
      }

      // If it changes while the note is updated, both versions are kept.
      if (await this.hasChanged(file, originalPath, originalStat)) {
        new Notice("The image changed during conversion; the original was left untouched");
        return;
      }
      if (await this.isOriginalStillLinked(file, sourceNote)) {
        new Notice(`Converted: ${outputTarget.fileName}. ${ORIGINAL_KEPT_FOR_LINKS}`);
        return;
      }
      // The original is the file Obsidian made for this paste or drop, so it
      // isn't kept in trash.
      await this.app.vault.delete(file);
      new Notice(`Converted: ${outputTarget.fileName}`);
    } catch (error: unknown) {
      if (outputFile && !linkUpdated) {
        await this.removeGeneratedOutput(outputFile);
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
        this.reservedOutputPaths.delete(outputTarget.vaultPath);
      }
    }
  }

  // Added through the vault, the AVIF is reported while its name is still
  // reserved, and never overwrites a file that took the name meanwhile.
  private async createAvif(inputPath: string, vaultPath: string): Promise<TFile> {
    const { stdout } = await execFileAsync(
      this.settings.magickPath,
      buildConvertArgs(inputPath, this.settings),
      {
        encoding: "buffer",
        // The whole AVIF is kept in memory for the vault anyway.
        maxBuffer: Infinity,
        timeout: CONVERSION_TIMEOUT_MS,
        windowsHide: true,
      }
    );
    return await this.app.vault.createBinary(vaultPath, new Uint8Array(stdout).buffer);
  }

  // AVIF shows only the first frame, so animated and multi-page images aren't
  // converted, nor are ones ImageMagick can't open.
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

  // Copying instead of renaming keeps the original name taken until the links
  // are updated, so another image can't reuse it.
  private async renameLinkedImage(file: TFile, sourceNote: TFile): Promise<void> {
    const originalPath = file.path;
    let outputTarget: OutputTarget | null = null;
    let outputFile: TFile | null = null;
    let linkUpdated = false;

    try {
      if (!(await this.waitForImageLinks(sourceNote, file))) return;
      if (this.isLinkedFromOtherNotes(file, sourceNote)) return;

      outputTarget = await this.reserveOutputTarget(
        file,
        sourceNote,
        file.extension.toLowerCase()
      );
      // The template gives the name the image already has, or one that
      // differs only in case, which links ignore.
      if (outputTarget.vaultPath.toLowerCase() === originalPath.toLowerCase()) return;
      const originalStat = { ...file.stat };
      const data = await this.app.vault.readBinary(file);
      outputFile = await this.app.vault.createBinary(outputTarget.vaultPath, data, {
        ctime: originalStat.ctime,
        mtime: originalStat.mtime,
      });

      // Edited or moved meanwhile: the copy would be outdated, or in the old
      // folder.
      if (await this.hasChanged(file, originalPath, originalStat)) {
        await this.removeGeneratedOutput(outputFile);
        new Notice(`Left as is: ${file.name} was changed or moved during renaming`);
        return;
      }

      linkUpdated = await this.replaceImageLinks(
        sourceNote,
        file,
        originalPath,
        outputTarget.fileName
      );
      if (!linkUpdated) {
        throw new Error(`Link to ${originalPath} was not updated`);
      }

      // If it changes while the note is updated, both versions are kept.
      if (await this.hasChanged(file, originalPath, originalStat)) {
        new Notice("The image changed during renaming; the original was left untouched");
        return;
      }
      if (await this.isOriginalStillLinked(file, sourceNote)) {
        new Notice(`Renamed: ${outputTarget.fileName}. ${ORIGINAL_KEPT_FOR_LINKS}`);
        return;
      }

      // The same image is now in the vault under the new name, so the
      // original isn't kept in trash.
      await this.app.vault.delete(file);
      new Notice(`Renamed: ${outputTarget.fileName}`);
    } catch (error: unknown) {
      if (outputFile && !linkUpdated) {
        await this.removeGeneratedOutput(outputFile);
      }

      console.error("Image rename failed", {
        error,
        imagePath: originalPath,
        notePath: sourceNote.path,
      });
      new Notice(
        linkUpdated
          ? "The renamed image was created, but the original could not be removed"
          : "Image rename failed; the original name was kept"
      );
    } finally {
      if (outputTarget) {
        this.reservedOutputPaths.delete(outputTarget.vaultPath);
      }
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

    for (let attempt = 0; ; attempt += 1) {
      const stem = rename
        ? buildFileStem(this.settings.fileNameTemplate, values, {
            attempt,
            replaceSpaces: this.settings.replaceSpaces,
          })
        : keepFileStem(file.basename, attempt);
      // As the vault saves it: no-break spaces as spaces, letters composed.
      const fileName = normalizePath(`${stem}.${extension}`);
      const vaultPath = folderPath + fileName;
      // An image may keep its own name, or change only its case, which file
      // systems that ignore case report as taken.
      const isOwnPath = vaultPath.toLowerCase() === file.path.toLowerCase();
      // A link by name alone, as Obsidian writes it, must find only the new
      // image, so the name is checked in every folder, ignoring case.
      const isFree =
        isOwnPath ||
        (!this.app.metadataCache.getFirstLinkpathDest(fileName, "") &&
          !(await this.app.vault.adapter.exists(vaultPath)));

      // Other images may be getting names at the same time, in any folder.
      if (isFree && !isFileNameTaken(fileName, [...this.reservedOutputPaths])) {
        this.reservedOutputPaths.add(vaultPath);
        return { fileName, vaultPath };
      }
    }
  }

  private async waitForImageLinks(
    note: TFile,
    image: TFile
  ): Promise<boolean> {
    for (let attempt = 0; attempt < LINK_RETRY_COUNT; attempt += 1) {
      await this.saveOpenNote(note);
      const content = await this.app.vault.read(note);
      const targets = findImageEmbedTargets(content, (target) =>
        this.resolveLinkTarget(target, note) === image
      );
      if (targets.size > 0) return true;

      if (attempt < LINK_RETRY_COUNT - 1) {
        await sleep(LINK_RETRY_DELAY_MS);
      }
    }
    // Not a notice: such an image may have come with sync, not the paste.
    console.debug("No link to the new image in the note; left as is", {
      imagePath: image.path,
      notePath: note.path,
    });
    return false;
  }

  // A freshly added image is linked only from its note. If other notes link
  // to it, it came some other way, such as with sync, and deleting it would
  // break their links.
  private isLinkedFromOtherNotes(image: TFile, note: TFile): boolean {
    const linkingNote = Object.keys(this.app.metadataCache.resolvedLinks).find(
      (notePath) =>
        notePath !== note.path &&
        (this.app.metadataCache.resolvedLinks[notePath]?.[image.path] ?? 0) > 0
    );
    if (!linkingNote) return false;
    console.debug("Other notes link to the image; the original is kept", {
      imagePath: image.path,
      notePath: note.path,
      linkingNote,
    });
    return true;
  }

  // External edits may not have reached the TFile cache yet, so the file on
  // disk is checked.
  private async hasChanged(
    file: TFile,
    originalPath: string,
    originalStat: FileStats
  ): Promise<boolean> {
    const currentStat = await this.app.vault.adapter.stat(originalPath);
    return (
      file.path !== originalPath ||
      currentStat?.ctime !== originalStat.ctime ||
      currentStat?.mtime !== originalStat.mtime ||
      currentStat?.size !== originalStat.size
    );
  }

  // Only embeds are replaced, so the note may still link to the original
  // otherwise, such as in its properties.
  private async isOriginalStillLinked(original: TFile, note: TFile): Promise<boolean> {
    const content = await this.app.vault.read(note);
    const isOriginal = (target: string): boolean =>
      this.resolveLinkTarget(target, note) === original;
    return (
      findLinkTargets(content, isOriginal).size > 0 ||
      this.isLinkedFromOtherNotes(original, note)
    );
  }

  // The original still exists, so every link can be resolved to the same file,
  // including links added while the output was being created.
  private async replaceImageLinks(
    note: TFile,
    originalFile: TFile,
    originalPath: string,
    outputFileName: string
  ): Promise<boolean> {
    let replacementCount = 0;
    await this.saveOpenNote(note);
    await this.app.vault.process(note, (content) => {
      // Moved after the check: the link would point to the new folder.
      if (originalFile.path !== originalPath) return content;
      const result = replaceImageEmbedLinks(
        content,
        outputFileName,
        (target) => this.resolveLinkTarget(target, note) === originalFile
      );
      replacementCount = result.replacementCount;
      return result.content;
    });
    return replacementCount > 0;
  }

  // Obsidian saves a note up to 2 seconds after an edit. Saving now puts a
  // fresh link on disk and spares Obsidian merging unsaved typing with the
  // plugin's change, which it reports with a notice.
  private async saveOpenNote(note: TFile): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file === note) {
        await leaf.view.save();
      }
    }
  }

  // The target comes decoded as Obsidian reads it. Obsidian itself resolves
  // "./", "../", and "/" from the note.
  private resolveLinkTarget(target: string, note: TFile): TFile | null {
    const linkPath = getLinkpath(target).replace(/\\/g, "/");
    return this.app.metadataCache.getFirstLinkpathDest(linkPath, note.path);
  }

  // The plugin has just made this file and nothing links to it, so it isn't
  // kept in trash. Never throws, so that a failed cleanup doesn't hide why it
  // was needed.
  private async removeGeneratedOutput(outputFile: TFile): Promise<void> {
    try {
      await this.app.vault.delete(outputFile);
    } catch (cleanupError: unknown) {
      console.error("Failed to remove generated image output", {
        cleanupError,
        outputPath: outputFile.path,
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

class AVIFicatorSettingTab extends PluginSettingTab {
  plugin: AVIFicatorPlugin;
  private magickCheckId = 0;
  // ImageMagick is checked when the tab opens and when the path changes, not
  // each time the tab is redrawn.
  private magickCheck: {
    path: string;
    result: ReturnType<typeof checkMagick>;
  } | null = null;
  private checkMagickLater: Debouncer<[], void> | null = null;

  constructor(app: App, plugin: AVIFicatorPlugin) {
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
              this.update();
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
          templateSetting.setErrorMessage(
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
          qualitySetting.setErrorMessage(
            quality === null ? "Enter a whole number from 0 to 100" : null
          );
          if (quality === null) return;

          this.plugin.settings.quality = quality;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl)
      .setName("Encoding speed")
      .setDesc(
        descLines(
          "Slower encoding makes files a little smaller.",
          "Default is Fast."
        )
      )
      .addDropdown((dropdown) => {
        for (const speed of ENCODING_SPEEDS) {
          dropdown.addOption(speed.toString(), ENCODING_SPEED_LABELS[speed]);
        }
        return dropdown
          .setValue(this.plugin.settings.encodingSpeed.toString())
          .onChange(async (value) => {
            const speed = Number(value);
            if (isEncodingSpeed(speed)) {
              this.plugin.settings.encodingSpeed = speed;
              await this.plugin.saveSettings();
            }
          });
      });

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
            this.update();
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
            maxSizeSetting.setErrorMessage(
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

  hide(): void {
    // Check again next time: ImageMagick may be installed or updated meanwhile.
    this.magickCheck = null;
    this.checkMagickLater?.cancel();
    super.hide();
  }

  private async showMagickStatus(
    statusEl: HTMLElement,
    formatNameEls: Map<ImageFormat, HTMLElement>,
    formatsNoteEl: HTMLElement
  ): Promise<void> {
    // Typing in the path field can start several checks; show only the last.
    const checkId = ++this.magickCheckId;
    statusEl.setText("Checking ImageMagick...");

    const path = this.plugin.settings.magickPath;
    if (this.magickCheck?.path !== path) {
      // Formats are checked whether they are on or not, so the status shows
      // what ImageMagick can do rather than what is selected.
      this.magickCheck = { path, result: checkMagick(path, CONVERTIBLE_FORMATS) };
    }
    const { status, formats } = await this.magickCheck.result;
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
