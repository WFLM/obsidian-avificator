import { strict as assert } from "node:assert";
import { test } from "node:test";
import { replaceImageEmbedLinks } from "./link-utils";

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
