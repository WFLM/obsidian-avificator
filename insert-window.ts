// Remembers which note was just pasted or dropped into and how many files
// that brings, so that images sync adds meanwhile are left alone.
export class InsertWindow {
  private readonly durationMs: number;
  private readonly maxDurationMs: number;
  private notePath: string | null = null;
  private fileCount = 0;
  private until = 0;
  private limit = 0;

  constructor(durationMs: number, maxDurationMs: number) {
    this.durationMs = durationMs;
    this.maxDurationMs = maxDurationMs;
  }

  // An earlier paste into the same note may still be saving its files.
  open(notePath: string, fileCount: number, now: number): void {
    const isOpen = now < this.until && this.fileCount > 0;
    this.fileCount =
      isOpen && this.notePath === notePath ? this.fileCount + fileCount : fileCount;
    this.notePath = notePath;
    this.until = now + this.durationMs;
    this.limit = now + this.maxDurationMs;
  }

  // The note for the next expected image, or null once all have come or the
  // wait is over. Each image extends the wait, up to the limit.
  take(now: number): string | null {
    if (now >= this.until || this.fileCount === 0) return null;
    this.fileCount -= 1;
    this.until = Math.min(now + this.durationMs, this.limit);
    return this.notePath;
  }
}

// The parts of a DataTransfer that show whether it brings files.
export interface TransferContents {
  items: ArrayLike<{ kind: string }>;
  getData(format: string): string;
}

// Images embedded in the HTML count too: Obsidian means to save them, though
// a bug of its own currently stops it.
export function dropFileCount(data: TransferContents): number {
  const files = Array.from(data.items).filter((item) => item.kind === "file").length;
  const embeddedImages = data.getData("text/html").split("data:image/").length - 1;
  return files + embeddedImages;
}

// With no files and no text, Obsidian pastes one image or file from the
// system clipboard.
export function pasteFileCount(data: TransferContents): number {
  const count = dropFileCount(data);
  return count === 0 && !data.getData("text/plain") ? 1 : count;
}
