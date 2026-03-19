/**
 * Self-contained HTML dashboard for Feique bridge.
 * No external dependencies — all CSS and JS are inline.
 */

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feique Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0e17;
    color: #c9d1d9;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    padding: 20px;
  }
  h1 { font-size: 20px; color: #e6edf3; margin-bottom: 16px; }
  h2 { font-size: 15px; color: #8b949e; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 16px;
    margin-bottom: 20px;
  }
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 16px;
  }
  .card h2 { margin-bottom: 12px; }
  .stat-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    border-bottom: 1px solid #21262d;
  }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: #8b949e; }
  .stat-value { font-family: "SF Mono", "Fira Code", monospace; color: #e6edf3; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-family: "SF Mono", "Fira Code", monospace;
  }
  .badge-green { background: #0d1117; border: 1px solid #238636; color: #3fb950; }
  .badge-yellow { background: #0d1117; border: 1px solid #9e6a03; color: #d29922; }
  .badge-red { background: #0d1117; border: 1px solid #da3633; color: #f85149; }
  .badge-blue { background: #0d1117; border: 1px solid #1f6feb; color: #58a6ff; }
  .badge-gray { background: #0d1117; border: 1px solid #484f58; color: #8b949e; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 13px;
  }
  th {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid #30363d;
    color: #8b949e;
    font-weight: 500;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid #21262d;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }
  .header-right {
    font-size: 12px;
    color: #484f58;
    font-family: "SF Mono", "Fira Code", monospace;
  }
  .refresh-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #238636;
    margin-right: 6px;
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .empty { color: #484f58; font-style: italic; padding: 8px 0; }
  .section-full { grid-column: 1 / -1; }
</style>
</head>
<body>
<div class="header">
  <h1>Feique Dashboard</h1>
  <div class="header-right"><span class="refresh-dot"></span><span id="ts">--</span></div>
</div>

<div class="grid">
  <div class="card" id="service-card">
    <h2>服务状态</h2>
    <div id="service-body"><div class="empty">加载中...</div></div>
  </div>
  <div class="card" id="team-card">
    <h2>团队活跃</h2>
    <div id="team-body"><div class="empty">加载中...</div></div>
  </div>
  <div class="card" id="cost-card">
    <h2>24h 运行统计</h2>
    <div id="cost-body"><div class="empty">加载中...</div></div>
  </div>
  <div class="card" id="handoff-card">
    <h2>交接 / 评审</h2>
    <div id="handoff-body"><div class="empty">加载中...</div></div>
  </div>
</div>

<div class="grid">
  <div class="card section-full" id="projects-card">
    <h2>项目概览</h2>
    <div id="projects-body"><div class="empty">加载中...</div></div>
  </div>
</div>

<div class="grid">
  <div class="card section-full" id="runs-card">
    <h2>最近运行</h2>
    <div id="runs-body"><div class="empty">加载中...</div></div>
  </div>
</div>

<script>
function statusBadge(status) {
  const map = {
    running: 'badge-blue',
    queued: 'badge-yellow',
    success: 'badge-green',
    failure: 'badge-red',
    cancelled: 'badge-gray',
    stale: 'badge-gray',
    orphaned: 'badge-yellow',
  };
  return '<span class="badge ' + (map[status] || 'badge-gray') + '">' + esc(status) + '</span>';
}

function trustBadge(level) {
  const map = {
    autonomous: 'badge-green',
    execute: 'badge-blue',
    suggest: 'badge-yellow',
    observe: 'badge-gray',
  };
  return '<span class="badge ' + (map[level] || 'badge-gray') + '">' + esc(level) + '</span>';
}

function stageBadge(stage) {
  const map = {
    ready: 'badge-green',
    starting: 'badge-yellow',
    degraded: 'badge-red',
    stopping: 'badge-yellow',
    stopped: 'badge-gray',
  };
  return '<span class="badge ' + (map[stage] || 'badge-gray') + '">' + esc(stage) + '</span>';
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shortTime(iso) {
  if (!iso) return '--';
  try {
    var d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso; }
}

function pct(n) {
  if (n == null || isNaN(n)) return '--';
  return (n * 100).toFixed(0) + '%';
}

function statRow(label, value) {
  return '<div class="stat-row"><span class="stat-label">' + esc(label) + '</span><span class="stat-value">' + value + '</span></div>';
}

function render(data) {
  document.getElementById('ts').textContent = shortTime(data.timestamp);

  // Service
  var s = data.service || {};
  document.getElementById('service-body').innerHTML =
    statRow('服务', esc(s.name || '--')) +
    statRow('阶段', stageBadge(s.stage || 'unknown')) +
    statRow('就绪', s.ready ? '<span class="badge badge-green">是</span>' : '<span class="badge badge-red">否</span>') +
    statRow('启动警告', esc(s.startupWarnings ?? 0)) +
    statRow('启动错误', esc(s.startupErrors ?? 0));

  // Team
  var t = data.team || {};
  var teamHtml = statRow('活跃成员', esc(t.active_members ?? 0));
  if (t.active_runs && t.active_runs.length > 0) {
    teamHtml += '<div style="margin-top:8px;font-size:12px;color:#8b949e;">运行中:</div>';
    t.active_runs.forEach(function(r) {
      teamHtml += '<div style="padding:4px 0;border-bottom:1px solid #21262d;font-family:monospace;font-size:12px;">' +
        statusBadge(r.status) + ' ' + esc(r.project_alias) +
        ' <span style="color:#484f58;">' + esc((r.prompt_excerpt || '').substring(0, 40)) + '</span></div>';
    });
  }
  if (t.queued_runs && t.queued_runs.length > 0) {
    teamHtml += '<div style="margin-top:8px;font-size:12px;color:#8b949e;">排队中: ' + t.queued_runs.length + '</div>';
  }
  document.getElementById('team-body').innerHTML = teamHtml || '<div class="empty">无活跃运行</div>';

  // Cost / 24h stats
  var c = data.cost || {};
  var costHtml = statRow('24h 总运行', esc(c.total_runs_24h ?? 0));
  if (c.by_project) {
    Object.keys(c.by_project).forEach(function(proj) {
      var p = c.by_project[proj];
      costHtml += statRow(proj, esc(p.runs) + ' 次 / 成功 ' + esc(p.success));
    });
  }
  document.getElementById('cost-body').innerHTML = costHtml;

  // Handoffs & Reviews
  var h = data.handoffs || {};
  var rv = data.reviews || {};
  document.getElementById('handoff-body').innerHTML =
    statRow('待处理交接', esc(h.pending ?? 0)) +
    statRow('24h 已完成交接', esc(h.completed_24h ?? 0)) +
    statRow('待评审', esc(rv.pending ?? 0)) +
    statRow('24h 已完成评审', esc(rv.completed_24h ?? 0));

  // Projects
  var projects = data.projects || [];
  if (projects.length === 0) {
    document.getElementById('projects-body').innerHTML = '<div class="empty">暂无项目数据</div>';
  } else {
    var html = '<table><tr><th>项目</th><th>总运行</th><th>成功率</th><th>活跃</th><th>信任等级</th></tr>';
    projects.forEach(function(p) {
      html += '<tr><td>' + esc(p.alias) + '</td><td>' + esc(p.total_runs) +
        '</td><td>' + pct(p.success_rate) + '</td><td>' + esc(p.active_runs) +
        '</td><td>' + trustBadge(p.trust_level) + '</td></tr>';
    });
    html += '</table>';
    document.getElementById('projects-body').innerHTML = html;
  }

  // Recent runs
  var allRuns = (t.active_runs || []).concat(t.queued_runs || []);
  // Also include recent completed runs if available from projects data
  if (data._recent_runs && data._recent_runs.length > 0) {
    allRuns = data._recent_runs;
  }
  if (allRuns.length === 0) {
    document.getElementById('runs-body').innerHTML = '<div class="empty">暂无运行记录</div>';
  } else {
    var rhtml = '<table><tr><th>运行 ID</th><th>项目</th><th>操作者</th><th>状态</th><th>开始时间</th><th>提示摘要</th></tr>';
    allRuns.slice(0, 20).forEach(function(r) {
      rhtml += '<tr><td title="' + esc(r.run_id) + '">' + esc((r.run_id || '').substring(0, 8)) +
        '</td><td>' + esc(r.project_alias) +
        '</td><td>' + esc(r.actor_id || '--') +
        '</td><td>' + statusBadge(r.status) +
        '</td><td>' + shortTime(r.started_at) +
        '</td><td title="' + esc(r.prompt_excerpt) + '">' + esc((r.prompt_excerpt || '').substring(0, 50)) +
        '</td></tr>';
    });
    rhtml += '</table>';
    document.getElementById('runs-body').innerHTML = rhtml;
  }
}

function fetchData() {
  fetch('/api/dashboard')
    .then(function(r) { return r.json(); })
    .then(render)
    .catch(function(e) { console.error('Dashboard fetch error:', e); });
}

fetchData();
setInterval(fetchData, 10000);
</script>
</body>
</html>`;
}
