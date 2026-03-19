import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock } from '../src/runtime/instance-lock.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('instance lock', () => {
  it('creates and releases a lock file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-lock-'));
    tempDirs.push(dir);

    const lock = await acquireInstanceLock({
      storageDir: dir,
      serviceName: 'feishu-bridge',
      ownerPid: 4242,
      isProcessAlive: () => false,
    });

    expect(await read(lock.lockPath)).toContain('"pid": 4242');
    await lock.release();
    await expect(fs.access(lock.lockPath)).rejects.toThrow();
  });

  it('rejects when another live process owns the lock', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-lock-'));
    tempDirs.push(dir);

    const lockPath = path.join(dir, 'feishu-bridge.lock');
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        instance_id: 'existing',
        pid: 7331,
        started_at: new Date().toISOString(),
        cwd: dir,
      }),
      'utf8',
    );

    await expect(
      acquireInstanceLock({
        storageDir: dir,
        serviceName: 'feishu-bridge',
        isProcessAlive: (pid) => pid === 7331,
      }),
    ).rejects.toThrow('Another feishu-bridge instance is already running');
  });

  it('replaces stale lock files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-lock-'));
    tempDirs.push(dir);

    const lockPath = path.join(dir, 'feishu-bridge.lock');
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        instance_id: 'stale',
        pid: 9999,
        started_at: new Date().toISOString(),
        cwd: dir,
      }),
      'utf8',
    );

    const lock = await acquireInstanceLock({
      storageDir: dir,
      serviceName: 'feishu-bridge',
      ownerPid: 8888,
      isProcessAlive: () => false,
    });

    expect(await read(lock.lockPath)).toContain('"pid": 8888');
    await lock.release();
  });
});

async function read(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}
