import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import type { App, DataWriteOptions, PluginManifest, TFile } from "obsidian";
import type AVIFicatorPlugin from "./main";
import type { InsertWindow } from "./insert-window";

class TestFile {
  readonly stat = { ctime: 1000, mtime: 2000, size: 3 };

  constructor(public path: string) {}

  get name(): string {
    return posix.basename(this.path);
  }

  get extension(): string {
    return posix.extname(this.path).slice(1);
  }

  get basename(): string {
    return this.name.slice(0, -(this.extension.length + 1));
  }
}

class TestAdapter {
  getBasePath(): string {
    return "/vault";
  }

  getFullPath(path: string): string {
    return join(this.getBasePath(), path);
  }
}

interface PluginUnderTest {
  insertWindow: InsertWindow;
  handleCreatedFile(file: TFile): Promise<void>;
  importDroppedImages(
    filePaths: string[],
    editor: object,
    info: { file: TFile },
    note: TFile
  ): Promise<void>;
  importDroppedImage(
    adapter: TestAdapter,
    filePath: string,
    info: { file: TFile },
    note: TFile
  ): Promise<TFile | null>;
  settings: { fileNameTemplate: string; replaceSpaces: boolean };
  handleEditorDrop(evt: object, editor: object, info: { file: TFile }): void;
  renameLinkedImage(file: TFile, note: TFile): Promise<void>;
  convertLinkedImage(file: TFile, note: TFile, format: "PNG", rename: boolean): Promise<void>;
  reserveOutputTarget(
    file?: TFile,
    note?: TFile,
    extension?: string
  ): Promise<{ fileName: string; vaultPath: string }>;
  findConversionObstacle(): Promise<null>;
  createAvif(inputPath: string, vaultPath: string): Promise<TFile>;
}

function file(path: string): TFile {
  return new TestFile(path) as unknown as TFile;
}

