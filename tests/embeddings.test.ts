import { describe, expect, it } from 'vitest';
import {
  LocalEmbeddingProvider,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from '../src/memory/embeddings.js';

describe('local embedding provider', () => {
  const provider = new LocalEmbeddingProvider(128);

  it('produces fixed-dimension vectors', async () => {
    const vec = await provider.embed('hello world');
    expect(vec).toHaveLength(128);
    expect(provider.dimension()).toBe(128);
  });

  it('produces normalized unit vectors', async () => {
    const vec = await provider.embed('test input text');
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it('returns identical embeddings for identical text', async () => {
    const a = await provider.embed('认证模块重构');
    const b = await provider.embed('认证模块重构');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 6);
  });

  it('gives high similarity for semantically related Chinese text', async () => {
    const a = await provider.embed('认证模块的 bug 修复');
    const b = await provider.embed('认证模块的问题修复');
    const c = await provider.embed('数据库性能优化方案');
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    // "认证模块修复" variants should be more similar to each other than to "数据库优化"
    expect(simAB).toBeGreaterThan(simAC);
  });

  it('gives high similarity for semantically related English text', async () => {
    const a = await provider.embed('fix authentication bug');
    const b = await provider.embed('fix auth issue');
    const c = await provider.embed('database performance tuning');
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
  });

  it('handles mixed Chinese-English text', async () => {
    const a = await provider.embed('fix 认证模块 authentication bug');
    const b = await provider.embed('修复认证模块的问题 authentication');
    const c = await provider.embed('create database migration script 数据库迁移');
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    // Mixed text about auth should be closer to Chinese auth text
    expect(simAB).toBeGreaterThan(simAC);
  });

  it('handles empty text gracefully', async () => {
    const vec = await provider.embed('');
    expect(vec).toHaveLength(128);
    // All zeros when normalized → zero vector
    expect(vec.every((v) => v === 0)).toBe(true);
  });
});

describe('cosine similarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 6);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('handles mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('serialization', () => {
  it('round-trips through serialize/deserialize', async () => {
    const provider = new LocalEmbeddingProvider(64);
    const vec = await provider.embed('test text');
    const json = serializeEmbedding(vec);
    const restored = deserializeEmbedding(json);
    expect(restored).not.toBeNull();
    // Check approximate equality (serialization rounds to 4 decimals)
    for (let i = 0; i < vec.length; i++) {
      expect(restored![i]).toBeCloseTo(vec[i]!, 3);
    }
  });

  it('returns null for invalid JSON', () => {
    expect(deserializeEmbedding('not json')).toBeNull();
    expect(deserializeEmbedding('"string"')).toBeNull();
  });
});
