import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/observability/metrics.js';

describe('metrics registry', () => {
  it('renders prometheus counters, summaries, and duplicate/cancel metrics', () => {
    const metrics = new MetricsRegistry();
    metrics.recordIncomingMessage('p2p', 'prompt');
    metrics.recordDuplicateEvent('message');
    metrics.recordCardAction('status');
    metrics.recordOutboundMessage('text', 'success');
    metrics.recordCodexTurnStarted('repo-a', 'run-1');
    metrics.recordCodexTurn('cancelled', 'repo-a', 1.25, 'run-1');

    const output = metrics.renderPrometheus();
    expect(output).toContain('feique_incoming_messages_total{chat_type="p2p",command="prompt"} 1');
    expect(output).toContain('feique_duplicate_events_total{kind="message"} 1');
    expect(output).toContain('feique_card_actions_total{action="status"} 1');
    expect(output).toContain('feique_outbound_messages_total{msg_type="text",status="success"} 1');
    expect(output).toContain('feique_codex_turn_duration_seconds{project="repo-a",status="cancelled"}_count 1');
    expect(output).toContain('feique_codex_turns_total{project="repo-a",status="cancelled"} 1');
    expect(output).toContain('feique_active_codex_runs{project="repo-a"} 0');
    expect(output).toContain('feique_cancellations_total{project="repo-a"} 1');
    expect(output).toContain('feique_last_run_timestamp_seconds{project="repo-a",run_id="run-1",status="cancelled"}');
    expect(output).toContain('feique_service_start_time_seconds');
  });

  it('renders histogram buckets for codex turn duration', () => {
    const metrics = new MetricsRegistry();
    metrics.recordCodexTurnStarted('proj-x', 'run-h1');
    metrics.recordCodexTurn('success', 'proj-x', 7.5, 'run-h1');

    const output = metrics.renderPrometheus();
    // 7.5s falls in le=10, le=30, le=60, le=120, le=300, le=600, le=1800 but NOT le=1, le=5
    expect(output).toContain('feique_codex_turn_duration_seconds_bucket{project="proj-x",status="success",le="1"} 0');
    expect(output).toContain('feique_codex_turn_duration_seconds_bucket{project="proj-x",status="success",le="5"} 0');
    expect(output).toContain('feique_codex_turn_duration_seconds_bucket{project="proj-x",status="success",le="10"} 1');
    expect(output).toContain('feique_codex_turn_duration_seconds_bucket{project="proj-x",status="success",le="30"} 1');
    expect(output).toContain('feique_codex_turn_duration_seconds_bucket{project="proj-x",status="success",le="+Inf"} 1');
    expect(output).toContain('feique_codex_turn_duration_seconds{project="proj-x",status="success"}_count 1');
    expect(output).toContain('feique_codex_turn_duration_seconds{project="proj-x",status="success"}_sum 7.5');
  });

  it('renders queue depth gauge', () => {
    const metrics = new MetricsRegistry();
    metrics.recordQueueDepth('my-proj', 3);

    const output = metrics.renderPrometheus();
    expect(output).toContain('feique_queue_depth{project="my-proj"} 3');
  });

  it('renders cost and token counters', () => {
    const metrics = new MetricsRegistry();
    metrics.recordCost('proj-a', 'codex', 0.05);
    metrics.recordCost('proj-a', 'codex', 0.03);
    metrics.recordTokens('proj-a', 'codex', 1000, 500);
    metrics.recordTokens('proj-a', 'claude', 200, 100);

    const output = metrics.renderPrometheus();
    expect(output).toContain('feique_cost_total_usd{backend="codex",project="proj-a"} 0.08');
    expect(output).toContain('feique_tokens_total{backend="codex",direction="input",project="proj-a"} 1000');
    expect(output).toContain('feique_tokens_total{backend="codex",direction="output",project="proj-a"} 500');
    expect(output).toContain('feique_tokens_total{backend="claude",direction="input",project="proj-a"} 200');
    expect(output).toContain('feique_tokens_total{backend="claude",direction="output",project="proj-a"} 100');
  });

  it('renders collaboration event counters', () => {
    const metrics = new MetricsRegistry();
    metrics.recordCollaborationEvent('handoff');
    metrics.recordCollaborationEvent('handoff');
    metrics.recordCollaborationEvent('pickup');
    metrics.recordCollaborationEvent('learn');
    metrics.recordCollaborationEvent('recall');
    metrics.recordCollaborationEvent('review');
    metrics.recordCollaborationEvent('approve');
    metrics.recordCollaborationEvent('reject');
    metrics.recordCollaborationEvent('digest');

    const output = metrics.renderPrometheus();
    expect(output).toContain('feique_collaboration_events_total{type="handoff"} 2');
    expect(output).toContain('feique_collaboration_events_total{type="pickup"} 1');
    expect(output).toContain('feique_collaboration_events_total{type="learn"} 1');
    expect(output).toContain('feique_collaboration_events_total{type="recall"} 1');
    expect(output).toContain('feique_collaboration_events_total{type="review"} 1');
    expect(output).toContain('feique_collaboration_events_total{type="approve"} 1');
    expect(output).toContain('feique_collaboration_events_total{type="reject"} 1');
    expect(output).toContain('feique_collaboration_events_total{type="digest"} 1');
  });

  it('renders trust level gauge', () => {
    const metrics = new MetricsRegistry();
    metrics.recordTrustLevel('proj-a', 'observe');
    metrics.recordTrustLevel('proj-b', 'execute');
    metrics.recordTrustLevel('proj-c', 'autonomous');

    const output = metrics.renderPrometheus();
    expect(output).toContain('feique_trust_level{project="proj-a"} 0');
    expect(output).toContain('feique_trust_level{project="proj-b"} 2');
    expect(output).toContain('feique_trust_level{project="proj-c"} 3');
  });

  it('updates trust level gauge on level change', () => {
    const metrics = new MetricsRegistry();
    metrics.recordTrustLevel('proj-a', 'observe');
    metrics.recordTrustLevel('proj-a', 'suggest');

    const output = metrics.renderPrometheus();
    expect(output).toContain('feique_trust_level{project="proj-a"} 1');
    expect(output).not.toContain('feique_trust_level{project="proj-a"} 0');
  });

  it('skips zero-token directions in recordTokens', () => {
    const metrics = new MetricsRegistry();
    metrics.recordTokens('proj-a', 'codex', 0, 500);

    const output = metrics.renderPrometheus();
    expect(output).not.toContain('direction="input"');
    expect(output).toContain('feique_tokens_total{backend="codex",direction="output",project="proj-a"} 500');
  });
});
