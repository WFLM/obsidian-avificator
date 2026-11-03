import { strict as assert } from "node:assert";
import { test } from "node:test";
import { InsertWindow, dropMayAddFiles, pasteMayAddFiles } from "./insert-window";

test("knows of no note before anything is pasted or dropped", () => {
  assert.equal(new InsertWindow(10_000, 60_000).notePathAt(0), null);
});

test("remembers the note for a while after a paste or drop", () => {
  const window = new InsertWindow(10_000, 60_000);
  window.open("Notes/a.md", 1_000);
  assert.equal(window.notePathAt(1_000), "Notes/a.md");
  assert.equal(window.notePathAt(10_999), "Notes/a.md");
  assert.equal(window.notePathAt(11_000), null);
});

test("follows the latest paste or drop and starts the wait over", () => {
  const window = new InsertWindow(10_000, 60_000);
  window.open("a.md", 0);
  window.open("b.md", 8_000);
  assert.equal(window.notePathAt(15_000), "b.md");
});

test("waits longer after each image, but not past the limit", () => {
  const window = new InsertWindow(10_000, 15_000);
  window.open("a.md", 0);
  window.extend(9_000);
  assert.equal(window.notePathAt(14_999), "a.md");
  assert.equal(window.notePathAt(15_000), null);
});

test("starts the limit over with each paste or drop", () => {
  const window = new InsertWindow(10_000, 15_000);
  window.open("a.md", 0);
  window.open("a.md", 12_000);
  window.extend(20_000);
  assert.equal(window.notePathAt(26_999), "a.md");
  assert.equal(window.notePathAt(27_000), null);
});

function transfer(kinds: string[], text: string, html = "") {
  const data: Record<string, string> = { "text/plain": text, "text/html": html };
  return {
    items: kinds.map((kind) => ({ kind })),
    getData: (format: string) => data[format] ?? "",
  };
}

test("a drop may add files only if it carries some", () => {
  assert.equal(dropMayAddFiles(transfer(["string", "file"], "a.png")), true);
  assert.equal(dropMayAddFiles(transfer(["string"], "some text")), false);
});

test("a paste may add files if it carries some or has no text", () => {
  assert.equal(pasteMayAddFiles(transfer(["file"], "")), true);
  assert.equal(pasteMayAddFiles(transfer(["string", "file"], "image")), true);
  // Obsidian then takes an image or a file from the system clipboard.
  assert.equal(pasteMayAddFiles(transfer([], "")), true);
  assert.equal(pasteMayAddFiles(transfer(["string"], "some text")), false);
});

// Obsidian saves PNG and JPEG images embedded in pasted or dropped HTML.
test("a paste or drop may add files if its HTML has embedded images", () => {
  const html = '<p>Chart</p><img src="data:image/png;base64,iVBORw0KGgo=">';
  assert.equal(pasteMayAddFiles(transfer(["string", "string"], "Chart", html)), true);
  assert.equal(dropMayAddFiles(transfer(["string", "string"], "Chart", html)), true);
  assert.equal(
    pasteMayAddFiles(transfer(["string", "string"], "Chart", "<p>Chart</p>")),
    false
  );
});
