export type BridgeCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'projects' }
  | { kind: 'new' }
  | { kind: 'cancel' }
  | { kind: 'project'; alias?: string }
  | { kind: 'session'; action: 'list' | 'use' | 'new' | 'drop'; threadId?: string }
  | { kind: 'prompt'; prompt: string };

export function parseBridgeCommand(input: string): BridgeCommand {
  const trimmed = normalizeIncomingText(input);

  if (!trimmed.startsWith('/')) {
    return { kind: 'prompt', prompt: trimmed };
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  const argument = rest.join(' ').trim();

  switch (command) {
    case '/help':
      return { kind: 'help' };
    case '/status':
      return { kind: 'status' };
    case '/projects':
      return { kind: 'projects' };
    case '/new':
      return { kind: 'new' };
    case '/cancel':
      return { kind: 'cancel' };
    case '/project':
      return { kind: 'project', alias: argument || undefined };
    case '/session':
      return parseSessionCommand(argument);
    default:
      return { kind: 'prompt', prompt: trimmed };
  }
}

export function normalizeIncomingText(input: string): string {
  return input
    .trim()
    .replace(/^@[^\s]+\s+/, '')
    .replace(/\u00a0/g, ' ')
    .trim();
}

export function buildHelpText(): string {
  return [
    'Codex Feishu',
    '',
    '/help 查看帮助',
    '/projects 列出可用项目',
    '/project <alias> 切换当前项目',
    '/status 查看当前项目、会话与运行状态',
    '/new 为当前项目新开会话',
    '/cancel 取消当前项目正在运行的任务',
    '/session list 列出当前项目保存过的会话',
    '/session use <thread_id> 切换到指定会话',
    '/session new 让下一条消息新开会话',
    '/session drop [thread_id] 删除指定或当前会话',
    '',
    '直接发送文本会进入当前项目的 Codex 会话。',
  ].join('\n');
}

function parseSessionCommand(argument: string): BridgeCommand {
  const [subcommand, ...rest] = argument.split(/\s+/).filter(Boolean);
  const threadId = rest.join(' ').trim() || undefined;

  switch (subcommand) {
    case 'list':
      return { kind: 'session', action: 'list' };
    case 'use':
      return { kind: 'session', action: 'use', threadId };
    case 'new':
      return { kind: 'session', action: 'new' };
    case 'drop':
      return { kind: 'session', action: 'drop', threadId };
    default:
      return { kind: 'prompt', prompt: `/session${argument ? ` ${argument}` : ''}`.trim() };
  }
}
