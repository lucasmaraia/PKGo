// Recent events (payloads sent, downloads, PS4 log connection, errors) kept
// in memory for the diagnostic report. Nothing is written to disk.
import os from 'node:os';

const MAX_LINES = 300;

export class ActivityLog {
  private lines: string[] = [];

  add(message: string): void {
    this.lines.push(`${new Date().toISOString()} ${message}`);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  get recent(): readonly string[] {
    return this.lines;
  }
}

/** Hides the user name in paths shared in reports. */
export function redactHome(text: string, home = os.homedir()): string {
  if (!home) return text;
  const variants = new Set([home, home.replace(/\\/g, '/')]);
  let out = text;
  for (const v of variants) out = out.split(v).join('~');
  return out;
}
