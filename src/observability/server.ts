import http from 'node:http';
import type { Logger } from '../logging.js';
import { MetricsRegistry } from './metrics.js';
import type { ServiceReadinessProbe } from './readiness.js';
import type { RunStateStore } from '../state/run-state-store.js';
import type { TrustStore } from '../state/trust-store.js';
import type { HandoffStore } from '../state/handoff-store.js';
import type { AuditLog } from '../state/audit-log.js';
import { renderDashboardHtml } from './dashboard-html.js';

export interface DashboardData {
  service: {
    name: string;
    stage: string;
    ready: boolean;
    startupWarnings: number;
    startupErrors: number;
  };
  team: {
    active_members: number;
    active_runs: Array<{
      run_id: string;
      project_alias: string;
      actor_id?: string;
      status: string;
      started_at: string;
      prompt_excerpt: string;
    }>;
    queued_runs: Array<{
      run_id: string;
      project_alias: string;
      actor_id?: string;
      status: string;
      started_at: string;
      prompt_excerpt: string;
    }>;
  };
  projects: Array<{
    alias: string;
    total_runs: number;
    success_rate: number;
    active_runs: number;
    trust_level: string;
  }>;
  cost: {
    total_runs_24h: number;
    by_project: Record<string, { runs: number; success: number }>;
  };
  handoffs: { pending: number; completed_24h: number };
  reviews: { pending: number; completed_24h: number };
  _recent_runs: Array<{
    run_id: string;
    project_alias: string;
    actor_id?: string;
    status: string;
    started_at: string;
    prompt_excerpt: string;
  }>;
  timestamp: string;
}

async function collectDashboardData(input: {
  serviceName: string;
  readiness?: ServiceReadinessProbe;
  runStateStore?: RunStateStore;
  trustStore?: TrustStore;
  handoffStore?: HandoffStore;
}): Promise<DashboardData> {
  const readiness = input.readiness?.snapshot() ?? {
    ok: true,
    ready: true,
    service: input.serviceName,
    stage: 'ready',
    startupWarnings: 0,
    startupErrors: 0,
    timestamp: new Date().toISOString(),
  };

  const allRuns = input.runStateStore ? await input.runStateStore.listRuns() : [];
  const trustStates = input.trustStore ? await input.trustStore.listAll() : [];
  const handoffs = input.handoffStore ? await input.handoffStore.listHandoffs(100) : [];
  const reviews = input.handoffStore ? await input.handoffStore.listReviews(100) : [];

  const activeRuns = allRuns.filter((r) => r.status === 'running' || r.status === 'orphaned');
  const queuedRuns = allRuns.filter((r) => r.status === 'queued');

  // Unique active actors
  const activeActors = new Set(
    [...activeRuns, ...queuedRuns].map((r) => r.actor_id).filter(Boolean),
  );

  // 24h window
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const runs24h = allRuns.filter((r) => r.started_at >= cutoff24h);

  // Per-project stats
  const projectMap = new Map<string, { total: number; successes: number; active: number }>();
  for (const run of allRuns) {
    const entry = projectMap.get(run.project_alias) ?? { total: 0, successes: 0, active: 0 };
    entry.total++;
    if (run.status === 'success') entry.successes++;
    if (run.status === 'running' || run.status === 'queued' || run.status === 'orphaned') entry.active++;
    projectMap.set(run.project_alias, entry);
  }

  const trustMap = new Map(trustStates.map((t) => [t.project_alias, t.current_level]));

  const projects = Array.from(projectMap.entries()).map(([alias, stats]) => ({
    alias,
    total_runs: stats.total,
    success_rate: stats.total > 0 ? stats.successes / stats.total : 0,
    active_runs: stats.active,
    trust_level: trustMap.get(alias) ?? 'execute',
  }));

  // Cost by project (24h)
  const byProject: Record<string, { runs: number; success: number }> = {};
  for (const run of runs24h) {
    const entry = byProject[run.project_alias] ?? { runs: 0, success: 0 };
    entry.runs++;
    if (run.status === 'success') entry.success++;
    byProject[run.project_alias] = entry;
  }

  // Handoff/review stats
  const pendingHandoffs = handoffs.filter((h) => h.status === 'pending').length;
  const completedHandoffs24h = handoffs.filter(
    (h) => h.status === 'accepted' && h.accepted_at && h.accepted_at >= cutoff24h,
  ).length;
  const pendingReviews = reviews.filter((r) => r.status === 'pending').length;
  const completedReviews24h = reviews.filter(
    (r) => (r.status === 'approved' || r.status === 'rejected') && r.resolved_at && r.resolved_at >= cutoff24h,
  ).length;

  const mapRun = (r: (typeof allRuns)[number]) => ({
    run_id: r.run_id,
    project_alias: r.project_alias,
    actor_id: r.actor_id,
    status: r.status,
    started_at: r.started_at,
    prompt_excerpt: r.prompt_excerpt,
  });

  return {
    service: {
      name: readiness.service,
      stage: readiness.stage,
      ready: readiness.ready,
      startupWarnings: readiness.startupWarnings,
      startupErrors: readiness.startupErrors,
    },
    team: {
      active_members: activeActors.size,
      active_runs: activeRuns.map(mapRun),
      queued_runs: queuedRuns.map(mapRun),
    },
    projects,
    cost: {
      total_runs_24h: runs24h.length,
      by_project: byProject,
    },
    handoffs: { pending: pendingHandoffs, completed_24h: completedHandoffs24h },
    reviews: { pending: pendingReviews, completed_24h: completedReviews24h },
    _recent_runs: allRuns.slice(0, 20).map(mapRun),
    timestamp: new Date().toISOString(),
  };
}

