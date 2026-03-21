const FILE_PATH_PATTERN = /(?:^|[\s(])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+)(?=$|[\s):,])/g;

export interface ThreadSummaryInput {
  previousSummary?: string;
  prompt: string;
  responseExcerpt: string;
  maxChars: number;
}

export interface ThreadSummaryDraft {
  summary: string;
  filesTouched: string[];
  openTasks: string[];
  decisions: string[];
}

export function summarizeThreadTurn(input: ThreadSummaryInput): ThreadSummaryDraft {
  const files = uniqueStrings([
    ...extractFilePaths(input.prompt),
    ...extractFilePaths(input.responseExcerpt),
  ]).slice(0, 8);
  const decisions = extractNumberedItems(afterMarker(input.responseExcerpt, ['决定', '变更', '已完成', '已实现'])).slice(0, 4);
  const openTasks = extractNumberedItems(afterMarker(input.responseExcerpt, ['建议下一步', '下一步', 'todo', '后续'])).slice(0, 4);

  const currentTurn = [
    `目标: ${compactLine(input.prompt, 220)}`,
    `结果: ${compactLine(input.responseExcerpt, 420)}`,
    ...(files.length > 0 ? [`涉及文件: ${files.join(', ')}`] : []),
    ...(decisions.length > 0 ? [`关键结论: ${decisions.join('；')}`] : []),
    ...(openTasks.length > 0 ? [`待办: ${openTasks.join('；')}`] : []),
  ].join('\n');

  // Build rolling summary: keep only the core of previous context,
  // strip any nested "历史上下文:" prefixes to prevent recursive growth.
  let summary: string;
  if (input.previousSummary) {
    const cleanPrevious = stripNestedPrefixes(input.previousSummary);
    // Allocate: 40% to history, 60% to current turn
    const historyBudget = Math.floor(input.maxChars * 0.4);
    const currentBudget = input.maxChars - historyBudget - 20; // 20 for separator
    const compactHistory = truncateToBudget(cleanPrevious, historyBudget);
    const compactCurrent = truncateToBudget(currentTurn, currentBudget);
    summary = `历史上下文: ${compactHistory}\n---\n${compactCurrent}`;
  } else {
    summary = truncateToBudget(currentTurn, input.maxChars);
  }

  return {
    summary,
    filesTouched: files,
    openTasks,
    decisions,
  };
}

/**
 * Strip recursive prefixes like "上次摘要: 上次摘要: ..." or "历史上下文: 历史上下文: ..."
 * to prevent summary from growing with nested layers.
 */
function stripNestedPrefixes(text: string): string {
  let result = text;
  const prefixes = ['上次摘要:', '上次摘要：', '历史上下文:', '历史上下文：'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (result.startsWith(prefix)) {
        result = result.slice(prefix.length).trimStart();
        changed = true;
      }
    }
  }
  return result;
}

function extractFilePaths(input: string): string[] {
  const matches = Array.from(input.matchAll(FILE_PATH_PATTERN)).map((match) => match[1] ?? '');
  return matches.filter(Boolean);
}

function afterMarker(input: string, markers: string[]): string {
  const normalized = input.replace(/\r/g, '');
  for (const marker of markers) {
    const index = normalized.indexOf(marker);
    if (index >= 0) {
      return normalized.slice(index);
    }
  }
  return normalized;
}

function extractNumberedItems(input: string): string[] {
  const matches = input.match(/(?:^|\n)\d+\.\s+(.+)/g) ?? [];
  return matches
    .map((line) => line.replace(/(?:^|\n)\d+\.\s+/, '').trim())
    .filter(Boolean)
    .map((line) => compactLine(line, 140));
}

function compactLine(input: string, maxChars: number): string {
  return truncateToBudget(input.replace(/\s+/g, ' ').trim(), maxChars);
}

function truncateToBudget(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
