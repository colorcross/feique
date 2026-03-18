export type MemoryScopeTarget = 'project' | 'group';
export interface MemoryCommandFilters {
  tag?: string;
  source?: string;
  created_by?: string;
}

export type AdminResource = 'viewer' | 'operator' | 'admin' | 'service-observer' | 'service-restart' | 'config-admin' | 'group' | 'chat' | 'project' | 'service' | 'config';
export type AdminListAction = 'status' | 'list' | 'add' | 'remove';
export type AdminProjectAction = 'add' | 'create' | 'remove' | 'set' | 'list';
export type AdminConfigAction = 'history' | 'rollback';

export type BridgeCommand =
  | { kind: 'help' }
  | { kind: 'status'; detail?: boolean }
  | { kind: 'projects' }
  | { kind: 'new' }
  | { kind: 'cancel' }
  | { kind: 'kb'; action: 'search' | 'status'; query?: string }
  | { kind: 'doc'; action: 'read' | 'create'; value?: string; extra?: string }
  | { kind: 'task'; action: 'list' | 'get' | 'create' | 'complete'; value?: string; extra?: string }
  | { kind: 'base'; action: 'tables' | 'records' | 'create' | 'update'; appToken?: string; tableId?: string; recordId?: string; value?: string; extra?: string }
  | { kind: 'memory'; action: 'status' | 'stats' | 'search' | 'recent' | 'save' | 'pin' | 'unpin' | 'forget' | 'restore'; scope?: MemoryScopeTarget; value?: string; filters?: MemoryCommandFilters }
  | { kind: 'wiki'; action: 'spaces' | 'search' | 'read' | 'create' | 'rename' | 'copy' | 'move' | 'members' | 'grant' | 'revoke'; value?: string; extra?: string; target?: string; role?: string }
  | { kind: 'project'; alias?: string; followupPrompt?: string }
  | { kind: 'session'; action: 'list' | 'use' | 'new' | 'drop'; threadId?: string }
  | { kind: 'session'; action: 'adopt'; target?: string }
  | { kind: 'admin'; resource: Exclude<AdminResource, 'project' | 'service' | 'config'>; action: AdminListAction; value?: string }
  | { kind: 'admin'; resource: 'project'; action: AdminProjectAction; alias?: string; field?: string; value?: string }
  | { kind: 'admin'; resource: 'service'; action: 'status' | 'restart' | 'runs' }
  | { kind: 'admin'; resource: 'config'; action: AdminConfigAction; value?: string }
  | { kind: 'backend'; name?: string }
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
      return { kind: 'status', detail: argument === 'detail' };
    case '/projects':
      return { kind: 'projects' };
    case '/new':
      return { kind: 'new' };
    case '/cancel':
      return { kind: 'cancel' };
    case '/kb':
      return parseKnowledgeCommand(argument);
    case '/doc':
      return parseDocCommand(argument);
    case '/task':
      return parseTaskCommand(argument);
    case '/base':
      return parseBaseCommand(argument);
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
    case '/backend':
      return { kind: 'backend', name: argument || undefined };
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
    '基础控制',
    '/help 查看帮助',
    '/projects 列出可用项目',
    '/project <alias> 切换当前项目',
    '/status 查看当前项目、会话与运行状态',
    '/status detail 查看当前项目的详细运行状态、排队耗时与最近失败',
    '/new 为当前项目新开会话',
    '/cancel 取消当前项目正在运行的任务',
    '',
    '后端切换',
    '/backend 查看当前项目的活跃后端',
    '/backend codex 切换当前项目到 Codex 后端',
    '/backend claude 切换当前项目到 Claude Code 后端',
    '',
    '会话管理',
    '/session list 列出当前项目保存过的会话',
    '/session use <thread_id> 切换到指定会话',
    '/session new 让下一条消息新开会话',
    '/session drop [thread_id] 删除指定或当前会话',
    '/session adopt latest 接管当前项目最近的本地会话',
    '/session adopt list 列出当前项目可接管的本地会话',
    '/session adopt <thread_id> 接管指定本地会话',
    '',
    '知识与记忆',
    '/kb status 查看当前项目知识库目录',
    '/kb search <query> 搜索项目文档/知识库',
    '/doc read <url|token> 读取飞书文档纯文本摘要',
    '/doc create <title> 创建一篇飞书文档',
    '/task list [limit] 列出最近任务',
    '/task get <task_guid> 查看任务详情',
    '/task create <summary> 创建任务',
    '/task complete <task_guid> 完成任务',
    '/base tables <app_token> 列出多维表格中的数据表',
    '/base records <app_token> <table_id> [limit] 列出多维表格记录',
    '/base create <app_token> <table_id> <json> 新建多维表格记录',
    '/base update <app_token> <table_id> <record_id> <json> 更新多维表格记录',
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
    '',
    '飞书知识库',
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
    '',
    '管理员',
    '/admin status 查看管理员配置摘要',
    '/admin viewer list 查看全局 viewer chat_id 列表',
    '/admin viewer add <chat_id> 添加全局 viewer chat_id',
    '/admin viewer remove <chat_id> 移除全局 viewer chat_id',
    '/admin operator list 查看全局 operator chat_id 列表',
    '/admin operator add <chat_id> 添加全局 operator chat_id',
    '/admin operator remove <chat_id> 移除全局 operator chat_id',
    '/admin service-observer list 查看全局 service observer chat_id 列表',
    '/admin service-observer add <chat_id> 添加全局 service observer chat_id',
    '/admin service-observer remove <chat_id> 移除全局 service observer chat_id',
    '/admin service-restart list 查看全局 service restart chat_id 列表',
    '/admin service-restart add <chat_id> 添加全局 service restart chat_id',
    '/admin service-restart remove <chat_id> 移除全局 service restart chat_id',
    '/admin config-admin list 查看全局 config admin chat_id 列表',
    '/admin config-admin add <chat_id> 添加全局 config admin chat_id',
    '/admin config-admin remove <chat_id> 移除全局 config admin chat_id',
    '/admin runs 查看所有 active/queued 运行及最近失败',
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
    '/admin project add <alias> <root> 动态接入已有项目目录',
    '/admin project create <alias> <root> 创建目录并接入新项目',
    '/admin project remove <alias> 移除项目',
    '/admin project set <alias> <field> <value> 修改项目配置',
    '/admin config history 查看最近 5 次配置快照',
    '/admin config rollback <id|latest> 回滚到最近配置快照',
    '/admin service restart 保存配置并重启服务',
    '',
    '也支持高置信度自然语言触发，例如：',
    '查看状态 / 帮我看下当前状态 / 当前项目是哪个 / 项目列表 / 新会话 / 取消当前任务 / 切换到项目 repo-a / 帮我把项目切到 repo-a 然后查看状态 / 接管最新会话 / 重启服务',
    '',
    '直接发送文本会进入当前项目的 Codex 会话。',
  ].join('\n');
}

