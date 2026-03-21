/**
 * Direction 2: 会话间知识回路 — Cross-Session Knowledge Loop
 *
 * Extracts insights from completed AI sessions and makes them
 * searchable across the team. Supports manual /learn and /recall.
 */

import type { MemoryRecord } from '../state/memory-store.js';

export interface LearnInput {
  project_alias: string;
  chat_id?: string;
  actor_id?: string;
  title: string;
  content: string;
  tags: string[];
  source: 'manual' | 'auto';
}

/**
 * Heuristic extraction of key findings from a completed AI run.
 * Returns null if no actionable insight is detected.
 */
export function extractInsights(
  prompt: string,
  response: string,
  projectAlias: string,
): LearnInput | null {
  const combined = `${prompt}\n${response}`;
  const lower = combined.toLowerCase();

  // Look for signal patterns — both explicit labels and natural phrasing
  const patterns: Array<{ regex: RegExp; tag: string }> = [
    // Explicit labels (original)
    { regex: /root\s*cause[：:]\s*(.+)/i, tag: 'root-cause' },
    { regex: /根因[：:]\s*(.+)/i, tag: 'root-cause' },
    { regex: /solution[：:]\s*(.+)/i, tag: 'solution' },
    { regex: /解决方案[：:]\s*(.+)/i, tag: 'solution' },
    { regex: /workaround[：:]\s*(.+)/i, tag: 'workaround' },
    { regex: /breaking\s*change[：:]\s*(.+)/i, tag: 'breaking-change' },

    // Natural language — English
    { regex: /(?:the\s+)?(?:root\s+)?(?:cause|issue|problem)\s+(?:was|is|turned out to be)\s+(.+)/i, tag: 'root-cause' },
    { regex: /(?:fixed|resolved|solved)\s+(?:by|this by|it by)\s+(.+)/i, tag: 'solution' },
    { regex: /(?:the\s+)?(?:fix|solution|resolution)\s+(?:was|is)\s+(?:to\s+)?(.+)/i, tag: 'solution' },
    { regex: /(?:found|discovered|noticed|identified)\s+(?:that\s+)?(.{20,})/i, tag: 'finding' },
    { regex: /(?:the\s+)?(?:key\s+)?(?:takeaway|insight|lesson|learning)\s+(?:is|was|here)\s*[：:]\s*(.+)/i, tag: 'conclusion' },
    { regex: /(?:important|note|warning|caution)[：:]\s*(.+)/i, tag: 'warning' },
    { regex: /(?:turns out|it appears|apparently)\s+(.{20,})/i, tag: 'finding' },

    // Natural language — Chinese
    { regex: /(?:原因|问题)(?:是|在于|出在)\s*(.+)/i, tag: 'root-cause' },
    { regex: /(?:通过|已经?|已通过)\s*(.{10,}?)(?:解决|修复|修好|搞定)/i, tag: 'solution' },
    { regex: /(?:需要|应该|建议)\s*(.{10,}?)(?:才能|就可以|来解决|来修复)/i, tag: 'solution' },
    { regex: /发现\s*(.{10,})/i, tag: 'finding' },
    { regex: /(?:关键|重要|核心)(?:发现|结论|原因|问题)[：:]\s*(.+)/i, tag: 'conclusion' },
    { regex: /(?:注意|警告|小心)[：:]\s*(.+)/i, tag: 'warning' },
    { regex: /(?:之所以|导致).{5,}?(?:是因为|原因是)\s*(.+)/i, tag: 'root-cause' },
    { regex: /(?:改成|改为|换成|调整为)\s*(.{10,}?)(?:就好了|就可以了|解决了|正常了)/i, tag: 'solution' },
    { regex: /(?:踩坑|坑|教训)[：:]\s*(.+)/i, tag: 'pitfall' },
  ];

  const findings: Array<{ text: string; tag: string }> = [];

  for (const { regex, tag } of patterns) {
    const match = combined.match(regex);
    if (match?.[1]) {
      findings.push({ text: match[1].trim().slice(0, 200), tag });
    }
  }

  if (findings.length === 0) return null;

  // Only auto-extract if the response is substantial.
  // Chinese packs ~2x more information per character than English,
  // so 40 chars is a reasonable minimum for both languages.
  if (response.length < 40) return null;

  const tags = [...new Set(findings.map((f) => f.tag)), 'auto-extracted'];
  const first = findings[0]!;
  const title = first.text.slice(0, 80);
  const content = findings.map((f) => `[${f.tag}] ${f.text}`).join('\n');

  return {
    project_alias: projectAlias,
    title,
    content,
    tags,
    source: 'auto',
  };
}

/**
 * Build a manual learn input from user command.
 */
export function buildLearnInput(
  text: string,
  projectAlias: string,
  actorId?: string,
  chatId?: string,
): LearnInput {
  // Try to split "title: content" or use first line as title
  const colonIndex = text.indexOf('：');
  const colonIndexEn = text.indexOf(':');
  const splitIndex =
    colonIndex >= 0 && (colonIndexEn < 0 || colonIndex < colonIndexEn)
      ? colonIndex
      : colonIndexEn;

  let title: string;
  let content: string;

  if (splitIndex > 0 && splitIndex < 60) {
    title = text.slice(0, splitIndex).trim();
    content = text.slice(splitIndex + 1).trim() || title;
  } else {
    title = text.slice(0, 80).trim();
    content = text;
  }

  return {
    project_alias: projectAlias,
    chat_id: chatId,
    actor_id: actorId,
    title,
    content,
    tags: ['manual'],
    source: 'manual',
  };
}

export function formatRecallResults(memories: MemoryRecord[], query: string): string {
  if (memories.length === 0) {
    return `没有找到与 "${query}" 相关的团队知识。`;
  }

  const lines: string[] = [`🔍 团队知识检索: "${query}"\n`];

  for (const mem of memories) {
    const pinIcon = mem.pinned ? '📌 ' : '';
    const source = mem.source === 'auto' ? '[自动提取]' : '[手动记录]';
    const by = mem.created_by ? ` by ${mem.created_by}` : '';
    lines.push(`${pinIcon}${mem.title} ${source}${by}`);
    lines.push(`  ${truncate(mem.content, 120)}`);
    if (mem.tags.length > 0) {
      lines.push(`  标签: ${mem.tags.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}
