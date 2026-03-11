export type MemoryScopeTarget = 'project' | 'group';
export interface MemoryCommandFilters {
  tag?: string;
  source?: string;
  created_by?: string;
}

export type AdminResource = 'admin' | 'group' | 'chat' | 'project' | 'service';
export type AdminListAction = 'status' | 'list' | 'add' | 'remove';
export type AdminProjectAction = 'add' | 'remove' | 'set' | 'list';

export type BridgeCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'projects' }
  | { kind: 'new' }
  | { kind: 'cancel' }
  | { kind: 'kb'; action: 'search' | 'status'; query?: string }
  | { kind: 'memory'; action: 'status' | 'stats' | 'search' | 'recent' | 'save' | 'pin' | 'unpin' | 'forget' | 'restore'; scope?: MemoryScopeTarget; value?: string; filters?: MemoryCommandFilters }
  | { kind: 'wiki'; action: 'spaces' | 'search' | 'read' | 'create' | 'rename' | 'copy' | 'move' | 'members' | 'grant' | 'revoke'; value?: string; extra?: string; target?: string; role?: string }
  | { kind: 'project'; alias?: string }
  | { kind: 'session'; action: 'list' | 'use' | 'new' | 'drop'; threadId?: string }
  | { kind: 'session'; action: 'adopt'; target?: string }
  | { kind: 'admin'; resource: Exclude<AdminResource, 'project' | 'service'>; action: AdminListAction; value?: string }
  | { kind: 'admin'; resource: 'project'; action: AdminProjectAction; alias?: string; field?: string; value?: string }
  | { kind: 'admin'; resource: 'service'; action: 'status' | 'restart' }
  | { kind: 'prompt'; prompt: string };

export function parseBridgeCommand(input: string): BridgeCommand {
  const trimmed = normalizeIncomingText(input);

  if (!trimmed.startsWith('/')) {
    const naturalLanguageCommand = parseNaturalLanguageCommand(trimmed);
    if (naturalLanguageCommand) {
      return naturalLanguageCommand;
    }
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
    case '/kb':
      return parseKnowledgeCommand(argument);
    case '/memory':
      return parseMemoryCommand(argument);
    case '/wiki':
      return parseWikiCommand(argument);
    case '/project':
      return { kind: 'project', alias: argument || undefined };
    case '/session':
      return parseSessionCommand(argument);
    case '/admin':
      return parseAdminCommand(argument);
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
    '/kb status 查看当前项目知识库目录',
    '/kb search <query> 搜索项目文档/知识库',
    '/memory status 查看当前项目记忆状态',
    '/memory stats 查看当前项目记忆统计',
    '/memory status group 查看当前群共享记忆状态',
    '/memory stats group 查看当前群共享记忆统计',
    '/memory recent 查看最近保存的项目记忆',
    '/memory recent group 查看最近保存的群共享记忆',
    '/memory recent --tag <tag> 按标签筛选最近项目记忆',
    '/memory recent --source <source> 按来源筛选最近项目记忆',
    '/memory recent --created-by <actor_id> 按创建者筛选最近项目记忆',
    '/memory search <query> 搜索当前项目记忆',
    '/memory search --tag <tag> <query> 按标签筛选项目记忆',
    '/memory search --source <source> <query> 按来源筛选项目记忆',
    '/memory search --created-by <actor_id> <query> 按创建者筛选项目记忆',
    '/memory search group <query> 搜索当前群共享记忆',
    '/memory save <text> 保存一条项目记忆',
    '/memory save group <text> 保存一条群共享记忆',
    '/memory pin <id> 置顶一条项目记忆',
    '/memory pin group <id> 置顶一条群共享记忆',
    '/memory unpin <id> 取消置顶项目记忆',
    '/memory forget <id> 归档一条项目记忆',
    '/memory forget all-expired 归档当前作用域下已过期记忆',
    '/memory forget group <id> 归档一条群共享记忆',
    '/memory restore <id> 恢复一条已归档项目记忆',
    '/memory restore group <id> 恢复一条已归档群共享记忆',
    '/wiki spaces 列出可访问的飞书知识空间',
    '/wiki search <query> 搜索飞书知识库',
    '/wiki read <url|token> 读取飞书文档纯文本摘要',
    '/wiki create <title> 在默认知识空间创建文档',
    '/wiki create <space_id> <title> 在指定知识空间创建文档',
    '/wiki rename <node_token> <title> 更新知识库节点标题',
    '/wiki copy <node_token> [target_space_id] 复制节点到默认或指定知识空间',
    '/wiki move <source_space_id> <node_token> [target_space_id] 移动节点到默认或指定知识空间',
    '/wiki members [space_id] 查看知识空间成员',
    '/wiki grant <space_id> <member_type> <member_id> [member|admin] 添加知识空间成员',
    '/wiki revoke <space_id> <member_type> <member_id> [member|admin] 移除知识空间成员',
    '/session list 列出当前项目保存过的会话',
    '/session use <thread_id> 切换到指定会话',
    '/session new 让下一条消息新开会话',
    '/session drop [thread_id] 删除指定或当前会话',
    '/session adopt latest 接管当前项目最近的本地 Codex 会话',
    '/session adopt list 列出当前项目可接管的本地 Codex 会话',
    '/session adopt <thread_id> 接管指定本地 Codex 会话',
    '/admin status 查看管理员配置摘要',
    '/admin admin list 查看管理员 chat_id 列表',
    '/admin admin add <chat_id> 添加管理员 chat_id',
    '/admin admin remove <chat_id> 移除管理员 chat_id',
    '/admin group list 查看已允许的群聊 chat_id',
    '/admin group add <chat_id> 允许一个群聊接入',
    '/admin group remove <chat_id> 移除一个群聊接入',
    '/admin chat list 查看已允许的私聊 chat_id',
    '/admin chat add <chat_id> 允许一个私聊接入',
    '/admin chat remove <chat_id> 移除一个私聊接入',
    '/admin project list 查看当前项目列表',
    '/admin project add <alias> <root> 动态接入项目',
    '/admin project remove <alias> 移除项目',
    '/admin project set <alias> <field> <value> 修改项目配置',
    '/admin service restart 保存配置并重启服务',
    '',
    '也支持高置信度自然语言触发，例如：',
    '查看状态 / 项目列表 / 新会话 / 取消当前任务 / 切换到项目 repo-a / 接管最新会话 / 重启服务',
    '',
    '直接发送文本会进入当前项目的 Codex 会话。',
  ].join('\n');
}

