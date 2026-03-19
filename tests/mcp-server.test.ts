import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMcpRequest } from '../src/mcp/server.js';

const tempDirs: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalHome = process.env.HOME;

afterEach(async () => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('mcp server', () => {
  it('serves MCP runtime tools, project switching, session adoption, and natural-language command execution', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-mcp-'));
    tempDirs.push(cwd);
    const codexHome = path.join(cwd, '.codex-home');
    const configPath = path.join(cwd, 'bridge.toml');
    const repoA = path.join(cwd, 'repo-a');
    const repoB = path.join(cwd, 'repo-b');
    await Promise.all([
      fs.mkdir(repoA, { recursive: true }),
      fs.mkdir(repoB, { recursive: true }),
      fs.mkdir(path.join(codexHome, 'sessions', '2026', '03', '11'), { recursive: true }),
    ]);
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = cwd;

    await fs.writeFile(
      configPath,
      [
        'version = 1',
        '',
        '[service]',
        'name = "test-bridge"',
        'project_switch_auto_adopt_latest = true',
        '',
        '[storage]',
        `dir = "${path.join(cwd, 'state')}"`,
        '',
        '[security]',
        'admin_chat_ids = ["chat-admin"]',
        'operator_chat_ids = ["chat-1"]',
        '',
        '[feishu]',
        'app_id = "app-id"',
        'app_secret = "app-secret"',
        '',
        '[projects.default]',
        `root = "${repoA}"`,
        'mention_required = false',
        '',
        '[projects.repo-b]',
        `root = "${repoB}"`,
        'mention_required = false',
      ].join('\n'),
      'utf8',
    );
    await writeCodexSession(
      path.join(codexHome, 'sessions', '2026', '03', '11', 'repo-b.jsonl'),
      {
        id: 'thread-repo-b',
        cwd: repoB,
        timestamp: '2026-03-11T10:00:00.000Z',
      },
    );

    const init = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0.0' } },
      },
      { cwd, configPath },
    );
    expect(init?.result).toMatchObject({
      serverInfo: {
        name: 'feishu-bridge',
      },
      capabilities: {
        tools: {},
      },
    });

    const tools = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
      { cwd, configPath },
    );
    const toolNames = ((tools?.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
    expect(toolNames).toContain('projects.list');
    expect(toolNames).toContain('project.create');
    expect(toolNames).toContain('project.switch');
    expect(toolNames).toContain('sessions.list');
    expect(toolNames).toContain('session.adopt');
    expect(toolNames).toContain('status.get');
    expect(toolNames).toContain('command.interpret');
    expect(toolNames).toContain('command.execute');
    expect(toolNames).toContain('config.history');

    const status = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'status.get', arguments: {} },
      },
      { cwd, configPath },
    );
    expect((status?.result as { structuredContent?: { running: boolean } }).structuredContent?.running).toBe(false);

    const interpret = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'command.interpret', arguments: { text: '切换到项目 repo-b' } },
      },
      { cwd, configPath },
    );
    expect((interpret?.result as { structuredContent?: { supported: boolean } }).structuredContent).toMatchObject({
      supported: true,
    });

    const switched = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'command.execute', arguments: { chatId: 'chat-1', text: '切换到项目 repo-b' } },
      },
      { cwd, configPath },
    );
    expect((switched?.result as { structuredContent?: { executed: boolean; kind: string; projectAlias: string; autoAdoption?: { kind: string } } }).structuredContent).toMatchObject({
      executed: true,
      kind: 'project',
      projectAlias: 'repo-b',
      autoAdoption: { kind: 'adopted' },
    });

    const createdRoot = path.join(cwd, 'repo-c');
    const created = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: { name: 'project.create', arguments: { chatId: 'chat-admin', projectAlias: 'repo-c', root: createdRoot } },
      },
      { cwd, configPath },
    );
    expect((created?.result as { structuredContent?: { alias: string; root: string; created: boolean } }).structuredContent).toMatchObject({
      alias: 'repo-c',
      root: createdRoot,
      created: true,
    });
    const createdStat = await fs.stat(createdRoot);
    expect(createdStat.isDirectory()).toBe(true);

    const savedSessions = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'sessions.list', arguments: { chatId: 'chat-1', projectAlias: 'repo-b' } },
      },
      { cwd, configPath },
    );
    expect((savedSessions?.result as { structuredContent?: { activeSessionId: string; sessions: Array<{ thread_id: string }> } }).structuredContent).toMatchObject({
      activeSessionId: 'thread-repo-b',
      sessions: [{ thread_id: 'thread-repo-b' }],
    });

    const adoptCandidates = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'session.adopt', arguments: { chatId: 'chat-1', projectAlias: 'repo-b', target: 'list' } },
      },
      { cwd, configPath },
    );
    expect((adoptCandidates?.result as { structuredContent?: { candidates: Array<{ sessionId: string }> } }).structuredContent?.candidates?.[0]?.sessionId).toBe('thread-repo-b');

    const statusDetail = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'command.execute', arguments: { chatId: 'chat-1', projectAlias: 'repo-b', text: '查看详细状态' } },
      },
      { cwd, configPath },
    );
    expect((statusDetail?.result as { structuredContent?: { executed: boolean; kind: string; projectAlias: string; activeSessionId: string } }).structuredContent).toMatchObject({
      executed: true,
      kind: 'status',
      projectAlias: 'repo-b',
      activeSessionId: 'thread-repo-b',
    });
  });
});

async function writeCodexSession(
  filePath: string,
  input: { id: string; cwd: string; timestamp: string },
): Promise<void> {
  const payload = {
    type: 'session_meta',
    payload: {
      id: input.id,
      timestamp: input.timestamp,
      cwd: input.cwd,
    },
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}
