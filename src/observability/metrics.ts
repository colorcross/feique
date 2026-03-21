export interface MetricsSink {
  incrementCounter(name: string, labels?: Record<string, string>, value?: number): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
}

export interface ReadinessMetricSnapshot {
  ok: boolean;
  ready: boolean;
  startupWarnings: number;
  startupErrors: number;
}

interface CounterMetric {
  type: 'counter';
  name: string;
  help: string;
}

interface SummaryMetric {
  type: 'summary';
  name: string;
  help: string;
}

interface GaugeMetric {
  type: 'gauge';
  name: string;
  help: string;
}

interface HistogramMetric {
  type: 'histogram';
  name: string;
  help: string;
  buckets: number[];
}

const COUNTER_DEFS: CounterMetric[] = [
  { name: 'feique_incoming_messages_total', help: 'Incoming Feishu messages received by the bridge.', type: 'counter' },
  { name: 'feique_duplicate_events_total', help: 'Duplicate inbound events ignored by the bridge.', type: 'counter' },
  { name: 'feique_card_actions_total', help: 'Interactive card actions handled by the bridge.', type: 'counter' },
  { name: 'feique_codex_turns_total', help: 'Codex runs executed by the bridge.', type: 'counter' },
  { name: 'feique_outbound_messages_total', help: 'Outbound Feishu messages sent by the bridge.', type: 'counter' },
  { name: 'feique_cancellations_total', help: 'Codex runs cancelled by users or recovery logic.', type: 'counter' },
  { name: 'feique_cost_total_usd', help: 'Cumulative estimated cost in USD.', type: 'counter' },
  { name: 'feique_tokens_total', help: 'Cumulative token usage.', type: 'counter' },
  { name: 'feique_collaboration_events_total', help: 'Collaboration events by type.', type: 'counter' },
];

const SUMMARY_DEFS: SummaryMetric[] = [
  { name: 'feique_codex_turn_duration_seconds', help: 'Duration of Codex runs in seconds.', type: 'summary' },
];

const GAUGE_DEFS: GaugeMetric[] = [
  { name: 'feique_active_codex_runs', help: 'Number of Codex runs currently in progress.', type: 'gauge' },
  { name: 'feique_service_live', help: 'Whether the bridge process is considered live.', type: 'gauge' },
  { name: 'feique_service_ready', help: 'Whether the bridge process is ready to accept traffic.', type: 'gauge' },
  { name: 'feique_startup_warnings', help: 'Number of startup doctor warnings recorded for the running process.', type: 'gauge' },
  { name: 'feique_startup_errors', help: 'Number of startup doctor errors recorded for the running process.', type: 'gauge' },
  { name: 'feique_last_incoming_message_timestamp_seconds', help: 'Unix timestamp of the last incoming Feishu message.', type: 'gauge' },
  { name: 'feique_last_card_action_timestamp_seconds', help: 'Unix timestamp of the last Feishu card action.', type: 'gauge' },
  { name: 'feique_last_codex_success_timestamp_seconds', help: 'Unix timestamp of the last successful Codex run.', type: 'gauge' },
  { name: 'feique_last_codex_failure_timestamp_seconds', help: 'Unix timestamp of the last failed Codex run.', type: 'gauge' },
  { name: 'feique_last_outbound_message_timestamp_seconds', help: 'Unix timestamp of the last successful outbound Feishu message.', type: 'gauge' },
  { name: 'feique_last_outbound_failure_timestamp_seconds', help: 'Unix timestamp of the last failed outbound Feishu message.', type: 'gauge' },
  { name: 'feique_last_run_timestamp_seconds', help: 'Unix timestamp of the latest known run transition.', type: 'gauge' },
  { name: 'feique_queue_depth', help: 'Current queue depth per project.', type: 'gauge' },
  { name: 'feique_trust_level', help: 'Numeric trust level per project (observe=0, suggest=1, execute=2, autonomous=3).', type: 'gauge' },
];

const HISTOGRAM_DEFS: HistogramMetric[] = [
  {
    name: 'feique_codex_turn_duration_seconds',
    help: 'Duration of Codex runs in seconds.',
    type: 'histogram',
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800],
  },
];

