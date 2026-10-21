// Region of a package and whether an update or DLC fits the game on the PS4.
// The content ID tells the region (UP9000-CUSA08809_00-…: U = Americas) and
// each regional release of a game has its own title ID, so an update or DLC
// only works on the game with its exact title ID. One made for another
// region's release of the same game (found by its name) does not.
import type {Region} from '@shared/types';

const REGIONS: Record<string, Region> = {U: 'US', E: 'EU', J: 'JP', H: 'ASIA'};

/** Region from a content ID (UP/EP/JP/HP…); null for homebrew and unknown prefixes. */
export function regionOf(contentId: string | null | undefined): Region | null {
  const m = /^([A-Z])P\d{4}-/.exec(contentId || '');
  return (m && REGIONS[m[1]!]) || null;
}

/** Name used to recognise the same game across regions. */
export const sameName = (title: string): string =>
  title
    // Before NFKD, which turns ™ into "TM".
    .replace(/[™®©]/g, '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

export interface InstalledGame {
  titleId: string;
  contentId: string | null;
  /** Names in every language its PKG has. */
  names: string[];
}

export interface Conflict {
  titleId: string;
  region: Region | null;
}

/**
 * For an update or DLC: the release of the same game installed on the PS4 when
 * it is not the one the package was made for. null when it fits, or when there
 * is nothing to compare with.
 */
export function regionConflict(
  pkg: {kind: string; titleId: string | null; contentId: string | null; names: string[]},
  installed: InstalledGame[],
): Conflict | null {
  if ((pkg.kind !== 'patch' && pkg.kind !== 'dlc') || !pkg.titleId) return null;
  const exact = installed.find(g => g.titleId === pkg.titleId);
  if (exact) {
    // Same title ID from another region would be unusual, but say so if it happens.
    const mine = regionOf(pkg.contentId);
    const theirs = regionOf(exact.contentId);
    return mine && theirs && mine !== theirs ? {titleId: exact.titleId, region: theirs} : null;
  }
  const other = installed.find(g => g.names.some(game => pkg.names.some(name => belongsTo(name, game, pkg.kind))));
  return other ? {titleId: other.titleId, region: regionOf(other.contentId)} : null;
}

/** Lower case, plain quotes and spaces, no trademark signs. */
const tidy = (s: string) =>
  s
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[‘’`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/**
 * An update carries its game's name; a DLC is named "Game: add-on" (or
 * "Game - add-on"). The separator keeps "Knack 2: X" away from "Knack".
 */
function belongsTo(name: string, game: string, kind: string): boolean {
  if (sameName(name) && sameName(name) === sameName(game)) return true;
  if (kind !== 'dlc') return false;
  const g = tidy(game);
  const n = tidy(name);
  return g.length >= 4 && [':', ' -', ' –', ' —'].some(sep => n.startsWith(g + sep));
}
