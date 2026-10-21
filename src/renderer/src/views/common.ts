import {
  ACTIVE_JOB_STATES,
  type ConsoleItem,
  type Job,
  type LibraryItem,
  type PkgKind,
  type Region,
} from '@shared/types';
import {esc, initials} from '../format';
import {t} from '../i18n';
import {store} from '../store';

export const kindLabel = (kind: PkgKind): string => t(`kind.${kind}`);

/** "Americas (UP9000)": region and the content ID's region/publisher part. */
export function regionLabel(region: Region | null, contentId: string | null): string {
  const code = /^[A-Z]{2}\d{4}/.exec(contentId || '')?.[0];
  if (!region) return code || '';
  return code ? `${t(`region.${region}`)} (${code})` : t(`region.${region}`);
}

export const percent = (job: Job): number => (job.total ? Math.min(100, (job.transferred / job.total) * 100) : 0);

export const isActive = (job: Job | undefined): job is Job => !!job && ACTIVE_JOB_STATES.includes(job.state);

export function jobLabel(job: Job): string {
  if (job.state === 'queued') return t('jobs.queued');
  if (job.state === 'starting') return t('jobs.starting');
  return `${percent(job).toFixed(0)}%`;
}

export const itemById = (id: string): LibraryItem | undefined => store.state?.library.find(i => i.id === id);
export const latestJob = (id: string): Job | undefined => store.state?.jobs.filter(j => j.pkgId === id).at(-1);

/** Cover image of a library item, or its initials when it has none. */
export function cover(
  item: Pick<LibraryItem, 'hasIcon' | 'iconId' | 'id' | 'title'> | undefined,
  cls = 'cover',
): string {
  return item?.hasIcon
    ? `<img class="${cls}" src="app-media://icon/${item.iconId || item.id}" alt="" loading="lazy">`
    : `<div class="${cls} fallback">${initials(item?.title || 'PKG')}</div>`;
}

export function consoleCover(item: ConsoleItem, cls = 'cover'): string {
  return item.hasIcon
    ? `<img class="${cls}" src="app-media://console-icon/${esc(item.titleId)}" alt="" loading="lazy">`
    : `<div class="${cls} fallback">${initials(item.title)}</div>`;
}

export const metaLine = (parts: (string | null | false | undefined | 0)[]): string => parts.filter(Boolean).join(' · ');
