import { strict as assert } from "node:assert";
import { test } from "node:test";
import { InsertWindow, dropFileCount, pasteFileCount } from "./insert-window";

void test("takes no file before anything is pasted or dropped", () => {
  assert.equal(new InsertWindow(10_000, 60_000).take(0), null);
});

function openWindow(durationMs: number, maxDurationMs: number, fileCount: number, now: number) {
  const window = new InsertWindow(durationMs, maxDurationMs);
  window.open("Notes/a.md", fileCount, now);
  return window;
}

void test("takes new files for the pasted ones for a while", () => {
  assert.equal(openWindow(10_000, 60_000, 1, 1_000).take(10_999), "Notes/a.md");
  assert.equal(openWindow(10_000, 60_000, 1, 1_000).take(11_000), null);
});

// A file sync brings in after them is left alone.
void test("takes only as many files as the paste or drop brings", () => {
  const window = new InsertWindow(10_000, 60_000);
  window.open("a.md", 2, 0);
  assert.equal(window.take(100), "a.md");
  assert.equal(window.take(200), "a.md");
  assert.equal(window.take(300), null);
});

void test("follows the latest paste or drop into another note", () => {
  const window = new InsertWindow(10_000, 60_000);
  window.open("a.md", 3, 0);
  window.open("b.md", 1, 8_000);
  assert.equal(window.take(15_000), "b.md");
  assert.equal(window.take(15_100), null);
});

// The files of the first one may still be on their way.
void test("adds the files of another paste or drop into the same note", () => {
  const window = new InsertWindow(10_000, 60_000);
  window.open("a.md", 2, 0);
  assert.equal(window.take(100), "a.md");
  window.open("a.md", 1, 200);
  assert.equal(window.take(300), "a.md");
  assert.equal(window.take(400), "a.md");
  assert.equal(window.take(500), null);
});

void test("doesn't add the files of a paste or drop that has ended", () => {
  const window = new InsertWindow(10_000, 60_000);
  window.open("a.md", 2, 0);
  window.open("a.md", 1, 10_000);
  assert.equal(window.take(10_100), "a.md");
  assert.equal(window.take(10_200), null);
});

void test("waits longer after each file, but not past the limit", () => {
  for (const [now, notePath] of [[14_999, "Notes/a.md"], [15_000, null]] as const) {
    const window = openWindow(10_000, 15_000, 3, 0);
    assert.equal(window.take(9_000), "Notes/a.md");
    assert.equal(window.take(now), notePath);
  }
});

void test("starts the limit over with each paste or drop", () => {
  for (const [now, notePath] of [[26_999, "Notes/a.md"], [27_000, null]] as const) {
    const window = openWindow(10_000, 15_000, 1, 0);
    window.open("Notes/a.md", 2, 12_000);
    assert.equal(window.take(20_000), "Notes/a.md");
    assert.equal(window.take(now), notePath);
  }
});

function transfer(kinds: string[], text: string, html = "") {
  const data: Record<string, string> = { "text/plain": text, "text/html": html };
  return {
    items: kinds.map((kind) => ({ kind })),
    getData: (format: string) => data[format] ?? "",
  };
}

void test("a drop adds the files it carries", () => {
  assert.equal(dropFileCount(transfer(["string", "file", "file"], "a.png")), 2);
  assert.equal(dropFileCount(transfer(["string"], "some text")), 0);
});

void test("a paste adds the files it carries, or one if it has no text", () => {
  assert.equal(pasteFileCount(transfer(["file"], "")), 1);
  assert.equal(pasteFileCount(transfer(["string", "file", "file"], "image")), 2);
  // Obsidian then takes one image or file from the system clipboard.
  assert.equal(pasteFileCount(transfer([], "")), 1);
  assert.equal(pasteFileCount(transfer(["string"], "some text")), 0);
});

void test("a paste or drop adds the images embedded in its HTML", () => {
  const html =
    '<p>Chart</p><img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/jpeg;base64,/9j/">';
  assert.equal(pasteFileCount(transfer(["string", "string"], "Chart", html)), 2);
  assert.equal(dropFileCount(transfer(["string", "string"], "Chart", html)), 2);
  assert.equal(pasteFileCount(transfer(["string", "string"], "Chart", "<p>Chart</p>")), 0);
});
