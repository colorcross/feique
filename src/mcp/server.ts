import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import packageJson from '../../package.json' with { type: 'json' };
import { buildHelpText, describeBridgeCommand, parseBridgeCommand, requiresCommandConfirmation, type BridgeCommand } from '../bridge/commands.js';
import { buildQueueKey } from '../bridge/service.js';
import { CodexSessionIndex, renderSessionMatchLabel, type IndexedCodexSession } from '../codex/session-index.js';
import { loadBridgeConfig, loadRuntimeConfig } from '../config/load.js';
import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import { ConfigHistoryStore } from '../state/config-history-store.js';
import { RunStateStore } from '../state/run-state-store.js';
import { SessionStore, buildConversationKey } from '../state/session-store.js';
import { fileExists, writeUtf8Atomic } from '../utils/fs.js';

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

interface McpConversationInput {
  chatId: string;
  actorId?: string;
  tenantKey?: string;
  projectAlias?: string;
}

interface ResolvedMcpProjectContext extends McpConversationInput {
  selectionKey: string;
  sessionKey: string;
  projectAlias: string;
  project: ProjectConfig;
}

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
    description: 'Adopt the latest or a specific local Codex CLI session for one MCP conversation. Use target=list to inspect candidates.',
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
    description: 'Execute supported slash commands or natural-language control intents over MCP. Mutating actions require confirmed=true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...CONVERSATION_SCHEMA_PROPERTIES,
        text: { type: 'string' },
        confirmed: { type: 'boolean' },
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
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: 'config.rollback',
    description: 'Roll back the writable config file to a previous snapshot. A service restart may still be required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string' },
      },
    },
  },
  {
    name: 'service.restart',
    description: 'Restart the codex-feishu background service with the current config.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
];

export async function startMcpServer(options: { cwd: string; configPath?: string }): Promise<void> {
  const parser = new StdioMessageParser(async (request) => {
    const response = await handleRequest(request, options);
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

async function handleRequest(request: JsonRpcRequest, options: { cwd: string; configPath?: string }): Promise<JsonRpcResponse | null> {
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
          name: 'codex-feishu',
          version: packageJson.version,
        },
        instructions:
          'Use the provided tools to inspect codex-feishu runtime state, switch projects, adopt Codex sessions, and safely interpret or execute supported control commands.',
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
        download_dir: project.download_dir ?? null,
        temp_dir: project.temp_dir ?? null,
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
        confirmed: argumentsObject.confirmed === true,
      });
      return buildToolResult(execution.text, execution.structured);
    }
    case 'config.history': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const writableConfigPath = resolveWritableConfigPath(options.configPath, sources);
      const store = new ConfigHistoryStore(config.storage.dir);
      const limit = typeof argumentsObject.limit === 'number' ? Math.max(1, Math.min(20, Math.trunc(argumentsObject.limit))) : 5;
      const snapshots = await store.listSnapshots(limit);
      return buildToolResult(renderJson({ writableConfigPath, snapshots }), { writableConfigPath, snapshots });
    }
    case 'config.rollback': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
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
      const writableConfigPath = resolveWritableConfigPath(options.configPath, sources);
      await restartServiceProcess(options.cwd, writableConfigPath);
      return buildToolResult('Service restart command submitted.', { restarted: true, service: config.service.name });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function switchProjectBinding(
  config: BridgeConfig,
  sessionStore: SessionStore,
  sessionIndex: CodexSessionIndex,
  conversation: McpConversationInput,
  projectAlias: string,
): Promise<{ text: string; structured: unknown }> {
  const resolved = await resolveProjectContext(config, sessionStore, { ...conversation, projectAlias });
  const structured: {
    projectAlias: string;
    selectionKey: string;
    sessionKey: string;
    autoAdoption:
      | { kind: 'disabled' }
      | { kind: 'existing'; threadId: string }
      | { kind: 'adopted'; session: IndexedCodexSession }
      | { kind: 'missing' };
  } = {
    projectAlias: resolved.projectAlias,
    selectionKey: resolved.selectionKey,
    sessionKey: resolved.sessionKey,
    autoAdoption: { kind: 'disabled' },
  };

  const lines = [`当前项目已切换为: ${resolved.projectAlias}`];
  if (resolved.project.description) {
    lines.push(`说明: ${resolved.project.description}`);
  }

  if (config.service.project_switch_auto_adopt_latest) {
    const adoption = await maybeAutoAdoptLatestSession(sessionStore, sessionIndex, resolved);
    structured.autoAdoption = adoption;
    if (adoption.kind === 'existing') {
      lines.push(`已保留当前项目会话: ${adoption.threadId}`);
    } else if (adoption.kind === 'adopted') {
      lines.push(`已自动接管本地 Codex 会话: ${adoption.session.threadId}`);
      lines.push(`match: ${renderSessionMatch(adoption.session)}`);
      lines.push(`source cwd: ${adoption.session.cwd}`);
    } else if (adoption.kind === 'missing') {
      lines.push('未找到可自动接管的本地 Codex 会话。下一条消息会新开会话。');
    }
  }

  return {
    text: lines.join('\n'),
    structured,
  };
}

