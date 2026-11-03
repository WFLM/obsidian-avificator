export interface LinkReplacementResult {
  content: string;
  replacementCount: number;
}

// Gets a link target as Obsidian reads it, see decodeMarkdownTarget.
type LinkTargetMatcher = (target: string) => boolean;

// A single "]" may be part of the file name; "]]" ends the embed.
const WIKI_IMAGE_EMBED_PATTERN = /!\[\[((?:[^\]\n]|\](?!\]))+)\]\]/g;
// The target may have balanced parentheses, which Obsidian doesn't encode. A
// backslash always escapes the next character: matching it on its own too
// would make an unclosed link with many backslashes take exponential time.
const MARKDOWN_IMAGE_EMBED_PATTERN =
  /!\[([^\]\n]*)\]\((<[^>\n]+>|(?:\\.|[^()\s\\]|\((?:\\.|[^()\s\\])*\))+)([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\)/g;

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

      if (!isOriginalTarget(decodeMarkdownTarget(target))) return fullMatch;

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

// The targets of the image embeds the matcher accepts, as it gets them.
export function findImageEmbedTargets(
  content: string,
  isTarget: LinkTargetMatcher
): Set<string> {
  const targets = new Set<string>();
  replaceImageEmbedLinks(content, "", (target) => {
    if (isTarget(target)) targets.add(target);
    return false;
  });
  return targets;
}

// Obsidian decodes the targets of Markdown links, but not of wiki links, and
// keeps a target it can't decode as it is. decodeURI leaves "%23" and other
// reserved characters encoded, so they stay part of the name.
function decodeMarkdownTarget(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

// Links by bare name ignore case and folders, so a name used anywhere in the
// vault would make such a link ambiguous.
export function isFileNameTaken(fileName: string, vaultPaths: readonly string[]): boolean {
  const lowerCased = fileName.toLowerCase();
  return vaultPaths.some(
    (path) => path.slice(path.lastIndexOf("/") + 1).toLowerCase() === lowerCased
  );
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
  // As in Obsidian, a subpath starts only at "#"; "?" is part of the name.
  const subpathIndex = target.indexOf("#");
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
