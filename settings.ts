import { DEFAULT_FILE_NAME_TEMPLATE, findUnknownVariable } from "./file-name";
import { IMAGE_FORMATS, type ImageFormat } from "./formats";

export const MODES = ["convert", "rename", "off"] as const;
export type Mode = (typeof MODES)[number];

export const ANIMATED_IMAGE_ACTIONS = ["ask", "rename", "skip"] as const;
export type AnimatedImageAction = (typeof ANIMATED_IMAGE_ACTIONS)[number];

export interface AVIFPluginSettings {
  mode: Mode;
  quality: number;
  magickPath: string;
  stripMetadata: boolean;
  limitImageSize: boolean;
  maxImageSize: number;
  animatedImageAction: AnimatedImageAction;
  formats: Record<ImageFormat, boolean>;
  fileNameTemplate: string;
  replaceSpaces: boolean;
}

export const DEFAULT_SETTINGS: AVIFPluginSettings = {
  mode: "convert",
  quality: 80,
  magickPath: "magick",
  stripMetadata: false,
  limitImageSize: false,
  maxImageSize: 2000,
  animatedImageAction: "ask",
  formats: allFormatsEnabled(),
  fileNameTemplate: DEFAULT_FILE_NAME_TEMPLATE,
  replaceSpaces: true,
};

function allFormatsEnabled(): Record<ImageFormat, boolean> {
  return Object.fromEntries(IMAGE_FORMATS.map((format) => [format, true])) as Record<
    ImageFormat,
    boolean
  >;
}

export function isMode(value: unknown): value is Mode {
  return MODES.some((mode) => mode === value);
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
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_SETTINGS.magickPath;
}

export function parseSettings(storedData: unknown): AVIFPluginSettings {
  const stored =
    typeof storedData === "object" && storedData !== null
      ? (storedData as Record<string, unknown>)
      : {};

  return {
    mode: isMode(stored.mode) ? stored.mode : DEFAULT_SETTINGS.mode,
    quality: validateQuality(stored.quality) ?? DEFAULT_SETTINGS.quality,
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
  };
}

// Formats missing from older settings, or added in newer versions, are on.
function parseFormats(storedFormats: unknown): Record<ImageFormat, boolean> {
  const formats = allFormatsEnabled();
  if (typeof storedFormats !== "object" || storedFormats === null) return formats;

  const stored = storedFormats as Record<string, unknown>;
  for (const format of IMAGE_FORMATS) {
    const enabled = stored[format];
    if (typeof enabled === "boolean") formats[format] = enabled;
  }
  return formats;
}
