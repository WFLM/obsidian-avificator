import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  describeMagickError,
  describeMagickSupport,
  isMagickReadError,
  parseFormatList,
  parseFrameCount,
} from "./magick-support";

const VERSION_OUTPUT = `Version: ImageMagick 7.1.1-41 Q16-HDRI x86_64 d7d490223:20241115 https://imagemagick.org
Copyright: (C) 1999 ImageMagick Studio LLC
`;

const FULL_FORMAT_LIST = `   Format  Module    Mode  Description
-------------------------------------------------------------------------------
      3FR  DNG       r--   Hasselblad CFV/H3D39II Raw Format (0.20.2-Release)
     AVIF  HEIC      rw+   AV1 Image File Format (1.19.3)
     HEIC  HEIC      rw+   High Efficiency Image Format (1.19.3)
     JPEG* JPEG      rw-   Joint Photographic Experts Group JFIF format (libjpeg-turbo 2.1.2)
      PNG* PNG       rw-   Portable Network Graphics (libpng 1.6.37)
     WEBP* WEBP      rw+   WebP Image Format (libwebp 1.2.2 [020F])
`;

const INPUT_FORMATS = ["PNG", "JPEG", "WEBP", "HEIC"];

test("parses read and write support from the format list", () => {
  const formats = parseFormatList(FULL_FORMAT_LIST);
  assert.deepEqual(formats.get("AVIF"), { read: true, write: true });
  assert.deepEqual(formats.get("JPEG"), { read: true, write: true });
  assert.deepEqual(formats.get("3FR"), { read: true, write: false });
  assert.equal(formats.has("FORMAT"), false);
});

test("parses the ImageMagick 6 format list without a module column", () => {
  const formats = parseFormatList(`   Format  Mode  Description
-------------------------------------------------------------------------------
     AVIF  r--   AV1 Image File Format
      PNG* rw-   Portable Network Graphics
`);
  assert.deepEqual(formats.get("AVIF"), { read: true, write: false });
  assert.deepEqual(formats.get("PNG"), { read: true, write: true });
});

const WITHOUT_HEIC = FULL_FORMAT_LIST.replace(/^.*HEIC  HEIC.*\n/m, "");
const READ_ONLY_AVIF = FULL_FORMAT_LIST.replace("AVIF  HEIC      rw+", "AVIF  HEIC      r--");

for (const [name, formatList, inputFormats, expected] of [
  ["reports full support with the version", FULL_FORMAT_LIST, INPUT_FORMATS, [
    { text: "ImageMagick 7.1.1-41: AVIF supported.", ok: true },
    { text: "Can read PNG, JPEG, WEBP, HEIC.", ok: true },
  ]],
  ["reports input formats ImageMagick can't read", WITHOUT_HEIC, INPUT_FORMATS, [
    { text: "ImageMagick 7.1.1-41: AVIF supported.", ok: true },
    { text: "Can read PNG, JPEG, WEBP.", ok: true },
    { text: "Can't read HEIC.", ok: false },
  ]],
  ["reports missing AVIF output", READ_ONLY_AVIF, INPUT_FORMATS, [
    { text: "ImageMagick 7.1.1-41: AVIF not supported.", ok: false },
    { text: "Images can't be converted.", ok: false },
    { text: "Can read PNG, JPEG, WEBP, HEIC.", ok: true },
  ]],
  ["checks only the given input formats", WITHOUT_HEIC, ["PNG", "JPEG"], [
    { text: "ImageMagick 7.1.1-41: AVIF supported.", ok: true },
    { text: "Can read PNG, JPEG.", ok: true },
  ]],
] as const) {
  test(name, () => {
    assert.deepEqual(
      describeMagickSupport(VERSION_OUTPUT, parseFormatList(formatList), inputFormats),
      expected
    );
  });
}

test("reports a program that doesn't look like ImageMagick", () => {
  assert.deepEqual(
    describeMagickSupport("hello\n", parseFormatList("world\n"), INPUT_FORMATS),
    [{ text: "The program at this path doesn't look like ImageMagick.", ok: false }]
  );
});

test("reports a missing executable", () => {
  const error = Object.assign(new Error("spawn magick ENOENT"), {
    code: "ENOENT",
  });
  assert.deepEqual(describeMagickError(error), [
    { text: "ImageMagick not found at this path.", ok: false },
  ]);
});

test("reports other errors with the first line of their message", () => {
  const error = new Error("spawn /usr/bin/magick EACCES\nmore details");
  assert.deepEqual(describeMagickError(error), [
    { text: "Could not run ImageMagick: spawn /usr/bin/magick EACCES", ok: false },
  ]);
});

test("reads the frame count ImageMagick prints", () => {
  assert.equal(parseFrameCount("3\n"), 3);
  assert.equal(parseFrameCount("1\n"), 1);
  assert.equal(parseFrameCount(""), null);
  assert.equal(parseFrameCount("magick: no decode delegate\n"), null);
});

test("takes an error ImageMagick itself reports for a read error", () => {
  const exited = Object.assign(new Error("Command failed: magick -ping"), {
    code: 1,
    killed: false,
    signal: null,
  });
  assert.equal(isMagickReadError(exited), true);
});

test("doesn't take a missing, unrunnable, or timed out ImageMagick for a read error", () => {
  const missing = Object.assign(new Error("spawn magick ENOENT"), { code: "ENOENT" });
  const denied = Object.assign(new Error("spawn magick EACCES"), { code: "EACCES" });
  const timedOut = Object.assign(new Error("Command failed"), {
    code: null,
    killed: true,
    signal: "SIGTERM",
  });
  assert.equal(isMagickReadError(missing), false);
  assert.equal(isMagickReadError(denied), false);
  assert.equal(isMagickReadError(timedOut), false);
  assert.equal(isMagickReadError("not an error"), false);
});
