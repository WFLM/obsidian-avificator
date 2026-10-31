export interface FormatSupport {
  read: boolean;
  write: boolean;
}

export interface MagickStatus {
  ok: boolean;
  message: string;
}

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
    return {
      ok: false,
      message: "The program at this path doesn't look like ImageMagick.",
    };
  }

  const canWriteAvif = formats.get("AVIF")?.write ?? false;
  const readable = inputFormats.filter((format) => formats.get(format)?.read);
  const unreadable = inputFormats.filter((format) => !formats.get(format)?.read);

  const parts = [
    version ? `ImageMagick ${version}:` : "ImageMagick:",
    canWriteAvif
      ? "AVIF output supported."
      : "AVIF output is not supported, so images can't be converted.",
  ];
  if (readable.length > 0) parts.push(`Can read ${readable.join(", ")}.`);
  if (unreadable.length > 0) parts.push(`Can't read ${unreadable.join(", ")}.`);

  return {
    ok: canWriteAvif && unreadable.length === 0,
    message: parts.join(" "),
  };
}

// `magick identify -format "%n\n"` prints the frame count once per frame.
export function parseFrameCount(output: string): number | null {
  const count = Number.parseInt(output.split("\n")[0] ?? "", 10);
  return Number.isNaN(count) ? null : count;
}

export function describeMagickError(error: unknown): MagickStatus {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return { ok: false, message: "ImageMagick not found at this path." };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    message: `Could not run ImageMagick: ${message.split("\n")[0]}`,
  };
}
