import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildConvertArgs, type ConvertOptions } from "./magick-args";

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

test("keeps metadata and size when both options are off", () => {
  assert.deepEqual(
    buildConvertArgs("/vault/in.jpg", "/vault/out.avif", {
      ...BASE_OPTIONS,
      quality: 55,
    }),
    ["/vault/in.jpg", "-quality", "55", "/vault/out.avif"]
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
      "-resize",
      "1600x1600>",
      "-quality",
      "80",
      "/vault/out.avif",
    ]
  );
});