// Obsidian supplies these classes at runtime; Node tests use a scoped stub.
// Other modules can be replaced too.
function createPlugin(app: object, modules: Record<string, unknown> = {}): PluginUnderTest {
  const pluginModule = { exports: {} as { default: typeof AVIFicatorPlugin } };
  const obsidian = {
    Plugin: class {
      constructor(public app: App) {}
    },
    TFile: TestFile,
    FileSystemAdapter: TestAdapter,
    MarkdownView: class {},
    Modal: class {},
    Notice: class {},
    PluginSettingTab: class {},
    AbstractInputSuggest: class {},
    getLinkpath: (target: string): string => target.split("#")[0] ?? "",
    Platform: { isMacOS: false },
    // As Obsidian's own.
    normalizePath: (path: string): string =>
      path
        .replace(/([\\/])+/g, "/")
        .replace(/(^\/+|\/+$)/g, "")
        .replace(/\u00A0|\u202F/g, " ")
        .normalize("NFC"),
  };
  runInNewContext(readFileSync(join(__dirname, "main.js"), "utf8"), {
    module: pluginModule,
    exports: pluginModule.exports,
    require: (id: string): unknown =>
      id === "obsidian" ? obsidian : id in modules ? modules[id] : require(id),
    console,
    // Obsidian's global sleep().
    sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const plugin = new pluginModule.exports.default(app as App, {} as PluginManifest);
  return plugin as unknown as PluginUnderTest;
}

async function sourceImage(context: TestContext, name = "image.png"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "avificator-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  await writeFile(path, "source image");
  return path;
}

function createImageFixture(outputName = "renamed.png") {
  const note = file("note.md");
  const image = file("attachments/image.png");
  const output = file(`attachments/${outputName}`);
  const bytes = Uint8Array.from([1, 2, 3]).buffer;
  const files = new Map([[image.path, { file: image, data: bytes }]]);
  const deleted: TFile[] = [];
  const state = {
    content: "![[image.png]]",
    diskStat: { ...image.stat, type: "file" },
  };
  const resolvedLinks: Record<string, Record<string, number>> = {
    [note.path]: { [image.path]: 1 },
  };
  const vault = {
    adapter: Object.assign(new TestAdapter(), {
      stat: async () => ({ ...state.diskStat }),
    }),
    read: async (): Promise<string> => state.content,
    readBinary: async (source: TFile): Promise<ArrayBuffer> => {
      const stored = files.get(source.path);
      assert.ok(stored);
      return stored.data;
    },
    createBinary: async (
      path: string, data: ArrayBuffer, options?: DataWriteOptions
    ): Promise<TFile> => {
      if (files.has(path)) throw new Error("File already exists");
      assert.equal(path, output.path);
      output.stat.ctime = options?.ctime ?? output.stat.ctime;
      output.stat.mtime = options?.mtime ?? output.stat.mtime;
      files.set(path, { file: output, data });
      return output;
    },
    process: async (_note: TFile, transform: (value: string) => string): Promise<void> => {
      state.content = transform(state.content);
    },
    delete: async (original: TFile): Promise<void> => {
      assert.equal(files.get(original.path)?.file, original);
      files.delete(original.path);
      deleted.push(original);
    },
  };
  const plugin = createPlugin({
    vault,
    workspace: { getLeavesOfType: (): never[] => [] },
    metadataCache: {
      getFirstLinkpathDest: (target: string): TFile | null =>
        files.get(target)?.file ??
        [...files.values()].find((stored) => stored.file.name === target)?.file ?? null,
      resolvedLinks,
    },
  });
  plugin.reserveOutputTarget = async () => ({
    fileName: output.name, vaultPath: output.path,
  });
  return { note, image, output, bytes, files, deleted, state, resolvedLinks, vault, plugin };
}

void test("a canceled import preserves a later note's insertion window", async (context) => {
  const sourcePath = await sourceImage(context);
  const note = file("a.md");
  const nextNote = file("b.md");
  const info = { file: note };
  const adapter = new TestAdapter();
  const created: string[] = [];
  const deleted: TFile[] = [];
  const now = Date.now();
  const plugin = createPlugin({
    vault: {
      createBinary: async (path: string): Promise<TFile> => {
        created.push(path);
        return file(path);
      },
      delete: async (copy: TFile): Promise<void> => { deleted.push(copy); },
    },
    fileManager: {
      getAvailablePathForAttachment: async (): Promise<string> => {
        info.file = nextNote;
        plugin.insertWindow.open(nextNote.path, 1, now);
        return "attachments/image.png";
      },
    },
  });

  const result = await plugin.importDroppedImage(adapter, sourcePath, info, note);

  assert.equal(result, null);
  assert.equal(plugin.insertWindow.take(now), nextNote.path);
  assert.deepEqual(created, []);
  assert.deepEqual(deleted, []);
});

void test("switching notes during a copy removes only the newly created image", async (context) => {
  const sourcePath = await sourceImage(context);
  const note = file("a.md");
  const info = { file: note };
  const adapter = new TestAdapter();
  const copy = file("attachments/image.png");
  const deleted: TFile[] = [];
  const plugin = createPlugin({
    vault: {
      createBinary: async (): Promise<TFile> => {
        info.file = file("b.md");
        return copy;
      },
      delete: async (image: TFile): Promise<void> => { deleted.push(image); },
    },
    fileManager: {
      getAvailablePathForAttachment: async (): Promise<string> => copy.path,
    },
  });

  const result = await plugin.importDroppedImage(adapter, sourcePath, info, note);

  assert.equal(result, null);
  assert.deepEqual(deleted, [copy]);
  assert.equal(readFileSync(sourcePath, "utf8"), "source image");
});

// keepEmbedsInQuotes then keeps them in a quote, as it does with Obsidian's.
void test("dropped images are inserted as Obsidian inserts files", async (context) => {
  const sourcePaths = [
    await sourceImage(context, "a.png"),
    await sourceImage(context, "b.png"),
  ];
  const note = file("note.md");
  const info = { file: note };
  const inserted: string[] = [];
  const editor = {
    replaceSelection: (text: string): void => {
      inserted.push(text);
    },
  };
  const plugin = createPlugin({
    vault: {
      adapter: new TestAdapter(),
      createBinary: async (path: string): Promise<TFile> => file(path),
    },
    fileManager: {
      getAvailablePathForAttachment: async (name: string): Promise<string> =>
        `attachments/${name}`,
      generateMarkdownLink: (image: TFile): string => `[[${image.name}]]`,
    },
  });

  await plugin.importDroppedImages(sourcePaths, editor, info, note);

  assert.deepEqual(inserted, ["![[a.png]]\n\n", "![[b.png]]"]);
});

for (const target of ["image.png", "attachments/image.png"]) {
  void test(`renaming preserves a new image's link using ${target}`, async () => {
    const { note, image, output, bytes, files, state, vault, plugin } = createImageFixture();
    const originalPath = image.path;
    const replacement = file(originalPath);
    const { createBinary, delete: remove } = vault;
    vault.createBinary = async (path, data, options) => {
      assert.deepEqual(data, bytes);
      assert.equal(options?.ctime, image.stat.ctime);
      assert.equal(options?.mtime, image.stat.mtime);
      const copy = await createBinary(path, data, options);
      state.content += "\n![[attachments/image.png]]";
      return copy;
    };
    vault.delete = async (original) => {
      await remove(original);
      if (original === image) {
        files.set(originalPath, { file: replacement, data: bytes });
        state.content += `\n![[${target}]]`;
      }
    };

    await plugin.renameLinkedImage(image, note);

    assert.equal(state.content, `![[renamed.png]]\n![[attachments/renamed.png]]\n![[${target}]]`);
    assert.equal(files.get(originalPath)?.file, replacement);
    assert.equal(files.get(output.path)?.file, output);
  });
}

for (const failure of ["copy", "links", "missing-link", "unlink"] as const) {
  void test(`renaming preserves image data when ${failure} fails`, async (context) => {
    context.mock.method(console, "error", (): void => undefined);
    const { note, image, output, bytes, files, deleted, state, vault, plugin } = createImageFixture();
    const existingOutput = file(output.path);
    if (failure === "copy") files.set(output.path, { file: existingOutput, data: bytes });
    const { createBinary, process, delete: remove } = vault;
    vault.createBinary = async (...args) => {
      assert.deepEqual(args[1], bytes);
      const copy = await createBinary(...args);
      if (failure === "missing-link") state.content = "The embed was removed";
      return copy;
    };
    vault.process = async (...args) => {
      if (failure === "links") throw new Error("Could not save the note");
      await process(...args);
    };
    vault.delete = async (original) => {
      if (original === image && failure === "unlink") {
        throw new Error("Could not remove the original");
      }
      await remove(original);
    };

    await plugin.renameLinkedImage(image, note);

    assert.equal(files.get(image.path)?.file, image);
    if (failure === "copy") {
      assert.equal(files.get(output.path)?.file, existingOutput);
      assert.equal(state.content, "![[image.png]]");
      assert.deepEqual(deleted, []);
    } else if (failure === "unlink") {
      assert.equal(files.get(output.path)?.file, output);
      assert.equal(state.content, "![[renamed.png]]");
      assert.deepEqual(deleted, []);
    } else {
      assert.equal(files.has(output.path), false);
      assert.equal(state.content, failure === "links" ? "![[image.png]]" : "The embed was removed");
      assert.deepEqual(deleted, [output]);
    }
  });
}

void test("conversion updates links added while creating the AVIF before deleting the image", async () => {
  const { note, image, output, deleted, state, vault, plugin } = createImageFixture("output.avif");
  const { delete: remove } = vault;
  vault.delete = async (original) => {
    assert.equal(state.content, "![[output.avif]]\n![[attachments/output.avif]]");
    await remove(original);
  };
  plugin.findConversionObstacle = async () => null;
  plugin.createAvif = async () => {
    state.content += "\n![[attachments/image.png]]";
    return output;
  };

  await plugin.convertLinkedImage(image, note, "PNG", true);

  assert.equal(state.content, "![[output.avif]]\n![[attachments/output.avif]]");
  assert.deepEqual(deleted, [image]);
});

void test("conversion adds ImageMagick's output to the vault byte for byte", async () => {
  // Bytes that reading the output as text would change.
  const avif = Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a]);
  const calls: { args: string[]; options: { encoding?: string; maxBuffer?: number } }[] = [];
  const execFile = Object.assign(
    (): never => {
      throw new Error("Only the promisified execFile is expected");
    },
    {
      [promisify.custom]: async (
        _file: string,
        args: string[],
        options: { encoding?: string; maxBuffer?: number }
      ) => {
        calls.push({ args, options });
        return { stdout: avif, stderr: Buffer.alloc(0) };
      },
    }
  );
  const output = file("attachments/output.avif");
  let created: number[] = [];
  const plugin = createPlugin(
    {
      vault: {
        createBinary: async (path: string, data: ArrayBuffer): Promise<TFile> => {
          assert.equal(path, output.path);
          created = [...new Uint8Array(data)];
          return output;
        },
      },
    },
    { "node:child_process": { execFile } }
  );

  const result = await plugin.createAvif("/vault/attachments/image.png", output.path);

  assert.equal(result, output);
  assert.deepEqual(created, [...avif]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args.slice(-1), ["avif:-"]);
  assert.equal(calls[0]?.options.encoding, "buffer");
  assert.equal(calls[0]?.options.maxBuffer, Infinity);
});

