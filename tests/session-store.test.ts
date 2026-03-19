import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore, buildConversationKey } from '../src/state/session-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('session store', () => {
  it('persists selected project and thread metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-store-'));
    tempDirs.push(dir);
    const store = new SessionStore(dir);
    const key = buildConversationKey({ tenantKey: 'tenant', chatId: 'chat', actorId: 'user', scope: 'chat-user' });

    await store.ensureConversation(key, {
      chat_id: 'chat',
      actor_id: 'user',
      tenant_key: 'tenant',
      scope: 'chat-user',
    });
    await store.selectProject(key, 'repo-a');
    await store.upsertProjectSession(key, 'repo-a', {
      thread_id: 'thread-1',
      last_prompt: 'hello',
      last_response_excerpt: 'world',
    });

    const conversation = await store.getConversation(key);
    expect(conversation?.selected_project_alias).toBe('repo-a');
    expect(conversation?.projects['repo-a']?.thread_id).toBe('thread-1');
    expect(conversation?.projects['repo-a']?.sessions?.['thread-1']?.last_response_excerpt).toBe('world');
  });

  it('keeps both updates under concurrent writes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-store-'));
    tempDirs.push(dir);
    const store = new SessionStore(dir);
    const key = buildConversationKey({ tenantKey: 'tenant', chatId: 'chat', actorId: 'user', scope: 'chat-user' });

    await store.ensureConversation(key, {
      chat_id: 'chat',
      actor_id: 'user',
      tenant_key: 'tenant',
      scope: 'chat-user',
    });

    await Promise.all([
      store.upsertProjectSession(key, 'repo-a', { thread_id: 'thread-a' }),
      store.upsertProjectSession(key, 'repo-b', { thread_id: 'thread-b' }),
    ]);

    const conversation = await store.getConversation(key);
    expect(conversation?.projects['repo-a']?.thread_id).toBe('thread-a');
    expect(conversation?.projects['repo-b']?.thread_id).toBe('thread-b');
  });

  it('switches active sessions and keeps history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-store-'));
    tempDirs.push(dir);
    const store = new SessionStore(dir);
    const key = buildConversationKey({ tenantKey: 'tenant', chatId: 'chat', actorId: 'user', scope: 'chat-user' });

    await store.ensureConversation(key, {
      chat_id: 'chat',
      actor_id: 'user',
      tenant_key: 'tenant',
      scope: 'chat-user',
    });
    await store.upsertProjectSession(key, 'repo-a', { thread_id: 'thread-1', last_prompt: 'a' });
    await store.clearActiveProjectSession(key, 'repo-a');
    await store.upsertProjectSession(key, 'repo-a', { thread_id: 'thread-2', last_prompt: 'b' });

    expect((await store.listProjectSessions(key, 'repo-a')).map((session) => session.thread_id)).toEqual(['thread-2', 'thread-1']);

    await store.setActiveProjectSession(key, 'repo-a', 'thread-1');
    const conversation = await store.getConversation(key);
    expect(conversation?.projects['repo-a']?.thread_id).toBe('thread-1');

    await store.dropProjectSession(key, 'repo-a', 'thread-1');
    const afterDrop = await store.getConversation(key);
    expect(afterDrop?.projects['repo-a']?.thread_id).toBe('thread-2');
  });

  it('persists active_backend through setProjectBackend and upsertProjectSession', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-store-'));
    tempDirs.push(dir);
    const store = new SessionStore(dir);
    const key = buildConversationKey({ tenantKey: 'tenant', chatId: 'chat', actorId: 'user', scope: 'chat-user' });

    await store.ensureConversation(key, {
      chat_id: 'chat',
      actor_id: 'user',
      tenant_key: 'tenant',
      scope: 'chat-user',
    });

    await store.setProjectBackend(key, 'repo-a', 'claude');
    expect(await store.getProjectBackend(key, 'repo-a')).toBe('claude');

    // upsertProjectSession normalizes internally — verify active_backend is preserved
    await store.upsertProjectSession(key, 'repo-a', {
      thread_id: 'thread-1',
      last_prompt: 'hello',
    });
    expect(await store.getProjectBackend(key, 'repo-a')).toBe('claude');
  });

  it('builds different keys for shared and actor-scoped sessions', () => {
    const shared = buildConversationKey({ tenantKey: 'tenant', chatId: 'chat', scope: 'chat' });
    const actor = buildConversationKey({ tenantKey: 'tenant', chatId: 'chat', actorId: 'user', scope: 'chat-user' });
    expect(shared).not.toBe(actor);
  });
});
