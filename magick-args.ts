export interface ConvertOptions {
  quality: number;
  stripMetadata: boolean;
  limitImageSize: boolean;
  maxImageSize: number;
}

export function buildConvertArgs(
  inputPath: string,
  outputPath: string,
  options: ConvertOptions
): string[] {
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
    outputPath,
  ];
}

// "magick identify" exists only in ImageMagick 7, while the info: format also
// works with ImageMagick 6's convert. Prints the frame count once per frame.
export function buildFrameCountArgs(inputPath: string): string[] {
  return ["-ping", inputPath, "-format", "%n\n", "info:"];
}
