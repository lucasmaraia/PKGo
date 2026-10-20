import {translate, translateError, type MessageKey} from '@shared/i18n';
import type {ErrorInfo, Language} from '@shared/types';

let language: Language = 'en';

export const currentLanguage = (): Language => language;

export const t = (key: MessageKey | string, params?: Record<string, string | number>): string =>
  translate(language, key, params);

/** Message for an error from the API (ErrorInfo) or anything else thrown. */
export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return translateError(language, error as ErrorInfo);
  return translateError(language, {code: 'unexpected', params: {detail: String(error)}});
}

/**
 * Sets the language and translates the static page: elements with
 * data-i18n (text), data-i18n-placeholder and data-i18n-title.
 */
export function setLanguage(next: Language): boolean {
  if (next === language && document.documentElement.lang === next) return false;
  language = next;
  document.documentElement.lang = next;
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle!);
  return true;
}
