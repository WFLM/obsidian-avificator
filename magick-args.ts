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
  // photos, so remove every profile except ICC instead. Rotate the pixels
  // first so the image stays upright without its EXIF orientation.
  const metadataArgs = options.stripMetadata
    ? ["-auto-orient", "+profile", "!icc,*"]
    : [];
  // The ">" flag only shrinks images larger than the box, never enlarges.
  const sizeArgs = options.limitImageSize
    ? ["-resize", `${options.maxImageSize}x${options.maxImageSize}>`]
    : [];

  return [
    inputPath,
    ...metadataArgs,
    ...sizeArgs,
    "-quality",
    options.quality.toString(),
    outputPath,
  ];
}
