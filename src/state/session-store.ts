import path from 'node:path';
import { fileExists, readUtf8, writeUtf8Atomic } from '../utils/fs.js';
import type { BackendName, SessionScope } from '../config/schema.js';
import { SerialExecutor } from '../utils/serial-executor.js';

export interface SessionHistoryEntry {
  thread_id: string;
  created_at: string;
  updated_at: string;
  last_prompt?: string;
  last_response_excerpt?: string;
}

export interface ProjectSessionState {
  thread_id?: string;
  active_thread_id?: string;
  active_backend?: BackendName;
  last_prompt?: string;
  last_response_excerpt?: string;
  updated_at: string;
  sessions?: Record<string, SessionHistoryEntry>;
}

export interface ConversationState {
  selected_project_alias?: string;
  updated_at: string;
  scope: SessionScope;
  tenant_key?: string;
  chat_id: string;
  actor_id?: string;
  projects: Record<string, ProjectSessionState>;
}

export interface SessionStateFile {
  version: 1;
  conversations: Record<string, ConversationState>;
}

const DEFAULT_STATE: SessionStateFile = {
  version: 1,
  conversations: {},
};

export class SessionStore {
  private readonly stateFilePath: string;
  private readonly serial = new SerialExecutor();

  public constructor(stateDir: string) {
    this.stateFilePath = path.join(stateDir, 'sessions.json');
  }

  public async listConversations(): Promise<Array<[string, ConversationState]>> {
    await this.serial.wait();
    const state = await this.readState();
    return Object.entries(state.conversations)
      .map(([key, value]) => [key, normalizeConversation(value)] as [string, ConversationState])
      .sort((left, right) => right[1].updated_at.localeCompare(left[1].updated_at));
  }

  public async getConversation(conversationKey: string): Promise<ConversationState | null> {
    await this.serial.wait();
    const state = await this.readState();
    const conversation = state.conversations[conversationKey];
    return conversation ? normalizeConversation(conversation) : null;
  }

  public async ensureConversation(
    conversationKey: string,
    seed: Pick<ConversationState, 'chat_id' | 'scope' | 'tenant_key' | 'actor_id'>,
  ): Promise<ConversationState> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const existing = state.conversations[conversationKey];
      if (existing) {
        return normalizeConversation(existing);
      }

