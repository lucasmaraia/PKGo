// Finds PS4 consoles on the local network.
//
// 1. Device Discovery Protocol (DDP): the PS4 answers a UDP "SRCH" broadcast on
//    port 987 with its name and power state, even in rest mode.
// 2. If nobody answers, every address of the local /24 is checked for the
//    GoldHEN FTP server, which also tells whether GoldHEN is loaded.
import dgram from 'node:dgram';
import type {DiscoveredConsole} from '@shared/types';
import {probeFtp} from '../console/FtpClient';
import {broadcastAddress, lanAddresses, subnetHosts} from './lan';

const DDP_PORT = 987;
const DDP_SEARCH = 'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00020020\n';

export interface DdpReply {
  status: 'on' | 'standby';
  type: string | null;
  name: string | null;
  id: string | null;
}

/** Parses a DDP reply ("HTTP/1.1 200 Ok" when on, "620 Server Standby" in rest mode). */
export function parseDdpReply(text: string): DdpReply | null {
  const [statusLine, ...lines] = text.split(/\r?\n/);
  const code = /^HTTP\/1\.1 (\d{3})/.exec(statusLine || '')?.[1];
  if (!code) return null;
  const fields = new Map<string, string>();
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at > 0) fields.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return {
    status: code === '200' ? 'on' : 'standby',
    type: fields.get('host-type') || null,
    name: fields.get('host-name') || null,
    id: fields.get('host-id') || null,
  };
}

/** Broadcasts a DDP search on every local network and collects PS4 replies. */
export function searchDdp(timeout = 1500): Promise<Map<string, DdpReply>> {
  return new Promise(resolve => {
    const found = new Map<string, DdpReply>();
    const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
    const finish = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(found);
    };
    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      const reply = parseDdpReply(msg.toString('utf8'));
      if (reply && (!reply.type || /PS4/i.test(reply.type))) found.set(rinfo.address, reply);
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const targets = new Set(['255.255.255.255', ...lanAddresses().map(a => broadcastAddress(a.address, a.netmask))]);
      const message = Buffer.from(DDP_SEARCH);
      for (const target of targets) socket.send(message, DDP_PORT, target, () => {});
      setTimeout(finish, timeout);
    });
  });
}

/** Checks `hosts` for an FTP server on `port`, a few at a time. */
async function scanFtp(hosts: string[], port: number, concurrency = 64, timeout = 400): Promise<string[]> {
  const found: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++]!;
      if (await probeFtp(host, port, timeout)) found.push(host);
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, hosts.length)}, worker));
  return found;
}

export async function discoverConsoles(ftpPort: number): Promise<DiscoveredConsole[]> {
  const ddp = await searchDdp();
  const consoles: DiscoveredConsole[] = await Promise.all(
    [...ddp].map(async ([ip, reply]) => ({
      ip,
      name: reply.name,
      status: reply.status,
      goldhen: await probeFtp(ip, ftpPort),
    })),
  );
  if (consoles.length) return consoles;
  const hosts = [...new Set(lanAddresses().flatMap(a => subnetHosts(a.address)))];
  const ftp = await scanFtp(hosts, ftpPort);
  return ftp.map(ip => ({ip, name: null, status: null, goldhen: true}));
}
