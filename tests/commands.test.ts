import { describe, expect, it } from 'vitest';
import { buildHelpText, normalizeIncomingText, parseBridgeCommand } from '../src/bridge/commands.js';

describe('bridge commands', () => {
  it('parses project switch commands', () => {
    expect(parseBridgeCommand('/project repo-a')).toEqual({ kind: 'project', alias: 'repo-a' });
    expect(parseBridgeCommand('/status detail')).toEqual({ kind: 'status', detail: true });
  });

  it('parses session commands', () => {
    expect(parseBridgeCommand('/session list')).toEqual({ kind: 'session', action: 'list' });
    expect(parseBridgeCommand('/session use thread-123')).toEqual({ kind: 'session', action: 'use', threadId: 'thread-123' });
    expect(parseBridgeCommand('/session new')).toEqual({ kind: 'session', action: 'new' });
    expect(parseBridgeCommand('/session drop')).toEqual({ kind: 'session', action: 'drop', threadId: undefined });
    expect(parseBridgeCommand('/session adopt')).toEqual({ kind: 'session', action: 'adopt', target: undefined });
    expect(parseBridgeCommand('/session adopt latest')).toEqual({ kind: 'session', action: 'adopt', target: 'latest' });
    expect(parseBridgeCommand('/session adopt list')).toEqual({ kind: 'session', action: 'adopt', target: 'list' });
    expect(parseBridgeCommand('/session adopt thread-123')).toEqual({ kind: 'session', action: 'adopt', target: 'thread-123' });
    expect(parseBridgeCommand('/admin status')).toEqual({ kind: 'admin', resource: 'service', action: 'status' });
    expect(parseBridgeCommand('/admin group add oc_group_1')).toEqual({ kind: 'admin', resource: 'group', action: 'add', value: 'oc_group_1' });
    expect(parseBridgeCommand('/admin project add repo-b /srv/repos/repo-b')).toEqual({
      kind: 'admin',
      resource: 'project',
      action: 'add',
      alias: 'repo-b',
      value: '/srv/repos/repo-b',
    });
    expect(parseBridgeCommand('/admin project set repo-b mention_required true')).toEqual({
      kind: 'admin',
      resource: 'project',
      action: 'set',
      alias: 'repo-b',
      field: 'mention_required',
      value: 'true',
    });
    expect(parseBridgeCommand('/admin service restart')).toEqual({ kind: 'admin', resource: 'service', action: 'restart' });
    expect(parseBridgeCommand('/admin runs')).toEqual({ kind: 'admin', resource: 'service', action: 'runs' });
    expect(parseBridgeCommand('/admin config history')).toEqual({ kind: 'admin', resource: 'config', action: 'history' });
    expect(parseBridgeCommand('/admin config rollback latest')).toEqual({ kind: 'admin', resource: 'config', action: 'rollback', value: 'latest' });
    expect(parseBridgeCommand('/cancel')).toEqual({ kind: 'cancel' });
    expect(parseBridgeCommand('/kb status')).toEqual({ kind: 'kb', action: 'status' });
    expect(parseBridgeCommand('/kb search install')).toEqual({ kind: 'kb', action: 'search', query: 'install' });
    expect(parseBridgeCommand('/doc read doxcn123')).toEqual({ kind: 'doc', action: 'read', value: 'doxcn123' });
    expect(parseBridgeCommand('/doc create 发布说明')).toEqual({ kind: 'doc', action: 'create', value: '发布说明' });
    expect(parseBridgeCommand('/task list 5')).toEqual({ kind: 'task', action: 'list', value: '5' });
    expect(parseBridgeCommand('/task get task-guid-1')).toEqual({ kind: 'task', action: 'get', value: 'task-guid-1' });
    expect(parseBridgeCommand('/task create 修复线上告警')).toEqual({ kind: 'task', action: 'create', value: '修复线上告警' });
    expect(parseBridgeCommand('/task complete task-guid-1')).toEqual({ kind: 'task', action: 'complete', value: 'task-guid-1' });
    expect(parseBridgeCommand('/base tables app123')).toEqual({ kind: 'base', action: 'tables', appToken: 'app123' });
    expect(parseBridgeCommand('/base records app123 tbl123 5')).toEqual({ kind: 'base', action: 'records', appToken: 'app123', tableId: 'tbl123', value: '5' });
    expect(parseBridgeCommand('/base create app123 tbl123 {\"标题\":\"发布\"}')).toEqual({
      kind: 'base',
      action: 'create',
      appToken: 'app123',
      tableId: 'tbl123',
      value: '{"标题":"发布"}',
    });
    expect(parseBridgeCommand('/base update app123 tbl123 rec123 {\"状态\":\"完成\"}')).toEqual({
      kind: 'base',
      action: 'update',
      appToken: 'app123',
      tableId: 'tbl123',
      recordId: 'rec123',
      value: '{"状态":"完成"}',
    });
    expect(parseBridgeCommand('/memory status')).toEqual({ kind: 'memory', action: 'status' });
    expect(parseBridgeCommand('/memory stats')).toEqual({ kind: 'memory', action: 'stats' });
    expect(parseBridgeCommand('/memory status group')).toEqual({ kind: 'memory', action: 'status', scope: 'group' });
    expect(parseBridgeCommand('/memory stats group')).toEqual({ kind: 'memory', action: 'stats', scope: 'group' });
    expect(parseBridgeCommand('/memory recent')).toEqual({ kind: 'memory', action: 'recent' });
    expect(parseBridgeCommand('/memory recent group')).toEqual({ kind: 'memory', action: 'recent', scope: 'group' });
    expect(parseBridgeCommand('/memory recent --tag release')).toEqual({ kind: 'memory', action: 'recent', filters: { tag: 'release' } });
    expect(parseBridgeCommand('/memory recent --created-by ou_123')).toEqual({ kind: 'memory', action: 'recent', filters: { created_by: 'ou_123' } });
    expect(parseBridgeCommand('/memory recent group --source wiki')).toEqual({
      kind: 'memory',
      action: 'recent',
      scope: 'group',
      filters: { source: 'wiki' },
    });
    expect(parseBridgeCommand('/memory search 发布')).toEqual({ kind: 'memory', action: 'search', value: '发布' });
    expect(parseBridgeCommand('/memory search --tag release --source wiki 发布')).toEqual({
      kind: 'memory',
      action: 'search',
      value: '发布',
      filters: { tag: 'release', source: 'wiki' },
    });
    expect(parseBridgeCommand('/memory search --created-by ou_123 发布')).toEqual({
      kind: 'memory',
      action: 'search',
      value: '发布',
      filters: { created_by: 'ou_123' },
    });
    expect(parseBridgeCommand('/memory search group 发布')).toEqual({ kind: 'memory', action: 'search', scope: 'group', value: '发布' });
    expect(parseBridgeCommand('/memory save 发布前必须先 pnpm build')).toEqual({ kind: 'memory', action: 'save', value: '发布前必须先 pnpm build' });
    expect(parseBridgeCommand('/memory save group 发布窗口在周五 20:00')).toEqual({ kind: 'memory', action: 'save', scope: 'group', value: '发布窗口在周五 20:00' });
    expect(parseBridgeCommand('/memory pin 123')).toEqual({ kind: 'memory', action: 'pin', value: '123' });
    expect(parseBridgeCommand('/memory pin group 123')).toEqual({ kind: 'memory', action: 'pin', scope: 'group', value: '123' });
    expect(parseBridgeCommand('/memory unpin group 123')).toEqual({ kind: 'memory', action: 'unpin', scope: 'group', value: '123' });
    expect(parseBridgeCommand('/memory forget 123')).toEqual({ kind: 'memory', action: 'forget', value: '123' });
    expect(parseBridgeCommand('/memory forget all-expired')).toEqual({ kind: 'memory', action: 'forget', value: 'all-expired' });
    expect(parseBridgeCommand('/memory restore 123')).toEqual({ kind: 'memory', action: 'restore', value: '123' });
    expect(parseBridgeCommand('/wiki spaces')).toEqual({ kind: 'wiki', action: 'spaces' });
    expect(parseBridgeCommand('/wiki search 发布流程')).toEqual({ kind: 'wiki', action: 'search', value: '发布流程' });
    expect(parseBridgeCommand('/wiki read https://example.feishu.cn/docx/doxcn123')).toEqual({
      kind: 'wiki',
      action: 'read',
      value: 'https://example.feishu.cn/docx/doxcn123',
    });
    expect(parseBridgeCommand('/wiki create 部署手册')).toEqual({
      kind: 'wiki',
      action: 'create',
      value: '部署手册',
    });
    expect(parseBridgeCommand('/wiki create space_xxx 部署手册')).toEqual({
      kind: 'wiki',
      action: 'create',
      value: '部署手册',
      extra: 'space_xxx',
    });
    expect(parseBridgeCommand('/wiki rename wikcn123 新标题')).toEqual({
      kind: 'wiki',
      action: 'rename',
      value: '新标题',
      extra: 'wikcn123',
    });
    expect(parseBridgeCommand('/wiki copy wikcn123')).toEqual({
      kind: 'wiki',
      action: 'copy',
      value: 'wikcn123',
      extra: undefined,
    });
    expect(parseBridgeCommand('/wiki copy wikcn123 space_xxx')).toEqual({
      kind: 'wiki',
      action: 'copy',
      value: 'wikcn123',
      extra: 'space_xxx',
    });
    expect(parseBridgeCommand('/wiki move space_src wikcn123 space_dst')).toEqual({
      kind: 'wiki',
      action: 'move',
      value: 'wikcn123',
      extra: 'space_src',
      target: 'space_dst',
    });
    expect(parseBridgeCommand('/wiki members')).toEqual({
      kind: 'wiki',
      action: 'members',
      value: undefined,
    });
    expect(parseBridgeCommand('/wiki members space_xxx')).toEqual({
      kind: 'wiki',
      action: 'members',
      value: 'space_xxx',
    });
    expect(parseBridgeCommand('/wiki grant space_xxx open_id ou_123 admin')).toEqual({
      kind: 'wiki',
      action: 'grant',
      extra: 'space_xxx',
      target: 'open_id',
      value: 'ou_123',
      role: 'admin',
    });
    expect(parseBridgeCommand('/wiki revoke space_xxx open_id ou_123')).toEqual({
      kind: 'wiki',
      action: 'revoke',
      extra: 'space_xxx',
      target: 'open_id',
      value: 'ou_123',
      role: undefined,
    });
  });

  it('treats unknown slash commands as prompts', () => {
    expect(parseBridgeCommand('/fix this bug')).toEqual({ kind: 'prompt', prompt: '/fix this bug' });
  });

  it('supports high-confidence natural language commands', () => {
    expect(parseBridgeCommand('查看状态')).toEqual({ kind: 'status' });
    expect(parseBridgeCommand('帮我看下当前状态')).toEqual({ kind: 'status' });
    expect(parseBridgeCommand('当前项目是哪个')).toEqual({ kind: 'project' });
    expect(parseBridgeCommand('帮我看看当前项目')).toEqual({ kind: 'project' });
    expect(parseBridgeCommand('读取文档 doxcn123')).toEqual({ kind: 'doc', action: 'read', value: 'doxcn123' });
    expect(parseBridgeCommand('创建任务 修复线上告警')).toEqual({ kind: 'task', action: 'create', value: '修复线上告警' });
    expect(parseBridgeCommand('完成任务 task-guid-1')).toEqual({ kind: 'task', action: 'complete', value: 'task-guid-1' });
    expect(parseBridgeCommand('查看详细状态')).toEqual({ kind: 'status', detail: true });
    expect(parseBridgeCommand('请帮我看下状态详情')).toEqual({ kind: 'status', detail: true });
    expect(parseBridgeCommand('项目列表')).toEqual({ kind: 'projects' });
    expect(parseBridgeCommand('帮我看看有哪些项目')).toEqual({ kind: 'projects' });
    expect(parseBridgeCommand('新会话')).toEqual({ kind: 'new' });
    expect(parseBridgeCommand('帮我开个新会话')).toEqual({ kind: 'new' });
    expect(parseBridgeCommand('切换到项目 repo-a')).toEqual({ kind: 'project', alias: 'repo-a' });
    expect(parseBridgeCommand('切到长话短说项目')).toEqual({ kind: 'project', alias: '长话短说' });
    expect(parseBridgeCommand('切到 XLINE 项目')).toEqual({ kind: 'project', alias: 'XLINE' });
    expect(parseBridgeCommand('切到 codex-feishu 项目')).toEqual({ kind: 'project', alias: 'codex-feishu' });
    expect(parseBridgeCommand('请把项目切到 repo-a')).toEqual({ kind: 'project', alias: 'repo-a' });
    expect(parseBridgeCommand('切到长话短说项目，看昨晚都干了啥')).toEqual({
      kind: 'project',
      alias: '长话短说',
      followupPrompt: '看昨晚都干了啥',
    });
    expect(parseBridgeCommand('切到 XLINE 项目，然后查看状态')).toEqual({
      kind: 'project',
      alias: 'XLINE',
      followupPrompt: '查看状态',
    });
    expect(parseBridgeCommand('帮我把项目切到 repo-a 然后查看状态')).toEqual({
      kind: 'project',
      alias: 'repo-a',
      followupPrompt: '查看状态',
    });
    expect(parseBridgeCommand('接管最新会话')).toEqual({ kind: 'session', action: 'adopt', target: 'latest' });
    expect(parseBridgeCommand('帮我接上最新会话')).toEqual({ kind: 'session', action: 'adopt', target: 'latest' });
    expect(parseBridgeCommand('接管会话 thread-123')).toEqual({ kind: 'session', action: 'adopt', target: 'thread-123' });
    expect(parseBridgeCommand('添加项目 repo-b /srv/repos/repo-b')).toEqual({
      kind: 'admin',
      resource: 'project',
      action: 'add',
      alias: 'repo-b',
      value: '/srv/repos/repo-b',
    });
    expect(parseBridgeCommand('修改项目 repo-b mention_required false')).toEqual({
      kind: 'admin',
      resource: 'project',
      action: 'set',
      alias: 'repo-b',
      field: 'mention_required',
      value: 'false',
    });
    expect(parseBridgeCommand('重启服务')).toEqual({ kind: 'admin', resource: 'service', action: 'restart' });
    expect(parseBridgeCommand('麻烦你重启一下服务')).toEqual({ kind: 'admin', resource: 'service', action: 'restart' });
    expect(parseBridgeCommand('查看运行列表')).toEqual({ kind: 'admin', resource: 'service', action: 'runs' });
  });

  it('normalizes leading mentions', () => {
    expect(normalizeIncomingText('@Codex   帮我看下这个报错')).toBe('帮我看下这个报错');
  });

  it('renders help text with key commands', () => {
    const helpText = buildHelpText();
    expect(helpText).toContain('/projects');
    expect(helpText).toContain('/status detail');
    expect(helpText).toContain('/new');
    expect(helpText).toContain('/session list');
    expect(helpText).toContain('/session adopt latest');
    expect(helpText).toContain('/session adopt list');
    expect(helpText).toContain('/admin status');
    expect(helpText).toContain('/admin runs');
    expect(helpText).toContain('/admin config history');
    expect(helpText).toContain('/admin config rollback <id|latest>');
    expect(helpText).toContain('/admin service restart');
    expect(helpText).toContain('/cancel');
    expect(helpText).toContain('/kb search');
    expect(helpText).toContain('/doc create');
    expect(helpText).toContain('/task create');
    expect(helpText).toContain('/base create');
    expect(helpText).toContain('/memory status');
    expect(helpText).toContain('/memory stats');
    expect(helpText).toContain('/memory status group');
    expect(helpText).toContain('/memory recent');
    expect(helpText).toContain('--tag <tag>');
    expect(helpText).toContain('--created-by <actor_id>');
    expect(helpText).toContain('/memory search --created-by <actor_id> <query>');
    expect(helpText).toContain('all-expired');
    expect(helpText).toContain('/memory search');
    expect(helpText).toContain('/memory save');
    expect(helpText).toContain('/memory pin');
    expect(helpText).toContain('/memory unpin');
    expect(helpText).toContain('/memory forget');
    expect(helpText).toContain('/memory restore');
    expect(helpText).toContain('/wiki search');
    expect(helpText).toContain('/wiki create');
    expect(helpText).toContain('/wiki rename');
    expect(helpText).toContain('/wiki copy');
    expect(helpText).toContain('/wiki move');
    expect(helpText).toContain('/wiki members');
    expect(helpText).toContain('/wiki grant');
    expect(helpText).toContain('/wiki revoke');
    expect(helpText).toContain('查看状态');
    expect(helpText).toContain('切换到项目 repo-a');
  });
});
