import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from '../utils/fs.js';
import { SerialExecutor } from '../utils/serial-executor.js';

export type MemoryScope = 'project' | 'group';

export interface ThreadSummaryRecord {
  conversation_key: string;
  project_alias: string;
  thread_id: string;
  summary: string;
  recent_prompt?: string;
  recent_response_excerpt?: string;
  files_touched: string[];
  open_tasks: string[];
  decisions: string[];
  created_at: string;
  updated_at: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  project_alias: string;
  chat_id?: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  pinned: boolean;
  confidence: number;
  created_by?: string;
  created_at: string;
  updated_at: string;
  last_accessed_at?: string;
  archived_at?: string;
  archived_by?: string;
  archive_reason?: string;
  expires_at?: string;
}

export type ProjectMemoryRecord = MemoryRecord;

interface MemorySelector {
  scope: MemoryScope;
  project_alias: string;
  chat_id?: string;
}

export interface MemoryFilters {
  tag?: string;
  source?: string;
  created_by?: string;
}

export type MemoryPinAgeBasis = 'updated_at' | 'last_accessed_at';
export interface MemoryStats {
  active_count: number;
  archived_count: number;
  expired_count: number;
  pinned_count: number;
  latest_updated_at?: string;
  latest_accessed_at?: string;
  latest_archived_at?: string;
}

interface MemoryQueryOptions {
  includeExpired?: boolean;
  includeArchived?: boolean;
}

const MEMORY_SCHEMA_VERSION = 4;

export class MemoryStore {
  private readonly dbPath: string;
  private readonly serial = new SerialExecutor();

  public constructor(stateDir: string) {
    this.dbPath = path.join(stateDir, 'memory.db');
  }

  public async upsertThreadSummary(record: Omit<ThreadSummaryRecord, 'created_at' | 'updated_at'>): Promise<ThreadSummaryRecord> {
    return this.serial.run(async () => {
      const now = new Date().toISOString();
      return this.withDb((db) => {
        db.prepare(`
          INSERT INTO thread_summaries (
            conversation_key, project_alias, thread_id, summary, recent_prompt, recent_response_excerpt,
            files_touched_json, open_tasks_json, decisions_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_key, project_alias, thread_id) DO UPDATE SET
            summary = excluded.summary,
            recent_prompt = excluded.recent_prompt,
            recent_response_excerpt = excluded.recent_response_excerpt,
            files_touched_json = excluded.files_touched_json,
            open_tasks_json = excluded.open_tasks_json,
            decisions_json = excluded.decisions_json,
            updated_at = excluded.updated_at
        `).run(
          record.conversation_key,
          record.project_alias,
          record.thread_id,
          record.summary,
          record.recent_prompt ?? null,
          record.recent_response_excerpt ?? null,
          JSON.stringify(record.files_touched),
          JSON.stringify(record.open_tasks),
          JSON.stringify(record.decisions),
          now,
          now,
        );

        const row = db.prepare(`
          SELECT conversation_key, project_alias, thread_id, summary, recent_prompt, recent_response_excerpt,
                 files_touched_json, open_tasks_json, decisions_json, created_at, updated_at
          FROM thread_summaries
          WHERE conversation_key = ? AND project_alias = ? AND thread_id = ?
        `).get(record.conversation_key, record.project_alias, record.thread_id) as unknown as ThreadSummaryRow;

        return mapThreadSummaryRow(row);
      });
    });
  }

