import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseSettings, validateMaxImageSize } from "./settings";

const ALL_FORMATS = {
  PNG: true,
  JPEG: true,
  WEBP: true,
  HEIC: true,
  GIF: true,
  BMP: true,
  TIFF: true,
  JXL: true,
};

const DEFAULTS = {
  mode: "convert",
  quality: 80,
  magickPath: "magick",
  stripMetadata: false,
  limitImageSize: false,
  maxImageSize: 2000,
  animatedImageAction: "ask",
  formats: ALL_FORMATS,
  fileNameTemplate: "{title}-{date:YYYYMMDDHHmmssSSS}{counter}",
  replaceSpaces: true,
  importDroppedFileLinks: true,
};

test("uses defaults when nothing is stored", () => {
  assert.deepEqual(parseSettings(null), DEFAULTS);
});

test("keeps valid stored settings and trims the ImageMagick path", () => {
  assert.deepEqual(
    parseSettings({
      mode: "rename",
      quality: 55,
      magickPath: "  /opt/homebrew/bin/magick  ",
      stripMetadata: true,
      limitImageSize: true,
      maxImageSize: 1600,
      animatedImageAction: "skip",
      formats: { ...ALL_FORMATS, GIF: false, TIFF: false },
      fileNameTemplate: " {date:YYYY-MM-DD} {title} ",
      replaceSpaces: false,
      importDroppedFileLinks: false,
    }),
    {
      mode: "rename",
      quality: 55,
      magickPath: "/opt/homebrew/bin/magick",
      stripMetadata: true,
      limitImageSize: true,
      maxImageSize: 1600,
      animatedImageAction: "skip",
      formats: { ...ALL_FORMATS, GIF: false, TIFF: false },
      fileNameTemplate: "{date:YYYY-MM-DD} {title}",
      replaceSpaces: false,
      importDroppedFileLinks: false,
    }
  );
  assert.equal(parseSettings({ mode: "off" }).mode, "off");
});

test("falls back to defaults for invalid stored values", () => {
  assert.deepEqual(
    parseSettings({
      mode: "pause",
      quality: 101,
      magickPath: "   ",
      stripMetadata: "yes",
      limitImageSize: "on",
      maxImageSize: 0,
      animatedImageAction: "convert",
      formats: "all",
      fileNameTemplate: "   ",
      replaceSpaces: "no",
      importDroppedFileLinks: "no",
    }),
    DEFAULTS
  );
  assert.deepEqual(
    parseSettings({
      mode: 1,
      quality: 12.5,
      magickPath: 42,
      stripMetadata: 0,
      limitImageSize: 1,
      maxImageSize: "1600",
      animatedImageAction: 1,
      formats: { PNG: "no", SVG: true },
      fileNameTemplate: "{title}-{foo}",
      replaceSpaces: 0,
      importDroppedFileLinks: 0,
    }),
    DEFAULTS
  );
});

test("keeps settings saved before the newer options existed", () => {
  assert.deepEqual(parseSettings({ quality: 30 }), { ...DEFAULTS, quality: 30 });
});

test("enables formats missing from stored settings", () => {
  assert.deepEqual(parseSettings({ formats: { PNG: false } }).formats, {
    ...ALL_FORMATS,
    PNG: false,
  });
});

test("accepts only a positive whole number as the maximum image size", () => {
  assert.equal(validateMaxImageSize(1), 1);
  assert.equal(validateMaxImageSize(8000), 8000);
  assert.equal(validateMaxImageSize(0), null);
  assert.equal(validateMaxImageSize(-1), null);
  assert.equal(validateMaxImageSize(12.5), null);
  assert.equal(validateMaxImageSize(Number.NaN), null);
  assert.equal(validateMaxImageSize("2000"), null);
});
