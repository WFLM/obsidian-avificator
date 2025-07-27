import { Plugin, TFile, Notice, App, PluginSettingTab, Setting } from "obsidian";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

const COMMAND_TEMPLATE = 'magick "{input_full_path}" -quality {quality} "{output_full_path}"';

interface AVIFPluginSettings {
  quality: number;
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

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class AVIFOnInsertPlugin extends Plugin {
  settings: AVIFPluginSettings;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new AVIFSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.extension.match(/^(png|jpe?g|webp|heic)$/i)) return;

        const activeNote = this.app.workspace.getActiveFile();
        if (!activeNote || activeNote.extension !== "md") return;

        const adapter = this.app.vault.adapter;
        const inputFullPath = await adapter.getFullPath(file.path);
        const folderPath = file.path.substring(0, file.path.lastIndexOf("/") + 1);

        const noteTitle = activeNote.basename.replace(/ /g, "_");
        const timestamp = generateTimestamp();
        const outputFileName = `${noteTitle}-${timestamp}.avif`;
        const outputPath = folderPath + outputFileName;
        const outputFullPath = await adapter.getFullPath(outputPath);

        const command = COMMAND_TEMPLATE
          .replace("{input_full_path}", inputFullPath)
          .replace("{output_full_path}", outputFullPath)
          .replace("{quality}", this.settings.quality.toString());

        try {
          await execAsync(command);
          await this.app.vault.delete(file);

          await this.replaceLinkWithRetry(activeNote, file.name, outputFileName);
        } catch (err) {
          console.error("❌ Error during AVIF conversion:", err);
          new Notice("❌ Error during AVIF conversion");
        }
      })
    );
  }

  async replaceLinkWithRetry(
    note: TFile,
    originalName: string,
    outputFileName: string,
    retries = 5,
    delay = 500
  ): Promise<boolean> {
    const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedOriginalName = escapeRegExp(originalName);
    const regex = new RegExp(`!\\[\\[${escapedOriginalName}\\]\\]`, "g");

    for (let i = 0; i < retries; i++) {
      let content = await this.app.vault.read(note);
      if (regex.test(content)) {
        content = content.replace(regex, `![[${outputFileName}]]`);
        await this.app.vault.modify(note, content);
        new Notice(`✅ Converted: ${outputFileName}`);
        return true;
      }
      await wait(delay);
    }
    new Notice("❌ Failed to update link after retries");
    return false;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
            const num = parseInt(value);
            if (!isNaN(num) && num >= 0 && num <= 100) {
              this.plugin.settings.quality = num;
              text.inputEl.style.borderColor = "";
              await this.plugin.saveSettings();
            } else {
              text.inputEl.style.borderColor = "red";
            }
          })
      );
  }
}
