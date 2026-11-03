export interface FormatSupport {
  read: boolean;
  write: boolean;
}

// One fact per line, so supported and unsupported things can be colored apart.
export interface StatusLine {
  text: string;
  ok: boolean;
}

export type MagickStatus = StatusLine[];

// A line of `magick -list format`, e.g. "     JPEG* JPEG      rw-   ...".
// ImageMagick 6 prints no module column.
const FORMAT_LINE = /^\s*([A-Z0-9_-]+)\*?\s+(?:\S+\s+)?([r-])([w-])[+-](?:\s|$)/i;

export function parseFormatList(output: string): Map<string, FormatSupport> {
  const formats = new Map<string, FormatSupport>();
  for (const line of output.split("\n")) {
    const [, name, read, write] = FORMAT_LINE.exec(line) ?? [];
    if (name) {
      formats.set(name.toUpperCase(), { read: read === "r", write: write === "w" });
    }
  }
  return formats;
}

export function describeMagickSupport(
  versionOutput: string,
  formats: Map<string, FormatSupport>,
  inputFormats: readonly string[]
): MagickStatus {
  const version = /ImageMagick (\S+)/.exec(versionOutput)?.[1];
  if (!version && formats.size === 0) {
    return [{ text: "The program at this path doesn't look like ImageMagick.", ok: false }];
  }

  const canWriteAvif = formats.get("AVIF")?.write ?? false;
  const readable = inputFormats.filter((format) => formats.get(format)?.read);
  const unreadable = inputFormats.filter((format) => !formats.get(format)?.read);

  const lines: MagickStatus = [
    {
      text: `${version ? `ImageMagick ${version}` : "ImageMagick"}: AVIF ${
        canWriteAvif ? "supported" : "not supported"
      }.`,
      ok: canWriteAvif,
    },
  ];
  if (!canWriteAvif) lines.push({ text: "Images can't be converted.", ok: false });
  if (readable.length > 0) {
    lines.push({ text: `Can read ${readable.join(", ")}.`, ok: true });
  }
  if (unreadable.length > 0) {
    lines.push({ text: `Can't read ${unreadable.join(", ")}.`, ok: false });
  }
  return lines;
}

// Reads the frame count that buildFrameCountArgs makes ImageMagick print.
export function parseFrameCount(output: string): number | null {
  const count = Number.parseInt(output, 10);
  return Number.isNaN(count) ? null : count;
}

// ImageMagick ran and exited with an error, which when counting frames means
// it couldn't read the image. A missing or unrunnable program has a string code
// such as ENOENT, and a timed out one has none.
export function isMagickReadError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "number";
}

export function describeMagickError(error: unknown): MagickStatus {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return [{ text: "ImageMagick not found at this path.", ok: false }];
  }

  const message = error instanceof Error ? error.message : String(error);
  return [{ text: `Could not run ImageMagick: ${message.split("\n")[0]}`, ok: false }];
}
