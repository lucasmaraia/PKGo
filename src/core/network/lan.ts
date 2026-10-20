import os from 'node:os';

// Virtual adapters (WSL, Hyper-V, VPNs, VMs, Docker) are unreachable from the PS4.
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier|Bluetooth|docker|br-|veth|virbr/i;

export interface LanAddress {
  name: string;
  address: string;
  netmask: string;
}

/** IPv4 addresses of real network adapters (no loopback or virtual ones). */
export function lanAddresses(): LanAddress[] {
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list || [])
      .filter(a => a.family === 'IPv4' && !a.internal && !VIRTUAL.test(name))
      .map(a => ({name, address: a.address, netmask: a.netmask})),
  );
}

const PRIVATE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

/** This PC's address as seen by the console: same subnet first, then any private address. */
export function lanIp(consoleIp = ''): string | null {
  const addrs = lanAddresses();
  const prefix = consoleIp.split('.').slice(0, 3).join('.') + '.';
  const pick =
    (consoleIp && addrs.find(a => a.address.startsWith(prefix))) ||
    addrs.find(a => a.address.startsWith('192.168.')) ||
    addrs.find(a => PRIVATE.test(a.address)) ||
    addrs[0];
  return pick?.address || null;
}

const toInt = (ip: string) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
const toIp = (n: number) => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');

export function broadcastAddress(address: string, netmask: string): string {
  return toIp((toInt(address) & toInt(netmask)) | (~toInt(netmask) >>> 0));
}

/** Host addresses of the /24 around `address` (the range a home router hands out). */
export function subnetHosts(address: string): string[] {
  const base = address.split('.').slice(0, 3).join('.');
  return Array.from({length: 254}, (_, i) => `${base}.${i + 1}`).filter(ip => ip !== address);
}
