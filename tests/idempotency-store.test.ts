import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../src/state/idempotency-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('idempotency store', () => {
  it('marks duplicate registrations and prunes expired entries', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-idempotency-'));
    tempDirs.push(dir);
    const store = new IdempotencyStore(dir);

    const first = await store.register('message::1', 'message', 86400);
    const second = await store.register('message::1', 'message', 86400);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.entry.duplicate_count).toBe(1);

    const filePath = path.join(dir, 'idempotency.json');
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as { version: 1; entries: Record<string, { last_seen_at: string }> };
    raw.entries['stale'] = {
      key: 'stale',
      kind: 'message',
      first_seen_at: '2000-01-01T00:00:00.000Z',
      last_seen_at: '2000-01-01T00:00:00.000Z',
      duplicate_count: 0,
    } as any;
    await fs.writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    await store.register('message::2', 'message', 1);
    expect((await store.tail(10)).some((entry) => entry.key === 'stale')).toBe(false);
  });
});
