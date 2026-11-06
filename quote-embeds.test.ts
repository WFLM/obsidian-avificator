import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { keepEmbedsInQuotes } from "./quote-embeds";

// Inserts each text at the cursor, as Obsidian does with every pasted or
// dropped file.
function insert(doc: string, cursor: number, ...texts: string[]): { doc: string; cursor: number } {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: keepEmbedsInQuotes,
  });
  for (const text of texts) {
    state = state.update(state.replaceSelection(text)).state;
  }
  return { doc: state.doc.toString(), cursor: state.selection.main.head };
}

const CALLOUT = "> [!info]- photo\n> ";

void test("keeps every pasted image inside a callout", () => {
  const result = insert(CALLOUT, CALLOUT.length, "![[a.png]]\n\n", "![[b.png]]\n\n", "![[c.png]]");
  assert.equal(
    result.doc,
    "> [!info]- photo\n> ![[a.png]]\n>\n> ![[b.png]]\n>\n> ![[c.png]]"
  );
  assert.equal(result.cursor, result.doc.length);
});

void test("keeps Markdown image links inside nested and indented quotes", () => {
  assert.equal(
    insert("> > ", 4, "![](a%20b.png)\n\n", "![](c.png)").doc,
    "> > ![](a%20b.png)\n> >\n> > ![](c.png)"
  );
  assert.equal(
    insert("  > ", 4, "![[a.png]]\n\n", "![[b.png]]").doc,
    "  > ![[a.png]]\n  >\n  > ![[b.png]]"
  );
});

void test("moves text after the cursor to the next quoted line", () => {
  assert.equal(
    insert("> before after", 9, "![[a.png]]\n\n").doc,
    "> before ![[a.png]]\n>\n> after"
  );
});

void test("leaves insertions outside quotes as Obsidian makes them", () => {
  assert.equal(insert("", 0, "![[a.png]]\n\n", "![[b.png]]").doc, "![[a.png]]\n\n![[b.png]]");
  assert.equal(insert("- item ", 7, "![[a.png]]\n\n").doc, "- item ![[a.png]]\n\n");
});

void test("leaves other text, and images put before the quote marks, as they are", () => {
  assert.equal(insert("> ", 2, "Some text\n\n").doc, "> Some text\n\n");
  assert.equal(insert("> ", 0, "![[a.png]]\n\n").doc, "![[a.png]]\n\n> ");
});
