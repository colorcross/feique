import { CodexSessionIndex, renderSessionMatchLabel, type IndexedCodexSession } from '../codex/session-index.js';
import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import { canAccessProject, canAccessProjectCapability, describeMinimumRole } from '../security/access.js';
import { SessionStore, buildConversationKey } from '../state/session-store.js';

export interface ConversationRef {
  chatId: string;
  actorId?: string;
  tenantKey?: string;
  projectAlias?: string;
}

export interface ResolvedProjectContext extends ConversationRef {
  selectionKey: string;
  sessionKey: string;
  projectAlias: string;
  project: ProjectConfig;
}

export async function resolveProjectContext(
  config: BridgeConfig,
  sessionStore: SessionStore,
  conversation: ConversationRef,
): Promise<ResolvedProjectContext> {
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
    ensureProjectAccess(config, conversation.projectAlias, conversation.chatId, 'viewer');
    await sessionStore.selectProject(selectionKey, conversation.projectAlias);
  }

  const selection = await sessionStore.getConversation(selectionKey);
  const fallbackAlias = config.service.default_project ?? Object.keys(config.projects)[0];
  const projectAlias = conversation.projectAlias ?? selection?.selected_project_alias ?? fallbackAlias;
  if (!projectAlias) {
    throw new Error('No project configured.');
  }
  ensureProjectAccess(config, projectAlias, conversation.chatId, 'viewer');
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

export async function switchProjectBinding(
  config: BridgeConfig,
  sessionStore: SessionStore,
  sessionIndex: CodexSessionIndex,
  conversation: ConversationRef,
  projectAlias: string,
): Promise<{
  text: string;
  structured: {
    projectAlias: string;
    selectionKey: string;
    sessionKey: string;
    autoAdoption:
      | { kind: 'disabled' }
      | { kind: 'existing'; threadId: string }
      | { kind: 'adopted'; session: IndexedCodexSession }
      | { kind: 'missing' };
  };
}> {
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

  const lines = [`已切换到项目: ${resolved.projectAlias}`];
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

export async function listBridgeSessions(
  config: BridgeConfig,
  sessionStore: SessionStore,
  conversation: ConversationRef,
): Promise<{
  text: string;
  structured: {
    projectAlias: string;
    sessionKey: string;
    activeSessionId: string | null;
    sessions: Awaited<ReturnType<SessionStore['listProjectSessions']>>;
  };
}> {
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

export async function adoptProjectSession(
  config: BridgeConfig,
  sessionStore: SessionStore,
  sessionIndex: CodexSessionIndex,
  conversation: ConversationRef,
  target?: string,
): Promise<{
  text: string;
  structured: {
    projectAlias: string;
    projectRoot: string;
    target?: string;
    sessionKey?: string;
    candidates?: IndexedCodexSession[];
    adopted: IndexedCodexSession | null;
  };
}> {
  const resolved = await resolveProjectContext(config, sessionStore, conversation);
  if (!canAccessProjectCapability(config, resolved.projectAlias, resolved.chatId, 'session:control')) {
    throw new Error(`当前 chat_id 无权接管项目 ${resolved.projectAlias} 的会话。至少需要 ${describeMinimumRole('operator')} 权限。`);
  }
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
          adopted: null,
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
        adopted: null,
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
        sessionKey: resolved.sessionKey,
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
      projectRoot: resolved.project.root,
      sessionKey: resolved.sessionKey,
      target: normalizedTarget ?? 'latest',
      adopted,
    },
  };
}

export async function maybeAutoAdoptLatestSession(
  sessionStore: SessionStore,
  sessionIndex: CodexSessionIndex,
  context: ResolvedProjectContext,
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

export function renderSessionMatch(session: Pick<IndexedCodexSession, 'matchKind' | 'matchScore'>): string {
  const label = renderSessionMatchLabel(session);
  return session.matchScore ? `${label} (${session.matchScore})` : label;
}

function ensureProjectAccess(config: BridgeConfig, projectAlias: string, chatId: string, minimumRole: 'viewer' | 'operator'): void {
  if (!canAccessProject(config, projectAlias, chatId, minimumRole)) {
    throw new Error(`当前 chat_id 无权访问项目 ${projectAlias}。至少需要 ${describeMinimumRole(minimumRole)} 权限。`);
  }
}

function requireProject(config: BridgeConfig, alias: string): ProjectConfig {
  const project = config.projects[alias];
  if (!project) {
    throw new Error(`Project not found: ${alias}`);
  }
  return project;
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
