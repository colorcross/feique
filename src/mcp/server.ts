import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import packageJson from '../../package.json' with { type: 'json' };
import { buildHelpText, describeBridgeCommand, parseBridgeCommand, type BridgeCommand } from '../bridge/commands.js';
import { buildQueueKey } from '../bridge/service.js';
import { adoptProjectSession as adoptSharedProjectSession, listBridgeSessions as listSharedBridgeSessions, renderSessionMatch, resolveProjectContext as resolveSharedProjectContext, switchProjectBinding as switchSharedProjectBinding, type ConversationRef, type ResolvedProjectContext } from '../control-plane/project-session.js';
import { CodexSessionIndex } from '../codex/session-index.js';
import { loadBridgeConfig, loadRuntimeConfig } from '../config/load.js';
import { createProjectAlias } from '../config/mutate.js';
import type { BridgeConfig, McpTransport } from '../config/schema.js';
import { canAccessGlobalCapability, canAccessProjectCapability, describeMinimumRole, filterAccessibleProjects } from '../security/access.js';
import { ConfigHistoryStore } from '../state/config-history-store.js';
import { RunStateStore } from '../state/run-state-store.js';
import { SessionStore, buildConversationKey } from '../state/session-store.js';
import { fileExists, writeUtf8Atomic } from '../utils/fs.js';
import { getProjectCacheDir, getProjectDownloadsDir, getProjectLogDir, getProjectTempDir } from '../projects/paths.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface McpServerOptions {
  cwd: string;
  configPath?: string;
  transport?: McpTransport;
  host?: string;
  port?: number;
  path?: string;
  ssePath?: string;
  messagePath?: string;
  authToken?: string;
  authTokenId?: string;
}

interface McpHttpSession {
  id: string;
  response: http.ServerResponse<http.IncomingMessage>;
  keepAlive: NodeJS.Timeout;
}

interface ResolvedMcpAuthToken {
  id: string;
  token: string;
  active: boolean;
}

type McpConversationInput = ConversationRef;
type ResolvedMcpProjectContext = ResolvedProjectContext;

const CONVERSATION_SCHEMA_PROPERTIES = {
  chatId: { type: 'string' },
  actorId: { type: 'string' },
  tenantKey: { type: 'string' },
  projectAlias: { type: 'string' },
} as const;

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'projects.list',
    description: 'List configured projects and their key isolation settings.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'project.switch',
    description: 'Switch the bound project for one MCP conversation and optionally auto-adopt the latest local Codex session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...CONVERSATION_SCHEMA_PROPERTIES,
      },
      required: ['chatId', 'projectAlias'],
    },
  },
  {
    name: 'project.create',
    description: 'Create a project directory on disk and bind it as a new project alias in the writable config.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...CONVERSATION_SCHEMA_PROPERTIES,
        root: { type: 'string' },
      },
      required: ['chatId', 'projectAlias', 'root'],
    },
  },
  {
    name: 'sessions.list',
    description: 'List saved bridge sessions for one MCP conversation and project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...CONVERSATION_SCHEMA_PROPERTIES,
      },
      required: ['chatId'],
    },
  },
  {
    name: 'session.adopt',
    description: 'Adopt the latest or a specific local CLI session (Codex or Claude) for one MCP conversation. Use target=list to inspect candidates.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...CONVERSATION_SCHEMA_PROPERTIES,
        target: { type: 'string' },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'status.get',
    description: 'Return runtime status, pid, active runs, and key storage paths.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'runs.list',
    description: 'List active runs or all saved runs from the local state store.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        all: { type: 'boolean' },
      },
    },
  },
  {
    name: 'command.interpret',
    description: 'Interpret slash commands or natural-language control intents without executing them.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'command.execute',
    description: 'Execute supported slash commands or natural-language control intents over MCP.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...CONVERSATION_SCHEMA_PROPERTIES,
        text: { type: 'string' },
      },
      required: ['chatId', 'text'],
    },
  },
  {
    name: 'config.history',
    description: 'Return recent config snapshots recorded by admin operations.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chatId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'config.rollback',
    description: 'Roll back the writable config file to a previous snapshot. A service restart may still be required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chatId: { type: 'string' },
        target: { type: 'string' },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'service.restart',
    description: 'Restart the feique background service with the current config.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chatId: { type: 'string' },
      },
      required: ['chatId'],
    },
  },
];

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const { config } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
  const transport = options.transport ?? config.mcp.transport;
  if (transport === 'http') {
    await startHttpMcpServer(options, config);
    return;
  }

  const parser = new StdioMessageParser(async (request) => {
    const response = await handleMcpRequest(request, options);
    if (response) {
      process.stdout.write(encodeMessage(response));
    }
  });

  process.stdin.on('data', (chunk: Buffer) => {
    parser.push(chunk);
  });
  process.stdin.on('end', () => {
    process.exit(0);
  });
  process.stdin.resume();
}

