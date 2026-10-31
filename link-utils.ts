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
