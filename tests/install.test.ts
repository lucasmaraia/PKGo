import net from 'node:net';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {KlogMonitor, parseKlogLine} from '@core/console/KlogMonitor';
import {InstallQueue, type InstallContext} from '@core/install/InstallQueue';
import {MAX_ATTEMPTS, type KlogStatus} from '@shared/types';
import type {LibraryEntry} from '@core/library/LibraryService';
import {ServedRanges} from '@core/server/ServedRanges';

describe('parseKlogLine', () => {
  const line = (s: string) => parseKlogLine(`<118>${s}`);

  it('recognizes tasks created by our payload by their option', () => {
    expect(line('Task 0000006a : option 00010000')).toEqual({type: 'ourTask', task: '0000006a'});
    expect(line('Task 0000006a : option 00000000')).toBeNull();
  });

  it('reads failed and finished tasks', () => {
    expect(
      line(
        'Task 00000056 : 0000000092910575(51 msec) [type=1,subtype=6,slot=00] : ended (state=0,runstate=2,error=0x80991404)',
      ),
    ).toEqual({type: 'taskEnded', task: '00000056', state: 0, error: 0x80991404 | 0});
    expect(
      line(
        'Task 10000001 : 0000001012379046(53960 msec) [type=1,subtype=6,slot=00] : ended (state=3,runstate=4,error=0x0)',
      ),
    ).toMatchObject({error: 0, state: 3});
    expect(line('Task 00000056 : deleted')).toEqual({type: 'taskDeleted', task: '00000056'});
    expect(line('Task 00000056 : deleting')).toBeNull();
  });

  it('reads install results on internal and extended storage', () => {
    expect(line('end sceAppInstaller::AppInstallApp(/user/bgft/task/0000006a)=0x00000000')).toEqual({
      type: 'installEnded',
      task: '0000006a',
      result: 0,
    });
    expect(line('end sceAppInstaller::AppInstallApp(/mnt/ext0/user/bgft/task/10000004)=0x80A30026')).toMatchObject({
      task: '10000004',
      result: 0x80a30026 | 0,
    });
  });

  it('notices games being deleted', () => {
    expect(line('[BGFT] [5190] GameWillDelete(CUSA03587)')).toEqual({type: 'gameDeleted', titleId: 'CUSA03587'});
    expect(line('[SceShellCore] Libc Heap Status: free 36%')).toBeNull();
  });
});

