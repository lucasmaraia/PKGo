import {currentLanguage} from './i18n';

const ESCAPES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

/** Escapes text for use inside HTML templates. */
export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c]!);

export function bytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toLocaleString(currentLanguage(), {maximumFractionDigits: i >= 3 ? 2 : 1})} ${units[i]}`;
}

export function duration(seconds: number | null): string {
  if (seconds == null || !isFinite(seconds)) return '';
  const sec = Math.max(0, Math.round(seconds));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}

export function initials(title: string): string {
  const letters = title
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();
  return esc(letters || 'PKG');
}
