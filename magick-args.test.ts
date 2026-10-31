import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildConvertArgs, buildFrameCountArgs, type ConvertOptions } from "./magick-args";

const BASE_OPTIONS: ConvertOptions = {
  quality: 80,
  stripMetadata: false,
  limitImageSize: false,
  maxImageSize: 2000,
};

test("removes metadata but keeps the color profile when asked", () => {
  assert.deepEqual(
    buildConvertArgs("/vault/in.jpg", "/vault/out.avif", {
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
      "/vault/out.avif",
    ]
  );
});

// Older ImageMagick versions don't carry the EXIF orientation over to AVIF.
test("keeps metadata and size when both options are off, but turns the image upright", () => {
  assert.deepEqual(
    buildConvertArgs("/vault/in.jpg", "/vault/out.avif", {
      ...BASE_OPTIONS,
      quality: 55,
    }),
    ["/vault/in.jpg", "-auto-orient", "-quality", "55", "/vault/out.avif"]
  );
});

test("shrinks only images whose longer side exceeds the limit", () => {
  assert.deepEqual(
    buildConvertArgs("/vault/in.jpg", "/vault/out.avif", {
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
      "/vault/out.avif",
    ]
  );
});

// ImageMagick 6 has no "magick identify", only "convert", so the frame count
// is printed with the info: format that both versions have.
test("counts frames without the identify subcommand", () => {
  assert.deepEqual(buildFrameCountArgs("/vault/in.gif"), [
    "-ping",
    "/vault/in.gif",
    "-format",
    "%n\n",
    "info:",
  ]);
});
