import { splitMarkdownForFeishuCard } from './text.js';

export function buildStatusCard(input: {
  title: string;
  summary: string;
  projectAlias: string;
  sessionId?: string;
  runStatus?: string;
  runPhase?: string;
  sessionCount?: number;
  includeActions: boolean;
  rerunPayload?: Record<string, unknown>;
  newSessionPayload?: Record<string, unknown>;
  statusPayload?: Record<string, unknown>;
  cancelPayload?: Record<string, unknown>;
}): Record<string, unknown> {
  const summarySections = splitMarkdownForFeishuCard(input.summary).map((chunk) => ({
    tag: 'markdown',
    content: chunk,
  }));
  const actions = input.includeActions
    ? [
        {
          tag: 'action',
          actions: [
            input.rerunPayload
              ? {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '重试上一轮' },
                  type: 'primary',
                  value: input.rerunPayload,
                }
              : null,
            input.newSessionPayload
              ? {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '新会话' },
                  value: input.newSessionPayload,
                }
              : null,
            input.cancelPayload
              ? {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '取消运行' },
                  value: input.cancelPayload,
                }
              : null,
            input.statusPayload
              ? {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '查看状态' },
                  value: input.statusPayload,
                }
              : null,
          ].filter(Boolean),
        },
      ]
    : [];

  const metadata = [
    `**项目**: ${input.projectAlias}`,
    input.runStatus ? `**状态**: ${input.runStatus}` : null,
    input.runPhase ? `**阶段**: ${input.runPhase}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: resolveCardTemplate(input.runStatus),
      title: {
        tag: 'plain_text',
        content: input.title,
      },
    },
    elements: [
      ...(metadata ? [{ tag: 'markdown', content: metadata }] : []),
      ...(metadata && summarySections.length > 0 ? [{ tag: 'hr' }] : []),
      ...interleaveWithDividers(summarySections),
      ...(actions.length > 0 && (metadata || summarySections.length > 0) ? [{ tag: 'hr' }] : []),
      ...actions,
    ],
  };
}

export function buildMessageCard(input: {
  title: string;
  body: string;
  status?: string;
  phase?: string;
  projectAlias?: string;
  sessionId?: string;
}): Record<string, unknown> {
  const metadata = [
    input.projectAlias ? `**项目**: ${input.projectAlias}` : null,
    input.status ? `**状态**: ${input.status}` : null,
    input.phase ? `**阶段**: ${input.phase}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const sections = splitMarkdownForFeishuCard(input.body).map((chunk) => ({
    tag: 'markdown',
    content: chunk,
  }));

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: resolveCardTemplate(input.status),
      title: {
        tag: 'plain_text',
        content: input.title,
      },
    },
    elements: [
      ...(metadata ? [{ tag: 'markdown', content: metadata }] : []),
      ...(metadata && sections.length > 0 ? [{ tag: 'hr' }] : []),
      ...interleaveWithDividers(sections),
    ],
  };
}

function resolveCardTemplate(status?: string): string {
  switch (status) {
    case 'success':
      return 'green';
    case 'failure':
      return 'red';
    case 'queued':
      return 'orange';
    case 'cancelled':
      return 'grey';
    default:
      return 'blue';
  }
}

function interleaveWithDividers<T extends Record<string, unknown>>(elements: T[]): Array<T | { tag: 'hr' }> {
  const output: Array<T | { tag: 'hr' }> = [];
  elements.forEach((element, index) => {
    if (index > 0) {
      output.push({ tag: 'hr' });
    }
    output.push(element);
  });
  return output;
}
