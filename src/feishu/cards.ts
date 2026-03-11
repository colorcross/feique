export function buildStatusCard(input: {
  title: string;
  summary: string;
  projectAlias: string;
  sessionId?: string;
  runStatus?: string;
  sessionCount?: number;
  includeActions: boolean;
  rerunPayload?: Record<string, unknown>;
  newSessionPayload?: Record<string, unknown>;
  statusPayload?: Record<string, unknown>;
  cancelPayload?: Record<string, unknown>;
}): Record<string, unknown> {
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
    input.sessionId ? `**会话**: ${input.sessionId}` : null,
    input.runStatus ? `**状态**: ${input.runStatus}` : null,
    typeof input.sessionCount === 'number' ? `**已保存会话数**: ${input.sessionCount}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: input.title,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [metadata, '', input.summary].filter(Boolean).join('\n'),
      },
      ...actions,
    ],
  };
}
