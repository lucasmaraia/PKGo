// HTTP server the PS4 downloads PKGs from. It serves only library files, by
// their id (/pkg/<id>.pkg), with range support: the console downloads in
// chunks and resumes. Nothing else on this PC is reachable through it.
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import {ServedRanges} from './ServedRanges';

export interface ServableFile {
  id: string;
  path: string;
  size: number;
}

export class PkgFileServer {
  private server: http.Server;
  /** Bytes of each PKG already handed to the console. */
  readonly served = new ServedRanges();

  constructor(private readonly lookup: (id: string) => ServableFile | undefined) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  /** Listens on `preferredPort` (stable for firewall rules), or any free port if taken. */
  async listen(preferredPort: number): Promise<number> {
    const attempt = (port: number) =>
      new Promise<void>((resolve, reject) => {
        const onError = (e: Error) => {
          this.server.off('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          this.server.off('error', onError);
          resolve();
        };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen(port, '0.0.0.0');
      });
    try {
      await attempt(preferredPort);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      await attempt(0);
    }
    return this.port;
  }

  get port(): number {
    return (this.server.address() as net.AddressInfo | null)?.port ?? 0;
  }

  /** Stops serving, cutting downloads in progress (closing waits for none). */
  close(): Promise<void> {
    return new Promise(resolve => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Match the path only: the PS4 download service adds query parameters.
    const {pathname} = new URL(req.url || '/', 'http://localhost');
    const match = /^\/pkg\/([0-9a-f]{12})\.pkg$/.exec(pathname);
    const file = match && (req.method === 'GET' || req.method === 'HEAD') ? this.lookup(match[1]!) : undefined;
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    const size = file.size;
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (req.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!m || (!m[1] && !m[2])) return this.unsatisfiable(res, size);
      if (!m[1]) start = Math.max(0, size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= size) return this.unsatisfiable(res, size);
      status = 206;
    }
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file.path, {start, end});
    let pos = start;
    stream.on('data', chunk => {
      this.served.mark(file.id, pos, pos + chunk.length);
      pos += chunk.length;
    });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  private unsatisfiable(res: http.ServerResponse, size: number): void {
    res.writeHead(416, {'Content-Range': `bytes */${size}`});
    res.end();
  }
}
