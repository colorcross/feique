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
});
