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

  const sections = [
    `最近目标: ${compactLine(input.prompt, 220)}`,
    `最近结果: ${compactLine(input.responseExcerpt, 420)}`,
    ...(files.length > 0 ? [`涉及文件: ${files.join(', ')}`] : []),
    ...(decisions.length > 0 ? [`关键结论: ${decisions.join('；')}`] : []),
    ...(openTasks.length > 0 ? [`待办: ${openTasks.join('；')}`] : []),
  ];

  const previous = input.previousSummary ? compactLine(input.previousSummary, 360) : undefined;
  const summary = truncateToBudget(
    [previous ? `上次摘要: ${previous}` : undefined, ...sections].filter(Boolean).join('\n'),
    input.maxChars,
  );

  return {
    summary,
    filesTouched: files,
    openTasks,
    decisions,
  };
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
