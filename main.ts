import {
  Plugin,
  TFile,
  Notice,
  App,
  PluginSettingTab,
  Setting,
  FileSystemAdapter,
  TAbstractFile,
  getLinkpath,
} from "obsidian";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  replaceImageEmbedLinks,
  sanitizeFileStem,
  type LinkReplacementResult,
} from "./link-utils";

const execFileAsync = promisify(execFile);
const SUPPORTED_IMAGE_EXTENSIONS = /^(png|jpe?g|webp|heic)$/i;
const CONVERSION_TIMEOUT_MS = 120_000;
const LINK_RETRY_COUNT = 10;
const LINK_RETRY_DELAY_MS = 250;

interface AVIFPluginSettings {
  quality: number;
}

interface OutputTarget {
  fileName: string;
  fullPath: string;
  vaultPath: string;
}

const DEFAULT_SETTINGS: AVIFPluginSettings = {
  quality: 80,
};

function generateTimestamp(): string {
  const now = new Date();
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1, 2) +
    pad(now.getDate(), 2) +
    pad(now.getHours(), 2) +
    pad(now.getMinutes(), 2) +
    pad(now.getSeconds(), 2) +
    pad(now.getMilliseconds(), 6)
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class AVIFOnInsertPlugin extends Plugin {
  settings: AVIFPluginSettings = { ...DEFAULT_SETTINGS };
  private readonly noteQueues = new Map<string, Promise<void>>();
  private readonly reservedOutputPaths = new Set<string>();

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

  private async handleCreatedFile(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) return;
    if (!SUPPORTED_IMAGE_EXTENSIONS.test(file.extension)) return;

    const sourceNote = this.app.workspace.getActiveFile();
    if (!sourceNote || sourceNote.extension !== "md") return;

    await this.queueNoteOperation(sourceNote.path, () =>
      this.convertLinkedImage(file, sourceNote)
    );
  }

  private async convertLinkedImage(file: TFile, sourceNote: TFile): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("AVIF conversion requires a desktop file-system vault");
      return;
    }

    let outputTarget: OutputTarget | null = null;
    let linkUpdated = false;

    try {
      const isLinked = await this.waitForImageLink(sourceNote, file);
      if (!isLinked) return;

      outputTarget = await this.reserveOutputTarget(adapter, file, sourceNote);
      const inputFullPath = adapter.getFullPath(file.path);

      await execFileAsync(
        "magick",
        [
          inputFullPath,
          "-quality",
          this.settings.quality.toString(),
          outputTarget.fullPath,
        ],
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
        file,
        outputTarget.fileName
      );
      if (!linkUpdated) {
        await this.removeGeneratedOutput(adapter, outputTarget.vaultPath);
        new Notice("AVIF link was not updated; the original image was preserved");
        return;
      }

      await this.app.vault.delete(file);
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

  private async reserveOutputTarget(
    adapter: FileSystemAdapter,
    file: TFile,
    sourceNote: TFile
  ): Promise<OutputTarget> {
    const folderPath = file.path.substring(0, file.path.lastIndexOf("/") + 1);
    const noteTitle = sanitizeFileStem(sourceNote.basename);
    const baseName = `${noteTitle}-${generateTimestamp()}`;

    for (let suffix = 0; ; suffix += 1) {
      const uniqueSuffix = suffix === 0 ? "" : `-${suffix}`;
      const fileName = `${baseName}${uniqueSuffix}.avif`;
      const vaultPath = folderPath + fileName;

      if (
        !this.reservedOutputPaths.has(vaultPath) &&
        !(await adapter.exists(vaultPath))
      ) {
        this.reservedOutputPaths.add(vaultPath);
        return {
          fileName,
          fullPath: adapter.getFullPath(vaultPath),
          vaultPath,
        };
      }
    }
  }

  private async waitForImageLink(note: TFile, file: TFile): Promise<boolean> {
    for (let attempt = 0; attempt < LINK_RETRY_COUNT; attempt += 1) {
      const content = await this.app.vault.read(note);
      const result = this.replaceImageLinks(content, note, file, file.name);
      if (result.replacementCount > 0) return true;

      if (attempt < LINK_RETRY_COUNT - 1) {
        await wait(LINK_RETRY_DELAY_MS);
      }
    }
    return false;
  }

  private async replaceLinkWithRetry(
    note: TFile,
    originalFile: TFile,
    outputFileName: string
  ): Promise<boolean> {
    for (let attempt = 0; attempt < LINK_RETRY_COUNT; attempt += 1) {
      const currentContent = await this.app.vault.read(note);
      const preview = this.replaceImageLinks(
        currentContent,
        note,
        originalFile,
        outputFileName
      );

      if (preview.replacementCount > 0) {
        let replacementCount = 0;
        await this.app.vault.process(note, (latestContent) => {
          const result = this.replaceImageLinks(
            latestContent,
            note,
            originalFile,
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
    originalFile: TFile,
    outputFileName: string
  ): LinkReplacementResult {
    return replaceImageEmbedLinks(
      content,
      outputFileName,
      (target) => this.linkResolvesToFile(target, note, originalFile)
    );
  }

  private linkResolvesToFile(target: string, note: TFile, file: TFile): boolean {
    const decodedTarget = this.decodeLinkTarget(target);
    const linkPath = getLinkpath(decodedTarget)
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "");
    const destination = this.app.metadataCache.getFirstLinkpathDest(linkPath, note.path);

    if (destination) {
      return destination.path === file.path;
    }
    if (linkPath === file.path) {
      return true;
    }
    if (linkPath !== file.name) {
      return false;
    }

    const filesWithSameName = this.app.vault
      .getFiles()
      .filter((candidate) => candidate.name === file.name);
    return filesWithSameName.length === 1;
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
    const storedData: unknown = await this.loadData();
    const storedQuality =
      typeof storedData === "object" && storedData !== null && "quality" in storedData
        ? (storedData as Record<string, unknown>).quality
        : undefined;

    this.settings = {
      quality: this.validateQuality(storedQuality) ?? DEFAULT_SETTINGS.quality,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  validateQuality(value: unknown): number | null {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 100
    ) {
      return null;
    }
    return value;
  }
}

class AVIFSettingTab extends PluginSettingTab {
  plugin: AVIFOnInsertPlugin;

  constructor(app: App, plugin: AVIFOnInsertPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "AVIF Converter Settings" });

    new Setting(containerEl)
      .setName("Image Quality")
      .setDesc("Set the quality for AVIF conversion (0-100). Default is 80.")
      .addText((text) =>
        text
          .setPlaceholder("Enter quality (0-100)")
          .setValue(this.plugin.settings.quality.toString())
          .onChange(async (value) => {
            const quality =
              value.trim() === "" ? null : this.plugin.validateQuality(Number(value));
            if (quality !== null) {
              this.plugin.settings.quality = quality;
              text.inputEl.style.borderColor = "";
              await this.plugin.saveSettings();
            } else {
              text.inputEl.style.borderColor = "red";
            }
          })
      );
  }
}
