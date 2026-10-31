import { strict as assert } from "node:assert";
import { test } from "node:test";
import { InsertWindow } from "./insert-window";

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