function parseNaturalLanguageCommand(input: string): BridgeCommand | null {
  const normalized = input
    .trim()
    .replace(/[。！？!?；;]+$/u, '')
    .replace(/\s+/g, ' ');

  if (!normalized) {
    return null;
  }

  if (/^(帮助|查看帮助|命令帮助)$/.test(normalized)) {
    return { kind: 'help' };
  }
  if (/^(查看状态|当前状态|运行状态|看状态)$/.test(normalized)) {
    return { kind: 'status' };
  }
  if (/^(查看项目|项目列表|列出项目|有哪些项目)$/.test(normalized)) {
    return { kind: 'projects' };
  }
  if (/^(新会话|开启新会话|重新开始会话|下一条消息新开会话)$/.test(normalized)) {
    return { kind: 'new' };
  }
  if (/^(取消当前任务|停止当前任务|取消运行|停止运行|停止任务)$/.test(normalized)) {
    return { kind: 'cancel' };
  }
  if (/^(查看会话|会话列表|列出会话)$/.test(normalized)) {
    return { kind: 'session', action: 'list' };
  }
  if (/^(接管最新会话|接管最近会话|接管最新 Codex 会话)$/i.test(normalized)) {
    return { kind: 'session', action: 'adopt', target: 'latest' };
  }
  if (/^(查看可接管会话|列出可接管会话|可接管会话列表)$/.test(normalized)) {
    return { kind: 'session', action: 'adopt', target: 'list' };
  }

  const projectMatch = normalized.match(/^(?:切换到项目|切到项目|使用项目)\s+(\S+)$/);
  if (projectMatch) {
    return { kind: 'project', alias: projectMatch[1] };
  }

  const adoptSessionMatch = normalized.match(/^(?:接管会话|使用会话)\s+(\S+)$/);
  if (adoptSessionMatch) {
    return { kind: 'session', action: 'adopt', target: adoptSessionMatch[1] };
  }

  if (/^(管理员状态|查看管理员状态)$/.test(normalized)) {
    return { kind: 'admin', resource: 'service', action: 'status' };
  }
  if (/^(重启服务|重启机器人|重启 codex-feishu 服务)$/i.test(normalized)) {
    return { kind: 'admin', resource: 'service', action: 'restart' };
  }

  const addAdminMatch = normalized.match(/^添加管理员\s+(\S+)$/);
  if (addAdminMatch) {
    return { kind: 'admin', resource: 'admin', action: 'add', value: addAdminMatch[1] };
  }
  const removeAdminMatch = normalized.match(/^移除管理员\s+(\S+)$/);
  if (removeAdminMatch) {
    return { kind: 'admin', resource: 'admin', action: 'remove', value: removeAdminMatch[1] };
  }

  const addGroupMatch = normalized.match(/^(?:允许群聊|接入群聊|添加群聊)\s+(\S+)$/);
  if (addGroupMatch) {
    return { kind: 'admin', resource: 'group', action: 'add', value: addGroupMatch[1] };
  }
  const removeGroupMatch = normalized.match(/^(?:移除群聊|拒绝群聊|禁用群聊)\s+(\S+)$/);
  if (removeGroupMatch) {
    return { kind: 'admin', resource: 'group', action: 'remove', value: removeGroupMatch[1] };
  }

  const addChatMatch = normalized.match(/^(?:允许私聊|接入私聊|添加私聊)\s+(\S+)$/);
  if (addChatMatch) {
    return { kind: 'admin', resource: 'chat', action: 'add', value: addChatMatch[1] };
  }
  const removeChatMatch = normalized.match(/^(?:移除私聊|拒绝私聊|禁用私聊)\s+(\S+)$/);
  if (removeChatMatch) {
    return { kind: 'admin', resource: 'chat', action: 'remove', value: removeChatMatch[1] };
  }

  const addProjectMatch = normalized.match(/^添加项目\s+(\S+)\s+(.+)$/);
  if (addProjectMatch) {
    const [, alias, root] = addProjectMatch;
    if (!alias || !root) {
      return null;
    }
    return { kind: 'admin', resource: 'project', action: 'add', alias, value: root.trim() };
  }
  const removeProjectMatch = normalized.match(/^移除项目\s+(\S+)$/);
  if (removeProjectMatch) {
    return { kind: 'admin', resource: 'project', action: 'remove', alias: removeProjectMatch[1] };
  }
  const updateProjectMatch = normalized.match(/^(?:设置项目|修改项目)\s+(\S+)\s+(\S+)\s+(.+)$/);
  if (updateProjectMatch) {
    const [, alias, field, value] = updateProjectMatch;
    if (!alias || !field || !value) {
      return null;
    }
    return {
      kind: 'admin',
      resource: 'project',
      action: 'set',
      alias,
      field,
      value: value.trim(),
    };
  }

  return null;
}

