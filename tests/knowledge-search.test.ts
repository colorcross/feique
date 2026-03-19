import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveKnowledgeRoots, searchKnowledgeBase } from '../src/knowledge/search.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('knowledge search', () => {
  it('searches configured documentation roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-kb-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'install.md'), '# Install\nUse npm install -g feishu-bridge\n', 'utf8');

    const project = {
      root,
      session_scope: 'chat' as const,
      mention_required: false,
      knowledge_paths: ['docs'],
      wiki_space_ids: [],
      admin_chat_ids: [],
      run_priority: 100,
      chat_rate_limit_window_seconds: 60,
      chat_rate_limit_max_runs: 20,
    };

    const roots = await resolveKnowledgeRoots(project);
    expect(roots).toEqual([path.join(root, 'docs')]);

    const result = await searchKnowledgeBase(project, 'feishu-bridge');
    expect(result.matches[0]).toEqual(
      expect.objectContaining({
        file: path.join(root, 'docs', 'install.md'),
      }),
    );
    expect(result.matches[0]?.text).toContain('feishu-bridge');
  });
});
