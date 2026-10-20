import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseKlogLine} from '@core/console/KlogMonitor';
import {InstallQueue, type InstallContext} from '@core/install/InstallQueue';
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

  beforeEach(() => {
    vi.useFakeTimers();
    blocked = [];
    served = new ServedRanges();
    const ctx: InstallContext = {
      library: id => (id === entry.id ? entry : undefined),
      title: () => 'Game',
      payload: {available: true, install: async () => {}},
      files: {served, block: id => void blocked.push(id), unblock: id => (blocked = blocked.filter(b => b !== id))},
      network: () => ({ps4Ip: '192.168.0.43', pcIp: '192.168.0.20', port: 8686}),
      onChange: () => {},
      onDownloaded: () => {},
    };
    queue = new InstallQueue(ctx);
  });

  afterEach(() => vi.useRealTimers());

  /** Lets the queue start the job and reach the download loop. */
  async function startJob() {
    const job = queue.enqueue(entry.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(job.state).toBe('installing');
    return job;
  }

  it('cancels a job being sent and stops serving its file', async () => {
    const job = await startJob();
    queue.cancel(job.id);
    expect(job.state).toBe('cancelled');
    expect(blocked).toEqual([entry.id]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(job.state).toBe('cancelled');
    expect(() => queue.cancel(job.id)).toThrow(expect.objectContaining({code: 'jobNotActive'}));
  });

  it('fails the job when the PS4 reports its download task failed', async () => {
    const job = await startJob();
    queue.attachTask('00000056');
    queue.taskEnded('00000056', 0x80991404 | 0);
    expect(job.state).toBe('error');
    expect(job.error).toEqual({code: 'ps4DownloadFailed', params: {code: '0x80991404'}});
  });

  it('reports a download cancelled on the PS4', async () => {
    const job = await startJob();
    queue.attachTask('00000057');
    queue.taskDeleted('00000057');
    expect(job.error?.code).toBe('ps4Cancelled');
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