export async function handleMcpRequest(request: JsonRpcRequest, options: { cwd: string; configPath?: string }): Promise<JsonRpcResponse | null> {
  if (request.method === 'notifications/initialized') {
    return null;
  }

  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-03-26',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'feique',
          version: packageJson.version,
        },
        instructions:
          'Use the provided tools to inspect feique runtime state, switch projects, adopt Codex sessions, and safely interpret or execute supported control commands.',
      },
    };
  }

  if (request.method === 'ping') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {},
    };
  }

  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        tools: TOOL_DEFINITIONS,
      },
    };
  }

  if (request.method === 'tools/call') {
    try {
      const result = await handleToolCall(request.params ?? {}, options);
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result,
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    error: {
      code: -32601,
      message: `Method not found: ${request.method}`,
    },
  };
}

async function handleToolCall(params: Record<string, unknown>, options: { cwd: string; configPath?: string }): Promise<ToolCallResult> {
  const name = typeof params.name === 'string' ? params.name : '';
  const argumentsObject = isPlainObject(params.arguments) ? (params.arguments as Record<string, unknown>) : {};

  switch (name) {
    case 'projects.list': {
      const { config } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const projects = Object.entries(config.projects).map(([alias, project]) => ({
        alias,
        root: project.root,
        session_scope: project.session_scope,
        mention_required: project.mention_required,
        admin_chat_ids: project.admin_chat_ids,
        session_operator_chat_ids: project.session_operator_chat_ids ?? [],
        run_operator_chat_ids: project.run_operator_chat_ids ?? [],
        config_admin_chat_ids: project.config_admin_chat_ids ?? [],
        download_dir: getProjectDownloadsDir(config.storage.dir, alias, project),
        temp_dir: getProjectTempDir(config.storage.dir, alias, project),
        cache_dir: getProjectCacheDir(config.storage.dir, alias, project),
        log_dir: getProjectLogDir(config.storage.dir, alias, project),
        chat_rate_limit_window_seconds: project.chat_rate_limit_window_seconds,
        chat_rate_limit_max_runs: project.chat_rate_limit_max_runs,
      }));
      return buildToolResult(projects.length > 0 ? renderJson(projects) : 'No projects configured.', { projects });
    }
    case 'project.switch': {
      const { config } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const sessionStore = new SessionStore(config.storage.dir);
      const sessionIndex = new CodexSessionIndex();
      const switched = await switchProjectBinding(
        config,
        sessionStore,
        sessionIndex,
        parseConversationInput(argumentsObject),
        requireString(argumentsObject, 'projectAlias'),
      );
      return buildToolResult(switched.text, switched.structured);
    }
    case 'project.create': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const chatId = requireString(argumentsObject, 'chatId');
      if (!canAccessGlobalCapability(config, chatId, 'config:mutate')) {
        throw new Error('Current chat is not allowed to create projects.');
      }
      const writableConfigPath = resolveWritableConfigPath(options.configPath, sources);
      if (!writableConfigPath) {
        throw new Error('No writable config path resolved for project creation.');
      }
      const alias = requireString(argumentsObject, 'projectAlias');
      if (config.projects[alias]) {
        throw new Error(`Project alias already exists: ${alias}`);
      }
      const root = requireString(argumentsObject, 'root');
      const history = new ConfigHistoryStore(config.storage.dir);
      const snapshot = await history.recordSnapshot({
        configPath: writableConfigPath,
        action: 'project.create',
        summary: `${alias} -> ${root}`,
        chatId,
        actorId: readOptionalString(argumentsObject, 'actorId'),
        limit: 5,
      });
      const created = await createProjectAlias({
        configPath: writableConfigPath,
        alias,
        root,
      });
      return buildToolResult(
        `Created project ${alias} at ${created.root}. Restart the service if it should pick up the new project immediately.`,
        { alias, root: created.root, snapshotId: snapshot.id, created: true },
      );
    }
    case 'sessions.list': {
      const { config } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const sessionStore = new SessionStore(config.storage.dir);
      const listing = await listBridgeSessions(config, sessionStore, parseConversationInput(argumentsObject));
      return buildToolResult(listing.text, listing.structured);
    }
    case 'session.adopt': {
      const { config } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const sessionStore = new SessionStore(config.storage.dir);
      const sessionIndex = new CodexSessionIndex();
      const adopted = await adoptProjectSession(
        config,
        sessionStore,
        sessionIndex,
        parseConversationInput(argumentsObject),
        readOptionalString(argumentsObject, 'target'),
      );
      return buildToolResult(adopted.text, adopted.structured);
    }
    case 'status.get': {
      const { config } = await loadRuntimeConfig({ cwd: options.cwd, configPath: options.configPath });
      const status = await inspectRuntimeStatus(config);
      return buildToolResult(renderJson(status), status);
    }
    case 'runs.list': {
      const { config } = await loadRuntimeConfig({ cwd: options.cwd, configPath: options.configPath });
      const runStateStore = new RunStateStore(config.storage.dir);
      const runs = argumentsObject.all === true ? await runStateStore.listRuns() : await runStateStore.listActiveRuns();
      return buildToolResult(renderJson(runs), { runs });
    }
    case 'command.interpret': {
      const interpretation = interpretBridgeCommand(requireString(argumentsObject, 'text'));
      return buildToolResult(interpretation.text, interpretation.structured);
    }
    case 'command.execute': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const sessionStore = new SessionStore(config.storage.dir);
      const sessionIndex = new CodexSessionIndex();
      const runStateStore = new RunStateStore(config.storage.dir);
      const execution = await executeMcpCommand({
        config,
        writableConfigPath: resolveWritableConfigPath(options.configPath, sources),
        cwd: options.cwd,
        sessionStore,
        sessionIndex,
        runStateStore,
        conversation: parseConversationInput(argumentsObject),
        text: requireString(argumentsObject, 'text'),
      });
      return buildToolResult(execution.text, execution.structured);
    }
    case 'config.history': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      if (!canAccessGlobalCapability(config, requireString(argumentsObject, 'chatId'), 'config:history')) {
        throw new Error('Current chat is not allowed to inspect config history.');
      }
      const writableConfigPath = resolveWritableConfigPath(options.configPath, sources);
      const store = new ConfigHistoryStore(config.storage.dir);
      const limit = typeof argumentsObject.limit === 'number' ? Math.max(1, Math.min(20, Math.trunc(argumentsObject.limit))) : 5;
      const snapshots = await store.listSnapshots(limit);
      return buildToolResult(renderJson({ writableConfigPath, snapshots }), { writableConfigPath, snapshots });
    }
    case 'config.rollback': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      if (!canAccessGlobalCapability(config, requireString(argumentsObject, 'chatId'), 'config:rollback')) {
        throw new Error('Current chat is not allowed to roll back config.');
      }
      const writableConfigPath = resolveWritableConfigPath(options.configPath, sources);
      if (!writableConfigPath) {
        throw new Error('No writable config path resolved for rollback.');
      }
      const store = new ConfigHistoryStore(config.storage.dir);
      const target = await store.getSnapshot(typeof argumentsObject.target === 'string' ? argumentsObject.target : undefined);
      if (!target) {
        throw new Error('Target config snapshot not found.');
      }
      await writeUtf8Atomic(writableConfigPath, target.content);
      return buildToolResult(
        `Rolled back config to snapshot ${target.id}. Restart the service if you need in-memory config to reload.`,
        { snapshot: target.id, configPath: writableConfigPath },
      );
    }
    case 'service.restart': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      if (!canAccessGlobalCapability(config, requireString(argumentsObject, 'chatId'), 'service:restart')) {
        throw new Error('Current chat is not allowed to restart the service.');
      }
      const writableConfigPath = resolveWritableConfigPath(options.configPath, sources);
      await restartServiceProcess(options.cwd, writableConfigPath);
      return buildToolResult('Service restart command submitted.', { restarted: true, service: config.service.name });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function startHttpMcpServer(options: McpServerOptions, config: BridgeConfig): Promise<void> {
  const host = options.host ?? config.mcp.host;
  const port = options.port ?? config.mcp.port;
  const rpcPath = options.path ?? config.mcp.path;
  const ssePath = options.ssePath ?? config.mcp.sse_path;
  const messagePath = options.messagePath ?? config.mcp.message_path;
  const auth = resolveHttpAuthTokens(config, options);
  const sessions = new Map<string, McpHttpSession>();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
      if (!authorizeHttpRequest(request, auth)) {
        response.statusCode = 401;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Unauthorized MCP request.' }));
        return;
      }

      if (request.method === 'GET' && url.pathname === ssePath) {
        const sessionId = randomUUID();
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        response.write(`event: endpoint\ndata: ${JSON.stringify({ sessionId, rpcPath, messagePath: `${messagePath}?sessionId=${sessionId}` })}\n\n`);
        const keepAlive = setInterval(() => {
          response.write(`: keep-alive ${Date.now()}\n\n`);
        }, 15000);
        keepAlive.unref?.();
        sessions.set(sessionId, { id: sessionId, response, keepAlive });
        request.on('close', () => {
          const session = sessions.get(sessionId);
          if (session) {
            clearInterval(session.keepAlive);
            sessions.delete(sessionId);
          }
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === messagePath) {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId || !sessions.has(sessionId)) {
          response.statusCode = 404;
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: 'Unknown MCP SSE session.' }));
          return;
        }
        const body = await readRequestBody(request);
        const payload = JSON.parse(body) as JsonRpcRequest;
        const rpcResponse = await handleMcpRequest(payload, options);
        if (rpcResponse) {
          sessions.get(sessionId)?.response.write(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`);
        }
        response.statusCode = 202;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ accepted: true, sessionId }));
        return;
      }

      if (request.method === 'POST' && url.pathname === rpcPath) {
        const body = await readRequestBody(request);
        const payload = JSON.parse(body) as JsonRpcRequest;
        const rpcResponse = await handleMcpRequest(payload, options);
        response.statusCode = rpcResponse ? 200 : 204;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(rpcResponse ? JSON.stringify(rpcResponse) : '');
        return;
      }

      if (request.method === 'GET' && url.pathname === rpcPath) {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({
          transport: 'http',
          rpcPath,
          ssePath,
          messagePath,
          auth: auth.length > 0 ? 'bearer' : 'none',
          tokenIds: auth.map((token) => token.id),
          activeTokenId: auth.find((token) => token.active)?.id ?? null,
        }));
        return;
      }

      response.statusCode = 404;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Not found.' }));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve();
    });
  });
  process.stderr.write(`MCP HTTP server listening on http://${host}:${port}${rpcPath}\n`);

  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      for (const session of sessions.values()) {
        clearInterval(session.keepAlive);
        session.response.end();
      }
      sessions.clear();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

async function switchProjectBinding(
  config: BridgeConfig,
  sessionStore: SessionStore,
  sessionIndex: CodexSessionIndex,
  conversation: McpConversationInput,
  projectAlias: string,
): Promise<{ text: string; structured: unknown }> {
  return switchSharedProjectBinding(config, sessionStore, sessionIndex, conversation, projectAlias);
}

async function listBridgeSessions(
  config: BridgeConfig,
  sessionStore: SessionStore,
  conversation: McpConversationInput,
): Promise<{ text: string; structured: unknown }> {
  return listSharedBridgeSessions(config, sessionStore, conversation);
}

async function adoptProjectSession(
  config: BridgeConfig,
  sessionStore: SessionStore,
  sessionIndex: CodexSessionIndex,
  conversation: McpConversationInput,
  target?: string,
): Promise<{ text: string; structured: unknown }> {
  return adoptSharedProjectSession(config, sessionStore, sessionIndex, conversation, target);
}

function interpretBridgeCommand(text: string): { text: string; structured: unknown } {
  const command = parseBridgeCommand(text);
  if (command.kind === 'prompt') {
    return {
      text: `普通提示词，不会作为 MCP 控制命令执行: ${truncateText(command.prompt, 120)}`,
      structured: {
        type: 'prompt',
        prompt: command.prompt,
        supported: false,
      },
    };
  }

  const supported = isMcpSupportedCommand(command);
  return {
    text: [
      `命令摘要: ${describeBridgeCommand(command)}`,
      `MCP 支持: ${supported ? 'yes' : 'no'}`,
    ].join('\n'),
    structured: {
      type: 'command',
      command,
      summary: describeBridgeCommand(command),
      supported,
    },
  };
}

async function executeMcpCommand(input: {
  config: BridgeConfig;
  writableConfigPath: string | null;
  cwd: string;
  sessionStore: SessionStore;
  sessionIndex: CodexSessionIndex;
  runStateStore: RunStateStore;
  conversation: McpConversationInput;
  text: string;
}): Promise<{ text: string; structured: unknown }> {
  const command = parseBridgeCommand(input.text);
  if (command.kind === 'prompt') {
    return {
      text: `普通提示词，不会作为 MCP 控制命令执行: ${truncateText(command.prompt, 120)}`,
      structured: {
        executed: false,
        type: 'prompt',
        prompt: command.prompt,
      },
    };
  }

  if (!isMcpSupportedCommand(command)) {
    return {
      text: `当前 MCP 只支持部分控制命令，暂不支持: ${describeBridgeCommand(command)}`,
      structured: {
        executed: false,
        summary: describeBridgeCommand(command),
        supported: false,
        command,
      },
    };
  }

  switch (command.kind) {
    case 'help':
      return {
        text: buildHelpText(),
        structured: {
          executed: true,
          kind: 'help',
        },
      };
    case 'projects': {
      const visibleAliases = filterAccessibleProjects(input.config, input.conversation.chatId);
      const projects = Object.entries(input.config.projects)
        .filter(([alias]) => visibleAliases.includes(alias))
        .map(([alias, project]) => ({
        alias,
        root: project.root,
        description: project.description ?? null,
        session_scope: project.session_scope,
        }));
      const selected = await resolveSelectedProjectAlias(input.config, input.sessionStore, input.conversation);
      return {
        text: projects.length === 0 ? 'No accessible projects configured for this chat.' : renderJson({ selected, projects }),
        structured: {
          executed: true,
          kind: 'projects',
          selected,
          projects,
        },
      };
    }
    case 'status': {
      const status = await buildConversationStatus(input.config, input.sessionStore, input.runStateStore, input.conversation, command.detail === true);
      return {
        text: status.text,
        structured: {
          executed: true,
          kind: 'status',
          ...(status.structured as object),
        },
      };
    }
    case 'project':
      if (!command.alias) {
        const project = await resolveProjectContext(input.config, input.sessionStore, input.conversation);
        return {
          text: `当前项目: ${project.projectAlias}${project.project.description ? `\n说明: ${project.project.description}` : ''}`,
          structured: {
            executed: true,
            kind: 'project',
            projectAlias: project.projectAlias,
            description: project.project.description ?? null,
          },
        };
      }
      const switched = await switchProjectBinding(input.config, input.sessionStore, input.sessionIndex, input.conversation, command.alias);
      return {
        text: switched.text,
        structured: {
          executed: true,
          kind: 'project',
          ...(switched.structured as object),
        },
      };
    case 'session':
      return executeSessionCommand(input.config, input.sessionStore, input.sessionIndex, input.conversation, command);
    case 'admin':
      return executeAdminServiceCommand(command, input);
    default:
      return {
        text: `当前 MCP 暂不支持: ${describeBridgeCommand(command)}`,
        structured: {
          executed: false,
          summary: describeBridgeCommand(command),
          supported: false,
          command,
        },
      };
  }
}

async function executeSessionCommand(
  config: BridgeConfig,
  sessionStore: SessionStore,
  sessionIndex: CodexSessionIndex,
  conversation: McpConversationInput,
  command: Extract<BridgeCommand, { kind: 'session' }>,
): Promise<{ text: string; structured: unknown }> {
  if (command.action === 'adopt') {
    const adopted = await adoptProjectSession(config, sessionStore, sessionIndex, conversation, command.target);
    return {
      text: adopted.text,
      structured: {
        executed: true,
        kind: 'session',
        action: 'adopt',
        ...(adopted.structured as object),
      },
    };
  }

  const resolved = await resolveProjectContext(config, sessionStore, conversation);
  const sessions = await sessionStore.listProjectSessions(resolved.sessionKey, resolved.projectAlias);
  const activeSessionId = (await sessionStore.getConversation(resolved.sessionKey))?.projects[resolved.projectAlias]?.thread_id ?? null;

  switch (command.action) {
    case 'list': {
      const listing = await listBridgeSessions(config, sessionStore, conversation);
      return {
        text: listing.text,
        structured: {
          executed: true,
          kind: 'session',
          action: 'list',
          ...(listing.structured as object),
        },
      };
    }
    case 'use': {
      if (!canAccessProjectCapability(config, resolved.projectAlias, conversation.chatId, 'session:control')) {
        throw new Error(`Current chat requires ${describeMinimumRole('operator')} role to switch sessions for ${resolved.projectAlias}.`);
      }
      if (!command.threadId) {
        throw new Error('session use requires threadId.');
      }
      await sessionStore.setActiveProjectSession(resolved.sessionKey, resolved.projectAlias, command.threadId);
      return {
        text: `已切换到会话: ${command.threadId}`,
        structured: {
          executed: true,
          kind: 'session',
          action: 'use',
          projectAlias: resolved.projectAlias,
          sessionKey: resolved.sessionKey,
          threadId: command.threadId,
        },
      };
    }
    case 'new':
      if (!canAccessProjectCapability(config, resolved.projectAlias, conversation.chatId, 'session:control')) {
        throw new Error(`Current chat requires ${describeMinimumRole('operator')} role to open a new session for ${resolved.projectAlias}.`);
      }
      await sessionStore.clearActiveProjectSession(resolved.sessionKey, resolved.projectAlias);
      return {
        text: '已切换为新会话模式。下一条消息会新开会话。',
        structured: {
          executed: true,
          kind: 'session',
          action: 'new',
          projectAlias: resolved.projectAlias,
          sessionKey: resolved.sessionKey,
        },
      };
    case 'drop': {
      if (!canAccessProjectCapability(config, resolved.projectAlias, conversation.chatId, 'session:control')) {
        throw new Error(`Current chat requires ${describeMinimumRole('operator')} role to drop sessions for ${resolved.projectAlias}.`);
      }
      const targetThreadId = command.threadId ?? activeSessionId;
      if (!targetThreadId) {
        return {
          text: '没有可删除的会话。',
          structured: {
            executed: true,
            kind: 'session',
            action: 'drop',
            projectAlias: resolved.projectAlias,
            sessionKey: resolved.sessionKey,
            deleted: null,
          },
        };
      }
      await sessionStore.dropProjectSession(resolved.sessionKey, resolved.projectAlias, targetThreadId);
      return {
        text: `已删除会话: ${targetThreadId}`,
        structured: {
          executed: true,
          kind: 'session',
          action: 'drop',
          projectAlias: resolved.projectAlias,
          sessionKey: resolved.sessionKey,
          deleted: targetThreadId,
          remainingSessions: sessions.filter((session) => session.thread_id !== targetThreadId).length,
        },
      };
    }
  }
}

async function executeAdminServiceCommand(
  command: Extract<BridgeCommand, { kind: 'admin' }>,
  input: {
    config: BridgeConfig;
    writableConfigPath: string | null;
    cwd: string;
    runStateStore: RunStateStore;
    conversation: McpConversationInput;
  },
): Promise<{ text: string; structured: unknown }> {
  if (command.resource !== 'service') {
    return {
      text: `当前 MCP 暂不支持管理员命令: ${describeBridgeCommand(command)}`,
      structured: {
        executed: false,
        summary: describeBridgeCommand(command),
        supported: false,
      },
    };
  }

  if (command.action === 'status') {
    const allowedAliases = filterAccessibleProjects(input.config, input.conversation.chatId, 'operator');
    if (!canAccessGlobalCapability(input.config, input.conversation.chatId, 'service:status') && allowedAliases.length === 0) {
      throw new Error(`Current chat requires ${describeMinimumRole('operator')} role to inspect service state.`);
    }
    const status = await inspectRuntimeStatus(input.config);
    return {
      text: renderJson(status),
      structured: {
        executed: true,
        kind: 'admin',
        resource: 'service',
        action: 'status',
        ...status,
      },
    };
  }

  if (command.action === 'runs') {
    const allowedAliases = new Set(filterAccessibleProjects(input.config, input.conversation.chatId, 'operator'));
    if (!canAccessGlobalCapability(input.config, input.conversation.chatId, 'service:runs') && allowedAliases.size === 0) {
      throw new Error(`Current chat requires ${describeMinimumRole('operator')} role to inspect active runs.`);
    }
    const runs = await input.runStateStore.listRuns();
    const visibleRuns = canAccessGlobalCapability(input.config, input.conversation.chatId, 'service:runs')
      ? runs
      : runs.filter((run) => allowedAliases.has(run.project_alias));
    const active = visibleRuns.filter((run) => run.status === 'queued' || run.status === 'running' || run.status === 'orphaned').slice(0, 10);
    const recentFailures = visibleRuns.filter((run) => run.status === 'failure' || run.status === 'cancelled' || run.status === 'stale').slice(0, 5);
    const lines = ['当前运行列表', '', 'active/queued:'];
    if (active.length === 0) {
      lines.push('(empty)');
    } else {
      for (const run of active) {
        lines.push(`- ${run.project_alias} | ${run.status} | chat=${run.chat_id} | ${run.updated_at}`);
        if (run.status_detail) {
          lines.push(`  detail=${truncateText(run.status_detail, 120)}`);
        }
      }
    }
    if (recentFailures.length > 0) {
      lines.push('', '最近失败:');
      for (const run of recentFailures) {
        lines.push(`- ${run.project_alias} | ${run.status} | ${run.updated_at}`);
        lines.push(`  error=${truncateText(run.error ?? 'unknown', 120)}`);
      }
    }
    return {
      text: lines.join('\n'),
      structured: {
        executed: true,
        kind: 'admin',
        resource: 'service',
        action: 'runs',
        active,
        recentFailures,
      },
    };
  }

  const adminAliases = filterAccessibleProjects(input.config, input.conversation.chatId, 'admin');
  if (!canAccessGlobalCapability(input.config, input.conversation.chatId, 'service:restart') && adminAliases.length === 0) {
    throw new Error(`Current chat requires ${describeMinimumRole('admin')} role to restart the service.`);
  }
  await restartServiceProcess(input.cwd, input.writableConfigPath);
  return {
    text: 'Service restart command submitted.',
    structured: {
      executed: true,
      kind: 'admin',
      resource: 'service',
      action: 'restart',
      restarted: true,
      service: input.config.service.name,
    },
  };
}

async function buildConversationStatus(
  config: BridgeConfig,
  sessionStore: SessionStore,
  runStateStore: RunStateStore,
  conversation: McpConversationInput,
  detail: boolean,
): Promise<{ text: string; structured: unknown }> {
  const resolved = await resolveProjectContext(config, sessionStore, conversation);
  const conversationState = await sessionStore.getConversation(resolved.sessionKey);
  const activeSessionId = conversationState?.projects[resolved.projectAlias]?.thread_id ?? null;
  const sessions = await sessionStore.listProjectSessions(resolved.sessionKey, resolved.projectAlias);
  const queueKey = buildQueueKey(resolved.sessionKey, resolved.projectAlias);
  const activeRun = await runStateStore.getLatestVisibleRun(queueKey);
  const runtime = await inspectRuntimeStatus(config);
  const allRuns = detail ? await runStateStore.listRuns() : [];
  const recentFailures = detail
    ? allRuns.filter((run) => run.queue_key === queueKey && (run.status === 'failure' || run.status === 'cancelled' || run.status === 'stale')).slice(0, 3)
    : [];

  const lines = [
    `项目: ${resolved.projectAlias}`,
    `项目根: ${resolved.project.root}`,
    `会话键: ${resolved.sessionKey}`,
    `当前会话: ${activeSessionId ?? '未选择'}`,
    `保存会话数: ${sessions.length}`,
    `服务运行: ${runtime.running ? 'yes' : 'no'}`,
    `可见运行: ${activeRun ? activeRun.status : 'none'}`,
  ];
  if (detail) {
    if (activeRun?.status_detail) {
      lines.push(`运行详情: ${activeRun.status_detail}`);
    }
    if (recentFailures.length > 0) {
      lines.push('', '最近失败:');
      for (const run of recentFailures) {
        lines.push(`- ${run.status} | ${run.updated_at}`);
        lines.push(`  error=${truncateText(run.error ?? 'unknown', 120)}`);
      }
    }
  }

  return {
    text: lines.join('\n'),
    structured: {
      projectAlias: resolved.projectAlias,
      projectRoot: resolved.project.root,
      selectionKey: resolved.selectionKey,
      sessionKey: resolved.sessionKey,
      activeSessionId,
      savedSessions: sessions.length,
      activeRun,
      runtime,
      recentFailures,
    },
  };
}

function isMcpSupportedCommand(command: BridgeCommand): boolean {
  switch (command.kind) {
    case 'help':
    case 'projects':
    case 'status':
    case 'project':
    case 'session':
      return true;
    case 'admin':
      return command.resource === 'service';
    default:
      return false;
  }
}

async function resolveSelectedProjectAlias(
  config: BridgeConfig,
  sessionStore: SessionStore,
  conversation: McpConversationInput,
): Promise<string> {
  const selectionKey = buildConversationKey({
    tenantKey: conversation.tenantKey,
    chatId: conversation.chatId,
    actorId: conversation.actorId,
    scope: 'chat',
  });
  const selection = await sessionStore.getConversation(selectionKey);
  return conversation.projectAlias ?? selection?.selected_project_alias ?? config.service.default_project ?? Object.keys(config.projects)[0] ?? 'default';
}

async function resolveProjectContext(
  config: BridgeConfig,
  sessionStore: SessionStore,
  conversation: McpConversationInput,
): Promise<ResolvedMcpProjectContext> {
  return resolveSharedProjectContext(config, sessionStore, conversation);
}

function parseConversationInput(argumentsObject: Record<string, unknown>): McpConversationInput {
  return {
    chatId: requireString(argumentsObject, 'chatId'),
    actorId: readOptionalString(argumentsObject, 'actorId'),
    tenantKey: readOptionalString(argumentsObject, 'tenantKey'),
    projectAlias: readOptionalString(argumentsObject, 'projectAlias'),
  };
}

function requireString(argumentsObject: Record<string, unknown>, key: string): string {
  const value = readOptionalString(argumentsObject, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readOptionalString(argumentsObject: Record<string, unknown>, key: string): string | undefined {
  return typeof argumentsObject[key] === 'string' && argumentsObject[key]!.trim().length > 0
    ? String(argumentsObject[key]).trim()
    : undefined;
}

function buildToolResult(text: string, structuredContent?: unknown): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

function authorizeHttpRequest(request: http.IncomingMessage, tokens: ResolvedMcpAuthToken[]): boolean {
  if (tokens.length === 0) {
    return true;
  }
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && tokens.some((token) => authorization === `Bearer ${token.token}`);
}

function resolveHttpAuthTokens(config: BridgeConfig, options: McpServerOptions): ResolvedMcpAuthToken[] {
  const now = Date.now();
  const resolved: ResolvedMcpAuthToken[] = [];
  const configured = options.authToken
    ? [{ id: options.authTokenId ?? 'cli', token: options.authToken, enabled: true }]
    : config.mcp.auth_tokens;
  const activeId = options.authToken ? options.authTokenId ?? 'cli' : config.mcp.active_auth_token_id;

  for (const token of configured) {
    if (!token.token || token.enabled === false) {
      continue;
    }
    if (token.expires_at) {
      const expiresAt = Date.parse(token.expires_at);
      if (!Number.isNaN(expiresAt) && expiresAt <= now) {
        continue;
      }
    }
    resolved.push({
      id: token.id,
      token: token.token,
      active: token.id === activeId,
    });
  }

  if (!options.authToken && config.mcp.auth_token) {
    resolved.push({
      id: 'legacy',
      token: config.mcp.auth_token,
      active: !activeId,
    });
  }

  if (resolved.length > 0 && !resolved.some((token) => token.active)) {
    resolved[0]!.active = true;
  }
  return resolved;
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

class StdioMessageParser {
  private buffer = Buffer.alloc(0);

  public constructor(private readonly onMessage: (request: JsonRpcRequest) => Promise<void>) {}

  public push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        throw new Error('Missing Content-Length header.');
      }
      const contentLength = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) {
        return;
      }
      const payload = this.buffer.slice(messageStart, messageEnd).toString('utf8');
      this.buffer = this.buffer.slice(messageEnd);
      await this.onMessage(JSON.parse(payload) as JsonRpcRequest);
    }
  }
}

function encodeMessage(payload: JsonRpcResponse): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

async function inspectRuntimeStatus(config: { service: { name: string }; storage: { dir: string } }): Promise<{
  running: boolean;
  pid?: number;
  pidPath: string;
  logPath: string;
  activeRuns: number;
}> {
  const pidPath = path.join(config.storage.dir, `${config.service.name}.pid`);
  const logPath = path.join(config.storage.dir, `${config.service.name}.log`);
  const pid = await readPid(pidPath);
  const runStateStore = new RunStateStore(config.storage.dir);
  return {
    running: pid !== null && (await isRunningPid(pid)),
    ...(pid !== null ? { pid } : {}),
    pidPath,
    logPath,
    activeRuns: (await runStateStore.listActiveRuns()).length,
  };
}

async function readPid(filePath: string): Promise<number | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }
  const raw = (await fs.readFile(filePath, 'utf8')).trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function isRunningPid(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveWritableConfigPath(explicitConfigPath: string | undefined, sources: string[]): string | null {
  if (explicitConfigPath) {
    return path.resolve(explicitConfigPath);
  }
  return sources[0] ?? null;
}

async function restartServiceProcess(cwd: string, configPath: string | null): Promise<void> {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Unable to resolve CLI entry for restart.');
  }
  await new Promise<void>((resolve, reject) => {
    const args = [...process.execArgv, cliEntry, 'restart'];
    if (configPath) {
      args.push('--config', path.resolve(configPath));
    }
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => resolve());
  });
}

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