async function listBridgeSessions(
  config: BridgeConfig,
  sessionStore: SessionStore,
  conversation: McpConversationInput,
): Promise<{ text: string; structured: unknown }> {
  const resolved = await resolveProjectContext(config, sessionStore, conversation);
  const sessions = await sessionStore.listProjectSessions(resolved.sessionKey, resolved.projectAlias);
  const activeSessionId = (await sessionStore.getConversation(resolved.sessionKey))?.projects[resolved.projectAlias]?.thread_id ?? null;
  if (sessions.length === 0) {
    return {
      text: `项目 ${resolved.projectAlias} 还没有保存的会话。`,
      structured: {
        projectAlias: resolved.projectAlias,
        sessionKey: resolved.sessionKey,
        activeSessionId,
        sessions: [],
      },
    };
  }

  const lines = sessions.map((session, index) => {
    const prefix = session.thread_id === activeSessionId ? '*' : `${index + 1}.`;
    return `${prefix} ${session.thread_id} (${session.updated_at})${session.last_response_excerpt ? `\n   ${truncateText(session.last_response_excerpt, 80)}` : ''}`;
  });
  return {
    text: [`项目: ${resolved.projectAlias}`, `当前会话: ${activeSessionId ?? '未选择'}`, '', ...lines].join('\n'),
    structured: {
      projectAlias: resolved.projectAlias,
      sessionKey: resolved.sessionKey,
      activeSessionId,
      sessions,
    },
  };
}

