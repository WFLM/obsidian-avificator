import {
  AbstractInputSuggest,
  Plugin,
  TFile,
  Notice,
  App,
  Menu,
  Modal,
  PluginSettingTab,
  Setting,
  FileSystemAdapter,
  TAbstractFile,
  debounce,
  getLinkpath,
  moment,
} from "obsidian";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildFileStem,
  filterTemplateSuggestions,
  findPartialVariable,
  findUnknownVariable,
  insertVariable,
  templateSuggestions,
  type FileNameValues,
  type TemplateSuggestion,
} from "./file-name";
import { replaceImageEmbedLinks, type LinkReplacementResult } from "./link-utils";
import {
  FORMAT_EXTENSIONS,
  IMAGE_FORMATS,
  formatForExtension,
  isAnimatedPng,
  type ImageFormat,
} from "./formats";
import { buildConvertArgs } from "./magick-args";
import {
  describeMagickError,
  describeMagickSupport,
  parseFormatList,
  parseFrameCount,
  type FormatSupport,
  type MagickStatus,
} from "./magick-support";
import {
  DEFAULT_SETTINGS,
  MODES,
  isAnimatedImageAction,
  isMode,
  normalizeFileNameTemplate,
  normalizeMagickPath,
  parseSettings,
  validateMaxImageSize,
  validateQuality,
  type AVIFPluginSettings,
  type AnimatedImageAction,
  type Mode,
} from "./settings";

const execFileAsync = promisify(execFile);
const CONVERSION_TIMEOUT_MS = 120_000;
const MAGICK_CHECK_TIMEOUT_MS = 10_000;
const MAGICK_CHECK_DELAY_MS = 500;
const MOMENT_FORMAT_URL = "https://momentjs.com/docs/#/displaying/format/";
const LINK_RETRY_COUNT = 10;
const LINK_RETRY_DELAY_MS = 250;

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

type MultiFrameKind = "animated" | "pages";

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

export default class AVIFOnInsertPlugin extends Plugin {
  settings: AVIFPluginSettings = { ...DEFAULT_SETTINGS };
  private readonly noteQueues = new Map<string, Promise<void>>();
  private readonly reservedOutputPaths = new Set<string>();
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

  private updateStatusBar(): void {
    this.statusBarItem?.setText(`AVIF: ${this.settings.mode}`);
  }

  private async handleCreatedFile(file: TAbstractFile): Promise<void> {
    // The mode is read when the image arrives, so switching modes doesn't
    // affect images that are already queued.
    const mode = this.settings.mode;
    if (mode === "off") return;
    if (!(file instanceof TFile)) return;
    const format = formatForExtension(file.extension);
    if (!format || !this.settings.formats[format]) return;

    const sourceNote = this.app.workspace.getActiveFile();
    if (!sourceNote || sourceNote.extension !== "md") return;

    await this.queueNoteOperation(sourceNote.path, () =>
      mode === "rename"
        ? this.renameLinkedImage(file, sourceNote)
        : this.convertLinkedImage(file, sourceNote, format)
    );
  }

  private async convertLinkedImage(
    file: TFile,
    sourceNote: TFile,
    format: ImageFormat
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("AVIF conversion requires a desktop file-system vault");
      return;
    }

    let outputTarget: OutputTarget | null = null;
    let linkUpdated = false;

