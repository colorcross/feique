import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OllamaEmbeddingProvider } from '../src/memory/ollama-embeddings.js';

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe('ollama embedding provider', () => {
  it('calls Ollama /api/embed with the configured model', async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3, 0.4];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'qwen3-embedding:8b', embeddings: [fakeEmbedding] }),
    });

    const provider = new OllamaEmbeddingProvider({
      base_url: 'http://localhost:11434',
      model: 'qwen3-embedding:8b',
      timeout_ms: 5000,
    });

    const result = await provider.embed('认证模块的 bug');
    expect(result).toEqual(fakeEmbedding);
    expect(provider.dimension()).toBe(4);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/embed');
    expect(JSON.parse(options.body)).toEqual({
      model: 'qwen3-embedding:8b',
      input: '认证模块的 bug',
    });
  });

  it('uses default config when none provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'qwen3-embedding:8b', embeddings: [[1, 2, 3]] }),
    });

    const provider = new OllamaEmbeddingProvider();
    await provider.embed('test');

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:11434/api/embed');
    expect(JSON.parse(options.body).model).toBe('qwen3-embedding:8b');
  });

  it('allows overriding the model', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'bge-m3', embeddings: [[0.5, 0.6]] }),
    });

    const provider = new OllamaEmbeddingProvider({ model: 'bge-m3' });
    const result = await provider.embed('test');
    expect(result).toEqual([0.5, 0.6]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe('bge-m3');
  });

  it('returns zero vector for empty text', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'qwen3-embedding:8b', embeddings: [[1, 2, 3]] }),
    });

    const provider = new OllamaEmbeddingProvider();
    // Prime dimension
    await provider.embed('prime');

    const result = await provider.embed('');
    expect(result).toEqual([0, 0, 0]);
    // fetch should only have been called once (for 'prime')
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'model not found',
    });

    const provider = new OllamaEmbeddingProvider();
    await expect(provider.embed('test')).rejects.toThrow('Ollama embed failed (404)');
  });

  it('throws on empty embeddings response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'qwen3-embedding:8b', embeddings: [] }),
    });

    const provider = new OllamaEmbeddingProvider();
    await expect(provider.embed('test')).rejects.toThrow('empty or invalid');
  });

  it('healthCheck returns ok on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'qwen3-embedding:8b', embeddings: [[0.1]] }),
    });

    const provider = new OllamaEmbeddingProvider();
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.model).toBe('qwen3-embedding:8b');
    expect(health.error).toBeUndefined();
  });

  it('healthCheck returns error on failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const provider = new OllamaEmbeddingProvider();
    const health = await provider.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.error).toContain('ECONNREFUSED');
  });
});
