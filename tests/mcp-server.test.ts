import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(repoRoot, 'src', 'cli.ts');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('mcp server', () => {
  it('serves MCP runtime tools, project switching, session adoption, and natural-language command execution', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-mcp-'));
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

    const child = spawn(tsxBin, [cliEntry, 'mcp', '--config', configPath], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome, HOME: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);

    const client = new McpTestClient(child);
    const init = await client.request(1, 'initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0.0' } });
    expect(init.result).toMatchObject({
      serverInfo: {
        name: 'codex-feishu',
      },
      capabilities: {
        tools: {},
      },
    });

    await client.notify('notifications/initialized', {});

    const tools = await client.request(2, 'tools/list', {});
    const toolNames = ((tools.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
    expect(toolNames).toContain('projects.list');
    expect(toolNames).toContain('project.switch');
    expect(toolNames).toContain('sessions.list');
    expect(toolNames).toContain('session.adopt');
    expect(toolNames).toContain('status.get');
    expect(toolNames).toContain('command.interpret');
    expect(toolNames).toContain('command.execute');
    expect(toolNames).toContain('config.history');

    const status = await client.request(3, 'tools/call', { name: 'status.get', arguments: {} });
    expect((status.result as { structuredContent?: { running: boolean } }).structuredContent?.running).toBe(false);

    const interpret = await client.request(4, 'tools/call', {
      name: 'command.interpret',
      arguments: { text: '切换到项目 repo-b' },
    });
    expect((interpret.result as { structuredContent?: { supported: boolean; requiresConfirmation: boolean } }).structuredContent).toMatchObject({
      supported: true,
      requiresConfirmation: true,
    });

    const pendingSwitch = await client.request(5, 'tools/call', {
      name: 'command.execute',
      arguments: { chatId: 'chat-1', text: '切换到项目 repo-b' },
    });
    expect((pendingSwitch.result as { structuredContent?: { executed: boolean; requiresConfirmation: boolean } }).structuredContent).toMatchObject({
      executed: false,
      requiresConfirmation: true,
    });

    const switched = await client.request(6, 'tools/call', {
      name: 'command.execute',
      arguments: { chatId: 'chat-1', text: '切换到项目 repo-b', confirmed: true },
    });
    expect((switched.result as { structuredContent?: { executed: boolean; kind: string; projectAlias: string; autoAdoption?: { kind: string } } }).structuredContent).toMatchObject({
      executed: true,
      kind: 'project',
      projectAlias: 'repo-b',
      autoAdoption: { kind: 'adopted' },
    });

    const savedSessions = await client.request(7, 'tools/call', {
      name: 'sessions.list',
      arguments: { chatId: 'chat-1', projectAlias: 'repo-b' },
    });
    expect((savedSessions.result as { structuredContent?: { activeSessionId: string; sessions: Array<{ thread_id: string }> } }).structuredContent).toMatchObject({
      activeSessionId: 'thread-repo-b',
      sessions: [{ thread_id: 'thread-repo-b' }],
    });

    const adoptCandidates = await client.request(8, 'tools/call', {
      name: 'session.adopt',
      arguments: { chatId: 'chat-1', projectAlias: 'repo-b', target: 'list' },
    });
    expect((adoptCandidates.result as { structuredContent?: { candidates: Array<{ threadId: string }> } }).structuredContent?.candidates?.[0]?.threadId).toBe('thread-repo-b');

    const statusDetail = await client.request(9, 'tools/call', {
      name: 'command.execute',
      arguments: { chatId: 'chat-1', projectAlias: 'repo-b', text: '查看详细状态' },
    });
    expect((statusDetail.result as { structuredContent?: { executed: boolean; kind: string; projectAlias: string; activeSessionId: string } }).structuredContent).toMatchObject({
      executed: true,
      kind: 'status',
      projectAlias: 'repo-b',
      activeSessionId: 'thread-repo-b',
    });
  }, 15000);
});

class McpTestClient {
  private buffer = Buffer.alloc(0);

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    });
  }

  public async request(id: number, method: string, params: Record<string, unknown>): Promise<{ id: number; result?: unknown; error?: unknown }> {
    this.write({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });
    return this.readMessage(id);
  }

  public async notify(method: string, params: Record<string, unknown>): Promise<void> {
    this.write({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private write(payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  private async readMessage(expectedId: number): Promise<{ id: number; result?: unknown; error?: unknown }> {
    const deadline = Date.now() + 5000;
    while (true) {
      const parsed = this.tryParseMessage();
      if (parsed) {
        if (parsed.id === expectedId) {
          return parsed as { id: number; result?: unknown; error?: unknown };
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for MCP response.');
      }
      if (this.child.exitCode !== null) {
        throw new Error('MCP child exited before sending a response.');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private tryParseMessage(): Record<string, unknown> | null {
    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      return null;
    }
    const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
    const match = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      throw new Error('Missing Content-Length header in MCP response.');
    }
    const contentLength = Number(match[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (this.buffer.length < messageEnd) {
      return null;
    }
    const payload = this.buffer.slice(messageStart, messageEnd).toString('utf8');
    this.buffer = this.buffer.slice(messageEnd);
    return JSON.parse(payload) as Record<string, unknown>;
  }
}

async function writeCodexSession(
  filePath: string,
  input: {
    id: string;
    cwd: string;
    timestamp: string;
  },
): Promise<void> {
  await fs.writeFile(
    filePath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: input,
    })}\n`,
    'utf8',
  );
}
