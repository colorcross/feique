import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/state/memory-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('memory store', () => {
  it('persists, searches, archives/restores, and summarizes project/group memories', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-memory-'));
    tempDirs.push(dir);
    const store = new MemoryStore(dir);
    await store.ensureReady();

    const memory = await store.saveProjectMemory({
      project_alias: 'default',
      title: '发布步骤',
      content: '发布前先 pnpm build，再执行 npm publish。',
      pinned: true,
      created_by: 'user',
    });
    expect(memory.project_alias).toBe('default');
    expect(memory.scope).toBe('project');

    const hits = await store.searchProjectMemories('default', 'npm publish', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe('发布步骤');
    expect(await store.searchProjectMemories('default', '发布步骤', 5, { source: 'manual' })).toHaveLength(1);
    expect(await store.searchProjectMemories('default', '发布步骤', 5, { source: 'wiki' })).toHaveLength(0);
    expect(await store.searchProjectMemories('default', '发布步骤', 5, { created_by: 'user' })).toHaveLength(1);
    expect(await store.searchProjectMemories('default', '发布步骤', 5, { created_by: 'other-user' })).toHaveLength(0);
    expect((await store.listRecentProjectMemories('default', 5, { created_by: 'user' }))[0]?.created_by).toBe('user');

    const groupMemory = await store.saveGroupMemory({
      project_alias: 'default',
      chat_id: 'oc_group_1',
      title: '值班约定',
      content: '本群发布窗口固定在周五 20:00。',
      created_by: 'user',
    });
    expect(groupMemory.scope).toBe('group');
    expect(groupMemory.chat_id).toBe('oc_group_1');

    const groupHits = await store.searchGroupMemories('default', 'oc_group_1', '周五 20:00', 5);
    expect(groupHits).toHaveLength(1);
    expect(groupHits[0]?.id).toBe(groupMemory.id);

    const pinned = await store.setMemoryPinned({ scope: 'group', project_alias: 'default', chat_id: 'oc_group_1' }, groupMemory.id, true);
    expect(pinned?.pinned).toBe(true);
    expect(await store.countPinnedGroupMemories('default', 'oc_group_1')).toBe(1);
    expect((await store.getOldestPinnedMemory({ scope: 'group', project_alias: 'default', chat_id: 'oc_group_1' }))?.id).toBe(groupMemory.id);

    const newerPinned = await store.saveGroupMemory({
      project_alias: 'default',
      chat_id: 'oc_group_1',
      title: '新置顶',
      content: '这是新的 pinned 项。',
      created_by: 'user',
      pinned: true,
    });
    expect((await store.getOldestPinnedMemory({ scope: 'group', project_alias: 'default', chat_id: 'oc_group_1' }, 'updated_at'))?.id).toBe(groupMemory.id);
    await store.searchGroupMemories('default', 'oc_group_1', '周五', 5);
    expect((await store.getOldestPinnedMemory({ scope: 'group', project_alias: 'default', chat_id: 'oc_group_1' }, 'last_accessed_at'))?.id).toBe(newerPinned.id);

    const archived = await store.archiveMemory({ scope: 'group', project_alias: 'default', chat_id: 'oc_group_1' }, groupMemory.id, {
      archived_by: 'user',
      reason: 'manual',
    });
    expect(archived?.archived_by).toBe('user');
    expect(await store.getMemory({ scope: 'group', project_alias: 'default', chat_id: 'oc_group_1' }, groupMemory.id)).toBeNull();
    expect((await store.getMemoryById({ scope: 'group', project_alias: 'default', chat_id: 'oc_group_1' }, groupMemory.id, { includeArchived: true, includeExpired: true }))?.archive_reason).toBe('manual');
    expect(await store.searchGroupMemories('default', 'oc_group_1', '周五 20:00', 5)).toHaveLength(0);

    const restored = await store.restoreMemory({ scope: 'group', project_alias: 'default', chat_id: 'oc_group_1' }, groupMemory.id, 'user');
    expect(restored?.archived_at).toBeUndefined();
    expect(await store.searchGroupMemories('default', 'oc_group_1', '周五 20:00', 5)).toHaveLength(1);

    await store.saveProjectMemory({
      project_alias: 'default',
      title: '过期约定',
      content: '这条记忆应该被清理。',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await store.searchProjectMemories('default', '过期约定', 5)).toHaveLength(0);
    expect(await store.cleanupExpiredMemories({ scope: 'project', project_alias: 'default' })).toBe(1);
    expect(await store.cleanupExpiredMemories()).toBe(0);
    const stats = await store.getMemoryStats({ scope: 'project', project_alias: 'default' });
    expect(stats.archived_count).toBe(1);
    expect(stats.active_count).toBe(1);
    expect(stats.latest_archived_at).toBeTruthy();

    const threadSummary = await store.upsertThreadSummary({
      conversation_key: 'tenant/chat',
      project_alias: 'default',
      thread_id: 'thread-1',
      summary: '最近目标: 修复构建问题\n最近结果: 已补测试并通过。',
      recent_prompt: '修复构建问题',
      recent_response_excerpt: '已补测试并通过。',
      files_touched: ['src/app.ts'],
      open_tasks: ['补一次真实联调'],
      decisions: ['先修根因，再发版'],
    });
    expect(threadSummary.files_touched).toContain('src/app.ts');

    const loaded = await store.getThreadSummary('tenant/chat', 'default', 'thread-1');
    expect(loaded?.summary).toContain('最近目标');
    expect(loaded?.open_tasks).toContain('补一次真实联调');
  });
});