  public async getThreadSummary(conversationKey: string, projectAlias: string, threadId: string): Promise<ThreadSummaryRecord | null> {
    await this.serial.wait();
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT conversation_key, project_alias, thread_id, summary, recent_prompt, recent_response_excerpt,
               files_touched_json, open_tasks_json, decisions_json, created_at, updated_at
        FROM thread_summaries
        WHERE conversation_key = ? AND project_alias = ? AND thread_id = ?
      `).get(conversationKey, projectAlias, threadId) as ThreadSummaryRow | undefined;
      return row ? mapThreadSummaryRow(row) : null;
    });
  }

  public async saveMemory(input: {
    scope: MemoryScope;
    project_alias: string;
    chat_id?: string;
    title: string;
    content: string;
    tags?: string[];
    source?: string;
    pinned?: boolean;
    confidence?: number;
    created_by?: string;
    expires_at?: string;
  }): Promise<MemoryRecord> {
    return this.serial.run(async () => {
      const now = new Date().toISOString();
      const record: MemoryRecord = {
        id: randomUUID(),
        scope: input.scope,
        project_alias: input.project_alias,
        chat_id: input.scope === 'group' ? input.chat_id : undefined,
        title: input.title,
        content: input.content,
        tags: input.tags ?? [],
        source: input.source ?? 'manual',
        pinned: input.pinned ?? false,
        confidence: input.confidence ?? 1,
        created_by: input.created_by,
        created_at: now,
        updated_at: now,
        last_accessed_at: now,
        expires_at: input.expires_at,
      };

      return this.withDb((db) => {
        db.prepare(`
          INSERT INTO project_memories (
            id, scope, project_alias, chat_id, title, content, tags_json, source, pinned, confidence, created_by, created_at, updated_at, last_accessed_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.id,
          record.scope,
          record.project_alias,
          record.chat_id ?? null,
          record.title,
          record.content,
          JSON.stringify(record.tags),
          record.source,
          record.pinned ? 1 : 0,
          record.confidence,
          record.created_by ?? null,
          record.created_at,
          record.updated_at,
          record.last_accessed_at ?? null,
          record.expires_at ?? null,
        );
        return record;
      });
    });
  }

  public async saveProjectMemory(input: {
    project_alias: string;
    title: string;
    content: string;
    tags?: string[];
    source?: string;
    pinned?: boolean;
    confidence?: number;
    created_by?: string;
    expires_at?: string;
  }): Promise<ProjectMemoryRecord> {
    return this.saveMemory({ ...input, scope: 'project' });
  }

  public async saveGroupMemory(input: {
    project_alias: string;
    chat_id: string;
    title: string;
    content: string;
    tags?: string[];
    source?: string;
    pinned?: boolean;
    confidence?: number;
    created_by?: string;
    expires_at?: string;
  }): Promise<MemoryRecord> {
    return this.saveMemory({ ...input, scope: 'group' });
  }

  public async searchMemories(selector: MemorySelector, query: string, limit: number, filters?: MemoryFilters): Promise<MemoryRecord[]> {
    await this.serial.wait();
    return this.withDb((db) => {
      const ftsQuery = buildAsciiFtsQuery(query);
      if (ftsQuery) {
        const { whereClause, params } = buildMemorySelectorWhere(selector, filters);
        const rows = db.prepare(`
          SELECT pm.id, pm.scope, pm.project_alias, pm.chat_id, pm.title, pm.content, pm.tags_json, pm.source, pm.pinned, pm.confidence, pm.created_by, pm.created_at, pm.updated_at, pm.last_accessed_at, pm.expires_at
          FROM memory_fts
          JOIN project_memories pm ON pm.rowid = memory_fts.rowid
          WHERE ${whereClause}
            AND memory_fts MATCH ?
          ORDER BY pm.pinned DESC, bm25(memory_fts), pm.updated_at DESC
          LIMIT ?
        `).all(...params, ftsQuery, limit) as unknown as MemoryRow[];
        if (rows.length > 0) {
          return touchRowsAndMap(db, rows);
        }
      }

      const normalized = `%${query.trim().toLowerCase()}%`;
      const { whereClause, params } = buildMemorySelectorWhere(selector, filters);
      const rows = db.prepare(`
        SELECT id, scope, project_alias, chat_id, title, content, tags_json, source, pinned, confidence, created_by, created_at, updated_at, last_accessed_at, expires_at
        FROM project_memories
        WHERE ${whereClause}
          AND (
            lower(title) LIKE ?
            OR lower(content) LIKE ?
            OR lower(tags_json) LIKE ?
          )
        ORDER BY pinned DESC, updated_at DESC
        LIMIT ?
      `).all(...params, normalized, normalized, normalized, limit) as unknown as MemoryRow[];
      return touchRowsAndMap(db, rows);
    });
  }

  public async searchProjectMemories(projectAlias: string, query: string, limit: number, filters?: MemoryFilters): Promise<ProjectMemoryRecord[]> {
    return this.searchMemories({ scope: 'project', project_alias: projectAlias }, query, limit, filters);
  }

  public async searchGroupMemories(projectAlias: string, chatId: string, query: string, limit: number, filters?: MemoryFilters): Promise<MemoryRecord[]> {
    return this.searchMemories({ scope: 'group', project_alias: projectAlias, chat_id: chatId }, query, limit, filters);
  }

  public async getMemory(selector: MemorySelector, id: string): Promise<MemoryRecord | null> {
    await this.serial.wait();
    return this.withDb((db) => {
      const { whereClause, params } = buildMemorySelectorWhere(selector);
      const row = db.prepare(`
        SELECT id, scope, project_alias, chat_id, title, content, tags_json, source, pinned, confidence, created_by, created_at, updated_at, last_accessed_at, archived_at, archived_by, archive_reason, expires_at
        FROM project_memories
        WHERE id = ?
          AND ${whereClause}
      `).get(id, ...params) as unknown as MemoryRow | undefined;
      return row ? mapMemoryRow(row) : null;
    });
  }

  public async getMemoryById(selector: MemorySelector, id: string, options?: MemoryQueryOptions): Promise<MemoryRecord | null> {
    await this.serial.wait();
    return this.withDb((db) => {
      const { whereClause, params } = buildMemorySelectorWhere(selector, undefined, options);
      const row = db.prepare(`
        SELECT id, scope, project_alias, chat_id, title, content, tags_json, source, pinned, confidence, created_by, created_at, updated_at, last_accessed_at, archived_at, archived_by, archive_reason, expires_at
        FROM project_memories
        WHERE id = ?
          AND ${whereClause}
      `).get(id, ...params) as unknown as MemoryRow | undefined;
      return row ? mapMemoryRow(row) : null;
    });
  }

  public async listRecentMemories(selector: MemorySelector, limit: number, filters?: MemoryFilters): Promise<MemoryRecord[]> {
    await this.serial.wait();
    return this.withDb((db) => {
      const { whereClause, params } = buildMemorySelectorWhere(selector, filters);
      const rows = db.prepare(`
        SELECT id, scope, project_alias, chat_id, title, content, tags_json, source, pinned, confidence, created_by, created_at, updated_at, last_accessed_at, expires_at
        FROM project_memories
        WHERE ${whereClause}
        ORDER BY pinned DESC, updated_at DESC
        LIMIT ?
      `).all(...params, limit) as unknown as MemoryRow[];
      return touchRowsAndMap(db, rows);
    });
  }

  public async listRecentProjectMemories(projectAlias: string, limit: number, filters?: MemoryFilters): Promise<ProjectMemoryRecord[]> {
    return this.listRecentMemories({ scope: 'project', project_alias: projectAlias }, limit, filters);
  }

  public async listRecentGroupMemories(projectAlias: string, chatId: string, limit: number, filters?: MemoryFilters): Promise<MemoryRecord[]> {
    return this.listRecentMemories({ scope: 'group', project_alias: projectAlias, chat_id: chatId }, limit, filters);
  }

  public async countMemories(selector: MemorySelector): Promise<number> {
    await this.serial.wait();
    return this.withDb((db) => {
      const { whereClause, params } = buildMemorySelectorWhere(selector);
      const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM project_memories
        WHERE ${whereClause}
      `).get(...params) as { count: number };
      return Number(row.count ?? 0);
    });
  }

  public async countProjectMemories(projectAlias: string): Promise<number> {
    return this.countMemories({ scope: 'project', project_alias: projectAlias });
  }

  public async countGroupMemories(projectAlias: string, chatId: string): Promise<number> {
    return this.countMemories({ scope: 'group', project_alias: projectAlias, chat_id: chatId });
  }

  public async countPinnedMemories(selector: MemorySelector): Promise<number> {
    await this.serial.wait();
    return this.withDb((db) => {
      const { whereClause, params } = buildMemorySelectorWhere(selector);
      const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM project_memories
        WHERE ${whereClause}
          AND pinned = 1
      `).get(...params) as { count: number };
      return Number(row.count ?? 0);
    });
  }

  public async countPinnedProjectMemories(projectAlias: string): Promise<number> {
    return this.countPinnedMemories({ scope: 'project', project_alias: projectAlias });
  }

  public async countPinnedGroupMemories(projectAlias: string, chatId: string): Promise<number> {
    return this.countPinnedMemories({ scope: 'group', project_alias: projectAlias, chat_id: chatId });
  }

  public async getMemoryStats(selector: MemorySelector): Promise<MemoryStats> {
    await this.serial.wait();
    return this.withDb((db) => {
      const now = new Date().toISOString();
      const params: Array<string | null> = [selector.scope, selector.project_alias];
      const baseClauses = ['scope = ?', 'project_alias = ?'];
      if (selector.scope === 'group') {
        baseClauses.push('chat_id = ?');
        params.push(selector.chat_id ?? null);
      }
      const baseWhere = baseClauses.join(' AND ');
      const row = db.prepare(`
        SELECT
          SUM(CASE WHEN archived_at IS NULL AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active_count,
          SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_count,
          SUM(CASE WHEN archived_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired_count,
          SUM(CASE WHEN archived_at IS NULL AND pinned = 1 AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS pinned_count,
          MAX(updated_at) AS latest_updated_at,
          MAX(last_accessed_at) AS latest_accessed_at,
          MAX(archived_at) AS latest_archived_at
        FROM project_memories
        WHERE ${baseWhere}
      `).get(now, now, now, ...params) as {
        active_count?: number;
        archived_count?: number;
        expired_count?: number;
        pinned_count?: number;
        latest_updated_at?: string | null;
        latest_accessed_at?: string | null;
        latest_archived_at?: string | null;
      };
      return {
        active_count: Number(row.active_count ?? 0),
        archived_count: Number(row.archived_count ?? 0),
        expired_count: Number(row.expired_count ?? 0),
        pinned_count: Number(row.pinned_count ?? 0),
        latest_updated_at: row.latest_updated_at ?? undefined,
        latest_accessed_at: row.latest_accessed_at ?? undefined,
        latest_archived_at: row.latest_archived_at ?? undefined,
      };
    });
  }

  public async cleanupExpiredMemories(selector?: MemorySelector): Promise<number> {
    return this.serial.run(async () => {
      return this.withDb((db) => {
        const now = new Date().toISOString();
        const clauses = ['archived_at IS NULL', 'expires_at IS NOT NULL', 'expires_at <= ?'];
        const params: Array<string | null> = [now];
        if (selector) {
          clauses.push('scope = ?');
          params.push(selector.scope);
          clauses.push('project_alias = ?');
          params.push(selector.project_alias);
          if (selector.scope === 'group') {
            clauses.push('chat_id = ?');
            params.push(selector.chat_id ?? null);
          }
        }
        const result = db.prepare(`
          UPDATE project_memories
          SET archived_at = ?, archived_by = ?, archive_reason = ?, pinned = 0, updated_at = ?
          WHERE ${clauses.join(' AND ')}
        `).run(now, 'system', 'expired', now, ...params);
        return Number(result.changes ?? 0);
      });
    });
  }

  public async getOldestPinnedMemory(selector: MemorySelector, basis: MemoryPinAgeBasis = 'updated_at'): Promise<MemoryRecord | null> {
    await this.serial.wait();
    return this.withDb((db) => {
      const { whereClause, params } = buildMemorySelectorWhere(selector, {});
      const orderBy = basis === 'last_accessed_at'
        ? 'COALESCE(last_accessed_at, updated_at, created_at) ASC, updated_at ASC'
        : 'updated_at ASC';
      const row = db.prepare(`
        SELECT id, scope, project_alias, chat_id, title, content, tags_json, source, pinned, confidence, created_by, created_at, updated_at, last_accessed_at, expires_at
        FROM project_memories
        WHERE ${whereClause}
          AND pinned = 1
        ORDER BY ${orderBy}
        LIMIT 1
      `).get(...params) as unknown as MemoryRow | undefined;
      return row ? mapMemoryRow(row) : null;
    });
  }

  public async setMemoryPinned(selector: MemorySelector, id: string, pinned: boolean): Promise<MemoryRecord | null> {
    return this.serial.run(async () => {
      const now = new Date().toISOString();
      return this.withDb((db) => {
        const { whereClause, params } = buildMemorySelectorWhere(selector);
        const result = db.prepare(`
          UPDATE project_memories
          SET pinned = ?, updated_at = ?, last_accessed_at = ?
          WHERE id = ?
            AND ${whereClause}
        `).run(pinned ? 1 : 0, now, now, id, ...params);
        if (result.changes === 0) {
          return null;
        }
        const row = db.prepare(`
          SELECT id, scope, project_alias, chat_id, title, content, tags_json, source, pinned, confidence, created_by, created_at, updated_at, last_accessed_at, expires_at
          FROM project_memories
          WHERE id = ?
            AND ${whereClause}
        `).get(id, ...params) as unknown as MemoryRow | undefined;
        return row ? mapMemoryRow(row) : null;
      });
    });
  }

  public async archiveMemory(selector: MemorySelector, id: string, input?: { archived_by?: string; reason?: string }): Promise<MemoryRecord | null> {
    return this.serial.run(async () => {
      const now = new Date().toISOString();
      return this.withDb((db) => {
        const { whereClause, params } = buildMemorySelectorWhere(selector);
        const result = db.prepare(`
          UPDATE project_memories
          SET archived_at = ?, archived_by = ?, archive_reason = ?, pinned = 0, updated_at = ?
          WHERE id = ?
            AND ${whereClause}
        `).run(now, input?.archived_by ?? null, input?.reason ?? 'manual', now, id, ...params);
        if (result.changes === 0) {
          return null;
        }
        const row = db.prepare(`
          SELECT id, scope, project_alias, chat_id, title, content, tags_json, source, pinned, confidence, created_by, created_at, updated_at, last_accessed_at, archived_at, archived_by, archive_reason, expires_at
          FROM project_memories
          WHERE id = ?
            AND scope = ?
            AND project_alias = ?
            ${selector.scope === 'group' ? 'AND chat_id = ?' : ''}
        `).get(id, selector.scope, selector.project_alias, ...(selector.scope === 'group' ? [selector.chat_id ?? null] : [])) as unknown as MemoryRow | undefined;
        return row ? mapMemoryRow(row) : null;
      });
    });
  }

  public async restoreMemory(selector: MemorySelector, id: string, restoredBy?: string): Promise<MemoryRecord | null> {
    return this.serial.run(async () => {
      const now = new Date().toISOString();
      return this.withDb((db) => {
        const { whereClause, params } = buildMemorySelectorWhere(selector, undefined, { includeArchived: true, includeExpired: true });
        const result = db.prepare(`
          UPDATE project_memories
          SET archived_at = NULL,
              archived_by = NULL,
              archive_reason = NULL,
              updated_at = ?,
              last_accessed_at = ?,
              expires_at = CASE
                WHEN expires_at IS NOT NULL AND expires_at <= ? THEN NULL
                ELSE expires_at
              END
          WHERE id = ?
            AND archived_at IS NOT NULL
            AND ${whereClause}
        `).run(now, now, now, id, ...params);
        if (result.changes === 0) {
          return null;
        }
        const restored = db.prepare(`
          SELECT id, scope, project_alias, chat_id, title, content, tags_json, source, pinned, confidence, created_by, created_at, updated_at, last_accessed_at, archived_at, archived_by, archive_reason, expires_at
          FROM project_memories
          WHERE id = ?
            AND ${whereClause}
        `).get(id, ...params) as unknown as MemoryRow | undefined;
        if (restoredBy) {
          void restoredBy;
        }
        return restored ? mapMemoryRow(restored) : null;
      });
    });
  }

  public async ensureReady(): Promise<void> {
    await this.serial.run(async () => {
      await ensureDir(path.dirname(this.dbPath));
      this.withDb(() => undefined);
    });
  }

  private withDb<T>(callback: (db: DatabaseSync) => T): T {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    try {
      initializeSchema(db);
      return callback(db);
    } finally {
      db.close();
    }
  }
}