async function adoptProjectSession(
  config: BridgeConfig,
  sessionStore: SessionStore,
  sessionIndex: CodexSessionIndex,
  conversation: McpConversationInput,
  target?: string,
): Promise<{ text: string; structured: unknown }> {
  const resolved = await resolveProjectContext(config, sessionStore, conversation);
  const normalizedTarget = target?.trim();

  if (normalizedTarget === 'list') {
    const candidates = await sessionIndex.listProjectSessions(resolved.project.root, 10);
    if (candidates.length === 0) {
      return {
        text: [`项目: ${resolved.projectAlias}`, `项目根: ${resolved.project.root}`, '未找到可接管的本地 Codex 会话。'].join('\n'),
        structured: {
          projectAlias: resolved.projectAlias,
          projectRoot: resolved.project.root,
          target: 'list',
          candidates: [],
        },
      };
    }
    const lines = candidates.map((session, index) =>
      [
        `${index + 1}. ${session.threadId}`,
        `   updated_at: ${session.updatedAt}`,
        `   cwd: ${session.cwd}`,
        `   match: ${renderSessionMatch(session)}`,
        `   source: ${session.source}`,
      ].join('\n'),
    );
    return {
      text: [`项目: ${resolved.projectAlias}`, `项目根: ${resolved.project.root}`, '可接管的本地 Codex 会话:', '', ...lines].join('\n'),
      structured: {
        projectAlias: resolved.projectAlias,
        projectRoot: resolved.project.root,
        target: 'list',
        candidates,
      },
    };
  }

  const adopted = !normalizedTarget || normalizedTarget === 'latest'
    ? await sessionIndex.findLatestProjectSession(resolved.project.root)
    : await sessionIndex.findProjectSessionById(resolved.project.root, normalizedTarget);
  if (!adopted) {
    return {
      text: [
        `项目: ${resolved.projectAlias}`,
        normalizedTarget ? `未找到可接管的本地 Codex 会话: ${normalizedTarget}` : '未找到可接管的本地 Codex 会话。',
        '用法: target=latest | target=list | target=<thread_id>',
      ].join('\n'),
      structured: {
        projectAlias: resolved.projectAlias,
        projectRoot: resolved.project.root,
        target: normalizedTarget ?? 'latest',
        adopted: null,
      },
    };
  }

  await sessionStore.upsertProjectSession(resolved.sessionKey, resolved.projectAlias, {
    thread_id: adopted.threadId,
  });
  return {
    text: [
      `项目: ${resolved.projectAlias}`,
      `已接管本地 Codex 会话: ${adopted.threadId}`,
      `match: ${renderSessionMatch(adopted)}`,
      `source cwd: ${adopted.cwd}`,
      `updated_at: ${adopted.updatedAt}`,
      '下一条消息会直接续接这个会话。',
    ].join('\n'),
    structured: {
      projectAlias: resolved.projectAlias,
      sessionKey: resolved.sessionKey,
      adopted,
    },
  };
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
        requiresConfirmation: false,
      },
    };
  }

  const supported = isMcpSupportedCommand(command);
  return {
    text: [
      `命令摘要: ${describeBridgeCommand(command)}`,
      `需要确认: ${requiresCommandConfirmation(command) ? 'yes' : 'no'}`,
      `MCP 支持: ${supported ? 'yes' : 'no'}`,
    ].join('\n'),
    structured: {
      type: 'command',
      command,
      summary: describeBridgeCommand(command),
      supported,
      requiresConfirmation: requiresCommandConfirmation(command),
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
  confirmed: boolean;
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

  if (requiresCommandConfirmation(command) && !input.confirmed) {
    return {
      text: `命令需要确认后才能执行: ${describeBridgeCommand(command)}`,
      structured: {
        executed: false,
        summary: describeBridgeCommand(command),
        supported: true,
        requiresConfirmation: true,
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
      const projects = Object.entries(input.config.projects).map(([alias, project]) => ({
        alias,
        root: project.root,
        description: project.description ?? null,
        session_scope: project.session_scope,
      }));
      const selected = await resolveSelectedProjectAlias(input.config, input.sessionStore, input.conversation);
      return {
        text: projects.length === 0 ? 'No projects configured.' : renderJson({ selected, projects }),
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
    const runs = await input.runStateStore.listRuns();
    const active = runs.filter((run) => run.status === 'queued' || run.status === 'running' || run.status === 'orphaned').slice(0, 10);
    const recentFailures = runs.filter((run) => run.status === 'failure' || run.status === 'cancelled' || run.status === 'stale').slice(0, 5);
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
  return (await resolveProjectContext(config, sessionStore, conversation)).projectAlias;
}

async function resolveProjectContext(
  config: BridgeConfig,
  sessionStore: SessionStore,
  conversation: McpConversationInput,
): Promise<ResolvedMcpProjectContext> {
  const selectionKey = buildConversationKey({
    tenantKey: conversation.tenantKey,
    chatId: conversation.chatId,
    actorId: conversation.actorId,
    scope: 'chat',
  });
  await sessionStore.ensureConversation(selectionKey, {
    chat_id: conversation.chatId,
    actor_id: conversation.actorId,
    tenant_key: conversation.tenantKey,
    scope: 'chat',
  });

  if (conversation.projectAlias) {
    requireProject(config, conversation.projectAlias);
    await sessionStore.selectProject(selectionKey, conversation.projectAlias);
  }

  const selection = await sessionStore.getConversation(selectionKey);
  const fallbackAlias = config.service.default_project ?? Object.keys(config.projects)[0];
  const projectAlias = conversation.projectAlias ?? selection?.selected_project_alias ?? fallbackAlias;
  if (!projectAlias) {
    throw new Error('No project configured.');
  }
  const project = requireProject(config, projectAlias);
  await sessionStore.selectProject(selectionKey, projectAlias);

  const sessionKey = buildConversationKey({
    tenantKey: conversation.tenantKey,
    chatId: conversation.chatId,
    actorId: conversation.actorId,
    scope: project.session_scope,
  });
  await sessionStore.ensureConversation(sessionKey, {
    chat_id: conversation.chatId,
    actor_id: conversation.actorId,
    tenant_key: conversation.tenantKey,
    scope: project.session_scope,
  });

  return {
    ...conversation,
    selectionKey,
    sessionKey,
    projectAlias,
    project,
  };
}

async function maybeAutoAdoptLatestSession(
  sessionStore: SessionStore,
  sessionIndex: CodexSessionIndex,
  context: ResolvedMcpProjectContext,
): Promise<
  | { kind: 'existing'; threadId: string }
  | { kind: 'adopted'; session: IndexedCodexSession }
  | { kind: 'missing' }
> {
  const conversation = await sessionStore.getConversation(context.sessionKey);
  const existingThreadId = conversation?.projects[context.projectAlias]?.thread_id;
  if (existingThreadId) {
    return { kind: 'existing', threadId: existingThreadId };
  }

  const adopted = await sessionIndex.findLatestProjectSession(context.project.root);
  if (!adopted) {
    return { kind: 'missing' };
  }

  await sessionStore.upsertProjectSession(context.sessionKey, context.projectAlias, {
    thread_id: adopted.threadId,
  });
  return { kind: 'adopted', session: adopted };
}

function requireProject(config: BridgeConfig, alias: string): ProjectConfig {
  const project = config.projects[alias];
  if (!project) {
    throw new Error(`Project not found: ${alias}`);
  }
  return project;
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

function renderSessionMatch(session: Pick<IndexedCodexSession, 'matchKind' | 'matchScore'>): string {
  const label = renderSessionMatchLabel(session);
  return session.matchScore ? `${label} (${session.matchScore})` : label;
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
