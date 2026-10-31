require("esbuild").build({
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: "main.js",
  platform: "node",
  target: ["es2020"],
  // Obsidian provides these at runtime; a bundled copy of CodeMirror wouldn't
  // recognize Obsidian's editors.
  external: ["obsidian", "@codemirror/state", "@codemirror/view"],
}).catch(() => process.exit(1));
