import type { MemoryRecord, MemoryStore, ThreadSummaryRecord } from '../state/memory-store.js';

export interface MemoryContext {
  threadSummary?: ThreadSummaryRecord;
  pinnedMemories: MemoryRecord[];
  relevantMemories: MemoryRecord[];
  pinnedGroupMemories: MemoryRecord[];
  relevantGroupMemories: MemoryRecord[];
}

export async function retrieveMemoryContext(
  store: MemoryStore,
  input: {
    conversationKey: string;
    projectAlias: string;
    threadId?: string;
    query: string;
    searchLimit: number;
    groupChatId?: string;
    includeGroupMemories?: boolean;
  },
): Promise<MemoryContext> {
  const threadSummary = input.threadId
    ? await store.getThreadSummary(input.conversationKey, input.projectAlias, input.threadId)
    : null;

  const recent = await store.listRecentProjectMemories(input.projectAlias, input.searchLimit);
  const pinned = recent.filter((record) => record.pinned);
  const searched = input.query.trim()
    ? await store.searchProjectMemories(input.projectAlias, input.query, input.searchLimit)
    : [];
  const relevant = searched.length > 0 ? searched : recent;
  const pinnedIds = new Set(pinned.map((item) => item.id));

  const groupRecent = input.includeGroupMemories && input.groupChatId
    ? await store.listRecentGroupMemories(input.projectAlias, input.groupChatId, input.searchLimit)
    : [];
  const groupPinned = groupRecent.filter((record) => record.pinned);
  const groupSearched = input.includeGroupMemories && input.groupChatId && input.query.trim()
    ? await store.searchGroupMemories(input.projectAlias, input.groupChatId, input.query, input.searchLimit)
    : [];
  const groupRelevant = groupSearched.length > 0 ? groupSearched : groupRecent;
  const groupPinnedIds = new Set(groupPinned.map((item) => item.id));

  return {
    threadSummary: threadSummary ?? undefined,
    pinnedMemories: pinned.slice(0, input.searchLimit),
    relevantMemories: relevant.filter((item) => !pinnedIds.has(item.id)).slice(0, input.searchLimit),
    pinnedGroupMemories: groupPinned.slice(0, input.searchLimit),
    relevantGroupMemories: groupRelevant.filter((item) => !groupPinnedIds.has(item.id)).slice(0, input.searchLimit),
  };
}