function createPastePlugin() {
  const note = file("note.md");
  const processed: string[] = [];
  const plugin = createPlugin({
    vault: { getFileByPath: (path: string): TFile | null => (path === note.path ? note : null) },
  });
  plugin.convertLinkedImage = async (image) => {
    processed.push(image.path);
  };
  plugin.insertWindow.open(note.path, 1, Date.now());
  return { plugin, processed };
}

// Sync may bring an image already linked in the note right after a paste.
void test("only as many new images as a paste brings are processed", async () => {
  const { plugin, processed } = createPastePlugin();

  await plugin.handleCreatedFile(file("attachments/Pasted image.png"));
  await plugin.handleCreatedFile(file("attachments/synced.png"));

  assert.deepEqual(processed, ["attachments/Pasted image.png"]);
});

void test("a note sync brings right after a paste doesn't take the image's place", async () => {
  const { plugin, processed } = createPastePlugin();

  await plugin.handleCreatedFile(file("Synced note.md"));
  await plugin.handleCreatedFile(file("attachments/Pasted image.png"));

  assert.deepEqual(processed, ["attachments/Pasted image.png"]);
});

// Obsidian then adds no files, though the drop carries some.
void test("a drop another plugin has handled leaves new images alone", () => {
  const note = file("note.md");
  const plugin = createPlugin({});
  const drop = (defaultPrevented: boolean) => ({
    defaultPrevented,
    ctrlKey: false,
    altKey: false,
    dataTransfer: { items: [{ kind: "file" }], getData: (): string => "" },
  });

  plugin.handleEditorDrop(drop(true), {}, { file: note });
  assert.equal(plugin.insertWindow.take(Date.now()), null);
  plugin.handleEditorDrop(drop(false), {}, { file: note });
  assert.equal(plugin.insertWindow.take(Date.now()), note.path);
});

