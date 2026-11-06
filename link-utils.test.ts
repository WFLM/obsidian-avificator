import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  findImageEmbedTargets,
  isFileNameTaken,
  replaceImageEmbedLinks,
} from "./link-utils";

const matchesOriginal = (target: string): boolean =>
  target === "image.png" || target === "attachments/image.png";

void test("replaces an exact wiki embed", () => {
  const result = replaceImageEmbedLinks(
    "Before ![[image.png]] after",
    "Note-20260723.avif",
    matchesOriginal
  );

  assert.equal(result.content, "Before ![[Note-20260723.avif]] after");
  assert.equal(result.replacementCount, 1);
});

void test("preserves a wiki embed path and alias", () => {
  const result = replaceImageEmbedLinks(
    "![[attachments/image.png|300]]",
    "Note-20260723.avif",
    matchesOriginal
  );

  assert.equal(result.content, "![[attachments/Note-20260723.avif|300]]");
  assert.equal(result.replacementCount, 1);
});

// Obsidian keeps single brackets in the names of pasted and dropped files.
void test("replaces a wiki embed with a bracket in the file name", () => {
  const result = replaceImageEmbedLinks(
    "![[photo [2026].png|300]] and ![[other.png]]",
    "Note-20260723.avif",
    (target) => target === "photo [2026].png"
  );

  assert.equal(result.content, "![[Note-20260723.avif|300]] and ![[other.png]]");
  assert.equal(result.replacementCount, 1);
});

// Obsidian starts a subpath only at "#" and keeps "?" in attachment names.
void test("keeps a question mark in the file name and a heading after it", () => {
  const result = replaceImageEmbedLinks(
    "![[Why?.png]] ![](Why%3F.png) ![[Why?.png#^block]]",
    "Note-20260723.avif",
    (target) => target === "Why?.png" || target === "Why%3F.png" || target === "Why?.png#^block"
  );

  assert.equal(
    result.content,
    "![[Note-20260723.avif]] ![](Note-20260723.avif) ![[Note-20260723.avif#^block]]"
  );
  assert.equal(result.replacementCount, 3);
});

void test("preserves Markdown alt text, path, and title", () => {
  const result = replaceImageEmbedLinks(
    '![Diagram](attachments/image.png "Preview")',
    "Note (draft).avif",
    matchesOriginal
  );

  assert.equal(
    result.content,
    '![Diagram](attachments/Note%20%28draft%29.avif "Preview")'
  );
  assert.equal(result.replacementCount, 1);
});

// A backslash could be matched two ways, which made the time double with
// each one in an unclosed link.
void test("skips an unclosed Markdown link with many backslashes quickly", () => {
  const content = `![](C:${"\\a".repeat(26)} `;
  const start = Date.now();
  const result = replaceImageEmbedLinks(content, "Note-20260723.avif", () => true);

  assert.ok(Date.now() - start < 200);
  assert.equal(result.replacementCount, 0);
});

void test("finds a Markdown link target with escaped parentheses", () => {
  assert.deepEqual(
    [...findImageEmbedTargets("![](a\\(b\\).png)", () => true)],
    ["a\\(b\\).png"]
  );
});

// Obsidian leaves parentheses unencoded in the Markdown links it inserts.
void test("replaces a Markdown embed with parentheses in the file name", () => {
  const result = replaceImageEmbedLinks(
    '![](image%20(1).png) ![](a(1).png "Title")',
    "Note-20260723.avif",
    (target) => target === "image (1).png" || target === "a(1).png"
  );

  assert.equal(result.content, '![](Note-20260723.avif) ![](Note-20260723.avif "Title")');
  assert.equal(result.replacementCount, 2);
});

void test("does not replace unrelated image embeds", () => {
  const content = "![[other.png]]\n![Other](attachments/other.png)";
  const result = replaceImageEmbedLinks(
    content,
    "Note-20260723.avif",
    matchesOriginal
  );

  assert.equal(result.content, content);
  assert.equal(result.replacementCount, 0);
});

// Obsidian decodes Markdown link targets with decodeURI, keeping a target it
// can't decode as it is, and takes wiki link targets as they are.
void test("gives link targets as Obsidian reads them", () => {
  const content = "![](photo%201.png) ![[photo%201.png]] ![](100%.png) ![](<a%20b.png>)";

  assert.deepEqual(
    [...findImageEmbedTargets(content, () => true)],
    ["photo%201.png", "photo 1.png", "100%.png", "a b.png"]
  );
});

void test("finds the targets of the embeds that point to the image, each once", () => {
  const content =
    "![[ image.png |300]] ![](attachments/image.png) ![[other.png]] ![[image.png]]";

  assert.deepEqual(
    [...findImageEmbedTargets(content, matchesOriginal)],
    ["image.png", "attachments/image.png"]
  );
});

void test("a file name is taken by a file of that name in any folder, whatever the case", () => {
  assert.equal(isFileNameTaken("Meeting-000.avif", ["Work/attachments/Meeting-000.avif"]), true);
  assert.equal(isFileNameTaken("meeting-000.avif", ["Meeting-000.AVIF"]), true);
});

void test("a file name is free when only other names end with it", () => {
  assert.equal(isFileNameTaken("x.png", ["a/y.png", "a/bx.png", "x.png/z.png"]), false);
});
