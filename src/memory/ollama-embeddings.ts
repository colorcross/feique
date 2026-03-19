/**
 * Ollama-based embedding provider.
 *
 * Calls Ollama's /api/embed endpoint for high-quality neural embeddings.
 * Default model: qwen3-embedding:8b (MTEB #1 multilingual, 100+ languages).
 *
 * Model is configurable and pluggable. When model is "auto" (or the
 * configured model is unavailable), the provider probes the local Ollama
 * instance via GET /api/tags, discovers installed embedding models, and
 * picks the best one based on a ranked preference list.
 */

import type { EmbeddingProvider } from './embeddings.js';

export interface OllamaEmbeddingConfig {
  /** Ollama API base URL. Default: http://127.0.0.1:11434 */
  base_url: string;
  /** Embedding model name. "auto" to auto-detect. Default: auto */
  model: string;
  /** Request timeout in ms. Default: 30000 */
  timeout_ms: number;
}

const DEFAULT_CONFIG: OllamaEmbeddingConfig = {
  base_url: 'http://127.0.0.1:11434',
  model: 'auto',
  timeout_ms: 30_000,
};

/**
 * Ranked preference list for embedding models.
 * Order: quality (MTEB score) × Chinese support × resource efficiency.
 * Each entry is a substring match against the Ollama model name.
 */
const MODEL_PREFERENCE: string[] = [
  'qwen3-embedding',
  'bge-m3',
  'gte-qwen',
  'gte-multilingual',
  'jina-embeddings-v2-base-zh',
  'jina-embeddings',
  'qwen3-embedding:0.6b',
  'nomic-embed',
  'mxbai-embed',
  'snowflake-arctic-embed',
  'bge-large-zh',
  'bge-small-zh',
  'bge-large-en',
  'bge-small-en',
  'all-minilm',
];

/** Patterns that identify an embedding model by name. */
const EMBEDDING_NAME_PATTERNS = [
  /embed/i,
  /^bge-/i,
  /^gte-/i,
  /^jina-embeddings/i,
  /^nomic-embed/i,
  /^snowflake-arctic/i,
  /^all-minilm/i,
];

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    size: number;
    details?: {
      family?: string;
      families?: string[];
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

export interface ModelDiscoveryResult {
  resolved_model: string | null;
  available_models: string[];
  reason: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly config: OllamaEmbeddingConfig;
  private cachedDimension: number | null = null;
  private resolvedModel: string | null = null;
  private modelResolved = false;

  constructor(config?: Partial<OllamaEmbeddingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // If an explicit model is set (not "auto"), use it directly
    if (this.config.model !== 'auto') {
      this.resolvedModel = this.config.model;
    }
  }

  dimension(): number {
    return this.cachedDimension ?? 0;
  }

  /** The model actually in use (null if not yet resolved). */
  activeModel(): string | null {
    return this.resolvedModel;
  }

  async embed(text: string): Promise<number[]> {
    if (!text.trim()) {
      return this.cachedDimension ? new Array(this.cachedDimension).fill(0) : [];
    }

    // Lazy model resolution: discover on first call if needed
    const model = await this.ensureModel();

    const url = `${this.config.base_url}/api/embed`;
    const body = JSON.stringify({ model, input: text });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');

        // If configured model is not found, try auto-discovery
        if (response.status === 404 && !this.isAutoMode() && !this.modelResolved) {
          this.resolvedModel = null;
          this.modelResolved = false;
          return this.embed(text); // retry with auto-discovery
        }

        throw new Error(`Ollama embed failed (${response.status}): ${errorText.slice(0, 200)}`);
      }

      const data = (await response.json()) as OllamaEmbedResponse;

      if (!data.embeddings?.[0] || !Array.isArray(data.embeddings[0])) {
        throw new Error('Ollama returned empty or invalid embeddings');
      }

      const embedding = data.embeddings[0];
      this.cachedDimension = embedding.length;
      return embedding;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Discover embedding models available on the local Ollama instance.
   * Returns a ranked list with the best model first.
   */
  async discoverModels(): Promise<ModelDiscoveryResult> {
    const url = `${this.config.base_url}/api/tags`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          resolved_model: null,
          available_models: [],
          reason: `Ollama API returned ${response.status}`,
        };
      }

      const data = (await response.json()) as OllamaTagsResponse;
      const allModels = data.models?.map((m) => m.name) ?? [];
      const embeddingModels = allModels.filter(isEmbeddingModel);

      if (embeddingModels.length === 0) {
        return {
          resolved_model: null,
          available_models: allModels,
          reason: allModels.length > 0
            ? `Ollama 上有 ${allModels.length} 个模型，但未找到嵌入模型。运行 \`ollama pull qwen3-embedding:8b\` 安装推荐模型。`
            : 'Ollama 上没有任何模型。运行 `ollama pull qwen3-embedding:8b` 安装推荐模型。',
        };
      }

      const best = pickBestModel(embeddingModels);
      return {
        resolved_model: best,
        available_models: embeddingModels,
        reason: `从 ${embeddingModels.length} 个嵌入模型中选择了 ${best}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        resolved_model: null,
        available_models: [],
        reason: `无法连接 Ollama (${this.config.base_url}): ${msg}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Check if Ollama is reachable and the model is available. */
  async healthCheck(): Promise<{ ok: boolean; model: string; error?: string; discovered?: ModelDiscoveryResult }> {
    try {
      const model = await this.ensureModel();
      const embedding = await this.embed('health check');
      return {
        ok: embedding.length > 0,
        model,
      };
    } catch (error) {
      const discovery = await this.discoverModels();
      return {
        ok: false,
        model: this.resolvedModel ?? this.config.model,
        error: error instanceof Error ? error.message : String(error),
        discovered: discovery,
      };
    }
  }

  // ── Private ──

  private isAutoMode(): boolean {
    return this.config.model === 'auto';
  }

  private async ensureModel(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;

    // Auto-discovery
    const discovery = await this.discoverModels();
    if (discovery.resolved_model) {
      this.resolvedModel = discovery.resolved_model;
      this.modelResolved = true;
      return this.resolvedModel;
    }

    throw new Error(
      `Ollama 嵌入模型自动探测失败: ${discovery.reason}`,
    );
  }
}

// ── Model selection helpers ──

function isEmbeddingModel(name: string): boolean {
  const lower = name.toLowerCase();
  return EMBEDDING_NAME_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Pick the best model from available embedding models using the preference list.
 * Falls back to the first available model if none match preferences.
 */
function pickBestModel(models: string[]): string {
  for (const preference of MODEL_PREFERENCE) {
    const match = models.find((m) => m.toLowerCase().includes(preference.toLowerCase()));
    if (match) return match;
  }
  // No preference match — return the first one
  return models[0]!;
}

// Exported for testing
export { isEmbeddingModel, pickBestModel, MODEL_PREFERENCE };
