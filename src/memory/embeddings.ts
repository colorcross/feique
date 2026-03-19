/**
 * Lightweight local text embedding for semantic search.
 *
 * Strategy: character bigram + word-level token frequency vectors.
 * Works for both Chinese and English without external API calls.
 *
 * The interface is pluggable — swap in neural embeddings (OpenAI, Cohere)
 * by implementing EmbeddingProvider.
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimension(): number;
}

/**
 * Default local embedding: character bigram + word token frequency.
 * No external dependencies, works offline.
 *
 * Produces a fixed-dimension vector by hashing features into buckets
 * (feature hashing / "hashing trick"), so no vocabulary needs to be
 * maintained across documents.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private readonly dim: number;

  constructor(dimension: number = 256) {
    this.dim = dimension;
  }

  dimension(): number {
    return this.dim;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Float64Array(this.dim);

    // Layer 1: Character bigrams (captures Chinese and subword patterns)
    const chars = [...text.toLowerCase()];
    for (let i = 0; i < chars.length - 1; i++) {
      const bigram = (chars[i] ?? '') + (chars[i + 1] ?? '');
      const bucket = hashString(bigram) % this.dim;
      vec[bucket]! += 1;
    }

    // Layer 2: Character trigrams (richer Chinese patterns)
    for (let i = 0; i < chars.length - 2; i++) {
      const trigram = (chars[i] ?? '') + (chars[i + 1] ?? '') + (chars[i + 2] ?? '');
      const bucket = hashString(trigram) % this.dim;
      vec[bucket]! += 0.7;
    }

    // Layer 3: Word-level tokens (captures English words, Chinese after splitting)
    const words = tokenize(text);
    for (const word of words) {
      const bucket = hashString(`w:${word}`) % this.dim;
      vec[bucket]! += 1.5; // Words weighted higher than character n-grams
    }

    // Layer 4: Word bigrams (captures phrases like "root cause", "性能瓶颈")
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i] ?? ''} ${words[i + 1] ?? ''}`;
      const bucket = hashString(`p:${phrase}`) % this.dim;
      vec[bucket]! += 1.2;
    }

    // Normalize to unit vector for cosine similarity
    return normalize(Array.from(vec));
  }
}

/**
 * Compute cosine similarity between two vectors. Returns 0..1.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return Math.max(0, dot / denom);
}

/**
 * Serialize embedding to a compact JSON string.
 * Rounds to 4 decimal places to save space.
 */
export function serializeEmbedding(vec: number[]): string {
  return JSON.stringify(vec.map((v) => Math.round(v * 10000) / 10000));
}

/**
 * Deserialize embedding from JSON string.
 */
export function deserializeEmbedding(json: string): number[] | null {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    return arr as number[];
  } catch {
    return null;
  }
}

// ── Internal helpers ──

function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * Tokenize text into words. Handles:
 * - English: split on whitespace/punctuation, lowercase
 * - Chinese: each character is a token (character-level tokenization)
 * - Mixed: both strategies applied
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // Extract English/numeric words
  const englishWords = lower.match(/[a-z][a-z0-9_-]{1,}/g);
  if (englishWords) {
    tokens.push(...englishWords);
  }

  // Extract Chinese characters as individual tokens
  const cjkChars = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  if (cjkChars) {
    tokens.push(...cjkChars);
  }

  // Extract Chinese 2-char words (common compounds)
  const cjkRuns = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      const chars = [...run];
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i]! + chars[i + 1]!);
      }
    }
  }

  return tokens;
}

/**
 * FNV-1a hash for strings → positive integer.
 * Fast, decent distribution, deterministic.
 */
function hashString(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash >>> 0;
}