    try {
      const isLinked = await this.waitForImageLink(sourceNote, file.path);
      if (!isLinked) return;

      const multiFrameKind = await this.getMultiFrameKind(adapter, file, format);
      if (multiFrameKind) {
        await this.handleMultiFrameImage(file, sourceNote, multiFrameKind);
        return;
      }

      outputTarget = await this.reserveOutputTarget(file, sourceNote, "avif");

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
        this.reservedOutputPaths.delete(outputTarget.vaultPath);
      }
    }
  }

  // AVIF keeps only the first frame visible, so animated and multi-page
  // images are never converted.
  private async getMultiFrameKind(
    adapter: FileSystemAdapter,
    file: TFile,
    format: ImageFormat
  ): Promise<MultiFrameKind | null> {
    if (format === "PNG") {
      const bytes = new Uint8Array(await this.app.vault.readBinary(file));
      return isAnimatedPng(bytes) ? "animated" : null;
    }

    try {
      const { stdout } = await execFileAsync(
        this.settings.magickPath,
        ["identify", "-ping", "-format", "%n\n", adapter.getFullPath(file.path)],
        { timeout: MAGICK_CHECK_TIMEOUT_MS, windowsHide: true }
      );
      if ((parseFrameCount(stdout) ?? 1) <= 1) return null;
    } catch (error: unknown) {
      // If ImageMagick can't read the file, the conversion fails and reports it.
      console.warn("Could not count image frames", { error, imagePath: file.path });
      return null;
    }
    return format === "TIFF" ? "pages" : "animated";
  }

  private async handleMultiFrameImage(
    file: TFile,
    sourceNote: TFile,
    kind: MultiFrameKind
  ): Promise<void> {
    let action = this.settings.animatedImageAction;
    if (action === "ask") {
      action = await askMultiFrameAction(this.app, file.name, kind);
    } else if (action === "skip") {
      new Notice(`Left as is: ${file.name} ${MULTI_FRAME_TEXT[kind].state}`);
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
      if (renamed) {
        await this.restoreOriginalNameSafely(file, originalPath);
      }

      console.error("Image rename failed", {
        error,
        imagePath: originalPath,
        notePath: sourceNote.path,
      });
      new Notice("Image rename failed; the original name was kept");
    } finally {
      if (outputTarget) {
        this.reservedOutputPaths.delete(outputTarget.vaultPath);
      }
    }
  }

  private async restoreOriginalNameSafely(file: TFile, originalPath: string): Promise<void> {
    try {
      await this.app.vault.rename(file, originalPath);
    } catch (restoreError: unknown) {
      console.error("Failed to restore the original image name", {
        restoreError,
        imagePath: file.path,
        originalPath,
      });
    }
  }

  private async reserveOutputTarget(
    file: TFile,
    sourceNote: TFile,
    extension: string
  ): Promise<OutputTarget> {
    const folderPath = file.path.substring(0, file.path.lastIndexOf("/") + 1);
    const values = fileNameValues(sourceNote.basename, file.basename, new Date());

    for (let attempt = 0; ; attempt += 1) {
      const stem = buildFileStem(this.settings.fileNameTemplate, values, {
        attempt,
        replaceSpaces: this.settings.replaceSpaces,
      });
      const fileName = `${stem}.${extension}`;
      const vaultPath = folderPath + fileName;

      if (
        !this.reservedOutputPaths.has(vaultPath) &&
        !(await this.app.vault.adapter.exists(vaultPath))
      ) {
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
    return replaceImageEmbedLinks(
      content,
      outputFileName,
      (target) => this.linkResolvesToPath(target, note, originalPath)
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
    if (linkPath === filePath) {
      return true;
    }

    const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
    if (linkPath !== fileName) {
      return false;
    }

    // A bare file name only points here if no other file shares that name.
    return !this.app.vault
      .getFiles()
      .some((candidate) => candidate.name === fileName && candidate.path !== filePath);
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

  constructor(app: App, plugin: AVIFOnInsertPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Mode")
      .setDesc("Convert new images to AVIF, only rename them, or leave them untouched.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(MODE_LABELS)
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            if (isMode(value)) {
              await this.plugin.setMode(value);
            }
          })
      );

    const templateSetting = new Setting(containerEl)
      .setName("File name template")
      .setDesc(
        createFragment((fragment) => {
          fragment.appendText(
            "Variables: {title} note title, {original} original file name, {date:FORMAT} date and time, {counter} 000, or 001, 002, and so on if the name is taken. Type { to pick one."
          );
          fragment.createEl("br");
          fragment.appendText(
            "Date format: YYYY year, MM month, DD day, HH hours, mm minutes, ss seconds, SSS milliseconds. See the "
          );
          fragment.createEl("a", { text: "format reference", href: MOMENT_FORMAT_URL });
          fragment.appendText(".");
        })
      );
    const templatePreviewEl = templateSetting.descEl.createDiv();
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
      .setDesc(
        "Use underscores instead of spaces in file names. Characters that can't be in file names or links are always replaced."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.replaceSpaces)
          .onChange(async (value) => {
            this.plugin.settings.replaceSpaces = value;
            await this.plugin.saveSettings();
            updateTemplatePreview();
          })
      );

    const qualitySetting = new Setting(containerEl)
      .setName("Image quality")
      .setDesc("Set the quality for AVIF conversion (0-100). Default is 80.");
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
        "Remove EXIF and XMP data, including GPS location and camera details, from converted images. Color profiles are kept. Works only in Convert to AVIF mode."
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
      .setDesc(
        "Shrink converted images whose longer side exceeds the maximum size, keeping their proportions. Smaller images are left as is. Works only in Convert to AVIF mode."
      )
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
        .setDesc("Longer side in pixels. Default is 2000.");
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
      .setName("Animated and multi-page images")
      .setDesc(
        "Converting them to AVIF would lose the animation or all pages but the first, so they are never converted. Choose what to do with them in Convert to AVIF mode."
      )
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
        "Command name or full path to the magick executable, e.g. /opt/homebrew/bin/magick. Default is magick."
      );
    const magickStatusEl = magickPathSetting.descEl.createDiv();
    const formatWarningEls = new Map<ImageFormat, HTMLElement>();
    const checkMagickLater = debounce(
      () => void this.showMagickStatus(magickStatusEl, formatWarningEls),
      MAGICK_CHECK_DELAY_MS,
      true
    );
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
      .setName("Image formats")
      .setDesc("Images of the selected formats are processed when you add them to a note.")
      .setHeading();
    for (const format of IMAGE_FORMATS) {
      const formatSetting = new Setting(containerEl)
        .setName(format)
        .setDesc(FORMAT_EXTENSIONS[format].map((extension) => `.${extension}`).join(", "))
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.formats[format])
            .onChange(async (value) => {
              this.plugin.settings.formats[format] = value;
              await this.plugin.saveSettings();
              // The ImageMagick status only covers the selected formats.
              checkMagickLater();
            })
        );
      formatWarningEls.set(format, formatSetting.descEl.createDiv({ cls: "mod-warning" }));
    }

    void this.showMagickStatus(magickStatusEl, formatWarningEls);
  }

  private async showMagickStatus(
    statusEl: HTMLElement,
    formatWarningEls: Map<ImageFormat, HTMLElement>
  ): Promise<void> {
    // Typing in the path field can start several checks; show only the last.
    const checkId = ++this.magickCheckId;
    statusEl.setText("Checking ImageMagick...");
    statusEl.removeClass("mod-success", "mod-warning");

    const enabledFormats = IMAGE_FORMATS.filter(
      (format) => this.plugin.settings.formats[format]
    );
    const { status, formats } = await checkMagick(
      this.plugin.settings.magickPath,
      enabledFormats
    );
    if (checkId !== this.magickCheckId) return;

    statusEl.setText(status.message);
    statusEl.addClass(status.ok ? "mod-success" : "mod-warning");

    // Without a format list (ImageMagick not found), the status says it all.
    for (const [format, warningEl] of formatWarningEls) {
      const unreadable = formats.size > 0 && !formats.get(format)?.read;
      warningEl.setText(
        unreadable
          ? "ImageMagick can't read this format, so conversion will fail. Rename only mode still works."
          : ""
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
