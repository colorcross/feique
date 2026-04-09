/**
 * AI-powered intent classifier for natural language command matching.
 *
 * Priority chain:
 * 1. Configured backend (Claude -p / Codex exec) — always available
 * 2. Ollama chat model — if available (fallback)
 *
 * Architecture: regex-first, AI-fallback. The AI call only happens
 * when the regex parser returns { kind: 'prompt' }.
 */

import { spawn } from 'node:child_process';
import type { BridgeCommand } from './commands.js';

export interface IntentClassifierConfig {
  enabled: boolean;
  /**
   * Which backend to use. Known shapes: 'claude', 'codex'. Unknown
   * backends (e.g. 'qwen') currently fall through to the codex-shaped
   * spawn args; per-backend classifier branches can be added when
   * needed.
   */
  backend: string;
  /** Backend CLI binary path. */
  backend_bin: string;
  /** Shell for pre_exec. */
  shell?: string;
  /** Pre-exec command (e.g. proxy_on). */
  pre_exec?: string;
  /** Ollama base URL — fallback if backend fails. */
  ollama_base_url?: string;
  /** Timeout in ms. Default: 8000 */
  timeout_ms: number;
  /** Minimum confidence to accept (0-1). Default: 0.8 */
  min_confidence: number;
}

interface ClassificationResult {
  intent: string;
  confidence: number;
  params: Record<string, string>;
}

const CLASSIFY_PROMPT = `You are an intent classifier. Classify this message into a command for the Feique (飞鹊) team collaboration tool.

Intents:
- help: View help
- status: View current status
- projects: List projects
- project: Switch project (params: alias)
- new: New session
- cancel: Cancel run
- backend: Switch AI backend (params: name=codex|claude) or view current (no params)
- team: View team activity
- learn: Save knowledge (params: value=content)
- recall: Search knowledge (params: query=terms)
- handoff: Hand off session (params: summary=optional)
- pickup: Accept handoff
- review: Submit for review
- approve: Approve (params: comment=optional)
- reject: Reject (params: reason=optional)
- insights: Efficiency report
- trust: View/set trust (params: action=set, level=observe|suggest|execute|autonomous)
- timeline: Project timeline (params: project=optional)
- digest: Team digest
- session_adopt: Adopt latest session
- session_list: List sessions
- prompt: Regular AI task (NOT a tool command)

Reply ONLY with JSON: {"intent":"...","confidence":0.X,"params":{}}
If it's a regular task/question for AI, use {"intent":"prompt","confidence":1.0,"params":{}}

Message: `;

export class IntentClassifier {
  private readonly config: IntentClassifierConfig;
  private ollamaChatModel: string | null | undefined = undefined; // undefined = not probed yet

  constructor(config: IntentClassifierConfig) {
    this.config = config;
  }

  async classify(message: string): Promise<BridgeCommand | null> {
    if (!this.config.enabled) return null;
    if (!message.trim()) return null;

    // Try configured backend first (always available)
    try {
      const result = await this.classifyWithBackend(message);
      if (result && result.intent !== 'prompt' && result.confidence >= this.config.min_confidence) {
        return this.mapIntentToCommand(result);
      }
      if (result) return null; // Got a response but it's 'prompt' or low confidence
    } catch { /* backend failed, try Ollama */ }

    // Fallback: Ollama chat model
    if (this.config.ollama_base_url) {
      try {
        const result = await this.classifyWithOllama(message);
        if (result && result.intent !== 'prompt' && result.confidence >= this.config.min_confidence) {
          return this.mapIntentToCommand(result);
        }
      } catch { /* Ollama also failed */ }
    }

    return null;
  }

  // ── Backend classification (Claude -p / Codex exec) ──

  private classifyWithBackend(message: string): Promise<ClassificationResult | null> {
    const prompt = CLASSIFY_PROMPT + message;

    if (this.config.backend === 'claude') {
      return this.classifyWithClaude(prompt);
    }
    return this.classifyWithCodex(prompt);
  }

  private classifyWithClaude(prompt: string): Promise<ClassificationResult | null> {
    const args = ['-p', '--output-format', 'text', prompt];
    return this.spawnAndParse(this.config.backend_bin, args);
  }

  private classifyWithCodex(prompt: string): Promise<ClassificationResult | null> {
    const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', prompt];
    return this.spawnAndParse(this.config.backend_bin, args);
  }

