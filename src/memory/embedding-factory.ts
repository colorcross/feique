/**
 * Factory for creating the configured embedding provider.
 */

import type { EmbeddingProvider } from './embeddings.js';
import { LocalEmbeddingProvider } from './embeddings.js';
import { OllamaEmbeddingProvider } from './ollama-embeddings.js';
import type { BridgeConfig } from '../config/schema.js';

export function createEmbeddingProvider(config: BridgeConfig): EmbeddingProvider {
  const embeddingConfig = config.embedding;

  switch (embeddingConfig.provider) {
    case 'ollama':
      return new OllamaEmbeddingProvider({
        base_url: embeddingConfig.ollama_base_url,
        model: embeddingConfig.ollama_model,
        timeout_ms: embeddingConfig.ollama_timeout_ms,
      });

    case 'local':
    default:
      return new LocalEmbeddingProvider();
  }
}
