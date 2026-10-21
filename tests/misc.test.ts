import {describe, expect, it} from 'vitest';
import {dlcLabel} from '@core/AppCore';
import {normalize} from '@core/config/ConfigStore';
import {redactHome} from '@core/diagnostics/ActivityLog';
import {parseDdpReply} from '@core/network/discovery';
import {broadcastAddress, subnetHosts} from '@core/network/lan';
import {ServedRanges} from '@core/server/ServedRanges';
import {matchLanguage, MESSAGES, translate, translateError} from '@shared/i18n';
import {nearest, type Box} from '@shared/spatial';

describe('ServedRanges', () => {
  it('counts each byte once, whatever the order and overlap of ranges', () => {
    const r = new ServedRanges();
    r.mark('a', 100, 200);
    r.mark('a', 0, 50);
    r.mark('a', 150, 300);
    r.mark('a', 50, 100);
    expect(r.bytes('a')).toBe(300);
    r.mark('a', 400, 500);
    expect(r.bytes('a')).toBe(400);
    r.reset('a');
    expect(r.bytes('a')).toBe(0);
  });
});

describe('parseDdpReply', () => {
  it('reads name, type and power state', () => {
    const on = parseDdpReply(
      'HTTP/1.1 200 Ok\nhost-id:AABBCCDDEEFF\nhost-type:PS4\nhost-name:PS4-415\nhost-request-port:997\n',
    );
    expect(on).toEqual({status: 'on', type: 'PS4', name: 'PS4-415', id: 'AABBCCDDEEFF'});
    expect(parseDdpReply('HTTP/1.1 620 Server Standby\nhost-type:PS4\n')?.status).toBe('standby');
    expect(parseDdpReply('garbage')).toBeNull();
  });
});

describe('lan helpers', () => {
  it('computes broadcast addresses and /24 hosts', () => {
    expect(broadcastAddress('192.168.0.20', '255.255.255.0')).toBe('192.168.0.255');
    expect(broadcastAddress('10.1.2.3', '255.255.0.0')).toBe('10.1.255.255');
    const hosts = subnetHosts('192.168.0.20');
    expect(hosts).toHaveLength(253);
    expect(hosts).not.toContain('192.168.0.20');
  });
});

describe('config normalize', () => {
  it('keeps valid values and drops malformed ones', () => {
    const c = normalize({
      ps4Ip: '192.168.0.43',
      unknown: true,
      ftpPort: 'x',
      folders: [{path: 'C:\\PKGs'}, {path: '/mnt/pkgs', recursive: false}, 'not-an-entry', 42],
      files: ['a.pkg', 1],
      hidden: ['abc'],
      language: 'fr',
    });
    expect(c).toEqual({
      ps4Ip: '192.168.0.43',
      ftpPort: 2121,
      serverPort: 8686,
      language: null,
      autoUpdate: true,
      folders: [
        {path: 'C:\\PKGs', recursive: true},
        {path: '/mnt/pkgs', recursive: false},
      ],
      files: ['a.pkg'],
      hidden: ['abc'],
    });
    expect(normalize({ps4Ip: '999.1.1.1'}).ps4Ip).toBe('');
    // Updates stay on unless turned off explicitly.
    expect(normalize({autoUpdate: false}).autoUpdate).toBe(false);
    expect(normalize({autoUpdate: 'no'}).autoUpdate).toBe(true);
  });
});

describe('i18n', () => {
  it('has the same keys in every language', () => {
    const base = Object.keys(MESSAGES.en).sort();
    for (const [lang, messages] of Object.entries(MESSAGES)) {
      expect(Object.keys(messages).sort(), lang).toEqual(base);
    }
  });

  it('keeps the same placeholders in every translation', () => {
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) || []).sort();
    for (const [key, text] of Object.entries(MESSAGES.en)) {
      for (const [lang, messages] of Object.entries(MESSAGES)) {
        expect(placeholders((messages as Record<string, string>)[key]!), `${lang} ${key}`).toEqual(placeholders(text));
      }
    }
  });

  it('fills placeholders and translates errors', () => {
    expect(translate('pt-BR', 'status.ready', {ip: '1.2.3.4'})).toBe('PS4 conectado · 1.2.3.4');
    expect(translateError('es', {code: 'invalidIp'})).toBe('Dirección IP no válida.');
    expect(translateError('en', {code: 'nope'})).toBe('Something went wrong (nope).');
  });

  it('maps system locales to supported languages', () => {
    expect(matchLanguage('pt-PT')).toBe('pt-BR');
    expect(matchLanguage('es-MX')).toBe('es');
    expect(matchLanguage('de-DE')).toBe('en');
  });
});

describe('dlcLabel', () => {
  it('takes the folder name the PS4 uses for a DLC from its content ID', () => {
    expect(dlcLabel('UP4064-CUSA20499_00-CUPHEADDLC000000')).toBe('CUPHEADDLC000000');
    expect(dlcLabel('UP0000-CUSA00001_00-SHORT')).toBeNull();
    expect(dlcLabel(null)).toBeNull();
  });
});

describe('redactHome', () => {
  it('hides the home folder in both slash styles', () => {
    expect(redactHome('C:\\Users\\ana\\Games and C:/Users/ana/x', 'C:\\Users\\ana')).toBe('~\\Games and ~/x');
  });
});

describe('nearest (focus navigation)', () => {
  const rect = (left: number, top: number, width = 100, height = 100) =>
    ({left, top, width, height, right: left + width, bottom: top + height}) satisfies Box;
  // A 3x2 grid of tiles plus a sidebar button on the left.
  const tiles = [rect(200, 0), rect(320, 0), rect(440, 0), rect(200, 120), rect(320, 120), rect(440, 120)];
  const side = rect(0, 130, 150, 40);
  const all = [...tiles, side];

  it('moves along rows and columns of the grid', () => {
    expect(nearest(tiles[0]!, all, 'right')).toBe(1);
    expect(nearest(tiles[1]!, all, 'down')).toBe(4);
    expect(nearest(tiles[5]!, all, 'up')).toBe(2);
    expect(nearest(tiles[2]!, all, 'right')).toBe(-1);
  });

  it('leaves the grid for the sidebar and comes back to the row in line', () => {
    expect(nearest(tiles[3]!, all, 'left')).toBe(6);
    expect(nearest(side, all, 'right')).toBe(3);
  });
});
