// Translations shared by the main process (native dialogs, tray) and the renderer.
// Messages are flat "section.key" entries; {name} placeholders take params.
import en from './locales/en.json';
import es from './locales/es.json';
import ptBR from './locales/pt-BR.json';
import type {ErrorInfo, Language} from './types';

export type Messages = typeof en;
export type MessageKey = keyof Messages;

export const MESSAGES: Record<Language, Messages> = {en, es, 'pt-BR': ptBR};

/** Names of the languages, each in its own language (for the selector). */
export const LANGUAGE_NAMES: Record<Language, string> = {'pt-BR': 'Português (Brasil)', en: 'English', es: 'Español'};

/** Maps a system locale (pt-BR, pt-PT, es-MX, en-US…) to a supported language. */
export function matchLanguage(locale: string | undefined): Language {
  const tag = (locale || '').toLowerCase();
  if (tag.startsWith('pt')) return 'pt-BR';
  if (tag.startsWith('es')) return 'es';
  return 'en';
}

export function translate(
  language: Language,
  key: MessageKey | string,
  params: Record<string, string | number> = {},
): string {
  const template = (MESSAGES[language] as Record<string, string>)[key] ?? (en as Record<string, string>)[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** The translated message for an error code; unknown codes fall back to a generic message. */
export function translateError(language: Language, error: ErrorInfo): string {
  const key = `errors.${error.code}`;
  const known = key in (en as Record<string, string>);
  return translate(language, known ? key : 'errors.unexpected', {detail: error.code, ...error.params});
}
