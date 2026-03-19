import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigHistoryStore } from '../src/state/config-history-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('config history store', () => {
  it('records and lists recent config snapshots', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-config-history-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'config.toml');
    await fs.writeFile(configPath, 'version = 1\n', 'utf8');

    const store = new ConfigHistoryStore(dir);
    const first = await store.recordSnapshot({
      configPath,
      action: 'group.add',
      summary: 'oc_group_1',
      chatId: 'chat-1',
      actorId: 'user-1',
    });
    await fs.writeFile(configPath, 'version = 1\n[feishu]\nallowed_group_ids = ["oc_group_1"]\n', 'utf8');
    await store.recordSnapshot({
      configPath,
      action: 'group.remove',
      summary: 'oc_group_1',
      chatId: 'chat-1',
      actorId: 'user-1',
    });

    const snapshots = await store.listSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.action).toBe('group.remove');
    expect((await store.getSnapshot(first.id))?.summary).toBe('oc_group_1');
  });
});