// A template may have a no-break space, or a letter and its accent typed apart.
void test("output names have the spaces and letters the vault saves them with", async () => {
  const plugin = createPlugin({
    vault: { adapter: { exists: async (): Promise<boolean> => false } },
    metadataCache: { getFirstLinkpathDest: (): TFile | null => null },
  });
  plugin.settings.fileNameTemplate = "Cafe\u0301\u00A0{counter}";
  plugin.settings.replaceSpaces = false;

  const target = await plugin.reserveOutputTarget(
    file("attachments/image.png"),
    file("note.md"),
    "avif"
  );

  assert.equal(target.fileName, "Caf\u00E9 000.avif");
  assert.equal(target.vaultPath, "attachments/Caf\u00E9 000.avif");
});

// A link by name alone would resolve to the other file, whatever its folder or
// case.
void test("output names skip names other files in the vault have", async () => {
  const taken = file("Work/SHOT 000.avif");
  const plugin = createPlugin({
    vault: { adapter: { exists: async (): Promise<boolean> => false } },
    metadataCache: {
      // As Obsidian resolves a link that is only a name.
      getFirstLinkpathDest: (linkpath: string): TFile | null =>
        linkpath.toLowerCase() === taken.name.toLowerCase() ? taken : null,
    },
  });
  plugin.settings.fileNameTemplate = "Shot {counter}";
  plugin.settings.replaceSpaces = false;

  const target = await plugin.reserveOutputTarget(
    file("attachments/image.png"),
    file("note.md"),
    "avif"
  );

  assert.equal(target.vaultPath, "attachments/Shot 001.avif");
});

