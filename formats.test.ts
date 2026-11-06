import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canConvert, formatForExtension, isAnimatedPng, multiFrameKind } from "./formats";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: number[] = []): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...Array.from(type, (char) => char.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

function png(...chunks: number[][]): Uint8Array {
  return new Uint8Array([...PNG_SIGNATURE, ...chunks.flat()]);
}

void test("maps file extensions to image formats", () => {
  assert.equal(formatForExtension("png"), "PNG");
  assert.equal(formatForExtension("JPG"), "JPEG");
  assert.equal(formatForExtension("jpeg"), "JPEG");
  assert.equal(formatForExtension("jfif"), "JPEG");
  assert.equal(formatForExtension("heif"), "HEIC");
  assert.equal(formatForExtension("tif"), "TIFF");
  assert.equal(formatForExtension("jxl"), "JXL");
  assert.equal(formatForExtension("svg"), null);
  assert.equal(formatForExtension("AVIF"), "AVIF");
});

void test("tells animated and multi-page images by their frame count", () => {
  assert.equal(multiFrameKind("GIF", 3), "animated");
  assert.equal(multiFrameKind("TIFF", 2), "pages");
  assert.equal(multiFrameKind("JPEG", 1), null);
});

void test("trusts the frame count over the extension", () => {
  // An animated WebP or GIF saved with a .png extension.
  assert.equal(multiFrameKind("PNG", 3), "animated");
});

void test("doesn't convert AVIF to AVIF", () => {
  assert.equal(canConvert("AVIF"), false);
  assert.equal(canConvert("PNG"), true);
  assert.equal(canConvert("HEIC"), true);
});

void test("detects an animated PNG by its acTL chunk", () => {
  const ihdr = chunk("IHDR", new Array<number>(13).fill(0));
  assert.equal(
    isAnimatedPng(png(ihdr, chunk("acTL", new Array<number>(8).fill(0)), chunk("IDAT"))),
    true
  );
});

void test("treats a PNG without an acTL chunk before IDAT as static", () => {
  const ihdr = chunk("IHDR", new Array<number>(13).fill(0));
  assert.equal(isAnimatedPng(png(ihdr, chunk("IDAT"), chunk("IEND"))), false);
  assert.equal(isAnimatedPng(png(ihdr, chunk("IDAT"), chunk("acTL"))), false);
});

void test("treats other or truncated data as not an animated PNG", () => {
  assert.equal(isAnimatedPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false);
  assert.equal(isAnimatedPng(png()), false);
  assert.equal(isAnimatedPng(png([0, 0, 0, 13, 73])), false);
});