      const created: ConversationState = {
        ...seed,
        updated_at: new Date().toISOString(),
        projects: {},
      };
      state.conversations[conversationKey] = created;
      await this.writeState(state);
      return normalizeConversation(created);
    });
  }

  public async selectProject(conversationKey: string, projectAlias: string): Promise<void> {
    await this.serial.run(async () => {
      const state = await this.readState();
      const conversation = state.conversations[conversationKey];
      if (!conversation) {
        throw new Error(`Conversation not found: ${conversationKey}`);
      }
      conversation.selected_project_alias = projectAlias;
      conversation.updated_at = new Date().toISOString();
      await this.writeState(state);
    });
  }

  public async upsertProjectSession(
    conversationKey: string,
    projectAlias: string,
    patch: Partial<ProjectSessionState>,
  ): Promise<ProjectSessionState> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const conversation = state.conversations[conversationKey];
      if (!conversation) {
        throw new Error(`Conversation not found: ${conversationKey}`);
      }

      const now = new Date().toISOString();
      const current = normalizeProjectSession(conversation.projects[projectAlias]);
      const next: ProjectSessionState = {
        ...current,
        ...patch,
        updated_at: now,
        sessions: { ...(current.sessions ?? {}) },
      };

      const activeThreadId = patch.thread_id ?? patch.active_thread_id ?? next.active_thread_id ?? next.thread_id;
      if (activeThreadId) {
        const existingHistory = next.sessions?.[activeThreadId];
        next.sessions ??= {};
        next.sessions[activeThreadId] = {
          thread_id: activeThreadId,
          created_at: existingHistory?.created_at ?? now,
          updated_at: now,
          last_prompt: patch.last_prompt ?? next.last_prompt ?? existingHistory?.last_prompt,
          last_response_excerpt: patch.last_response_excerpt ?? next.last_response_excerpt ?? existingHistory?.last_response_excerpt,
        };
        next.active_thread_id = activeThreadId;
        next.thread_id = activeThreadId;
        next.last_prompt = next.sessions[activeThreadId].last_prompt;
        next.last_response_excerpt = next.sessions[activeThreadId].last_response_excerpt;
      }

      conversation.projects[projectAlias] = next;
      conversation.updated_at = now;
      await this.writeState(state);
      return normalizeProjectSession(next);
    });
  }

  public async listProjectSessions(conversationKey: string, projectAlias: string): Promise<SessionHistoryEntry[]> {
    await this.serial.wait();
    const conversation = await this.getConversation(conversationKey);
    const project = conversation?.projects[projectAlias];
    return Object.values(project?.sessions ?? {}).sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  public async setActiveProjectSession(conversationKey: string, projectAlias: string, threadId: string): Promise<ProjectSessionState> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const conversation = state.conversations[conversationKey];
      if (!conversation) {
        throw new Error(`Conversation not found: ${conversationKey}`);
      }
      const current = normalizeProjectSession(conversation.projects[projectAlias]);
      const history = current.sessions?.[threadId];
      if (!history) {
        throw new Error(`Session not found for project ${projectAlias}: ${threadId}`);
      }
      const next: ProjectSessionState = {
        ...current,
        thread_id: threadId,
        active_thread_id: threadId,
        last_prompt: history.last_prompt,
        last_response_excerpt: history.last_response_excerpt,
        updated_at: new Date().toISOString(),
        sessions: current.sessions,
      };
      conversation.projects[projectAlias] = next;
      conversation.updated_at = next.updated_at;
      await this.writeState(state);
      return normalizeProjectSession(next);
    });
  }

  public async clearActiveProjectSession(conversationKey: string, projectAlias: string): Promise<ProjectSessionState | null> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const conversation = state.conversations[conversationKey];
      if (!conversation) {
        return null;
      }
      const current = normalizeProjectSession(conversation.projects[projectAlias]);
      if (!current.updated_at) {
        return null;
      }
      const next: ProjectSessionState = {
        ...current,
        thread_id: undefined,
        active_thread_id: undefined,
        last_prompt: undefined,
        last_response_excerpt: undefined,
        updated_at: new Date().toISOString(),
        sessions: current.sessions,
      };
      conversation.projects[projectAlias] = next;
      conversation.updated_at = next.updated_at;
      await this.writeState(state);
      return normalizeProjectSession(next);
    });
  }

  public async setProjectBackend(conversationKey: string, projectAlias: string, backendName: BackendName): Promise<void> {
    await this.serial.run(async () => {
      const state = await this.readState();
      const conversation = state.conversations[conversationKey];
      if (!conversation) {
        throw new Error(`Conversation not found: ${conversationKey}`);
      }
      const current = normalizeProjectSession(conversation.projects[projectAlias]);
      conversation.projects[projectAlias] = {
        ...current,
        active_backend: backendName,
        updated_at: new Date().toISOString(),
      };
      conversation.updated_at = new Date().toISOString();
      await this.writeState(state);
    });
  }

  public async getProjectBackend(conversationKey: string, projectAlias: string): Promise<BackendName | undefined> {
    await this.serial.wait();
    const state = await this.readState();
    const conversation = state.conversations[conversationKey];
    return conversation?.projects[projectAlias]?.active_backend;
  }

  public async dropProjectSession(conversationKey: string, projectAlias: string, threadId: string): Promise<ProjectSessionState | null> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const conversation = state.conversations[conversationKey];
      if (!conversation) {
        return null;
      }
      const current = normalizeProjectSession(conversation.projects[projectAlias]);
      if (!current.sessions?.[threadId]) {
        return current.updated_at ? current : null;
      }

      const sessions = { ...(current.sessions ?? {}) };
      delete sessions[threadId];
      const nextActive = Object.values(sessions).sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
      const next: ProjectSessionState = {
        updated_at: new Date().toISOString(),
        sessions,
        thread_id: nextActive?.thread_id,
        active_thread_id: nextActive?.thread_id,
        last_prompt: nextActive?.last_prompt,
        last_response_excerpt: nextActive?.last_response_excerpt,
      };
      if (Object.keys(sessions).length === 0) {
        conversation.projects[projectAlias] = next;
      } else {
        conversation.projects[projectAlias] = next;
      }
      conversation.updated_at = next.updated_at;
      await this.writeState(state);
      return normalizeProjectSession(next);
    });
  }

  public async resetProjectSession(conversationKey: string, projectAlias: string): Promise<void> {
    await this.serial.run(async () => {
      const state = await this.readState();
      const conversation = state.conversations[conversationKey];
      if (!conversation) {
        return;
      }
      delete conversation.projects[projectAlias];
      conversation.updated_at = new Date().toISOString();
      await this.writeState(state);
    });
  }

  public async clearConversation(conversationKey: string): Promise<void> {
    await this.serial.run(async () => {
      const state = await this.readState();
      delete state.conversations[conversationKey];
      await this.writeState(state);
    });
  }

  private async readState(): Promise<SessionStateFile> {
    if (!(await fileExists(this.stateFilePath))) {
      return structuredClone(DEFAULT_STATE);
    }

    const content = await readUtf8(this.stateFilePath);
    const parsed = JSON.parse(content) as SessionStateFile;
    return {
      version: 1,
      conversations: Object.fromEntries(
        Object.entries(parsed.conversations ?? {}).map(([key, value]) => [key, normalizeConversation(value)]),
      ),
    };
  }

  private async writeState(state: SessionStateFile): Promise<void> {
    await writeUtf8Atomic(this.stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export function buildConversationKey(input: {
  tenantKey?: string;
  chatId: string;
  actorId?: string;
  scope: SessionScope;
}): string {
  const scopeId = input.scope === 'chat-user' ? input.actorId ?? 'unknown-actor' : 'shared';
  return [input.tenantKey ?? 'tenant', input.chatId, input.scope, scopeId].join('::');
}

function normalizeConversation(input: ConversationState): ConversationState {
  return {
    ...input,
    projects: Object.fromEntries(
      Object.entries(input.projects ?? {}).map(([alias, project]) => [alias, normalizeProjectSession(project)]),
    ),
  };
}

function normalizeProjectSession(input?: Partial<ProjectSessionState>): ProjectSessionState {
  const updatedAt = input?.updated_at ?? new Date(0).toISOString();
  const sessions = { ...(input?.sessions ?? {}) };
  const activeThreadId = input?.active_thread_id ?? input?.thread_id;

  if (activeThreadId && !sessions[activeThreadId]) {
    sessions[activeThreadId] = {
      thread_id: activeThreadId,
      created_at: updatedAt,
      updated_at: updatedAt,
      last_prompt: input?.last_prompt,
      last_response_excerpt: input?.last_response_excerpt,
    };
  }

  return {
    thread_id: activeThreadId,
    active_thread_id: activeThreadId,
    last_prompt: activeThreadId ? sessions[activeThreadId]?.last_prompt ?? input?.last_prompt : input?.last_prompt,
    last_response_excerpt: activeThreadId ? sessions[activeThreadId]?.last_response_excerpt ?? input?.last_response_excerpt : input?.last_response_excerpt,
    updated_at: updatedAt,
    sessions,
  };
}