for (const action of ["renaming", "conversion"] as const) {
  const run = (fixture: ReturnType<typeof createImageFixture>): Promise<void> =>
    action === "renaming"
      ? fixture.plugin.renameLinkedImage(fixture.image, fixture.note)
      : fixture.plugin.convertLinkedImage(fixture.image, fixture.note, "PNG", true);
  const outputName = action === "renaming" ? "renamed.png" : "output.avif";
  const prepare = (fixture: ReturnType<typeof createImageFixture>): void => {
    fixture.plugin.findConversionObstacle = async () => null;
    fixture.plugin.createAvif = async (_inputPath, vaultPath) => {
      fixture.files.set(vaultPath, { file: fixture.output, data: fixture.bytes });
      return fixture.output;
    };
  };

  // Such an image came some other way, for example with sync.
  void test(`${action} leaves alone an image other notes link to`, async () => {
    const fixture = createImageFixture(outputName);
    prepare(fixture);
    fixture.resolvedLinks["other.md"] = { [fixture.image.path]: 1 };

    await run(fixture);

    assert.equal(fixture.state.content, "![[image.png]]");
    assert.equal(fixture.files.has(fixture.output.path), false);
    assert.deepEqual(fixture.deleted, []);
  });

  const otherLinks = {
    "a wiki link": "[[image.png]]",
    "a Markdown link": "[Download](image.png)",
    "a property": '---\ncover: "[[image.png]]"\n---',
  };
  for (const [kind, link] of Object.entries(otherLinks)) {
    void test(`${action} keeps the original the note also links to with ${kind}`, async () => {
      const fixture = createImageFixture(outputName);
      prepare(fixture);
      fixture.state.content = `${link}\n![[image.png]]`;

      await run(fixture);

      assert.equal(fixture.state.content, `${link}\n![[${outputName}]]`);
      assert.equal(fixture.files.get(fixture.image.path)?.file, fixture.image);
      assert.equal(fixture.files.get(fixture.output.path)?.file, fixture.output);
      assert.deepEqual(fixture.deleted, []);
    });
  }

  void test(`${action} keeps the original if another note links to it meanwhile`, async () => {
    const fixture = createImageFixture(outputName);
    prepare(fixture);
    const { process } = fixture.vault;
    fixture.vault.process = async (...args) => {
      await process(...args);
      fixture.resolvedLinks["other.md"] = { [fixture.image.path]: 1 };
    };

    await run(fixture);

    assert.equal(fixture.state.content, `![[${outputName}]]`);
    assert.equal(fixture.files.get(fixture.image.path)?.file, fixture.image);
    assert.equal(fixture.files.get(fixture.output.path)?.file, fixture.output);
    assert.deepEqual(fixture.deleted, []);
  });

  // Runs the change once the copy or the AVIF is made.
  const afterCopy = (fixture: ReturnType<typeof createImageFixture>, change: () => void): void => {
    if (action === "renaming") {
      const { createBinary } = fixture.vault;
      fixture.vault.createBinary = async (...args) => {
        const copy = await createBinary(...args);
        change();
        return copy;
      };
    } else {
      const createAvif = fixture.plugin.createAvif.bind(fixture.plugin);
      fixture.plugin.createAvif = async (...args) => {
        const avif = await createAvif(...args);
        change();
        return avif;
      };
    }
  };
  const editedBytes = Uint8Array.from([4, 5, 6]).buffer;
  const editImage = (fixture: ReturnType<typeof createImageFixture>): void => {
    fixture.files.set(fixture.image.path, { file: fixture.image, data: editedBytes });
    // A same-size external edit may not have reached Obsidian's cache yet.
    fixture.state.diskStat.mtime += 100;
  };

  // Encoding at a slow speed takes long enough to edit the image meanwhile.
  void test(`${action} leaves an image edited meanwhile as it is`, async () => {
    const fixture = createImageFixture(outputName);
    prepare(fixture);
    afterCopy(fixture, () => editImage(fixture));

    await run(fixture);

    assert.equal(fixture.state.content, "![[image.png]]");
    assert.deepEqual(fixture.files.get(fixture.image.path)?.data, editedBytes);
    assert.equal(fixture.files.has(fixture.output.path), false);
    assert.deepEqual(fixture.deleted, [fixture.output]);
  });

  // Obsidian updates the link to the new path, and the output is in the old
  // folder.
  for (const moment of ["while the copy is made", "right before the note is updated"]) {
    void test(`${action} leaves an image moved ${moment} as it is`, async (context) => {
      context.mock.method(console, "error", (): void => undefined);
      const fixture = createImageFixture(outputName);
      prepare(fixture);
      const { files, image, bytes, state, vault } = fixture;
      const moveImage = (): void => {
        files.delete(image.path);
        image.path = "moved/image.png";
        files.set(image.path, { file: image, data: bytes });
        state.content = "![[moved/image.png]]";
      };
      if (moment === "while the copy is made") {
        afterCopy(fixture, moveImage);
      } else {
        const { process } = vault;
        vault.process = async (...args) => {
          moveImage();
          await process(...args);
        };
      }

      await run(fixture);

      assert.equal(state.content, "![[moved/image.png]]");
      assert.equal(files.get("moved/image.png")?.file, image);
      assert.equal(files.has(fixture.output.path), false);
      assert.deepEqual(fixture.deleted, [fixture.output]);
    });
  }

  void test(`${action} keeps the original edited while the note is updated`, async () => {
    const fixture = createImageFixture(outputName);
    prepare(fixture);
    const { process } = fixture.vault;
    fixture.vault.process = async (...args) => {
      await process(...args);
      editImage(fixture);
    };

    await run(fixture);

    assert.equal(fixture.state.content, `![[${outputName}]]`);
    assert.deepEqual(fixture.files.get(fixture.image.path)?.data, editedBytes);
    assert.equal(fixture.files.get(fixture.output.path)?.file, fixture.output);
    assert.deepEqual(fixture.deleted, []);
  });
}
