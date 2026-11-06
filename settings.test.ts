import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  effectiveActions,
  normalizeMagickPath,
  parseSettings,
  validateMaxImageSize,
} from "./settings";

const BOTH = { rename: true, convert: true };
const RENAME_ONLY = { rename: true, convert: false };
const CONVERT_ONLY = { rename: false, convert: true };
const NONE = { rename: false, convert: false };

const ALL_FORMATS = {
  PNG: BOTH,
  JPEG: BOTH,
  WEBP: BOTH,
  HEIC: BOTH,
  GIF: BOTH,
  BMP: BOTH,
  TIFF: BOTH,
  JXL: BOTH,
  AVIF: RENAME_ONLY,
};

const DEFAULTS = {
  mode: "convert",
  quality: 80,
  encodingSpeed: 8,
  magickPath: "magick",
  stripMetadata: false,
  limitImageSize: false,
  maxImageSize: 2000,
  animatedImageAction: "ask",
  formats: ALL_FORMATS,
  fileNameTemplate: "{title}-{date:YYYYMMDDHHmmssSSS}{counter}",
  replaceSpaces: true,
  importDroppedFileLinks: true,
  showStatusBar: true,
};

void test("uses defaults when nothing is stored", () => {
  assert.deepEqual(parseSettings(null), DEFAULTS);
});

void test("keeps valid stored settings and trims the ImageMagick path", () => {
  assert.deepEqual(
    parseSettings({
      mode: "rename",
      quality: 55,
      encodingSpeed: 4,
      magickPath: "  /opt/homebrew/bin/magick  ",
      stripMetadata: true,
      limitImageSize: true,
      maxImageSize: 1600,
      animatedImageAction: "skip",
      formats: { ...ALL_FORMATS, HEIC: RENAME_ONLY, GIF: CONVERT_ONLY, TIFF: NONE },
      fileNameTemplate: " {date:YYYY-MM-DD} {title} ",
      replaceSpaces: false,
      importDroppedFileLinks: false,
      showStatusBar: false,
    }),
    {
      mode: "rename",
      quality: 55,
      encodingSpeed: 4,
      magickPath: "/opt/homebrew/bin/magick",
      stripMetadata: true,
      limitImageSize: true,
      maxImageSize: 1600,
      animatedImageAction: "skip",
      formats: { ...ALL_FORMATS, HEIC: RENAME_ONLY, GIF: CONVERT_ONLY, TIFF: NONE },
      fileNameTemplate: "{date:YYYY-MM-DD} {title}",
      replaceSpaces: false,
      importDroppedFileLinks: false,
      showStatusBar: false,
    }
  );
  assert.equal(parseSettings({ mode: "off" }).mode, "off");
});

// Windows Explorer's "Copy as path" puts the path in quotes.
void test("removes the quotes around a pasted ImageMagick path", () => {
  assert.equal(
    normalizeMagickPath(' "C:\\Program Files\\ImageMagick\\magick.exe" '),
    "C:\\Program Files\\ImageMagick\\magick.exe"
  );
  assert.equal(normalizeMagickPath("'/opt/homebrew/bin/magick'"), "/opt/homebrew/bin/magick");
  assert.equal(normalizeMagickPath('""'), "magick");
});

void test("falls back to defaults for invalid stored values", () => {
  assert.deepEqual(
    parseSettings({
      mode: "pause",
      quality: 101,
      encodingSpeed: 5,
      magickPath: "   ",
      stripMetadata: "yes",
      limitImageSize: "on",
      maxImageSize: 0,
      animatedImageAction: "convert",
      formats: "all",
      fileNameTemplate: "   ",
      replaceSpaces: "no",
      importDroppedFileLinks: "no",
      showStatusBar: "no",
    }),
    DEFAULTS
  );
  assert.deepEqual(
    parseSettings({
      mode: 1,
      quality: 12.5,
      encodingSpeed: "8",
      magickPath: 42,
      stripMetadata: 0,
      limitImageSize: 1,
      maxImageSize: "1600",
      animatedImageAction: 1,
      formats: { PNG: "no", SVG: true },
      fileNameTemplate: "{title}-{foo}",
      replaceSpaces: 0,
      importDroppedFileLinks: 0,
      showStatusBar: 0,
    }),
    DEFAULTS
  );
});

void test("keeps settings saved before the newer options existed", () => {
  assert.deepEqual(parseSettings({ quality: 30 }), { ...DEFAULTS, quality: 30 });
});

void test("enables formats and actions missing from stored settings", () => {
  assert.deepEqual(
    parseSettings({ formats: { PNG: NONE, JPEG: { convert: false }, WEBP: { rename: "no" } } })
      .formats,
    { ...ALL_FORMATS, PNG: NONE, JPEG: RENAME_ONLY }
  );
});

void test("never converts AVIF, whatever is stored", () => {
  assert.deepEqual(parseSettings({ formats: { AVIF: BOTH } }).formats.AVIF, RENAME_ONLY);
  assert.deepEqual(parseSettings({ formats: { AVIF: CONVERT_ONLY } }).formats.AVIF, NONE);
});

void test("follows the format actions in Convert mode", () => {
  assert.deepEqual(effectiveActions("convert", CONVERT_ONLY), CONVERT_ONLY);
  assert.deepEqual(effectiveActions("convert", BOTH), BOTH);
});

void test("only renames in Rename only mode, and only where renaming is on", () => {
  assert.deepEqual(effectiveActions("rename", BOTH), RENAME_ONLY);
  assert.deepEqual(effectiveActions("rename", CONVERT_ONLY), NONE);
});

void test("does nothing when the mode is off", () => {
  assert.deepEqual(effectiveActions("off", BOTH), NONE);
});

void test("accepts only a positive whole number as the maximum image size", () => {
  assert.equal(validateMaxImageSize(1), 1);
  assert.equal(validateMaxImageSize(8000), 8000);
  assert.equal(validateMaxImageSize(0), null);
  assert.equal(validateMaxImageSize(-1), null);
  assert.equal(validateMaxImageSize(12.5), null);
  assert.equal(validateMaxImageSize(Number.NaN), null);
  assert.equal(validateMaxImageSize("2000"), null);
});
