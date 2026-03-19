import { describe, expect, it, vi, afterEach } from 'vitest';
import { OllamaEmbeddingProvider, isEmbeddingModel, pickBestModel } from '../src/memory/ollama-embeddings.js';

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

// ── Explicit model tests ──

describe('ollama embedding provider (explicit model)', () => {
  it('calls /api/embed with the configured model', async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3, 0.4];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'qwen3-embedding:8b', embeddings: [fakeEmbedding] }),
    });

    const provider = new OllamaEmbeddingProvider({ model: 'qwen3-embedding:8b' });
    const result = await provider.embed('认证模块的 bug');

    expect(result).toEqual(fakeEmbedding);
    expect(provider.dimension()).toBe(4);
    expect(provider.activeModel()).toBe('qwen3-embedding:8b');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe('qwen3-embedding:8b');
  });

  it('allows swapping the model to bge-m3', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'bge-m3', embeddings: [[0.5, 0.6]] }),
    });

    const provider = new OllamaEmbeddingProvider({ model: 'bge-m3' });
    const result = await provider.embed('test');
    expect(result).toEqual([0.5, 0.6]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe('bge-m3');
  });

  it('returns zero vector for empty text after dimension is known', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'qwen3-embedding:8b', embeddings: [[1, 2, 3]] }),
    });

    const provider = new OllamaEmbeddingProvider({ model: 'qwen3-embedding:8b' });
    await provider.embed('prime');
    const result = await provider.embed('');
    expect(result).toEqual([0, 0, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on empty embeddings response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'x', embeddings: [] }),
    });

    const provider = new OllamaEmbeddingProvider({ model: 'x' });
    await expect(provider.embed('test')).rejects.toThrow('empty or invalid');
  });

  it('falls back to auto-discovery when explicit model returns 404', async () => {
    // First call: 404 for the explicit model
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'model not found',
    });
    // Second call: /api/tags for discovery
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:8b', model: 'llama3:8b', size: 1000, details: { family: 'llama' } },
          { name: 'bge-m3:latest', model: 'bge-m3:latest', size: 500, details: { family: 'bert' } },
        ],
      }),
    });
    // Third call: embed with discovered model
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'bge-m3:latest', embeddings: [[0.1, 0.2]] }),
    });

    const provider = new OllamaEmbeddingProvider({ model: 'nonexistent-model' });
    const result = await provider.embed('test');
    expect(result).toEqual([0.1, 0.2]);
    expect(provider.activeModel()).toBe('bge-m3:latest');
  });
});

// ── Auto-discovery tests ──

describe('ollama auto-discovery (model=auto)', () => {
  it('discovers and picks the best model from Ollama', async () => {
    // /api/tags
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:8b', model: 'llama3:8b', size: 5000 },
          { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 300 },
          { name: 'qwen3-embedding:8b', model: 'qwen3-embedding:8b', size: 4000 },
          { name: 'bge-m3:latest', model: 'bge-m3:latest', size: 600 },
        ],
      }),
    });
    // embed
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'qwen3-embedding:8b', embeddings: [[0.5]] }),
    });

    const provider = new OllamaEmbeddingProvider(); // model defaults to "auto"
    const result = await provider.embed('test');
    expect(result).toEqual([0.5]);
    expect(provider.activeModel()).toBe('qwen3-embedding:8b');
  });

  it('picks bge-m3 when qwen3-embedding is not available', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:8b', model: 'llama3:8b', size: 5000 },
          { name: 'bge-m3:latest', model: 'bge-m3:latest', size: 600 },
          { name: 'all-minilm:latest', model: 'all-minilm:latest', size: 100 },
        ],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'bge-m3:latest', embeddings: [[0.3]] }),
    });

    const provider = new OllamaEmbeddingProvider();
    await provider.embed('test');
    expect(provider.activeModel()).toBe('bge-m3:latest');
  });

  it('throws when Ollama has no embedding models', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:8b', model: 'llama3:8b', size: 5000 },
          { name: 'qwen2:7b', model: 'qwen2:7b', size: 4000 },
        ],
      }),
    });

    const provider = new OllamaEmbeddingProvider();
    await expect(provider.embed('test')).rejects.toThrow('自动探测失败');
  });

  it('throws when Ollama is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const provider = new OllamaEmbeddingProvider();
    await expect(provider.embed('test')).rejects.toThrow('无法连接 Ollama');
  });

  it('discoverModels returns ranked list', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'all-minilm:latest', model: 'all-minilm:latest', size: 100 },
          { name: 'bge-m3:latest', model: 'bge-m3:latest', size: 600 },
          { name: 'qwen3-embedding:0.6b', model: 'qwen3-embedding:0.6b', size: 400 },
        ],
      }),
    });

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.discoverModels();
    expect(result.resolved_model).toBe('qwen3-embedding:0.6b');
    expect(result.available_models).toHaveLength(3);
    expect(result.reason).toContain('3 个嵌入模型');
  });
});

// ── healthCheck tests ──

describe('ollama healthCheck', () => {
  it('returns ok on success with explicit model', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'qwen3-embedding:8b', embeddings: [[0.1]] }),
    });

    const provider = new OllamaEmbeddingProvider({ model: 'qwen3-embedding:8b' });
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.model).toBe('qwen3-embedding:8b');
  });

  it('returns discovery info on failure', async () => {
    // embed fails
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    // discovery also fails
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const provider = new OllamaEmbeddingProvider({ model: 'qwen3-embedding:8b' });
    const health = await provider.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.discovered).toBeDefined();
  });
});

// ── Model classification tests ──

describe('isEmbeddingModel', () => {
  it('recognizes common embedding models', () => {
    expect(isEmbeddingModel('qwen3-embedding:8b')).toBe(true);
    expect(isEmbeddingModel('bge-m3:latest')).toBe(true);
    expect(isEmbeddingModel('bge-large-zh-v1.5:latest')).toBe(true);
    expect(isEmbeddingModel('nomic-embed-text:latest')).toBe(true);
    expect(isEmbeddingModel('mxbai-embed-large:latest')).toBe(true);
    expect(isEmbeddingModel('jina-embeddings-v2-base-zh:latest')).toBe(true);
    expect(isEmbeddingModel('snowflake-arctic-embed:latest')).toBe(true);
    expect(isEmbeddingModel('all-minilm:latest')).toBe(true);
    expect(isEmbeddingModel('gte-multilingual-base:latest')).toBe(true);
  });

  it('rejects non-embedding models', () => {
    expect(isEmbeddingModel('llama3:8b')).toBe(false);
    expect(isEmbeddingModel('qwen2:7b')).toBe(false);
    expect(isEmbeddingModel('mistral:7b')).toBe(false);
    expect(isEmbeddingModel('codellama:13b')).toBe(false);
    expect(isEmbeddingModel('deepseek-coder:6.7b')).toBe(false);
  });
});

describe('pickBestModel', () => {
  it('prefers qwen3-embedding over others', () => {
    expect(pickBestModel(['bge-m3:latest', 'qwen3-embedding:8b', 'all-minilm:latest'])).toBe('qwen3-embedding:8b');
  });

  it('prefers bge-m3 when no qwen3', () => {
    expect(pickBestModel(['all-minilm:latest', 'bge-m3:latest', 'nomic-embed-text:latest'])).toBe('bge-m3:latest');
  });

  it('falls back to first model when no preference matches', () => {
    expect(pickBestModel(['custom-embed:latest'])).toBe('custom-embed:latest');
  });
});
