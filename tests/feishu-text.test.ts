import { describe, expect, it } from 'vitest';
import { buildFeishuPost, splitMarkdownForFeishuCard, splitTextForFeishu, truncateForFeishuCard } from '../src/feishu/text.js';

describe('feishu text utilities', () => {
  it('splits oversized text into multiple chunks', () => {
    const input = 'a'.repeat(2000) + '\n\n' + 'b'.repeat(2000);
    const chunks = splitTextForFeishu(input, 1800);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1800)).toBe(true);
  });

  it('truncates card summaries safely', () => {
    const summary = truncateForFeishuCard('x'.repeat(1300), 1200);
    expect(summary.length).toBeLessThanOrEqual(1200);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('formats post messages with bullets and links', () => {
    const post = buildFeishuPost('Title', '# 概览\n- 访问 [官网](https://example.com)\n详情 https://docs.example.com');
    expect(post.zh_cn.content[0]?.[0]).toEqual({ tag: 'text', text: '【概览】' });
    expect(post.zh_cn.content[1]?.[0]).toEqual({ tag: 'text', text: '• 访问 ' });
    expect(post.zh_cn.content[1]?.[1]).toEqual({ tag: 'a', text: '官网', href: 'https://example.com' });
    expect(post.zh_cn.content[2]?.[1]).toEqual({ tag: 'a', text: 'https://docs.example.com', href: 'https://docs.example.com' });
  });

  it('splits long markdown for cards', () => {
    const chunks = splitMarkdownForFeishuCard(['a'.repeat(1500), 'b'.repeat(1500)].join('\n\n'), 1800);
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= 1800)).toBe(true);
  });
});
