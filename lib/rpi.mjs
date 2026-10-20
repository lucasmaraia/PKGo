// Client for the PS4 Remote Package Installer (flatz) HTTP API, port 12800.

// Some RPI builds print numbers as bare hex literals (e.g. "length": 0x1A2B),
// which is not valid JSON. Quote them before parsing.
export function parseLoose(text) {
  return JSON.parse(text.replace(/:\s*(0x[0-9a-fA-F]+)/g, ':"$1"'));
}

export function num(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function rpiCall({ps4Ip, rpiPort}, endpoint, body, timeout = 5000) {
  if (!ps4Ip) throw new Error('IP do PS4 não configurado');
  const res = await fetch(`http://${ps4Ip}:${rpiPort}/api/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  try {
    return parseLoose(text);
  } catch {
    throw new Error(`resposta inesperada do PS4: ${text.slice(0, 80)}`);
  }
}

export function describeError(res) {
  const code = num(res.error_code ?? res.error);
  const hex = code ? ` (código 0x${(code >>> 0).toString(16).toUpperCase()})` : '';
  return `O PS4 recusou a instalação${hex}.`;
}
