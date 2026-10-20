/**
 * Byte ranges of each file already sent, merged as [start, end) pairs.
 * The install payload reports nothing back, so install progress is the
 * share of the PKG the console has downloaded from us.
 */
export class ServedRanges {
  private ranges = new Map<string, [number, number][]>();

  mark(id: string, start: number, end: number): void {
    const merged: [number, number][] = [];
    for (const r of [...(this.ranges.get(id) || []), [start, end] as [number, number]].sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    this.ranges.set(id, merged);
  }

  bytes(id: string): number {
    return (this.ranges.get(id) || []).reduce((total, [s, e]) => total + e - s, 0);
  }

  reset(id: string): void {
    this.ranges.delete(id);
  }
}
