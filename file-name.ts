export const DEFAULT_FILE_NAME_TEMPLATE = "{title}-{date:YYYYMMDDHHmmssSSS}{counter}";

export interface FileNameValues {
  title: string;
  original: string;
  formatDate: (format: string) => string;
}

export interface FileNameOptions {
  // 0 for the first try; raised while the generated name is taken.
  attempt: number;
  replaceSpaces: boolean;
}

const VARIABLE_PATTERN = /\{([^{}]*)\}/g;
const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
// Not allowed in file names on some systems, or breaks Obsidian links.
const FORBIDDEN_CHARACTERS = /[\\/:*?"<>|#^[\]]/g;

// File systems allow names of up to 255 bytes, so long titles and names are
// cut to leave room for the rest of the template.
const MAX_VALUE_BYTES = 100;

function cutToBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  let byteCount = 0;
  for (const character of value) {
    byteCount += encoder.encode(character).length;
    if (byteCount > maxBytes) break;
    result += character;
  }
  return result;
}

export function sanitizeFileStem(value: string, replaceSpaces: boolean): string {
  const separator = replaceSpaces ? "_" : " ";
  // Sanitizing never makes the value longer.
  const sanitized = cutToBytes(value, MAX_VALUE_BYTES)
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, separator)
    .replace(replaceSpaces ? /_+/g : / +/g, separator)
    .replace(/^[._ -]+|[._ -]+$/g, "");
  return sanitized || "Untitled";
}

export function buildFileStem(
  template: string,
  values: FileNameValues,
  options: FileNameOptions
): string {
  const { attempt, replaceSpaces } = options;
  const rendered = template.replace(VARIABLE_PATTERN, (variable, name: string) => {
    if (name === "title") return sanitizeFileStem(values.title, replaceSpaces);
    if (name === "original") return sanitizeFileStem(values.original, replaceSpaces);
    if (name === "counter") return attempt.toString().padStart(3, "0");
    if (name === "date") return values.formatDate(DEFAULT_DATE_FORMAT);
    if (name.startsWith("date:")) {
      return values.formatDate(name.slice("date:".length) || DEFAULT_DATE_FORMAT);
    }
    return variable;
  });
  // Without {counter}, a taken name gets " 1", " 2", and so on.
  const suffix = attempt > 0 && !template.includes("{counter}") ? ` ${attempt}` : "";

  const stem = (rendered + suffix)
    .replace(FORBIDDEN_CHARACTERS, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return (replaceSpaces ? stem.replace(/\s+/g, "_") : stem) || "Untitled";
}

// For images converted without renaming: the same name, with " 1", " 2", and
// so on if it is taken, as when a template has no {counter}.
export function keepFileStem(stem: string, attempt: number): string {
  return attempt > 0 ? `${stem} ${attempt}` : stem;
}

export function findUnknownVariable(template: string): string | null {
  for (const [variable, name = ""] of template.matchAll(VARIABLE_PATTERN)) {
    const isKnown =
      ["title", "original", "counter", "date"].includes(name) || name.startsWith("date:");
    if (!isKnown) return variable;
  }
  return null;
}

export interface TemplateSuggestion {
  variable: string;
  description: string;
}

export interface PartialVariable {
  // Index of the opening brace.
  start: number;
  query: string;
}

const SUGGESTED_DATE_FORMATS = ["YYYYMMDDHHmmssSSS", "YYYY-MM-DD", "YYYY-MM-DD HH-mm"];

export function templateSuggestions(
  formatDate: (format: string) => string
): TemplateSuggestion[] {
  return [
    { variable: "{title}", description: "Note title" },
    { variable: "{original}", description: "Original file name" },
    {
      variable: "{counter}",
      description: "000, or 001, 002, and so on if the name is taken",
    },
    ...SUGGESTED_DATE_FORMATS.map((format) => ({
      variable: `{date:${format}}`,
      description: formatDate(format),
    })),
  ];
}

export function filterTemplateSuggestions(
  suggestions: TemplateSuggestion[],
  query: string
): TemplateSuggestion[] {
  const prefix = `{${query}`.toLowerCase();
  return suggestions.filter((suggestion) =>
    suggestion.variable.toLowerCase().startsWith(prefix)
  );
}

// The unclosed "{..." right before the cursor, if the user is typing one.
export function findPartialVariable(value: string, cursor: number): PartialVariable | null {
  if (cursor === 0) return null;
  const start = value.lastIndexOf("{", cursor - 1);
  if (start === -1) return null;

  const query = value.slice(start + 1, cursor);
  return query.includes("}") ? null : { start, query };
}

export function insertVariable(
  value: string,
  partial: PartialVariable,
  cursor: number,
  variable: string
): { value: string; cursor: number } {
  // When editing inside an existing variable, replace it up to its "}".
  const closing = value.indexOf("}", cursor);
  const nextOpening = value.indexOf("{", cursor);
  const end =
    closing !== -1 && (nextOpening === -1 || closing < nextOpening) ? closing + 1 : cursor;

  return {
    value: value.slice(0, partial.start) + variable + value.slice(end),
    cursor: partial.start + variable.length,
  };
}
