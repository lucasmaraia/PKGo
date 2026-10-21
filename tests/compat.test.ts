import {describe, expect, it} from 'vitest';
import {regionConflict, regionOf} from '@core/library/compat';

describe('regionOf', () => {
  it('reads the region from the content ID', () => {
    expect(regionOf('UP9000-CUSA08809_00-SOTC000000000000')).toBe('US');
    expect(regionOf('EP9000-CUSA08034_00-SOTC000000000000')).toBe('EU');
    expect(regionOf('JP0700-CUSA12345_00-X')).toBe('JP');
    expect(regionOf('IV0000-LAPY10010_00-HOMEBREW00000000')).toBeNull();
    expect(regionOf(null)).toBeNull();
  });
});

describe('regionConflict', () => {
  const usGame = {
    titleId: 'CUSA08809',
    contentId: 'UP9000-CUSA08809_00-SOTC000000000000',
    names: ['Shadow of the Colossus™'],
  };

  it('flags an update made for another region of the installed game', () => {
    const euPatch = {
      kind: 'patch',
      titleId: 'CUSA08034',
      contentId: 'EP9000-CUSA08034_00-SOTC000000000000',
      names: ['Shadow of the Colossus'],
    };
    expect(regionConflict(euPatch, [usGame])).toEqual({titleId: 'CUSA08809', region: 'US'});
  });

  it('accepts the update for the installed release', () => {
    const usPatch = {
      kind: 'patch',
      titleId: 'CUSA08809',
      contentId: 'UP9000-CUSA08809_00-SOTC000000000000',
      names: ['Shadow of the Colossus'],
    };
    expect(regionConflict(usPatch, [usGame])).toBeNull();
  });

  it('recognises DLCs by "Game: add-on" names, without mixing up sequels', () => {
    const marvel = {
      titleId: 'CUSA26174',
      contentId: 'UP1001-CUSA26174_00-CODA000000000000',
      names: ['Marvel’s Midnight Suns'],
    };
    const euDlc = {
      kind: 'dlc',
      titleId: 'CUSA26200',
      contentId: 'EP1001-CUSA26200_00-CODADLC200000000',
      names: ["Marvel's Midnight Suns: Redemption"],
    };
    expect(regionConflict(euDlc, [marvel])).toEqual({titleId: 'CUSA26174', region: 'US'});
    const knack = {titleId: 'CUSA00068', contentId: 'UP9000-CUSA00068_00-KNACK00000000000', names: ['KNACK™']};
    const knack2Dlc = {
      kind: 'dlc',
      titleId: 'CUSA07670',
      contentId: 'UP9000-CUSA07670_00-X',
      names: ['KNACK™ 2: Skin'],
    };
    expect(regionConflict(knack2Dlc, [knack])).toBeNull();
  });

  it('says nothing for games, or when the game is not on the PS4', () => {
    expect(
      regionConflict(
        {kind: 'game', titleId: 'CUSA08034', contentId: 'EP9000-CUSA08034_00-X', names: ['Shadow of the Colossus']},
        [usGame],
      ),
    ).toBeNull();
    expect(
      regionConflict({kind: 'patch', titleId: 'CUSA99999', contentId: 'EP0000-CUSA99999_00-X', names: ['Other Game']}, [
        usGame,
      ]),
    ).toBeNull();
  });
});