describe('InstallQueue', () => {
  const entry: LibraryEntry = {
    id: 'aaaaaaaaaaaa',
    path: '/x/game.pkg',
    name: 'game.pkg',
    size: 1000,
    mtime: 0,
    info: {titleId: 'CUSA00001', contentId: 'UP0000-CUSA00001_00-GAME000000000000', kind: 'game', category: 'gd'},
    error: null,
  };
  let blocked: string[];
  let served: ServedRanges;
  let queue: InstallQueue;
  let removed: (string | null)[];
  let removeWorks: boolean;
  let sent: number;

  beforeEach(() => {
    vi.useFakeTimers();
    blocked = [];
    removed = [];
    removeWorks = true;
    sent = 0;
    served = new ServedRanges();
    const ctx: InstallContext = {
      library: id => (id === entry.id ? entry : undefined),
      title: () => 'Game',
      payload: {
        available: true,
        install: async () => {
          sent++;
        },
      },
      files: {served, block: id => void blocked.push(id), unblock: id => (blocked = blocked.filter(b => b !== id))},
      network: () => ({ps4Ip: '192.168.0.43', pcIp: '192.168.0.20', port: 8686}),
      removeTask: async task => {
        removed.push(task);
        return removeWorks;
      },
      onChange: () => {},
      onDownloaded: () => {},
    };
    queue = new InstallQueue(ctx, {retryDelay: 10_000, cleanupDelay: 2000});
  });

  afterEach(() => vi.useRealTimers());

  /** Lets the queue start the job and reach the download loop. */
  async function startJob() {
    const job = queue.enqueue(entry.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(job.state).toBe('installing');
    return job;
  }

  it('cancels a job being sent, stops serving its file and removes the PS4 download', async () => {
    const job = await startJob();
    queue.attachTask('0000006a');
    queue.cancel(job.id);
    expect(job.state).toBe('cancelled');
    expect(blocked).toEqual([entry.id]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(job.state).toBe('cancelled');
    expect(removed).toEqual(['0000006a']);
    expect(job.cleanup).toBe('done');
    expect(() => queue.cancel(job.id)).toThrow(expect.objectContaining({code: 'jobNotActive'}));
  });

  it('looks the download up by content ID when the PS4 log did not name it', async () => {
    const job = await startJob();
    removeWorks = false;
    queue.cancel(job.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(removed).toEqual([null]);
    expect(job.cleanup).toBe('failed');
  });

  it('sends a failed download again, after removing the failed one', async () => {
    const job = await startJob();
    queue.attachTask('00000056');
    queue.taskEnded('00000056', 0x80991404 | 0);
    expect(job.state).toBe('queued');
    expect(job.attempt).toBe(2);
    expect(job.error).toEqual({code: 'ps4DownloadFailed', params: {code: '0x80991404'}});
    await vi.advanceTimersByTimeAsync(9000);
    expect(removed).toEqual(['00000056']);
    expect(sent).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toBe(2);
    expect(job.state).toBe('installing');
    expect(job.taskId).toBeUndefined();
  });

  it('gives up after the last try', async () => {
    const job = await startJob();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(job.attempt).toBe(attempt);
      queue.attachTask(`0000005${attempt}`);
      queue.taskEnded(`0000005${attempt}`, 0x80991404 | 0);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(job.state).toBe('error');
    expect(sent).toBe(MAX_ATTEMPTS);
  });

  it('retries a download the PS4 never started', async () => {
    const job = await startJob();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(job.state).toBe('queued');
    expect(job.error?.code).toBe('downloadNotStarted');
  });

  it('does not retry a download cancelled on the PS4, nor try to remove it', async () => {
    const job = await startJob();
    queue.attachTask('00000057');
    queue.taskDeleted('00000057');
    expect(job.state).toBe('error');
    expect(job.error?.code).toBe('ps4Cancelled');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(removed).toEqual([]);
  });

  it('ignores tasks of other downloads and successful endings', async () => {
    const job = await startJob();
    queue.attachTask('00000058');
    queue.taskEnded('99999999', 0x80991404 | 0);
    queue.taskEnded('00000058', 0);
    expect(job.state).toBe('installing');
  });

  it('finishes when the whole file was served', async () => {
    const job = await startJob();
    served.mark(entry.id, 0, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(job.state).toBe('done');
    queue.installEnded(job.taskId ?? 'none', 0);
    expect(job.state).toBe('done');
  });
});

describe('KlogMonitor', () => {
  /** Fake klog server; `serve` decides what each connection gets. */
  async function server(serve: (sock: net.Socket, n: number) => void) {
    let n = 0;
    const srv = net.createServer(sock => serve(sock, ++n));
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    return {srv, port: (srv.address() as net.AddressInfo).port};
  }

  function track(monitor: KlogMonitor) {
    const statuses: KlogStatus[] = [];
    monitor.on('status', s => statuses.push(s));
    return statuses;
  }

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10));
    expect(check()).toBe(true);
  };

  it('reads events from the log', async () => {
    const {srv, port} = await server(sock => sock.write('<118>Task 0000006a : option 00010000\n'));
    const monitor = new KlogMonitor(() => '127.0.0.1', port);
    const events: unknown[] = [];
    monitor.on('event', e => events.push(e));
    monitor.start();
    await until(() => events.length === 1);
    expect(events[0]).toEqual({type: 'ourTask', task: '0000006a'});
    expect(monitor.status).toBe('live');
    monitor.stop();
    srv.close();
  });

  it('backs off when another reader keeps taking the log', async () => {
    // Like GoldHEN when someone else connects: our connection is closed at once.
    const {srv, port} = await server(sock => sock.end());
    const monitor = new KlogMonitor(() => '127.0.0.1', port, {retryMs: 10, busyRetryMs: 60_000});
    const statuses = track(monitor);
    monitor.start();
    await until(() => monitor.status === 'busy');
    expect(statuses).toContain('live');
    monitor.stop();
    srv.close();
  });

  it('tells when the log server does not answer', async () => {
    const {srv, port} = await server(() => {});
    await new Promise(r => srv.close(r));
    const monitor = new KlogMonitor(() => '127.0.0.1', port, {retryMs: 60_000});
    monitor.start();
    await until(() => monitor.status === 'unavailable');
    monitor.stop();
    expect(monitor.status).toBe('off');
  });
});
