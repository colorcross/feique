export type MemoryScopeTarget = 'project' | 'group';
export interface MemoryCommandFilters {
  tag?: string;
  source?: string;
  created_by?: string;
}

export type AdminResource = 'viewer' | 'operator' | 'admin' | 'service-observer' | 'service-restart' | 'config-admin' | 'group' | 'chat' | 'project' | 'service' | 'config';
export type AdminListAction = 'status' | 'list' | 'add' | 'remove';
export type AdminProjectAction = 'add' | 'create' | 'remove' | 'set' | 'list' | 'setup';
export type AdminConfigAction = 'history' | 'rollback';

export type BridgeCommand =
  | { kind: 'help'; detail?: boolean }
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
  | { kind: 'team' }
  | { kind: 'learn'; value: string }
  | { kind: 'recall'; query: string }
  | { kind: 'handoff'; summary?: string; target?: string }
  | { kind: 'pickup'; id?: string }
  | { kind: 'review' }
  | { kind: 'approve'; comment?: string }
  | { kind: 'reject'; reason?: string }
  | { kind: 'insights' }
  | { kind: 'trust'; action?: 'set'; level?: string }
  | { kind: 'timeline'; project?: string }
  | { kind: 'digest' }
  | { kind: 'gaps' }
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
      return { kind: 'help', detail: argument === 'all' || argument === '详细' };
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
    case '/team':
      return { kind: 'team' };
    case '/learn':
      return argument ? { kind: 'learn', value: argument } : { kind: 'prompt', prompt: trimmed };
    case '/recall':
      return argument ? { kind: 'recall', query: argument } : { kind: 'prompt', prompt: trimmed };
    case '/handoff':
      return { kind: 'handoff', summary: argument || undefined };
    case '/pickup':
      return { kind: 'pickup', id: argument || undefined };
    case '/review':
      return { kind: 'review' };
    case '/approve':
      return { kind: 'approve', comment: argument || undefined };
    case '/reject':
      return { kind: 'reject', reason: argument || undefined };
    case '/insights':
      return { kind: 'insights' };
    case '/trust':
      return parseTrustCommand(argument);
    case '/timeline':
      return { kind: 'timeline', project: argument || undefined };
    case '/digest':
      return { kind: 'digest' };
    case '/gaps':
      return { kind: 'gaps' };
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
    '飞鹊 (Feique) — 团队 AI 协作中枢',
    '',
    '常用命令',
    '/projects 查看可用项目',
    '/project <名称> 切换项目',
    '/status 查看当前状态',
    '/backend codex|claude 切换后端',
    '/team 查看团队成员活动',
    '/learn <内容> 记录团队知识',
    '/recall <关键词> 检索知识',
    '/insights 团队效率体检',
    '/digest 生成团队日报',
    '/gaps 检测知识缺口',
    '',
    '所有命令均支持自然语言，如：用 claude / 谁在用AI / 效率怎么样',
    '',
    '输入 /help all 查看完整命令列表',
  ].join('\n');
}

