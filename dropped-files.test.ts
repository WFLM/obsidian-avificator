import { strict as assert } from "node:assert";
import { test } from "node:test";
import { noteClosedMessage, parseFileUriList, vaultRelativePath } from "./dropped-files";

test("turns dropped file URIs into paths", () => {
  assert.deepEqual(
    parseFileUriList(
      "file:///home/user/Pictures/Screenshot%20from%202026.png\r\n"
    ),
    ["/home/user/Pictures/Screenshot from 2026.png"]
  );
});

test("reads several URIs and skips comments and blank lines", () => {
  assert.deepEqual(
    parseFileUriList("# dropped from Files\r\nfile:///tmp/a.png\r\n\r\nfile:///tmp/b%23c.jpg"),
    ["/tmp/a.png", "/tmp/b#c.jpg"]
  );
});

test("rejects lists with anything but file URIs", () => {
  assert.equal(parseFileUriList("file:///tmp/a.png\nhttps://example.com/b.png"), null);
  assert.equal(parseFileUriList("not a uri"), null);
  assert.equal(parseFileUriList(""), null);
});

test("finds the vault path of a file inside the vault", () => {
  assert.equal(vaultRelativePath("/vault", "/vault/Images/a.png"), "Images/a.png");
  assert.equal(vaultRelativePath("/vault/", "/vault/a.png"), "a.png");
});

test("treats files outside the vault as outside", () => {
  assert.equal(vaultRelativePath("/vault", "/home/user/a.png"), null);
  assert.equal(vaultRelativePath("/vault", "/vault2/a.png"), null);
  assert.equal(vaultRelativePath("/vault", "/vault"), null);
});

test("says which dropped image wasn't linked when the note was closed", () => {
  assert.equal(noteClosedMessage("Plan", "a.png", 0), "Plan is no longer open, so a.png wasn't linked");
});

test("also counts the dropped images that weren't copied", () => {
  assert.equal(
    noteClosedMessage("Plan", "a.png", 1),
    "Plan is no longer open, so a.png wasn't linked, and 1 more image wasn't copied"
  );
  assert.equal(
    noteClosedMessage("Plan", "a.png", 3),
    "Plan is no longer open, so a.png wasn't linked, and 3 more images weren't copied"
  );
});