const TRUST_LEVEL_NUMERIC: Record<string, number> = {
  observe: 0,
  suggest: 1,
  execute: 2,
  autonomous: 3,
};

export type CollaborationEventType = 'handoff' | 'pickup' | 'review' | 'approve' | 'reject' | 'learn' | 'recall' | 'digest';

export class MetricsRegistry implements MetricsSink {
  private readonly counters = new Map<string, number>();
  private readonly summaries = new Map<string, { count: number; sum: number }>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, { count: number; sum: number; bucketCounts: Map<number, number> }>();
  private readonly startedAtSeconds = Math.floor(Date.now() / 1000);

  public incrementCounter(name: string, labels: Record<string, string> = {}, value: number = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  public setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    this.gauges.set(key, value);
  }

  public incrementGauge(name: string, labels: Record<string, string> = {}, value: number = 1): void {
    const key = metricKey(name, labels);
    this.gauges.set(key, (this.gauges.get(key) ?? 0) + value);
  }

  public observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    const current = this.summaries.get(key) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += value;
    this.summaries.set(key, current);
  }

  public observeHistogram(name: string, value: number, buckets: number[], labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    const current = this.histograms.get(key) ?? { count: 0, sum: 0, bucketCounts: new Map<number, number>() };
    current.count += 1;
    current.sum += value;
    for (const bound of buckets) {
      if (value <= bound) {
        current.bucketCounts.set(bound, (current.bucketCounts.get(bound) ?? 0) + 1);
      }
    }
    this.histograms.set(key, current);
  }

  public recordIncomingMessage(chatType: string, command: string): void {
    this.incrementCounter('feique_incoming_messages_total', { chat_type: chatType, command });
    this.setGauge('feique_last_incoming_message_timestamp_seconds', nowInSeconds());
  }

  public recordDuplicateEvent(kind: 'message' | 'card'): void {
    this.incrementCounter('feique_duplicate_events_total', { kind });
  }

  public recordCardAction(action: string): void {
    this.incrementCounter('feique_card_actions_total', { action });
    this.setGauge('feique_last_card_action_timestamp_seconds', nowInSeconds(), { action });
  }

  public recordCodexTurnStarted(projectAlias: string, runId?: string): void {
    this.incrementGauge('feique_active_codex_runs', { project: projectAlias }, 1);
    this.setGauge('feique_last_run_timestamp_seconds', nowInSeconds(), buildRunLabels(projectAlias, runId, 'running'));
  }

  public recordCodexTurn(status: 'success' | 'failure' | 'cancelled', projectAlias: string, durationSeconds: number, runId?: string): void {
    this.incrementCounter('feique_codex_turns_total', { status, project: projectAlias });
    this.observe('feique_codex_turn_duration_seconds', durationSeconds, { status, project: projectAlias });
    this.observeHistogram(
      'feique_codex_turn_duration_seconds',
      durationSeconds,
      HISTOGRAM_DEFS[0]!.buckets,
      { status, project: projectAlias },
    );
    this.incrementGauge('feique_active_codex_runs', { project: projectAlias }, -1);
    const timestampMetric =
      status === 'success'
        ? 'feique_last_codex_success_timestamp_seconds'
        : 'feique_last_codex_failure_timestamp_seconds';
    this.setGauge(timestampMetric, nowInSeconds(), { project: projectAlias });
    this.setGauge('feique_last_run_timestamp_seconds', nowInSeconds(), buildRunLabels(projectAlias, runId, status));
    if (status === 'cancelled') {
      this.incrementCounter('feique_cancellations_total', { project: projectAlias });
    }
  }

  public recordOutboundMessage(msgType: string, status: 'success' | 'failure'): void {
    this.incrementCounter('feique_outbound_messages_total', { msg_type: msgType, status });
    const timestampMetric =
      status === 'success'
        ? 'feique_last_outbound_message_timestamp_seconds'
        : 'feique_last_outbound_failure_timestamp_seconds';
    this.setGauge(timestampMetric, nowInSeconds(), { msg_type: msgType });
  }

  public recordQueueDepth(project: string, depth: number): void {
    this.setGauge('feique_queue_depth', depth, { project });
  }

  public recordCost(project: string, backend: string, costUsd: number): void {
    this.incrementCounter('feique_cost_total_usd', { project, backend }, costUsd);
  }

  public recordTokens(project: string, backend: string, inputTokens: number, outputTokens: number): void {
    if (inputTokens > 0) {
      this.incrementCounter('feique_tokens_total', { project, backend, direction: 'input' }, inputTokens);
    }
    if (outputTokens > 0) {
      this.incrementCounter('feique_tokens_total', { project, backend, direction: 'output' }, outputTokens);
    }
  }

  public recordCollaborationEvent(type: CollaborationEventType): void {
    this.incrementCounter('feique_collaboration_events_total', { type });
  }

  public recordTrustLevel(project: string, level: string): void {
    const numeric = TRUST_LEVEL_NUMERIC[level] ?? 0;
    this.setGauge('feique_trust_level', numeric, { project });
  }

  public recordReadiness(snapshot: ReadinessMetricSnapshot): void {
    this.setGauge('feique_service_live', snapshot.ok ? 1 : 0);
    this.setGauge('feique_service_ready', snapshot.ready ? 1 : 0);
    this.setGauge('feique_startup_warnings', snapshot.startupWarnings);
    this.setGauge('feique_startup_errors', snapshot.startupErrors);
  }

  public renderPrometheus(): string {
    const lines: string[] = [];

    for (const definition of COUNTER_DEFS) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} counter`);
      for (const [key, value] of this.counters.entries()) {
        if (!key.startsWith(`${definition.name}{`) && key !== definition.name) {
          continue;
        }
        lines.push(`${key} ${value}`);
      }
    }

    for (const definition of SUMMARY_DEFS) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} summary`);
      for (const [key, value] of this.summaries.entries()) {
        if (!key.startsWith(`${definition.name}{`) && key !== definition.name) {
          continue;
        }
        lines.push(`${key}_count ${value.count}`);
        lines.push(`${key}_sum ${value.sum}`);
      }
    }

    for (const definition of GAUGE_DEFS) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} gauge`);
      for (const [key, value] of this.gauges.entries()) {
        if (!key.startsWith(`${definition.name}{`) && key !== definition.name) {
          continue;
        }
        lines.push(`${key} ${value}`);
      }
    }

    for (const definition of HISTOGRAM_DEFS) {
      const relatedKeys = [...this.histograms.entries()].filter(
        ([key]) => key.startsWith(`${definition.name}{`) || key === definition.name,
      );
      if (relatedKeys.length > 0) {
        lines.push(`# HELP ${definition.name}_bucket ${definition.help}`);
        lines.push(`# TYPE ${definition.name}_bucket histogram`);
        for (const [key, value] of relatedKeys) {
          const labelsMatch = key.match(/\{(.+)\}$/);
          const existingLabels = labelsMatch ? labelsMatch[1] : '';
          for (const bound of definition.buckets) {
            const bucketCount = value.bucketCounts.get(bound) ?? 0;
            const leLabel = `le="${bound}"`;
            const allLabels = existingLabels ? `${existingLabels},${leLabel}` : leLabel;
            lines.push(`${definition.name}_bucket{${allLabels}} ${bucketCount}`);
          }
          const infLabel = `le="+Inf"`;
          const allInfLabels = existingLabels ? `${existingLabels},${infLabel}` : infLabel;
          lines.push(`${definition.name}_bucket{${allInfLabels}} ${value.count}`);
          lines.push(`${key}_count ${value.count}`);
          lines.push(`${key}_sum ${value.sum}`);
        }
      }
    }

    lines.push('# HELP feique_service_start_time_seconds Unix time when the bridge process started.');
    lines.push('# TYPE feique_service_start_time_seconds gauge');
    lines.push(`feique_service_start_time_seconds ${this.startedAtSeconds}`);

    return `${lines.join('\n')}\n`;
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== undefined && value !== '');
  if (entries.length === 0) {
    return name;
  }
  const serialized = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',');
  return `${name}{${serialized}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function buildRunLabels(projectAlias: string, runId: string | undefined, status: string): Record<string, string> {
  return {
    project: projectAlias,
    status,
    ...(runId ? { run_id: runId } : {}),
  };
}
