import { describe, expect, it } from 'vitest';
import { buildMessageCard, buildStatusCard } from '../src/feishu/cards.js';

describe('status card', () => {
  it('includes actions only when requested', () => {
    const card = buildStatusCard({
      title: 'Done',
      summary: 'Summary',
      projectAlias: 'repo-a',
      runPhase: '执行中',
      includeActions: true,
      rerunPayload: { action: 'rerun' },
      newSessionPayload: { action: 'new' },
      statusPayload: { action: 'status' },
    });

    expect(card.header).toBeTruthy();
    expect(Array.isArray(card.elements)).toBe(true);
    expect(JSON.stringify(card)).toContain('重试上一轮');
    expect(JSON.stringify(card)).toContain('执行中');
    expect(JSON.stringify(card)).not.toContain('thread-1');
  });

  it('builds generic message cards from markdown body', () => {
    const card = buildMessageCard({
      title: 'Reply',
      body: '第一段\n\n第二段',
      status: 'success',
      phase: '已完成',
      projectAlias: 'repo-a',
    });

    expect(card.header).toBeTruthy();
    expect((card.header as { template?: string }).template).toBe('green');
    expect(JSON.stringify(card)).toContain('repo-a');
    expect(JSON.stringify(card)).toContain('第一段');
    expect(JSON.stringify(card)).toContain('第二段');
    expect(JSON.stringify(card)).toContain('已完成');
    expect(JSON.stringify(card)).toContain('"tag":"hr"');
  });
});
