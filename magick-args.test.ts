import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildConvertArgs, buildFrameCountArgs, type ConvertOptions } from "./magick-args";

const BASE_OPTIONS: ConvertOptions = {
  quality: 80,
  stripMetadata: false,
  limitImageSize: false,
  maxImageSize: 2000,
};

void test("removes metadata but keeps the color profile when asked", () => {
  assert.deepEqual(
    buildConvertArgs("/vault/in.jpg", {
      ...BASE_OPTIONS,
      stripMetadata: true,
    }),
    [
      "/vault/in.jpg",
      "-auto-orient",
      "+profile",
      "!icc,*",
      "-quality",
      "80",
      "avif:-",
    ]
  );
});

// Older ImageMagick versions don't carry the EXIF orientation over to AVIF.
void test("keeps metadata and size when both options are off, but turns the image upright", () => {
  assert.deepEqual(
    buildConvertArgs("/vault/in.jpg", {
      ...BASE_OPTIONS,
      quality: 55,
    }),
    [
      "/vault/in.jpg",
      "-auto-orient",
      "-quality",
      "55",
      "avif:-",
    ]
  );
});

void test("shrinks only images whose longer side exceeds the limit", () => {
  assert.deepEqual(
    buildConvertArgs("/vault/in.jpg", {
      ...BASE_OPTIONS,
      limitImageSize: true,
      maxImageSize: 1600,
    }),
    [
      "/vault/in.jpg",
      "-auto-orient",
      "-resize",
      "1600x1600>",
      "-quality",
      "80",
      "avif:-",
    ]
  );
});

// The plugin adds the AVIF to the vault itself.
void test("writes the AVIF to standard output", () => {
  assert.deepEqual(buildConvertArgs("/vault/growth%o.png", BASE_OPTIONS), [
    "/vault/growth%o.png",
    "-auto-orient",
    "-quality",
    "80",
    "avif:-",
  ]);
});

// ImageMagick 6 has no "magick identify", only "convert", and -format with
// info: would print the count once per frame.
void test("prints the frame count once, without the identify subcommand", () => {
  assert.deepEqual(buildFrameCountArgs("/vault/in.gif"), [
    "-ping",
    "/vault/in.gif",
    "-print",
    "%n\n",
    "null:",
  ]);
});