export function describeBridgeCommand(command: BridgeCommand): string {
  switch (command.kind) {
    case 'help':
      return '查看帮助';
    case 'status':
      return command.detail ? '查看详细状态' : '查看当前状态';
    case 'projects':
      return '查看项目列表';
    case 'new':
      return '新建会话';
    case 'cancel':
      return '取消当前运行';
    case 'kb':
      return command.action === 'search' ? `搜索知识库: ${command.query ?? ''}`.trim() : '查看知识库状态';
    case 'doc':
      return `文档操作: ${command.action}${command.value ? ` ${command.value}` : ''}`;
    case 'task':
      return `任务操作: ${command.action}${command.value ? ` ${command.value}` : ''}`;
    case 'base':
      return `多维表格操作: ${command.action}${command.appToken ? ` ${command.appToken}` : ''}`;
    case 'memory':
      return `记忆操作: ${command.action}`;
    case 'wiki':
      return `知识库操作: ${command.action}`;
    case 'project':
      if (!command.alias) {
        return '查看当前项目';
      }
      return command.followupPrompt
        ? `切换到项目 ${command.alias}，并执行：${truncateForDescription(command.followupPrompt)}`
        : `切换到项目 ${command.alias}`;
    case 'session':
      if (command.action === 'adopt') {
        return `接管会话 ${command.target ?? 'latest'}`;
      }
      return `会话操作: ${command.action}${'threadId' in command && command.threadId ? ` ${command.threadId}` : ''}`;
    case 'admin':
      if (command.resource === 'project') {
        return `管理员项目操作: ${command.action}${command.alias ? ` ${command.alias}` : ''}`;
      }
      if (command.resource === 'config') {
        return `配置操作: ${command.action}${command.value ? ` ${command.value}` : ''}`;
      }
      return `管理员操作: ${command.resource} ${command.action}${'value' in command && command.value ? ` ${command.value}` : ''}`;
    case 'backend':
      return command.name ? `切换后端到 ${command.name}` : '查看当前后端';
    case 'prompt':
      return truncateForDescription(command.prompt);
  }
}

