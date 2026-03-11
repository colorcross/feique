import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
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

describe('mcp http server', () => {
  it('serves HTTP JSON-RPC and SSE endpoints behind Bearer auth', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-mcp-http-'));
    tempDirs.push(cwd);
    const configPath = path.join(cwd, 'bridge.toml');
    const repoA = path.join(cwd, 'repo-a');
    await fs.mkdir(repoA, { recursive: true });
    await fs.writeFile(
      configPath,
      [
        'version = 1',
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
      ].join('\n'),
      'utf8',
    );

    const port = await getFreePort();
    const authToken = 'test-mcp-token';
    const child = spawn(tsxBin, [cliEntry, 'mcp', '--config', configPath, '--transport', 'http', '--host', '127.0.0.1', '--port', String(port), '--auth-token', authToken], {
      cwd,
      env: { ...process.env, HOME: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);

    await waitForHttpReady(`http://127.0.0.1:${port}/mcp`, authToken);

    const unauthorized = await request({
      url: `http://127.0.0.1:${port}/mcp`,
      method: 'GET',
    });
    expect(unauthorized.statusCode).toBe(401);

    const initialize = await request({
      url: `http://127.0.0.1:${port}/mcp`,
      method: 'POST',
      token: authToken,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0.0' } },
      }),
    });
    expect(initialize.statusCode).toBe(200);
    expect(JSON.parse(initialize.body)).toMatchObject({
      result: {
        serverInfo: {
          name: 'codex-feishu',
        },
      },
    });

    const sse = await openSse(`http://127.0.0.1:${port}/mcp/sse`, authToken);
    const endpoint = await sse.nextEvent();
    expect(endpoint.event).toBe('endpoint');
    const endpointPayload = JSON.parse(endpoint.data) as { sessionId: string; messagePath: string };
    expect(endpointPayload.sessionId).toBeTruthy();

    const accepted = await request({
      url: `http://127.0.0.1:${port}${endpointPayload.messagePath}`,
      method: 'POST',
      token: authToken,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'ping',
        params: {},
      }),
    });
    expect(accepted.statusCode).toBe(202);

    const ping = await sse.nextEvent();
    expect(ping.event).toBe('message');
    expect(JSON.parse(ping.data)).toMatchObject({
      id: 2,
      result: {},
    });

    sse.close();
  }, 15000);
});

async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHttpReady(url: string, token: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await request({ url, method: 'GET', token });
      if (response.statusCode === 200) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for MCP HTTP server.');
}

function request(input: { url: string; method: 'GET' | 'POST'; token?: string; body?: string }): Promise<{ statusCode: number; body: string }> {
  const url = new URL(input.url);
  return new Promise((resolve, reject) => {
    const requestRef = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: input.method,
        headers: {
          ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
          ...(input.body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(input.body, 'utf8') } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    requestRef.once('error', reject);
    if (input.body) {
      requestRef.write(input.body);
    }
    requestRef.end();
  });
}

async function openSse(urlString: string, token: string): Promise<{
  nextEvent(): Promise<{ event: string; data: string }>;
  close(): void;
}> {
  const url = new URL(urlString);
  const eventQueue: Array<{ event: string; data: string }> = [];
  let buffer = '';
  let closed = false;
  let notify: (() => void) | undefined;

  const requestRef = http.request(
    {
      host: url.hostname,
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );

  requestRef.end();

  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    requestRef.once('response', resolve);
    requestRef.once('error', reject);
  });

  response.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const separator = buffer.indexOf('\n\n');
      if (separator < 0) {
        return;
      }
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const lines = raw.split('\n');
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (dataLines.length > 0) {
        eventQueue.push({ event, data: dataLines.join('\n') });
        notify?.();
        notify = undefined;
      }
    }
  });
  response.on('close', () => {
    closed = true;
    notify?.();
  });

  return {
    async nextEvent(): Promise<{ event: string; data: string }> {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (eventQueue.length > 0) {
          return eventQueue.shift()!;
        }
        if (closed) {
          throw new Error('SSE stream closed before next event.');
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 50);
        });
      }
      throw new Error('Timed out waiting for SSE event.');
    },
    close(): void {
      requestRef.destroy();
      response.destroy();
    },
  };
}
