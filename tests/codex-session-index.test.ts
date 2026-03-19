import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexSessionIndex } from '../src/codex/session-index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('codex session index', () => {
  it('prefers exact project-root matches before fuzzy historical roots', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-codex-home-'));
    tempDirs.push(codexHome);
    const currentRoot = '/workspace/acme-service';
    const previousRoot = '/archive/acme-service-repo';

    await writeSessionMeta(codexHome, 'session-exact', currentRoot, '2026-03-11T03:37:22.628Z');
    await writeSessionMeta(codexHome, 'session-old-root', previousRoot, '2026-03-10T12:06:50.670Z');
    await writeSessionMeta(codexHome, 'session-other', '/workspace/other-project', '2026-03-11T09:00:00.000Z');

    const index = new CodexSessionIndex(codexHome);
    const sessions = await index.listProjectSessions(currentRoot, 10);

    expect(sessions.map((session) => session.threadId)).toEqual(['session-exact', 'session-old-root']);
    expect(sessions[0]?.matchKind).toBe('exact-root');
    expect(sessions[1]?.matchKind).toBe('normalized-name');
  });

  it('finds fuzzy historical sessions when the project root moved', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-codex-home-'));
    tempDirs.push(codexHome);
    const currentRoot = '/workspace/acme-service';
    const previousRoot = '/archive/acme-service-repo';

    await writeSessionMeta(codexHome, 'session-old-root', previousRoot, '2026-03-10T12:06:50.670Z');

    const index = new CodexSessionIndex(codexHome);
    const adopted = await index.findLatestProjectSession(currentRoot);

    expect(adopted?.threadId).toBe('session-old-root');
    expect(adopted?.matchKind).toBe('normalized-name');
  });
});

async function writeSessionMeta(codexHome: string, threadId: string, cwd: string, timestamp: string): Promise<void> {
  const filePath = path.join(codexHome, 'sessions', '2026', '03', `${threadId}.jsonl`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const sessionMeta = {
    timestamp,
    type: 'session_meta',
    payload: {
      id: threadId,
      cwd,
      timestamp,
    },
  };
  await fs.writeFile(filePath, `${JSON.stringify(sessionMeta)}\n`, 'utf8');
}
