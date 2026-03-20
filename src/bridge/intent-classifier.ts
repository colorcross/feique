/**
 * AI-powered intent classifier for natural language command matching.
 *
 * Uses Ollama chat completion to classify user messages into bridge
 * commands when regex patterns fail to match. Works across any language.
 *
 * Architecture: regex-first, AI-fallback. The AI call only happens
 * when the regex parser returns { kind: 'prompt' }.
 */

import type { BridgeCommand } from './commands.js';

export interface IntentClassifierConfig {
  enabled: boolean;
  /** Ollama base URL. Default: http://127.0.0.1:11434 */
  ollama_base_url: string;
  /** Model for intent classification. Default: qwen3.5:latest */
  model: string;
  /** Timeout in ms. Default: 5000 */
  timeout_ms: number;
  /** Minimum confidence to accept (0-1). Default: 0.8 */
  min_confidence: number;
}

export const DEFAULT_INTENT_CONFIG: IntentClassifierConfig = {
  enabled: false,
  ollama_base_url: 'http://127.0.0.1:11434',
  model: 'qwen3.5:latest',
  timeout_ms: 5000,
  min_confidence: 0.8,
};

interface ClassificationResult {
  intent: string;
  confidence: number;
  params: Record<string, string>;
}

const INTENT_DEFINITIONS = `You are an intent classifier for a team AI collaboration tool called Feique (飞鹊).
Classify the user message into ONE of these intents. Reply with ONLY a JSON object, no other text.

Intents:
- help: View help
- status: View current status (detail=true for verbose)
- projects: List available projects
- project: Switch to a project (params: alias)
- new: Start a new session
- cancel: Cancel current run
- backend: Switch or view AI backend (params: name=codex|claude, empty=view current)
- team: View team activity / who's doing what
- learn: Save team knowledge (params: value=the content)
- recall: Search team knowledge (params: query=search terms)
- handoff: Hand off current session (params: summary=optional description)
- pickup: Accept a handoff
- review: Submit for review
- approve: Approve a review (params: comment=optional)
- reject: Reject a review (params: reason=optional)
- insights: View team efficiency report
- trust: View or set trust level (params: action=set, level=observe|suggest|execute|autonomous)
- timeline: View project timeline (params: project=optional alias)
- digest: Generate team digest report
- session_adopt: Adopt latest local session
- session_list: List saved sessions
- prompt: Regular message to send to AI (NOT a command)

Rules:
- If the message is a question or task for the AI to work on, classify as "prompt"
- Only classify as a command if the user clearly wants to control the tool itself
- For backend switching, the name must be "codex" or "claude"
- Confidence should be 0.0-1.0 based on how certain you are

Respond with exactly: {"intent":"...","confidence":0.X,"params":{...}}`;

export class IntentClassifier {
  private readonly config: IntentClassifierConfig;

  constructor(config?: Partial<IntentClassifierConfig>) {
    this.config = { ...DEFAULT_INTENT_CONFIG, ...config };
  }

  async classify(message: string): Promise<BridgeCommand | null> {
    if (!this.config.enabled) return null;
    if (!message.trim()) return null;

    try {
      const result = await this.callOllama(message);
      if (!result || result.confidence < this.config.min_confidence) return null;
      if (result.intent === 'prompt') return null;

      return this.mapIntentToCommand(result);
    } catch {
      return null; // AI classification is best-effort
    }
  }

  private async callOllama(message: string): Promise<ClassificationResult | null> {
    const url = `${this.config.ollama_base_url}/api/chat`;
    const body = JSON.stringify({
      model: this.config.model,
      messages: [
        { role: 'system', content: INTENT_DEFINITIONS },
        { role: 'user', content: message },
      ],
      stream: false,
      options: {
        temperature: 0,
        num_predict: 128,
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!response.ok) return null;

      const data = (await response.json()) as { message?: { content?: string } };
      const content = data.message?.content?.trim();
      if (!content) return null;

      // Extract JSON from response (may have markdown fences or extra text)
      const jsonMatch = content.match(/\{[^}]+\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as ClassificationResult;
      if (!parsed.intent || typeof parsed.confidence !== 'number') return null;

      return {
        intent: parsed.intent,
        confidence: parsed.confidence,
        params: parsed.params ?? {},
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private mapIntentToCommand(result: ClassificationResult): BridgeCommand | null {
    const { intent, params } = result;

    switch (intent) {
      case 'help':
        return { kind: 'help' };
      case 'status':
        return { kind: 'status', detail: params.detail === 'true' };
      case 'projects':
        return { kind: 'projects' };
      case 'project':
        return params.alias ? { kind: 'project', alias: params.alias } : null;
      case 'new':
        return { kind: 'new' };
      case 'cancel':
        return { kind: 'cancel' };
      case 'backend':
        return { kind: 'backend', name: params.name || undefined };
      case 'team':
        return { kind: 'team' };
      case 'learn':
        return params.value ? { kind: 'learn', value: params.value } : null;
      case 'recall':
        return params.query ? { kind: 'recall', query: params.query } : null;
      case 'handoff':
        return { kind: 'handoff', summary: params.summary || undefined };
      case 'pickup':
        return { kind: 'pickup' };
      case 'review':
        return { kind: 'review' };
      case 'approve':
        return { kind: 'approve', comment: params.comment || undefined };
      case 'reject':
        return { kind: 'reject', reason: params.reason || undefined };
      case 'insights':
        return { kind: 'insights' };
      case 'trust':
        if (params.action === 'set' && params.level) {
          return { kind: 'trust', action: 'set', level: params.level };
        }
        return { kind: 'trust' };
      case 'timeline':
        return { kind: 'timeline', project: params.project || undefined };
      case 'digest':
        return { kind: 'digest' };
      case 'session_adopt':
        return { kind: 'session', action: 'adopt', target: params.target || 'latest' };
      case 'session_list':
        return { kind: 'session', action: 'list' };
      default:
        return null;
    }
  }
}