interface ThreadSummaryRow {
  conversation_key: string;
  project_alias: string;
  thread_id: string;
  summary: string;
  recent_prompt?: string | null;
  recent_response_excerpt?: string | null;
  files_touched_json: string;
  open_tasks_json: string;
  decisions_json: string;
  created_at: string;
  updated_at: string;
}

interface MemoryRow {
  id: string;
  scope: string;
  project_alias: string;
  chat_id?: string | null;
  title: string;
  content: string;
  tags_json: string;
  source: string;
  pinned: number;
  confidence: number;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at?: string | null;
  archived_at?: string | null;
  archived_by?: string | null;
  archive_reason?: string | null;
  expires_at?: string | null;
}

function initializeSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_summaries (
      conversation_key TEXT NOT NULL,
      project_alias TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      recent_prompt TEXT,
      recent_response_excerpt TEXT,
      files_touched_json TEXT NOT NULL DEFAULT '[]',
      open_tasks_json TEXT NOT NULL DEFAULT '[]',
      decisions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_key, project_alias, thread_id)
    );

    CREATE TABLE IF NOT EXISTS project_memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'project',
      project_alias TEXT NOT NULL,
      chat_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      pinned INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      archived_at TEXT,
      archived_by TEXT,
      archive_reason TEXT,
      expires_at TEXT
    );
  `);

  const userVersion = getUserVersion(db);
  if (userVersion < MEMORY_SCHEMA_VERSION) {
    migrateProjectMemoriesSchema(db);
    db.exec(`
      DROP TRIGGER IF EXISTS project_memories_ai;
      DROP TRIGGER IF EXISTS project_memories_ad;
      DROP TRIGGER IF EXISTS project_memories_au;
      DROP TABLE IF EXISTS memory_fts;
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project_memories_scope_project_updated
      ON project_memories(scope, project_alias, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_project_memories_scope_project_chat_updated
      ON project_memories(scope, project_alias, chat_id, updated_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      title,
      content,
      tags_json,
      content='project_memories',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS project_memories_ai AFTER INSERT ON project_memories BEGIN
      INSERT INTO memory_fts(rowid, title, content, tags_json)
      VALUES (new.rowid, new.title, new.content, new.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS project_memories_ad AFTER DELETE ON project_memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, content, tags_json)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS project_memories_au AFTER UPDATE ON project_memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, content, tags_json)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags_json);
      INSERT INTO memory_fts(rowid, title, content, tags_json)
      VALUES (new.rowid, new.title, new.content, new.tags_json);
    END;
  `);

  if (userVersion < MEMORY_SCHEMA_VERSION) {
    db.prepare("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')").run();
    db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION};`);
  }
}

