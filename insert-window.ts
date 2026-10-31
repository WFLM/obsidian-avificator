// Remembers the note something was last pasted or dropped into, for a while.
// Images are processed only if they show up in that time, so that images sync
// brings into an open note are left alone.
export class InsertWindow {
  private readonly durationMs: number;
  private readonly maxDurationMs: number;
  private notePath: string | null = null;
  private until = 0;
  private limit = 0;

  constructor(durationMs: number, maxDurationMs: number) {
    this.durationMs = durationMs;
    this.maxDurationMs = maxDurationMs;
  }

  open(notePath: string, now: number): void {
    this.notePath = notePath;
    this.until = now + this.durationMs;
    this.limit = now + this.maxDurationMs;
  }

  // Waits for the next image of a multi-file paste or drop, but not past the
  // limit, so that a stream of synced images can't keep the window open.
  extend(now: number): void {
    this.until = Math.min(now + this.durationMs, this.limit);
  }

  notePathAt(now: number): string | null {
    return now < this.until ? this.notePath : null;
  }
}
