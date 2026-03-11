import { describe, expect, it } from 'vitest';
import { buildMessageCard, buildStatusCard } from '../src/feishu/cards.js';

describe('status card', () => {
  it('includes actions only when requested', () => {
    const card = buildStatusCard({
      title: 'Done',
      summary: 'Summary',
      projectAlias: 'repo-a',
      sessionId: 'thread-1',
      includeActions: true,
      rerunPayload: { action: 'rerun' },
      newSessionPayload: { action: 'new' },
      statusPayload: { action: 'status' },
    });

    expect(card.header).toBeTruthy();
    expect(Array.isArray(card.elements)).toBe(true);
    expect(JSON.stringify(card)).toContain('重试上一轮');
  });

  it('builds generic message cards from markdown body', () => {
    const card = buildMessageCard({
      title: 'Reply',
      body: '第一段\n\n第二段',
      status: 'running',
      projectAlias: 'repo-a',
    });

    expect(card.header).toBeTruthy();
    expect(JSON.stringify(card)).toContain('repo-a');
    expect(JSON.stringify(card)).toContain('第一段');
    expect(JSON.stringify(card)).toContain('第二段');
  });
});
