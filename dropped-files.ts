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
