export interface ConvertOptions {
  quality: number;
  stripMetadata: boolean;
  limitImageSize: boolean;
  maxImageSize: number;
}

// The AVIF goes to standard output, so the plugin can add it to the vault.
export function buildConvertArgs(inputPath: string, options: ConvertOptions): string[] {
  // -strip would also drop the ICC profile and shift colors of wide-gamut
  // photos, so remove every profile except ICC instead.
  const metadataArgs = options.stripMetadata ? ["+profile", "!icc,*"] : [];
  // The ">" flag only shrinks images larger than the box, never enlarges.
  const sizeArgs = options.limitImageSize
    ? ["-resize", `${options.maxImageSize}x${options.maxImageSize}>`]
    : [];

  return [
    inputPath,
    // Rotates the pixels as the EXIF orientation says, so the image stays
    // upright without it: older ImageMagick versions don't carry it over to
    // AVIF, and removing metadata drops it.
    "-auto-orient",
    ...metadataArgs,
    ...sizeArgs,
    "-quality",
    options.quality.toString(),
    "avif:-",
  ];
}

// "magick identify" exists only in ImageMagick 7, while this also works with
// ImageMagick 6's convert. -print writes the frame count once, not per frame.
export function buildFrameCountArgs(inputPath: string): string[] {
  return ["-ping", inputPath, "-print", "%n\n", "null:"];
}
