import { DEFAULT_FILE_NAME_TEMPLATE, findUnknownVariable } from "./file-name";
import { IMAGE_FORMATS, canConvert, type ImageFormat } from "./formats";

export const MODES = ["convert", "rename", "off"] as const;
export type Mode = (typeof MODES)[number];

// What happens to new images of a format: both, either, or neither.
export interface FormatActions {
  rename: boolean;
  convert: boolean;
}

// The AV1 encoder's speed, which ImageMagick passes on. Slower ones make files
// only a little smaller, and below 4 a photo can take minutes.
export const ENCODING_SPEEDS = [8, 6, 4] as const;
export type EncodingSpeed = (typeof ENCODING_SPEEDS)[number];

const ANIMATED_IMAGE_ACTIONS = ["ask", "rename", "skip"] as const;
export type AnimatedImageAction = (typeof ANIMATED_IMAGE_ACTIONS)[number];

export interface AVIFicatorSettings {
  mode: Mode;
  quality: number;
  encodingSpeed: EncodingSpeed;
  magickPath: string;
  stripMetadata: boolean;
  limitImageSize: boolean;
  maxImageSize: number;
  animatedImageAction: AnimatedImageAction;
  formats: Record<ImageFormat, FormatActions>;
  fileNameTemplate: string;
  replaceSpaces: boolean;
  importDroppedFileLinks: boolean;
  showStatusBar: boolean;
}

export const DEFAULT_SETTINGS: AVIFicatorSettings = {
  mode: "convert",
  quality: 80,
  encodingSpeed: 8,
  magickPath: "magick",
  stripMetadata: false,
  limitImageSize: false,
  maxImageSize: 2000,
  animatedImageAction: "ask",
  formats: allFormatActions(),
  fileNameTemplate: DEFAULT_FILE_NAME_TEMPLATE,
  replaceSpaces: true,
  importDroppedFileLinks: true,
  showStatusBar: true,
};

function allFormatActions(): Record<ImageFormat, FormatActions> {
  return Object.fromEntries(
    IMAGE_FORMATS.map((format) => [format, { rename: true, convert: canConvert(format) }])
  ) as Record<ImageFormat, FormatActions>;
}

export function isMode(value: unknown): value is Mode {
  return MODES.some((mode) => mode === value);
}

// The mode switches everything off, or conversion only, on top of the format
// actions.
export function effectiveActions(mode: Mode, actions: FormatActions): FormatActions {
  return {
    rename: mode !== "off" && actions.rename,
    convert: mode === "convert" && actions.convert,
  };
}

export function isAnimatedImageAction(value: unknown): value is AnimatedImageAction {
  return ANIMATED_IMAGE_ACTIONS.some((action) => action === value);
}

export function validateQuality(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    return null;
  }
  return value;
}

export function isEncodingSpeed(value: unknown): value is EncodingSpeed {
  return ENCODING_SPEEDS.some((speed) => speed === value);
}

export function validateMaxImageSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

// An empty template means the default one, like an empty ImageMagick path.
export function normalizeFileNameTemplate(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_SETTINGS.fileNameTemplate;
}

function parseFileNameTemplate(value: unknown): string {
  const template = normalizeFileNameTemplate(value);
  return findUnknownVariable(template) ? DEFAULT_SETTINGS.fileNameTemplate : template;
}

export function normalizeMagickPath(value: unknown): string {
  // Paths copied from a file manager, such as with "Copy as path" in Windows
  // Explorer, may come in quotes.
  const trimmed =
    typeof value === "string" ? value.trim().replace(/^(["'])(.*)\1$/, "$2").trim() : "";
  return trimmed || DEFAULT_SETTINGS.magickPath;
}

export function parseSettings(storedData: unknown): AVIFicatorSettings {
  const stored =
    typeof storedData === "object" && storedData !== null
      ? (storedData as Record<string, unknown>)
      : {};

  return {
    mode: isMode(stored.mode) ? stored.mode : DEFAULT_SETTINGS.mode,
    quality: validateQuality(stored.quality) ?? DEFAULT_SETTINGS.quality,
    encodingSpeed: isEncodingSpeed(stored.encodingSpeed)
      ? stored.encodingSpeed
      : DEFAULT_SETTINGS.encodingSpeed,
    magickPath: normalizeMagickPath(stored.magickPath),
    stripMetadata:
      typeof stored.stripMetadata === "boolean"
        ? stored.stripMetadata
        : DEFAULT_SETTINGS.stripMetadata,
    limitImageSize:
      typeof stored.limitImageSize === "boolean"
        ? stored.limitImageSize
        : DEFAULT_SETTINGS.limitImageSize,
    maxImageSize:
      validateMaxImageSize(stored.maxImageSize) ?? DEFAULT_SETTINGS.maxImageSize,
    animatedImageAction: isAnimatedImageAction(stored.animatedImageAction)
      ? stored.animatedImageAction
      : DEFAULT_SETTINGS.animatedImageAction,
    formats: parseFormats(stored.formats),
    fileNameTemplate: parseFileNameTemplate(stored.fileNameTemplate),
    replaceSpaces:
      typeof stored.replaceSpaces === "boolean"
        ? stored.replaceSpaces
        : DEFAULT_SETTINGS.replaceSpaces,
    importDroppedFileLinks:
      typeof stored.importDroppedFileLinks === "boolean"
        ? stored.importDroppedFileLinks
        : DEFAULT_SETTINGS.importDroppedFileLinks,
    showStatusBar:
      typeof stored.showStatusBar === "boolean"
        ? stored.showStatusBar
        : DEFAULT_SETTINGS.showStatusBar,
  };
}

// Formats and actions missing from stored settings, or added in newer
// versions, are on.
function parseFormats(storedFormats: unknown): Record<ImageFormat, FormatActions> {
  const formats = allFormatActions();
  if (typeof storedFormats !== "object" || storedFormats === null) return formats;

  const stored = storedFormats as Record<string, unknown>;
  for (const format of IMAGE_FORMATS) {
    const value = stored[format];
    if (typeof value === "object" && value !== null) {
      const actions = value as Record<string, unknown>;
      if (typeof actions.rename === "boolean") formats[format].rename = actions.rename;
      if (typeof actions.convert === "boolean") formats[format].convert = actions.convert;
    }
    if (!canConvert(format)) formats[format].convert = false;
  }
  return formats;
}