export async function startMetricsServer(input: {
  host: string;
  port: number;
  serviceName: string;
  logger: Logger;
  metrics: MetricsRegistry;
  readiness?: ServiceReadinessProbe;
  runStateStore?: RunStateStore;
  trustStore?: TrustStore;
  handoffStore?: HandoffStore;
  auditLog?: AuditLog;
}): Promise<{
  address: {
    host: string;
    port: number;
  };
  close(): Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    if (!request.url) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }

    if (request.url === '/metrics') {
      if (input.readiness) {
        input.metrics.recordReadiness(input.readiness.snapshot());
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      response.end(input.metrics.renderPrometheus());
      return;
    }

    if (request.url === '/healthz' || request.url === '/readyz') {
      const readiness = input.readiness?.snapshot() ?? {
        ok: true,
        ready: true,
        service: input.serviceName,
        stage: 'ready',
        startupWarnings: 0,
        startupErrors: 0,
        timestamp: new Date().toISOString(),
      };
      response.statusCode = request.url === '/readyz' ? (readiness.ready ? 200 : 503) : (readiness.ok ? 200 : 503);
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(
        JSON.stringify({
          ...readiness,
          surface: 'metrics',
        }),
      );
      return;
    }

    if (request.url === '/api/dashboard') {
      collectDashboardData({
        serviceName: input.serviceName,
        readiness: input.readiness,
        runStateStore: input.runStateStore,
        trustStore: input.trustStore,
        handoffStore: input.handoffStore,
      }).then((data) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(data));
      }).catch((error) => {
        input.logger.error({ error }, 'Dashboard data collection failed');
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Internal server error' }));
      });
      return;
    }

    if (request.url === '/dashboard') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderDashboardHtml());
      return;
    }

    response.statusCode = 404;
    response.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, input.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : input.port;
      input.logger.info({ host: input.host, port }, 'Metrics server started');
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : input.port;

  return {
    address: {
      host: input.host,
      port: resolvedPort,
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      input.logger.info({ host: input.host, port: input.port }, 'Metrics server stopped');
    },
  };
}
