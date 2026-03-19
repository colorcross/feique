import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/state/audit-log.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('audit log', () => {
  it('appends and tails structured events', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-audit-'));
    tempDirs.push(dir);
    const audit = new AuditLog(dir);

    await audit.append({ type: 'one', chat_id: 'chat-1' });
    await audit.append({ type: 'two', chat_id: 'chat-2' });

    const events = await audit.tail(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('two');
    expect(events[0]?.chat_id).toBe('chat-2');
  });

  it('archives and prunes expired events', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-audit-cleanup-'));
    tempDirs.push(dir);
    const audit = new AuditLog(dir);

    await audit.append({ type: 'fresh', at: '2026-03-10T00:00:00.000Z' });
    await audit.append({ type: 'archive', at: '2026-03-01T00:00:00.000Z' });
    await audit.append({ type: 'drop', at: '2026-02-01T00:00:00.000Z' });

    const result = await audit.cleanup({
      retentionDays: 20,
      archiveAfterDays: 7,
      archiveDir: path.join(dir, 'archive'),
      now: new Date('2026-03-12T00:00:00.000Z'),
    });

    expect(result.kept).toBe(1);
    expect(result.archived).toBe(1);
    expect(result.removed).toBe(1);

    const current = await audit.tail(10);
    expect(current.map((event) => event.type)).toEqual(['fresh']);

    const archived = await fs.readFile(path.join(dir, 'archive', 'audit.jsonl'), 'utf8');
    expect(archived).toContain('"type":"archive"');
    expect(archived).not.toContain('"type":"drop"');
  });
});
