/**
 * Ollama-based embedding provider.
 *
 * Calls Ollama's /api/embed endpoint for high-quality neural embeddings.
 * Default model: qwen3-embedding:8b (MTEB #1 multilingual, 100+ languages).
 * Model is configurable — any Ollama embedding model works as a drop-in.
 */

import type { EmbeddingProvider } from './embeddings.js';

export interface OllamaEmbeddingConfig {
  /** Ollama API base URL. Default: http://127.0.0.1:11434 */
  base_url: string;
  /** Embedding model name. Default: qwen3-embedding:8b */
  model: string;
  /** Request timeout in ms. Default: 30000 */
  timeout_ms: number;
}

const DEFAULT_CONFIG: OllamaEmbeddingConfig = {
  base_url: 'http://127.0.0.1:11434',
  model: 'qwen3-embedding:8b',
  timeout_ms: 30_000,
};

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly config: OllamaEmbeddingConfig;
  private cachedDimension: number | null = null;

  constructor(config?: Partial<OllamaEmbeddingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Returns the embedding dimension. Determined from the first call result
   * since different models have different dimensions.
   * Returns 0 before the first embed() call completes.
   */
  dimension(): number {
    return this.cachedDimension ?? 0;
  }

  async embed(text: string): Promise<number[]> {
    if (!text.trim()) {
      // Return zero vector — dimension may not be known yet
      return this.cachedDimension ? new Array(this.cachedDimension).fill(0) : [];
    }

    const url = `${this.config.base_url}/api/embed`;
    const body = JSON.stringify({
      model: this.config.model,
      input: text,
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

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
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

  /** Check if Ollama is reachable and the model is available. */
  async healthCheck(): Promise<{ ok: boolean; model: string; error?: string }> {
    try {
      const embedding = await this.embed('health check');
      return {
        ok: embedding.length > 0,
        model: this.config.model,
      };
    } catch (error) {
      return {
        ok: false,
        model: this.config.model,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
