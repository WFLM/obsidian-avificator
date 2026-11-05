import {
  EditorState,
  type ChangeSpec,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";

// Obsidian inserts every pasted or dropped file but the last as an embed and a
// blank line.
const EMBED_AND_BLANK_LINE = /^!\[[^\n]+\n\n$/;
const QUOTE_MARKS = /^[ \t]*(?:>[ \t]?)+/;

// In a quote or callout, that blank line and the next one get the quote's ">"
// marks, so that the following images stay inside it.
export const keepEmbedsInQuotes = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    if (!tr.docChanged) return tr;
    const changed: { from: number; end: number; inserted: string }[] = [];
    tr.changes.iterChanges((fromA, _toA, _fromB, toB, inserted) => {
      changed.push({ from: fromA, end: toB, inserted: inserted.toString() });
    });
    const [only] = changed;
    if (changed.length !== 1 || !only || !EMBED_AND_BLANK_LINE.test(only.inserted)) return tr;

    const line = tr.startState.doc.lineAt(only.from);
    const quote = QUOTE_MARKS.exec(line.text)?.[0];
    // An embed put before the marks isn't in the quote.
    if (!quote || only.from - line.from < quote.length) return tr;

    const bareQuote = quote.trimEnd();
    const changes: ChangeSpec[] = [
      { from: only.end - 1, insert: bareQuote },
      { from: only.end, insert: quote },
    ];
    // The next file goes where the cursor is, which is after the inserted text.
    const selection = tr.newSelection.main;
    const cursorAfter = selection.empty && selection.head === only.end;
    return [
      tr,
      {
        changes,
        sequential: true,
        selection: cursorAfter
          ? { anchor: only.end + bareQuote.length + quote.length }
          : undefined,
      },
    ];
  }
);
