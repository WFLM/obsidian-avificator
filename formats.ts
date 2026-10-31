// Format names match ImageMagick's, so they can be looked up in its format
// list as is.
export const IMAGE_FORMATS = ["PNG", "JPEG", "WEBP", "HEIC", "GIF", "BMP", "TIFF", "JXL"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const FORMAT_EXTENSIONS: Record<ImageFormat, readonly string[]> = {
  PNG: ["png"],
  JPEG: ["jpg", "jpeg", "jfif"],
  WEBP: ["webp"],
  HEIC: ["heic", "heif"],
  GIF: ["gif"],
  BMP: ["bmp"],
  TIFF: ["tif", "tiff"],
  JXL: ["jxl"],
};

export function formatForExtension(extension: string): ImageFormat | null {
  const lowerCased = extension.toLowerCase();
  return (
    IMAGE_FORMATS.find((format) => FORMAT_EXTENSIONS[format].includes(lowerCased)) ??
    null
  );
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// ImageMagick reads only the first frame of an animated PNG, so the animation
// is detected by the acTL chunk that must come before the image data.
export function isAnimatedPng(bytes: Uint8Array): boolean {
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    // Chunk length, type, data, and CRC.
    offset += 4 + 4 + view.getUint32(offset) + 4;
  }
  return false;
}