  private spawnAndParse(bin: string, args: string[]): Promise<ClassificationResult | null> {
    return new Promise((resolve) => {
      let spawnCmd: string;
      let spawnArgs: string[];

      if (this.config.pre_exec) {
        const shell = this.config.shell ?? process.env.SHELL ?? '/bin/zsh';
        const quoted = args.map((a) => `'${a.replace(/'/g, `'"'"'`)}'`).join(' ');
        spawnCmd = shell;
        spawnArgs = ['-ic', `${this.config.pre_exec} && ${bin} ${quoted}`];
      } else {
        spawnCmd = bin;
        spawnArgs = args;
      }

      const proc = spawn(spawnCmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, NO_COLOR: '1' },
        cwd: '/tmp',
      });

      let stdout = '';
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve(null);
      }, this.config.timeout_ms);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      proc.on('close', () => {
        clearTimeout(timer);
        resolve(this.parseJsonFromOutput(stdout));
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  // ── Ollama fallback ──

  private async classifyWithOllama(message: string): Promise<ClassificationResult | null> {
    const model = await this.resolveOllamaChatModel();
    if (!model) return null;

    const url = `${this.config.ollama_base_url}/api/chat`;
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'user', content: CLASSIFY_PROMPT + message },
      ],
      stream: false,
      options: { temperature: 0, num_predict: 128 },
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
      return this.parseJsonFromOutput(data.message?.content ?? '');
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveOllamaChatModel(): Promise<string | null> {
    if (this.ollamaChatModel !== undefined) return this.ollamaChatModel;

    try {
      const url = `${this.config.ollama_base_url}/api/tags`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);

      try {
        const resp = await fetch(url, { method: 'GET', signal: controller.signal });
        if (!resp.ok) { this.ollamaChatModel = null; return null; }

        const data = (await resp.json()) as { models: Array<{ name: string }> };
        const all = data.models?.map((m) => m.name) ?? [];
        const chat = all.filter((n) => !/embed|bge-|gte-|nomic-embed|all-minilm|snowflake|jina-embed|mxbai-embed/i.test(n));

        const prefs = ['qwen3.5', 'qwen3', 'qwen2.5', 'llama3', 'llama4', 'mistral', 'gemma', 'phi', 'deepseek'];
        for (const p of prefs) {
          const m = chat.find((n) => n.toLowerCase().includes(p));
          if (m) { this.ollamaChatModel = m; return m; }
        }
        this.ollamaChatModel = chat[0] ?? null;
        return this.ollamaChatModel;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      this.ollamaChatModel = null;
      return null;
    }
  }

  // ── Parsing ──

  private parseJsonFromOutput(output: string): ClassificationResult | null {
    const jsonMatch = output.match(/\{[^{}]*"intent"[^{}]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]) as ClassificationResult;
      if (!parsed.intent || typeof parsed.confidence !== 'number') return null;
      return { intent: parsed.intent, confidence: parsed.confidence, params: parsed.params ?? {} };
    } catch {
      return null;
    }
  }

  private mapIntentToCommand(result: ClassificationResult): BridgeCommand | null {
    const { intent, params } = result;

    switch (intent) {
      case 'help': return { kind: 'help' };
      case 'status': return { kind: 'status', detail: params.detail === 'true' };
      case 'projects': return { kind: 'projects' };
      case 'project': return params.alias ? { kind: 'project', alias: params.alias } : null;
      case 'new': return { kind: 'new' };
      case 'cancel': return { kind: 'cancel' };
      case 'backend': return { kind: 'backend', name: params.name || undefined };
      case 'team': return { kind: 'team' };
      case 'learn': return params.value ? { kind: 'learn', value: params.value } : null;
      case 'recall': return params.query ? { kind: 'recall', query: params.query } : null;
      case 'handoff': return { kind: 'handoff', summary: params.summary || undefined };
      case 'pickup': return { kind: 'pickup' };
      case 'review': return { kind: 'review' };
      case 'approve': return { kind: 'approve', comment: params.comment || undefined };
      case 'reject': return { kind: 'reject', reason: params.reason || undefined };
      case 'insights': return { kind: 'insights' };
      case 'trust':
        if (params.action === 'set' && params.level) return { kind: 'trust', action: 'set', level: params.level };
        return { kind: 'trust' };
      case 'timeline': return { kind: 'timeline', project: params.project || undefined };
      case 'digest': return { kind: 'digest' };
      case 'session_adopt': return { kind: 'session', action: 'adopt', target: params.target || 'latest' };
      case 'session_list': return { kind: 'session', action: 'list' };
      default: return null;
    }
  }
}