export function isReadOnlyCommand(command: BridgeCommand): boolean {
  switch (command.kind) {
    case 'help':
    case 'status':
    case 'projects':
      return true;
    case 'kb':
      return true;
    case 'project':
      return !command.alias;
    case 'doc':
      return command.action === 'read';
    case 'task':
      return command.action === 'list' || command.action === 'get';
    case 'base':
      return command.action === 'tables' || command.action === 'records';
    case 'memory':
      return command.action === 'status' || command.action === 'stats' || command.action === 'search' || command.action === 'recent';
    case 'wiki':
      return command.action === 'spaces' || command.action === 'search' || command.action === 'read' || command.action === 'members';
    case 'session':
      return command.action === 'list';
    case 'backend':
      return !command.name;
    case 'admin':
      if (command.resource === 'service') {
        return command.action === 'status' || command.action === 'runs';
      }
      if (command.resource === 'project') {
        return command.action === 'list';
      }
      if (command.resource === 'config') {
        return command.action === 'history';
      }
      return command.action === 'status' || command.action === 'list';
    default:
      return false;
  }
}

function parseNaturalLanguageCommand(input: string): BridgeCommand | null {
  const normalized = stripNaturalLanguagePrefix(
    input
    .trim()
    .replace(/[。！？!?；;]+$/u, '')
    .replace(/\s+/g, ' '),
  );

  if (!normalized) {
    return null;
  }

  if (/^(帮助|查看帮助|命令帮助|帮助手册)$/.test(normalized)) {
    return { kind: 'help' };
  }
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:当前)?(?:运行)?状态$/.test(normalized)) {
    return { kind: 'status' };
  }
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:当前)?(?:详细状态|状态详情|详细运行状态)$/.test(normalized)) {
    return { kind: 'status', detail: true };
  }
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:项目列表|可用项目|有哪些项目|查看项目|列出项目)$/.test(normalized)) {
    return { kind: 'projects' };
  }
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:当前)?项目(?:是哪个|是什么)?$|^我现在在哪个项目$/.test(normalized)) {
    return { kind: 'project' };
  }
  if (/^(新会话|开启新会话|重新开始会话|下一条消息新开会话|开(?:个|一个)?新会话|重新开(?:个|一个)?会话|新开会话)$/.test(normalized)) {
    return { kind: 'new' };
  }
  if (/^(取消当前任务|停止当前任务|取消运行|停止运行|停止任务|停掉当前任务|终止当前任务|取消这次运行)$/.test(normalized)) {
    return { kind: 'cancel' };
  }
  if (/^(查看文档|读取文档|打开文档)\s+(\S+)$/.test(normalized)) {
    const match = normalized.match(/^(?:查看文档|读取文档|打开文档)\s+(\S+)$/);
    return match?.[1] ? { kind: 'doc', action: 'read', value: match[1] } : null;
  }
  if (/^(创建任务|新建任务)\s+(.+)$/.test(normalized)) {
    const match = normalized.match(/^(?:创建任务|新建任务)\s+(.+)$/);
    return match?.[1] ? { kind: 'task', action: 'create', value: match[1].trim() } : null;
  }
  if (/^(完成任务|关闭任务)\s+(\S+)$/.test(normalized)) {
    const match = normalized.match(/^(?:完成任务|关闭任务)\s+(\S+)$/);
    return match?.[1] ? { kind: 'task', action: 'complete', value: match[1] } : null;
  }
  if (/^(查看会话|会话列表|列出会话|查看当前会话|看看会话列表|有哪些会话)$/.test(normalized)) {
    return { kind: 'session', action: 'list' };
  }
  if (/^(接管最新会话|接管最近会话|接管最新 Codex 会话|接上最新会话|续上最新会话|恢复最新会话)$/i.test(normalized)) {
    return { kind: 'session', action: 'adopt', target: 'latest' };
  }
  if (/^(查看可接管会话|列出可接管会话|可接管会话列表|查看可恢复会话|可恢复会话列表)$/.test(normalized)) {
    return { kind: 'session', action: 'adopt', target: 'list' };
  }

  const projectWithPromptMatch = normalized.match(
    /^(?:把)?(?:当前)?(?:项目)?(?:切换到|切到|切换至|转到|进入|使用|换到|改到)\s*([^，,。；;：:\s]+?)\s*(?:项目)?(?:[，,。；;：:]\s*|\s*(?:然后|并且|并|再)\s*)(.+)$/,
  );
  if (projectWithPromptMatch) {
    const [, alias, followupPrompt] = projectWithPromptMatch;
    if (alias && followupPrompt) {
      return { kind: 'project', alias, followupPrompt: followupPrompt.replace(/^(?:然后|并且|并|再)\s*/u, '').trim() };
    }
  }

  const projectMatch = normalized.match(
    /^(?:把)?(?:当前)?(?:项目)?(?:切换到项目|切到项目|使用项目|切换到|切到|切换至|转到|进入|使用|换到|改到)\s+(\S+?)(?:\s*项目)?$/,
  );
  if (projectMatch) {
    return { kind: 'project', alias: projectMatch[1] };
  }

  const projectShortMatch = normalized.match(/^(?:把)?(?:当前)?(?:项目)?(?:切换到|切到|切换至|转到|进入|使用|换到|改到)([^，,。；;：:\s]+)项目$/);
  if (projectShortMatch) {
    return { kind: 'project', alias: projectShortMatch[1] };
  }

  const adoptSessionMatch = normalized.match(/^(?:接管会话|使用会话|接上会话|恢复会话|续上会话)\s+(\S+)$/);
  if (adoptSessionMatch) {
    return { kind: 'session', action: 'adopt', target: adoptSessionMatch[1] };
  }

  const backendMatch = normalized.match(/^(?:切换(?:到|为)?|使用|换(?:到|成)?|改(?:到|为)?)?\s*(?:后端(?:(?:切换)?(?:到|为)?)?)\s*(codex|claude)\s*(?:后端)?$/i);
  if (backendMatch) {
    return { kind: 'backend', name: backendMatch[1]!.toLowerCase() };
  }
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:当前)?后端(?:是什么|是哪个)?$/.test(normalized)) {
    return { kind: 'backend' };
  }

  if (/^(管理员状态|查看管理员状态|看一下管理员状态)$/.test(normalized)) {
    return { kind: 'admin', resource: 'service', action: 'status' };
  }
  if (/^(查看运行列表|查看运行状态列表|管理员运行列表|查看排队列表|查看任务列表)$/.test(normalized)) {
    return { kind: 'admin', resource: 'service', action: 'runs' };
  }
  if (/^(重启服务|重启机器人|重启 codex-feishu 服务|重启一下服务|重启一下机器人)$/i.test(normalized)) {
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

  const createProjectMatch = normalized.match(/^(?:创建项目|新建项目)\s+(\S+)\s+(.+)$/);
  if (createProjectMatch) {
    const [, alias, root] = createProjectMatch;
    if (!alias || !root) {
      return null;
    }
    return { kind: 'admin', resource: 'project', action: 'create', alias, value: root.trim() };
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

function stripNaturalLanguagePrefix(input: string): string {
  let value = input.trim();
  const prefixPattern = /^(?:请(?:帮我)?|帮我|帮忙|麻烦(?:你|帮我)?|劳驾(?:帮我)?|辛苦(?:帮我)?|能不能(?:帮我)?|可以(?:帮我)?|可否(?:帮我)?)(?:\s+|(?=把)|(?=看)|(?=查)|(?=切)|(?=转)|(?=进)|(?=用)|(?=开)|(?=取)|(?=停)|(?=重)|(?=接)|(?=恢)|(?=创)|(?=完)|(?=当)|(?=项))/u;
  while (prefixPattern.test(value)) {
    value = value.replace(prefixPattern, '').trim();
  }
  return value.replace(/^把(?=项目|当前项目|切换到|切到|切换至|转到|进入|使用|换到|改到)/u, '').trim();
}

function truncateForDescription(input: string, limit: number = 36): string {
  return input.length > limit ? `${input.slice(0, limit)}...` : input;
}

function parseAdminCommand(argument: string): BridgeCommand {
  const [resource, action, ...rest] = argument.split(/\s+/).filter(Boolean);

  if (!resource || resource === 'status') {
    return { kind: 'admin', resource: 'service', action: 'status' };
  }

  if (resource === 'runs') {
    return { kind: 'admin', resource: 'service', action: 'runs' };
  }

  if (resource === 'service') {
    if (action === 'restart') {
      return { kind: 'admin', resource: 'service', action: 'restart' };
    }
    if (action === 'runs') {
      return { kind: 'admin', resource: 'service', action: 'runs' };
    }
    return { kind: 'admin', resource: 'service', action: 'status' };
  }

  if (resource === 'config') {
    if (!action || action === 'history') {
      return { kind: 'admin', resource: 'config', action: 'history' };
    }
    if (action === 'rollback') {
      return { kind: 'admin', resource: 'config', action: 'rollback', value: rest.join(' ').trim() || undefined };
    }
    return { kind: 'prompt', prompt: `/admin${argument ? ` ${argument}` : ''}`.trim() };
  }

  if (resource === 'project') {
    if (action === 'list' || !action) {
      return { kind: 'admin', resource: 'project', action: 'list' };
    }
    if (action === 'add') {
      return { kind: 'admin', resource: 'project', action: 'add', alias: rest[0], value: rest.slice(1).join(' ').trim() || undefined };
    }
    if (action === 'create') {
      return { kind: 'admin', resource: 'project', action: 'create', alias: rest[0], value: rest.slice(1).join(' ').trim() || undefined };
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

  if (
    resource === 'viewer' ||
    resource === 'operator' ||
    resource === 'admin' ||
    resource === 'service-observer' ||
    resource === 'service-restart' ||
    resource === 'config-admin' ||
    resource === 'group' ||
    resource === 'chat'
  ) {
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

function parseDocCommand(argument: string): BridgeCommand {
  const [subcommand, ...rest] = argument.split(/\s+/).filter(Boolean);
  const value = rest.join(' ').trim() || undefined;

  switch (subcommand) {
    case 'read':
      return { kind: 'doc', action: 'read', value };
    case 'create':
      return { kind: 'doc', action: 'create', value };
    default:
      return { kind: 'prompt', prompt: `/doc${argument ? ` ${argument}` : ''}`.trim() };
  }
}

function parseTaskCommand(argument: string): BridgeCommand {
  const [subcommand, ...rest] = argument.split(/\s+/).filter(Boolean);
  const value = rest.join(' ').trim() || undefined;

  switch (subcommand) {
    case 'list':
      return { kind: 'task', action: 'list', value };
    case 'get':
      return { kind: 'task', action: 'get', value };
    case 'create':
      return { kind: 'task', action: 'create', value };
    case 'complete':
      return { kind: 'task', action: 'complete', value };
    default:
      return { kind: 'prompt', prompt: `/task${argument ? ` ${argument}` : ''}`.trim() };
  }
}

function parseBaseCommand(argument: string): BridgeCommand {
  const [subcommand, ...rest] = argument.split(/\s+/).filter(Boolean);

  switch (subcommand) {
    case 'tables':
      return { kind: 'base', action: 'tables', appToken: rest[0] };
    case 'records':
      return { kind: 'base', action: 'records', appToken: rest[0], tableId: rest[1], value: rest[2] };
    case 'create':
      return {
        kind: 'base',
        action: 'create',
        appToken: rest[0],
        tableId: rest[1],
        value: rest.slice(2).join(' ').trim() || undefined,
      };
    case 'update':
      return {
        kind: 'base',
        action: 'update',
        appToken: rest[0],
        tableId: rest[1],
        recordId: rest[2],
        value: rest.slice(3).join(' ').trim() || undefined,
      };
    default:
      return { kind: 'prompt', prompt: `/base${argument ? ` ${argument}` : ''}`.trim() };
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
