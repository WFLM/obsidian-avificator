import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isFileNameTaken, linkPathPointsTo, replaceImageEmbedLinks } from "./link-utils";

const matchesOriginal = (target: string): boolean =>
  target === "image.png" || target === "attachments/image.png";

test("replaces an exact wiki embed", () => {
  const result = replaceImageEmbedLinks(
    "Before ![[image.png]] after",
    "Note-20260723.avif",
    matchesOriginal
  );

  assert.equal(result.content, "Before ![[Note-20260723.avif]] after");
  assert.equal(result.replacementCount, 1);
});

test("preserves a wiki embed path and alias", () => {
  const result = replaceImageEmbedLinks(
    "![[attachments/image.png|300]]",
    "Note-20260723.avif",
    matchesOriginal
  );

  assert.equal(result.content, "![[attachments/Note-20260723.avif|300]]");
  assert.equal(result.replacementCount, 1);
});

test("preserves Markdown alt text, path, and title", () => {
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

test("does not replace unrelated image embeds", () => {
  const content = "![[other.png]]\n![Other](attachments/other.png)";
  const result = replaceImageEmbedLinks(
    content,
    "Note-20260723.avif",
    matchesOriginal
  );

  assert.equal(result.content, content);
  assert.equal(result.replacementCount, 0);
});

test("a link path points to a file at that vault path", () => {
  assert.equal(
    linkPathPointsTo("Projects/attachments/x.png", "Other/Note.md", "Projects/attachments/x.png", []),
    true
  );
});

test("a link path points to a file relative to the note's folder", () => {
  assert.equal(
    linkPathPointsTo("attachments/x.png", "Projects/Plan.md", "Projects/attachments/x.png", []),
    true
  );
  assert.equal(
    linkPathPointsTo("../attachments/x.png", "Projects/Plan.md", "attachments/x.png", []),
    true
  );
});

test("a bare file name or partial path points to the only file it ends", () => {
  const otherFiles = ["Notes/y.png", "Notes/attachments/x.jpg"];
  assert.equal(linkPathPointsTo("x.png", "Note.md", "Notes/attachments/x.png", otherFiles), true);
  assert.equal(
    linkPathPointsTo("attachments/x.png", "Note.md", "Notes/attachments/x.png", otherFiles),
    true
  );
});

test("a bare file name or partial path that other files end with points nowhere", () => {
  const otherFiles = ["Archive/attachments/x.png"];
  assert.equal(linkPathPointsTo("x.png", "Note.md", "Notes/attachments/x.png", otherFiles), false);
  assert.equal(
    linkPathPointsTo("attachments/x.png", "Note.md", "Notes/attachments/x.png", otherFiles),
    false
  );
});

test("a link path to another file doesn't point to the file", () => {
  assert.equal(linkPathPointsTo("y.png", "Notes/Note.md", "Notes/x.png", []), false);
  assert.equal(linkPathPointsTo("other/x.png", "Notes/Note.md", "Notes/x.png", []), false);
});

test("a file name is taken by a file of that name in any folder, whatever the case", () => {
  assert.equal(isFileNameTaken("Meeting-000.avif", ["Work/attachments/Meeting-000.avif"]), true);
  assert.equal(isFileNameTaken("meeting-000.avif", ["Meeting-000.AVIF"]), true);
});

test("a file name is free when only other names end with it", () => {
  assert.equal(isFileNameTaken("x.png", ["a/y.png", "a/bx.png", "x.png/z.png"]), false);
});
