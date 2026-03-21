export const DEFAULT_FEISHU_TEXT_LIMIT = 1800;
export const DEFAULT_FEISHU_CARD_SUMMARY_LIMIT = 1200;
export const DEFAULT_FEISHU_CARD_MARKDOWN_LIMIT = 2000;

interface FeishuPostTextSegment {
  tag: 'text';
  text: string;
}

interface FeishuPostLinkSegment {
  tag: 'a';
  text: string;
  href: string;
}

type FeishuPostSegment = FeishuPostTextSegment | FeishuPostLinkSegment;

export function splitTextForFeishu(input: string, maxChars: number = DEFAULT_FEISHU_TEXT_LIMIT): string[] {
  const text = input.trim();
  if (!text) {
    return [''];
  }
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let buffer = '';
  const paragraphs = text.split(/\n{2,}/);

  for (const paragraph of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }

    if (buffer) {
      chunks.push(buffer);
      buffer = '';
    }

    if (paragraph.length <= maxChars) {
      buffer = paragraph;
      continue;
    }

    chunks.push(...splitHard(paragraph, maxChars));
  }

  if (buffer) {
    chunks.push(buffer);
  }

  return chunks;
}

/**
 * Smart truncation for Feishu cards. Keeps the beginning AND the last
 * paragraph (conclusions/status often appear at the end).
 */
export function truncateForFeishuCard(input: string, maxChars: number = DEFAULT_FEISHU_CARD_SUMMARY_LIMIT): string {
  const text = input.trim();
  if (text.length <= maxChars) {
    return text;
  }

  // Try to keep the last meaningful paragraph
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length >= 3) {
    const lastParagraph = paragraphs[paragraphs.length - 1]!.trim();
    // Reserve space for the ending: "...\n\n[last paragraph]"
    const endingLen = lastParagraph.length + 6; // "\n\n…\n\n" + content
    if (endingLen < maxChars * 0.4 && lastParagraph.length > 10) {
      const headBudget = maxChars - endingLen;
      const head = text.slice(0, Math.max(0, headBudget - 1)).trimEnd();
      return `${head}…\n\n${lastParagraph}`;
    }
  }

  // Fallback: simple truncation
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function buildFeishuPost(title: string, body: string): {
  zh_cn: {
    title: string;
    content: Array<Array<FeishuPostSegment>>;
  };
} {
  const rawLines = body.split(/\r?\n/).map((line) => line.trimEnd());
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.length > 0 || (lines.length > 0 && lines[lines.length - 1] !== '')) {
      lines.push(line);
    }
  }

  const content =
    lines.length > 0
      ? lines.map((line) => tokenizePostLine(formatPostLine(line)))
      : [[{ tag: 'text' as const, text: body.trim() || ' ' }]];
  return {
    zh_cn: {
      title,
      content,
    },
  };
}

export function splitMarkdownForFeishuCard(input: string, maxChars: number = DEFAULT_FEISHU_CARD_MARKDOWN_LIMIT): string[] {
  return splitTextForFeishu(input, maxChars);
}

function splitHard(input: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = input.trim();

  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n', maxChars);
    if (cut <= 0) {
      cut = remaining.lastIndexOf(' ', maxChars);
    }
    if (cut <= 0) {
      cut = maxChars;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function formatPostLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return ' ';
  }
  if (/^#{1,6}\s+/.test(trimmed)) {
    return `【${trimmed.replace(/^#{1,6}\s+/, '').trim()}】`;
  }
  if (/^>\s+/.test(trimmed)) {
    return `引用｜${trimmed.replace(/^>\s+/, '').trim()}`;
  }
  if (/^[-*]\s+/.test(trimmed)) {
    return `• ${trimmed.replace(/^[-*]\s+/, '').trim()}`;
  }
  return trimmed;
}

function tokenizePostLine(line: string): FeishuPostSegment[] {
  const segments: FeishuPostSegment[] = [];
  const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = markdownLinkRegex.exec(line)) !== null) {
    const fullMatch = match[0];
    const label = match[1];
    const href = match[2];
    if (!label || !href) {
      continue;
    }
    if (match.index > cursor) {
      segments.push(...tokenizeBareUrls(line.slice(cursor, match.index)));
    }
    segments.push({ tag: 'a', text: label, href });
    cursor = match.index + fullMatch.length;
  }

  if (cursor < line.length) {
    segments.push(...tokenizeBareUrls(line.slice(cursor)));
  }

  return segments.length > 0 ? mergeAdjacentTextSegments(segments) : [{ tag: 'text', text: line || ' ' }];
}

function tokenizeBareUrls(input: string): FeishuPostSegment[] {
  const segments: FeishuPostSegment[] = [];
  const urlRegex = /https?:\/\/[^\s]+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(input)) !== null) {
    const [href] = match;
    if (match.index > cursor) {
      segments.push({ tag: 'text', text: input.slice(cursor, match.index) });
    }
    segments.push({ tag: 'a', text: href, href });
    cursor = match.index + href.length;
  }

  if (cursor < input.length) {
    segments.push({ tag: 'text', text: input.slice(cursor) });
  }

  return segments;
}

function mergeAdjacentTextSegments(input: FeishuPostSegment[]): FeishuPostSegment[] {
  const merged: FeishuPostSegment[] = [];
  for (const segment of input) {
    if (segment.tag === 'text' && segment.text.length === 0) {
      continue;
    }
    const last = merged.at(-1);
    if (last?.tag === 'text' && segment.tag === 'text') {
      last.text += segment.text;
      continue;
    }
    merged.push(segment);
  }
  return merged.length > 0 ? merged : [{ tag: 'text', text: ' ' }];
}
