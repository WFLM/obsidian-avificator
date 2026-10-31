export interface LinkReplacementResult {
  content: string;
  replacementCount: number;
}

type LinkTargetMatcher = (target: string) => boolean;

const WIKI_IMAGE_EMBED_PATTERN = /!\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_IMAGE_EMBED_PATTERN =
  /!\[([^\]\n]*)\]\((<[^>\n]+>|(?:\\.|[^)\s])+)([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\)/g;

export function replaceImageEmbedLinks(
  content: string,
  outputFileName: string,
  isOriginalTarget: LinkTargetMatcher
): LinkReplacementResult {
  let replacementCount = 0;

  const withWikiLinks = content.replace(
    WIKI_IMAGE_EMBED_PATTERN,
    (fullMatch: string, innerLink: string) => {
      const aliasIndex = innerLink.indexOf("|");
      const target = aliasIndex === -1 ? innerLink : innerLink.slice(0, aliasIndex);
      const alias = aliasIndex === -1 ? "" : innerLink.slice(aliasIndex);

      if (!isOriginalTarget(target.trim())) return fullMatch;

      replacementCount += 1;
      return `![[${replaceTrimmedTarget(target, outputFileName, false)}${alias}]]`;
    }
  );

  const withMarkdownLinks = withWikiLinks.replace(
    MARKDOWN_IMAGE_EMBED_PATTERN,
    (
      fullMatch: string,
      altText: string,
      rawTarget: string,
      title: string | undefined
    ) => {
      const isEnclosed = rawTarget.startsWith("<") && rawTarget.endsWith(">");
      const target = isEnclosed ? rawTarget.slice(1, -1) : rawTarget;

      if (!isOriginalTarget(target)) return fullMatch;

      replacementCount += 1;
      const replacementTarget = replaceTargetBasename(target, outputFileName, true);
      const formattedTarget = isEnclosed ? `<${replacementTarget}>` : replacementTarget;
      return `![${altText}](${formattedTarget}${title ?? ""})`;
    }
  );

  return {
    content: withMarkdownLinks,
    replacementCount,
  };
}

// For a file that is no longer at filePath, so Obsidian can't resolve links to
// it: whether the link path is its vault path, its path relative to the note's
// folder, or the end of its path, such as a bare file name, that no other file
// in the vault shares.
export function linkPathPointsTo(
  linkPath: string,
  notePath: string,
  filePath: string,
  vaultPaths: readonly string[]
): boolean {
  if (linkPath === filePath) return true;
  if (resolveFromFolder(notePath, linkPath) === filePath) return true;

  const endsWithLinkPath = (path: string): boolean =>
    path === linkPath || path.endsWith(`/${linkPath}`);
  return (
    endsWithLinkPath(filePath) &&
    !vaultPaths.some((path) => path !== filePath && endsWithLinkPath(path))
  );
}

// Links by bare name ignore case and folders, so a name used anywhere in the
// vault would make such a link ambiguous.
export function isFileNameTaken(fileName: string, vaultPaths: readonly string[]): boolean {
  const lowerCased = fileName.toLowerCase();
  return vaultPaths.some(
    (path) => path.slice(path.lastIndexOf("/") + 1).toLowerCase() === lowerCased
  );
}

function resolveFromFolder(notePath: string, linkPath: string): string {
  const segments = notePath.split("/").slice(0, -1);
  for (const segment of linkPath.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "." && segment !== "") segments.push(segment);
  }
  return segments.join("/");
}

function replaceTrimmedTarget(
  target: string,
  outputFileName: string,
  encodeOutput: boolean
): string {
  const trimmedTarget = target.trim();
  const startIndex = target.indexOf(trimmedTarget);
  const prefix = target.slice(0, startIndex);
  const suffix = target.slice(startIndex + trimmedTarget.length);
  return (
    prefix +
    replaceTargetBasename(trimmedTarget, outputFileName, encodeOutput) +
    suffix
  );
}

function replaceTargetBasename(
  target: string,
  outputFileName: string,
  encodeOutput: boolean
): string {
  const subpathIndex = target.search(/[?#]/);
  const path = subpathIndex === -1 ? target : target.slice(0, subpathIndex);
  const subpath = subpathIndex === -1 ? "" : target.slice(subpathIndex);
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const encodedOutputFileName = encodeOutput
    ? encodeMarkdownPathSegment(outputFileName)
    : outputFileName;

  return path.slice(0, separatorIndex + 1) + encodedOutputFileName + subpath;
}

function encodeMarkdownPathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
