import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// A text/uri-list has one URI per line; lines starting with "#" are comments.
// Returns null unless every URI points to a local file.
export function parseFileUriList(uriList: string): string[] | null {
  const uris = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (uris.length === 0) return null;

  const paths: string[] = [];
  for (const uri of uris) {
    if (!uri.toLowerCase().startsWith("file:")) return null;
    try {
      paths.push(fileURLToPath(uri));
    } catch {
      return null;
    }
  }
  return paths;
}

export function vaultRelativePath(basePath: string, filePath: string): string | null {
  const relativePath = relative(basePath, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath.split(sep).join("/");
}

// For when the note was closed while a dropped image was being copied: that
// image is in the vault but not linked, and the rest aren't copied.
export function noteClosedMessage(
  noteName: string,
  fileName: string,
  skippedCount: number
): string {
  const message = `${noteName} is no longer open, so ${fileName} wasn't linked`;
  if (skippedCount === 0) return message;
  const skipped = skippedCount === 1 ? "1 more image wasn't" : `${skippedCount} more images weren't`;
  return `${message}, and ${skipped} copied`;
}