export function buildFullHelpText(): string {
  return [
    '飞鹊 (Feique)',
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
    '团队协作',
    '/team 查看团队成员当前 AI 协作态势',
    '/learn <内容> 记录一条团队知识（标题:内容 或直接输入）',
    '/recall <关键词> 检索团队沉淀的知识',
    '/handoff [摘要] 将当前会话交接给其他成员',
    '/pickup [id] 接手一个待交接的任务',
    '/review 将最近的 AI 输出提交评审',
    '/approve [评语] 批准当前评审',
    '/reject [原因] 打回当前评审',
    '/insights 查看团队 AI 协作效率体检报告',
    '/trust 查看当前项目的信任等级',
    '/trust set <observe|suggest|execute|autonomous> 设置信任等级',
    '/timeline [项目] 查看项目协作时间线',
    '/digest 立即生成团队 AI 协作日报',
    '/gaps 检测团队知识缺口',
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
    '所有命令均支持自然语言触发，例如：',
    '基础: 查看状态 / 项目列表 / 新会话 / 取消当前任务 / 切换到项目 repo-a',
    '协作: 谁在用AI / 大家在忙什么 / 效率怎么样 / 哪里有瓶颈',
    '知识: 记住：XXX / 有没有关于XXX的经验 / 查一下知识 XXX',
    '交接: 交接一下 / 我来接手 / 评审一下 / 通过 / 打回',
    '管理: 信任等级 / 提升信任 / 时间线 / 日报 / 团队总结',
    '',
    '直接发送文本会进入当前项目的 AI 会话。',
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
    case 'team':
      return '查看团队协作态势';
    case 'learn':
      return `记录团队知识: ${truncateForDescription(command.value)}`;
    case 'recall':
      return `检索团队知识: ${truncateForDescription(command.query)}`;
    case 'handoff':
      return '发起会话交接';
    case 'pickup':
      return '接手交接任务';
    case 'review':
      return '发起评审';
    case 'approve':
      return '批准评审';
    case 'reject':
      return '打回评审';
    case 'insights':
      return '查看团队效率体检';
    case 'trust':
      return command.action === 'set' ? `设置信任等级: ${command.level}` : '查看信任状态';
    case 'timeline':
      return command.project ? `查看项目 ${command.project} 时间线` : '查看项目时间线';
    case 'digest':
      return '生成团队 AI 协作日报';
    case 'gaps':
      return '检测知识缺口';
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
    case 'team':
    case 'recall':
    case 'insights':
    case 'timeline':
    case 'digest':
    case 'gaps':
      return true;
    case 'trust':
      return !command.action;
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

  // ── /team: 团队态势感知 ──
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:团队(?:协作)?态势|团队状态|团队活动|谁在做什么|团队在做什么|谁在用\s*AI|大家在忙什么|团队成员(?:在做什么|状态)|现在谁在(?:干活|工作|用AI)|看看团队)$/.test(normalized)) {
    return { kind: 'team' };
  }

  // ── /learn: 知识记录 ──
  const learnMatch = normalized.match(/^(?:记住|记录(?:一下)?|保存(?:知识|经验|一下)?|团队知识|知识记录)[：:\s]+(.+)$/);
  if (learnMatch?.[1]) {
    return { kind: 'learn', value: learnMatch[1].trim() };
  }

  // ── /recall: 知识检索 ──
  // "有没有关于X的知识/经验"
  const recallHasMatch = normalized.match(/^有没有(?:关于|涉及)(.+?)的?(?:知识|经验|记录)$/);
  if (recallHasMatch?.[1]) {
    return { kind: 'recall', query: recallHasMatch[1].trim() };
  }
  // "关于X有什么知识/经验"
  const recallAboutMatch = normalized.match(/^关于(.+?)(?:有什么|有没有)(?:知识|经验|记录)$/);
  if (recallAboutMatch?.[1]) {
    return { kind: 'recall', query: recallAboutMatch[1].trim() };
  }
  // "搜搜/查查/找找 X" or "查一下知识 X" or "检索 X"
  const recallSearchMatch = normalized.match(/^(?:搜搜|查查|查一下|找找|搜索|检索|回忆)(?:看)?(?:知识|经验|团队知识|以前的经验)?[：:\s]+(.+)$/);
  if (recallSearchMatch?.[1]) {
    return { kind: 'recall', query: recallSearchMatch[1].trim() };
  }

  // ── /handoff: 会话交接 ──
  const handoffMatch = normalized.match(/^(?:交接(?:一下|出去)?|转交(?:一下)?|交给(?:别人|其他人|下一个人)|(?:这个)?任务交出去|我做不完了|谁来接(?:手|一下)?|把(?:这个|当前)(?:任务|会话)交(?:出去|接))(?:[，,：:\s]+(.+))?$/);
  if (handoffMatch) {
    return { kind: 'handoff', summary: handoffMatch[1]?.trim() || undefined };
  }

  // ── /pickup: 接手任务 ──
  if (/^(?:我来(?:接手?|处理|做|搞)|我接(?:手|了)?|让我来|我来吧|接手(?:任务)?|我来接(?:这个)?(?:任务|活)?)$/.test(normalized)) {
    return { kind: 'pickup' };
  }

  // ── /review: 评审 ──
  if (/^(?:评审(?:一下)?|提交评审|看看(?:这个)?结果|帮(?:忙)?(?:看看|审查|评审)(?:结果)?|review(?:一下)?|审查(?:一下)?)$/i.test(normalized)) {
    return { kind: 'review' };
  }

  // ── /approve: 批准（短句高置信度匹配）──
  const approveMatch = normalized.match(/^(?:通过|批准|同意|LGTM|approved?)(?:[，,：:\s]+(.+))?$/i);
  if (approveMatch) {
    return { kind: 'approve', comment: approveMatch[1]?.trim() || undefined };
  }

  // ── /reject: 打回 ──
  const rejectMatch = normalized.match(/^(?:不行|打回|驳回|退回|不通过|reject(?:ed)?)(?:[，,：:\s]+(.+))?$/i);
  if (rejectMatch) {
    return { kind: 'reject', reason: rejectMatch[1]?.trim() || undefined };
  }

  // ── /insights: 效率体检 ──
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:团队体检|效率体检|效率报告|协作体检|瓶颈分析|哪里有瓶颈|效率怎么样|有什么(?:问题|瓶颈)|团队健康|(?:AI)?(?:使用|协作)(?:效率|情况|分析)|有没有(?:问题|瓶颈|异常))$/.test(normalized)) {
    return { kind: 'insights' };
  }

  // ── /trust: 信任管理 ──
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:信任(?:等级|状态|级别)|项目信任|当前信任)$/.test(normalized)) {
    return { kind: 'trust' };
  }
  const trustSetMatch = normalized.match(/^(?:设置|修改|调整)信任(?:等级|级别)?(?:为|到)\s*(observe|suggest|execute|autonomous|观察|建议|执行|自主)$/i);
  if (trustSetMatch) {
    const levelMap: Record<string, string> = { '观察': 'observe', '建议': 'suggest', '执行': 'execute', '自主': 'autonomous' };
    const raw = trustSetMatch[1]!.toLowerCase();
    return { kind: 'trust', action: 'set', level: levelMap[raw] ?? raw };
  }
  if (/^提升信任(?:等级)?$/.test(normalized)) {
    return { kind: 'trust', action: 'set', level: '_promote' };
  }
  if (/^降低信任(?:等级)?$/.test(normalized)) {
    return { kind: 'trust', action: 'set', level: '_demote' };
  }

  // ── /timeline: 项目时间线 ──
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:(?:项目)?时间线|最近(?:发生了什么|有什么动态|动态)|项目(?:动态|历史|活动|进展)|发生了什么事?)$/.test(normalized)) {
    return { kind: 'timeline' };
  }
  const timelineProjectMatch = normalized.match(/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(\S+?)(?:的|项目的?)(?:时间线|动态|历史|活动|进展)$/);
  if (timelineProjectMatch) {
    return { kind: 'timeline', project: timelineProjectMatch[1] };
  }

  // ── /gaps: 知识缺口检测 ──
  if (/^(?:(?:查看|看|查|检测)(?:一下|下)?)?(?:知识缺口|缺口检测|知识(?:盲区|空白|短板)|(?:哪些|什么)(?:知识|经验)(?:缺失|不够|没有)|team knowledge gaps?)$/i.test(normalized)) {
    return { kind: 'gaps' };
  }

  // ── /digest: 团队日报 ──
  if (/^(?:(?:查看|看|查|生成|出个|出一下|来个|出)(?:一下|下)?)?(?:(?:团队)?(?:AI)?(?:协作)?日报|今天(?:的)?(?:报告|总结|摘要)|团队(?:总结|报告|摘要)|每日摘要|daily\s*digest)$/i.test(normalized)) {
    return { kind: 'digest' };
  }

  // ── /backend: 后端切换（必须在项目切换之前，否则 "切到 claude" 会被误判为切换项目）──
  // Pattern 1: 带"后端"关键词 — "切换后端到 claude" / "后端换成 codex"
  const backendWithKeyword = normalized.match(/^(?:切换(?:到|为)?|使用|换(?:到|成)?|改(?:到|为|用)?)?\s*(?:后端(?:(?:切换)?(?:到|为)?)?)\s*(codex|claude)\s*(?:后端)?$/i);
  if (backendWithKeyword) {
    return { kind: 'backend', name: backendWithKeyword[1]!.toLowerCase() };
  }
  // Pattern 2: 不带"后端"— "用 claude" / "换成 codex" / "切到 claude" / "改用 codex"
  const backendDirect = normalized.match(/^(?:用|使用|换(?:成|到)?|切(?:换?(?:到|成)?)?|改(?:用|成|到)?|转(?:到|成)?)\s*(codex|claude)(?:\s*(?:吧|看看|试试|帮我|来))?$/i);
  if (backendDirect) {
    return { kind: 'backend', name: backendDirect[1]!.toLowerCase() };
  }
  // Pattern 3: "codex/claude + 动词" — "claude 来" / "codex 帮我"
  const backendNameFirst = normalized.match(/^(codex|claude)\s*(?:来(?:吧)?|帮我|试试|处理|干活|上)$/i);
  if (backendNameFirst) {
    return { kind: 'backend', name: backendNameFirst[1]!.toLowerCase() };
  }
  // Pattern 4: 查看当前后端
  if (/^(?:(?:查看|看|查)(?:一下|下)?|看看)?(?:当前)?(?:后端|backend)(?:是什么|是哪个)?$/.test(normalized)) {
    return { kind: 'backend' };
  }
  // Pattern 5: "用的什么/哪个" — "现在用的什么" / "当前用的哪个"
  if (/^(?:现在|当前)?用的(?:什么|哪个)(?:后端|backend)?$/.test(normalized)) {
    return { kind: 'backend' };
  }
  // Pattern 6: English — "switch to claude" / "use codex" / "change to claude"
  const backendEnglish = normalized.match(/^(?:switch(?:\s+backend)?(?:\s+to)?|use|change(?:\s+backend)?(?:\s+to)?|backend)\s+(codex|claude)$/i);
  if (backendEnglish) {
    return { kind: 'backend', name: backendEnglish[1]!.toLowerCase() };
  }
  // Pattern 7: English name-first — "claude please" / "codex go"
  const backendEnglishNameFirst = normalized.match(/^(codex|claude)\s+(?:please|go|now|backend)$/i);
  if (backendEnglishNameFirst) {
    return { kind: 'backend', name: backendEnglishNameFirst[1]!.toLowerCase() };
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


  if (/^(管理员状态|查看管理员状态|看一下管理员状态)$/.test(normalized)) {
    return { kind: 'admin', resource: 'service', action: 'status' };
  }
  if (/^(查看运行列表|查看运行状态列表|管理员运行列表|查看排队列表|查看任务列表)$/.test(normalized)) {
    return { kind: 'admin', resource: 'service', action: 'runs' };
  }
  if (/^(重启服务|重启机器人|重启 feique 服务|重启一下服务|重启一下机器人)$/i.test(normalized)) {
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

function parseTrustCommand(argument: string): BridgeCommand {
  if (!argument) return { kind: 'trust' };
  const parts = argument.split(/\s+/).filter(Boolean);
  if (parts[0] === 'set' && parts[1]) {
    return { kind: 'trust', action: 'set', level: parts[1] };
  }
  return { kind: 'trust' };
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
    if (action === 'setup') {
      return { kind: 'admin', resource: 'project', action: 'setup', alias: rest[0], value: rest.slice(1).join(' ').trim() || undefined };
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