function parseAdminCommand(argument: string): BridgeCommand {
  const [resource, action, ...rest] = argument.split(/\s+/).filter(Boolean);

  if (!resource || resource === 'status') {
    return { kind: 'admin', resource: 'service', action: 'status' };
  }

  if (resource === 'service') {
    return { kind: 'admin', resource: 'service', action: action === 'restart' ? 'restart' : 'status' };
  }

  if (resource === 'project') {
    if (action === 'list' || !action) {
      return { kind: 'admin', resource: 'project', action: 'list' };
    }
    if (action === 'add') {
      return { kind: 'admin', resource: 'project', action: 'add', alias: rest[0], value: rest.slice(1).join(' ').trim() || undefined };
    }
    if (action === 'remove') {
      return { kind: 'admin', resource: 'project', action: 'remove', alias: rest[0] };
    }
    if (action === 'set') {
      return {
        kind: 'admin',
        resource: 'project',
        action: 'set',
        alias: rest[0],
        field: rest[1],
        value: rest.slice(2).join(' ').trim() || undefined,
      };
    }
    return { kind: 'prompt', prompt: `/admin${argument ? ` ${argument}` : ''}`.trim() };
  }

  if (resource === 'admin' || resource === 'group' || resource === 'chat') {
    if (action === 'list' || !action) {
      return { kind: 'admin', resource, action: 'list' };
    }
    if (action === 'add' || action === 'remove') {
      return { kind: 'admin', resource, action, value: rest.join(' ').trim() || undefined };
    }
  }

  return { kind: 'prompt', prompt: `/admin${argument ? ` ${argument}` : ''}`.trim() };
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
    case 'adopt':
      return { kind: 'session', action: 'adopt', target: threadId };
    default:
      return { kind: 'prompt', prompt: `/session${argument ? ` ${argument}` : ''}`.trim() };
  }
}