function migrateProjectMemoriesSchema(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(project_memories)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has('scope')) {
    db.exec("ALTER TABLE project_memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
  }
  if (!names.has('chat_id')) {
    db.exec('ALTER TABLE project_memories ADD COLUMN chat_id TEXT');
  }
  if (!names.has('last_accessed_at')) {
    db.exec('ALTER TABLE project_memories ADD COLUMN last_accessed_at TEXT');
    db.exec('UPDATE project_memories SET last_accessed_at = updated_at WHERE last_accessed_at IS NULL');
  }
  if (!names.has('archived_at')) {
    db.exec('ALTER TABLE project_memories ADD COLUMN archived_at TEXT');
  }
  if (!names.has('archived_by')) {
    db.exec('ALTER TABLE project_memories ADD COLUMN archived_by TEXT');
  }
  if (!names.has('archive_reason')) {
    db.exec('ALTER TABLE project_memories ADD COLUMN archive_reason TEXT');
  }
}

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function buildMemorySelectorWhere(selector: MemorySelector, filters?: MemoryFilters, options?: MemoryQueryOptions): { whereClause: string; params: Array<string | null> } {
  const params: Array<string | null> = [selector.scope, selector.project_alias];
  const clauses = [
    'scope = ?',
    'project_alias = ?',
  ];

  if (!options?.includeExpired) {
    clauses.push('(expires_at IS NULL OR expires_at > ?)');
    params.push(new Date().toISOString());
  }

  if (!options?.includeArchived) {
    clauses.push('archived_at IS NULL');
  }

  if (selector.scope === 'group') {
    clauses.push('chat_id = ?');
    params.push(selector.chat_id ?? null);
  }

  if (filters?.source) {
    clauses.push('source = ?');
    params.push(filters.source);
  }

  if (filters?.created_by) {
    clauses.push('created_by = ?');
    params.push(filters.created_by);
  }

  if (filters?.tag) {
    clauses.push('lower(tags_json) LIKE ?');
    params.push(`%${filters.tag.toLowerCase()}%`);
  }

  return {
    whereClause: clauses.join(' AND '),
    params,
  };
}

function buildAsciiFtsQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  return tokens.map((token) => `${token}*`).join(' AND ');
}

function mapThreadSummaryRow(row: ThreadSummaryRow): ThreadSummaryRecord {
  return {
    conversation_key: row.conversation_key,
    project_alias: row.project_alias,
    thread_id: row.thread_id,
    summary: row.summary,
    recent_prompt: row.recent_prompt ?? undefined,
    recent_response_excerpt: row.recent_response_excerpt ?? undefined,
    files_touched: parseJsonArray(row.files_touched_json),
    open_tasks: parseJsonArray(row.open_tasks_json),
    decisions: parseJsonArray(row.decisions_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapMemoryRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope === 'group' ? 'group' : 'project',
    project_alias: row.project_alias,
    chat_id: row.chat_id ?? undefined,
    title: row.title,
    content: row.content,
    tags: parseJsonArray(row.tags_json),
    source: row.source,
    pinned: row.pinned === 1,
    confidence: row.confidence,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_accessed_at: row.last_accessed_at ?? undefined,
    archived_at: row.archived_at ?? undefined,
    archived_by: row.archived_by ?? undefined,
    archive_reason: row.archive_reason ?? undefined,
    expires_at: row.expires_at ?? undefined,
  };
}

function touchRowsAndMap(db: DatabaseSync, rows: MemoryRow[]): MemoryRecord[] {
  if (rows.length === 0) {
    return [];
  }
  const touchedAt = new Date().toISOString();
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(`
    UPDATE project_memories
    SET last_accessed_at = ?
    WHERE id IN (${placeholders})
  `).run(touchedAt, ...ids);
  return rows.map((row) => mapMemoryRow({ ...row, last_accessed_at: touchedAt }));
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
