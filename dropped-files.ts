import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// A text/uri-list has one URI per line; lines starting with "#" are comments.
// Electron on Wayland runs the URIs together, so a line is also split before
// each "file://", which a file URI can't contain. Returns null unless every
// URI points to a local file.
export function parseFileUriList(uriList: string): string[] | null {
  const uris = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap((line) => line.split(/(?=file:\/\/)/i));
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

// Obsidian inserts the file:/// addresses a drop carries as text, or as a
// Markdown link, instead of copying the files, when the drop has no plain text
// or plain text other than the addresses. Otherwise it copies the files.
export function dropInsertsAddresses(uriList: string, plainText: string): boolean {
  if (!plainText) return true;
  const uris = uriList.toLowerCase();
  const text = plainText.toLowerCase();
  if (uris === text) return false;
  try {
    return decodeURIComponent(uris) !== text;
  } catch {
    return true;
  }
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
