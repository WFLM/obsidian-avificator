import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_FILE_NAME_TEMPLATE,
  buildFileStem,
  filterTemplateSuggestions,
  findPartialVariable,
  findUnknownVariable,
  insertVariable,
  keepFileStem,
  sanitizeFileStem,
  templateSuggestions,
} from "./file-name";

const VALUES = {
  title: "Встреча с командой",
  original: "Pasted image 1",
  formatDate: (format: string) =>
    ({
      YYYYMMDDHHmmssSSS: "20261031143005123",
      "YYYY-MM-DD": "2026-10-31",
      "HH:mm": "14:30",
    })[format] ?? `<${format}>`,
};

const WITH_UNDERSCORES = { attempt: 0, replaceSpaces: true };
const WITH_SPACES = { attempt: 0, replaceSpaces: false };

test("sanitizes note titles for generated file names", () => {
  assert.equal(sanitizeFileStem(" Plan #1 | draft ", true), "Plan_1_draft");
  assert.equal(sanitizeFileStem(" Plan #1 | draft ", false), "Plan 1 draft");
  assert.equal(sanitizeFileStem("snake_case  name", false), "snake_case name");
  assert.equal(sanitizeFileStem("!!!", true), "Untitled");
});

test("keeps combining marks, as in Hindi or in names from macOS", () => {
  assert.equal(sanitizeFileStem("हिन्दी नोट", false), "हिन्दी नोट");
  assert.equal(sanitizeFileStem("cafe\u0301 menu", true), "cafe\u0301_menu");
});

test("drops the invisible parts of emoji along with them", () => {
  assert.equal(sanitizeFileStem("Ideas ❤️", true), "Ideas");
  assert.equal(sanitizeFileStem("Plan 1️⃣", true), "Plan_1");
});

test("cuts long titles and names to 100 bytes, between characters", () => {
  assert.equal(sanitizeFileStem("x".repeat(300), true), "x".repeat(100));
  assert.equal(sanitizeFileStem("Я".repeat(200), true), "Я".repeat(50));
  assert.equal(sanitizeFileStem(`a${"я".repeat(60)}`, true), `a${"я".repeat(49)}`);
});

test("keeps names from long titles within the 255 bytes file systems allow", () => {
  const stem = buildFileStem(
    DEFAULT_FILE_NAME_TEMPLATE,
    { ...VALUES, title: "Очень длинное название заметки ".repeat(10) },
    WITH_UNDERSCORES
  );
  assert.ok(Buffer.byteLength(`${stem}.avif`) <= 255);
});

test("builds the default name with milliseconds and a duplicate counter", () => {
  assert.equal(
    buildFileStem(DEFAULT_FILE_NAME_TEMPLATE, VALUES, WITH_UNDERSCORES),
    "Встреча_с_командой-20261031143005123000"
  );
  assert.equal(
    buildFileStem(DEFAULT_FILE_NAME_TEMPLATE, VALUES, { ...WITH_UNDERSCORES, attempt: 2 }),
    "Встреча_с_командой-20261031143005123002"
  );
});

test("keeps spaces when asked", () => {
  assert.equal(
    buildFileStem(DEFAULT_FILE_NAME_TEMPLATE, VALUES, WITH_SPACES),
    "Встреча с командой-20261031143005123000"
  );
});

test("appends a number when the template has no counter", () => {
  const template = "{date:YYYY-MM-DD} {title}";
  assert.equal(
    buildFileStem(template, VALUES, WITH_SPACES),
    "2026-10-31 Встреча с командой"
  );
  assert.equal(
    buildFileStem(template, VALUES, { ...WITH_SPACES, attempt: 1 }),
    "2026-10-31 Встреча с командой 1"
  );
  assert.equal(
    buildFileStem(template, VALUES, { ...WITH_UNDERSCORES, attempt: 1 }),
    "2026-10-31_Встреча_с_командой_1"
  );
});

test("uses the original name and YYYY-MM-DD for a date without a format", () => {
  assert.equal(
    buildFileStem("{date}-{original}", VALUES, WITH_UNDERSCORES),
    "2026-10-31-Pasted_image_1"
  );
});

test("replaces characters that can't be in file names or links", () => {
  assert.equal(
    buildFileStem("{date:HH:mm} a/b#c", VALUES, WITH_SPACES),
    "14-30 a-b-c"
  );
});

test("keeps the original name and appends a number when it is taken", () => {
  assert.equal(keepFileStem("Pasted image 1", 0), "Pasted image 1");
  assert.equal(keepFileStem("Pasted image 1", 2), "Pasted image 1 2");
});

test("falls back to Untitled for an empty name", () => {
  assert.equal(buildFileStem(" . ", VALUES, WITH_SPACES), "Untitled");
});

test("finds variables the template doesn't support", () => {
  assert.equal(findUnknownVariable("{title}-{foo}"), "{foo}");
  assert.equal(findUnknownVariable("{Title}"), "{Title}");
  assert.equal(
    findUnknownVariable("{title}{original}{date}{date:YYYY [week] WW}{counter}"),
    null
  );
});

test("takes a variable without its closing brace for an unknown one", () => {
  assert.equal(findUnknownVariable("{titl"), "{titl");
  assert.equal(findUnknownVariable("{title}-{date:YYYY"), "{date:YYYY");
  assert.equal(findUnknownVariable("{a{title}"), "{a");
});

test("finds the variable being typed before the cursor", () => {
  assert.deepEqual(findPartialVariable("{title}-{da", 11), { start: 8, query: "da" });
  assert.deepEqual(findPartialVariable("{title", 6), { start: 0, query: "title" });
  assert.deepEqual(findPartialVariable("{", 1), { start: 0, query: "" });
  assert.equal(findPartialVariable("{title}-", 8), null);
  assert.equal(findPartialVariable("{title}", 0), null);
});

test("suggests variables with date examples", () => {
  const suggestions = templateSuggestions(VALUES.formatDate);
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.variable),
    [
      "{title}",
      "{original}",
      "{counter}",
      "{date:YYYYMMDDHHmmssSSS}",
      "{date:YYYY-MM-DD}",
      "{date:YYYY-MM-DD HH-mm}",
    ]
  );
  assert.equal(suggestions[4]?.description, "2026-10-31");
});

test("filters suggestions by what is typed after the brace", () => {
  const suggestions = templateSuggestions(VALUES.formatDate);
  assert.equal(filterTemplateSuggestions(suggestions, "").length, 6);
  assert.deepEqual(
    filterTemplateSuggestions(suggestions, "DATE:yyyy-").map((s) => s.variable),
    ["{date:YYYY-MM-DD}", "{date:YYYY-MM-DD HH-mm}"]
  );
  assert.deepEqual(filterTemplateSuggestions(suggestions, "date:HH"), []);
});

test("inserts the chosen variable in place of the typed part", () => {
  assert.deepEqual(
    insertVariable("{title}-{da", { start: 8, query: "da" }, 11, "{date:YYYY-MM-DD}"),
    { value: "{title}-{date:YYYY-MM-DD}", cursor: 25 }
  );
  assert.deepEqual(
    insertVariable("{ti}-x", { start: 0, query: "ti" }, 3, "{title}"),
    { value: "{title}-x", cursor: 7 }
  );
  assert.deepEqual(
    insertVariable("{ti-{counter}", { start: 0, query: "ti" }, 3, "{title}"),
    { value: "{title}-{counter}", cursor: 7 }
  );
});
