export const DEFAULT_FEISHU_TEXT_LIMIT = 1800;
export const DEFAULT_FEISHU_CARD_SUMMARY_LIMIT = 1200;

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

export function truncateForFeishuCard(input: string, maxChars: number = DEFAULT_FEISHU_CARD_SUMMARY_LIMIT): string {
  const text = input.trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function buildFeishuPost(title: string, body: string): {
  zh_cn: {
    title: string;
    content: Array<Array<{ tag: 'text'; text: string }>>;
  };
} {
  const rawLines = body.split(/\r?\n/).map((line) => line.trimEnd());
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.length > 0 || (lines.length > 0 && lines[lines.length - 1] !== '')) {
      lines.push(line);
    }
  }

  const content = lines.length > 0 ? lines.map((line) => [{ tag: 'text' as const, text: line || ' ' }]) : [[{ tag: 'text' as const, text: body.trim() || ' ' }]];
  return {
    zh_cn: {
      title,
      content,
    },
  };
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