function parseKnowledgeCommand(argument: string): BridgeCommand {
  const [subcommand, ...rest] = argument.split(/\s+/).filter(Boolean);
  const query = rest.join(' ').trim() || undefined;

  switch (subcommand) {
    case 'status':
      return { kind: 'kb', action: 'status' };
    case 'search':
      return { kind: 'kb', action: 'search', query };
    default:
      return { kind: 'prompt', prompt: `/kb${argument ? ` ${argument}` : ''}`.trim() };
  }
}

function parseMemoryCommand(argument: string): BridgeCommand {
  const parts = argument.split(/\s+/).filter(Boolean);
  const subcommand = parts[0];
  const possibleScope = parts[1] === 'group' ? 'group' : undefined;
  const scope = possibleScope as MemoryScopeTarget | undefined;
  const payloadStart = scope ? 2 : 1;
  const payload = parts.slice(payloadStart);
  const { value, filters } = parseMemoryPayload(payload);

  switch (subcommand) {
    case 'status':
      return { kind: 'memory', action: 'status', scope };
    case 'stats':
      return { kind: 'memory', action: 'stats', scope };
    case 'search':
      return { kind: 'memory', action: 'search', scope, value, filters };
    case 'recent':
      return { kind: 'memory', action: 'recent', scope, filters };
    case 'save':
      return { kind: 'memory', action: 'save', scope, value, filters };
    case 'pin':
      return { kind: 'memory', action: 'pin', scope, value };
    case 'unpin':
      return { kind: 'memory', action: 'unpin', scope, value };
    case 'forget':
      return { kind: 'memory', action: 'forget', scope, value };
    case 'restore':
      return { kind: 'memory', action: 'restore', scope, value };
    default:
      return { kind: 'prompt', prompt: `/memory${argument ? ` ${argument}` : ''}`.trim() };
  }
}

function parseMemoryPayload(parts: string[]): { value?: string; filters?: MemoryCommandFilters } {
  const filters: MemoryCommandFilters = {};
  const positional: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) {
      continue;
    }
    if (part === '--tag') {
      const tag = parts[index + 1];
      if (tag) {
        filters.tag = tag;
        index += 1;
      }
      continue;
    }
    if (part === '--source') {
      const source = parts[index + 1];
      if (source) {
        filters.source = source;
        index += 1;
      }
      continue;
    }
    if (part === '--created-by') {
      const createdBy = parts[index + 1];
      if (createdBy) {
        filters.created_by = createdBy;
        index += 1;
      }
      continue;
    }
    positional.push(part);
  }

  return {
    value: positional.join(' ').trim() || undefined,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
  };
}

function parseWikiCommand(argument: string): BridgeCommand {
  const [subcommand, ...rest] = argument.split(/\s+/).filter(Boolean);
  const value = rest.join(' ').trim() || undefined;

  switch (subcommand) {
    case 'spaces':
      return { kind: 'wiki', action: 'spaces' };
    case 'search':
      return { kind: 'wiki', action: 'search', value };
    case 'read':
      return { kind: 'wiki', action: 'read', value };
    case 'create': {
      if (rest.length <= 1) {
        return { kind: 'wiki', action: 'create', value };
      }
      return { kind: 'wiki', action: 'create', value: rest.slice(1).join(' ').trim(), extra: rest[0] };
    }
    case 'rename': {
      const token = rest[0];
      const title = rest.slice(1).join(' ').trim() || undefined;
      return { kind: 'wiki', action: 'rename', value: title, extra: token };
    }
    case 'copy': {
      const token = rest[0];
      const targetSpaceId = rest[1];
      return { kind: 'wiki', action: 'copy', value: token, extra: targetSpaceId };
    }
    case 'move': {
      const sourceSpaceId = rest[0];
      const token = rest[1];
      const targetSpaceId = rest[2];
      return { kind: 'wiki', action: 'move', value: token, extra: sourceSpaceId, target: targetSpaceId };
    }
    case 'members':
      return { kind: 'wiki', action: 'members', value };
    case 'grant': {
      const spaceId = rest[0];
      const memberType = rest[1];
      const memberId = rest[2];
      const role = rest[3];
      return { kind: 'wiki', action: 'grant', extra: spaceId, target: memberType, value: memberId, role };
    }
    case 'revoke': {
      const spaceId = rest[0];
      const memberType = rest[1];
      const memberId = rest[2];
      const role = rest[3];
      return { kind: 'wiki', action: 'revoke', extra: spaceId, target: memberType, value: memberId, role };
    }
    default:
      return { kind: 'prompt', prompt: `/wiki${argument ? ` ${argument}` : ''}`.trim() };
  }
}
