import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  dropInsertsAddresses,
  parseFileUriList,
  vaultRelativePath,
} from "./dropped-files";

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

// Electron on Wayland puts the addresses of several dropped files one right
// after another.
test("reads several URIs run together without line breaks", () => {
  assert.deepEqual(
    parseFileUriList(
      "file:///home/user/Pictures/IMG_0001.jpegfile:///home/user/Pictures/IMG_0002.jpeg"
    ),
    ["/home/user/Pictures/IMG_0001.jpeg", "/home/user/Pictures/IMG_0002.jpeg"]
  );
  assert.deepEqual(parseFileUriList("file:///tmp/profile:/a.png"), ["/tmp/profile:/a.png"]);
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

const URI = "file:///home/user/Pictures/Screenshot%20from%202026.png";

test("Obsidian inserts dropped addresses as text without plain text or with other text", () => {
  assert.equal(dropInsertsAddresses(URI, ""), true);
  assert.equal(dropInsertsAddresses(URI, "Screenshot from 2026"), true);
});

test("Obsidian copies dropped files itself when the plain text is their address", () => {
  assert.equal(dropInsertsAddresses(URI, URI), false);
  assert.equal(
    dropInsertsAddresses(URI, "file:///home/user/Pictures/Screenshot from 2026.png"),
    false
  );
  assert.equal(dropInsertsAddresses(URI, URI.toUpperCase()), false);
});
