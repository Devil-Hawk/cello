/**
 * Embeddings module for semantic similarity matching
 *
 * Provides embedding generation and similarity calculation for
 * comparing job descriptions to resumes.
 *
 * Supports:
 * - Mock embeddings for testing (deterministic, based on text hash)
 * - OpenAI embeddings for production (requires API key)
 * - Future: transformers.js for local embeddings
 */

import type { EmbeddingConfig } from './types'

const DEFAULT_DIMENSION = 384

/**
 * Generate a deterministic mock embedding based on text content.
 * Uses a simple hash-based approach to create consistent embeddings
 * where similar text produces similar embeddings.
 */
export function generateMockEmbedding(text: string, dimension: number = DEFAULT_DIMENSION): number[] {
  const normalizedText = text.toLowerCase().trim()
  const words = normalizedText.split(/\s+/)

  // Create embedding based on word frequencies and positions
  const embedding = new Array(dimension).fill(0)

  // Hash each word and distribute values across the embedding
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const wordHash = simpleHash(word)

    // Distribute word influence across multiple dimensions
    for (let j = 0; j < Math.min(10, dimension); j++) {
      const idx = (wordHash + j * 37) % dimension
      const value = Math.sin(wordHash + j) * (1 / (i + 1)) // Position weighting
      embedding[idx] += value
    }

    // Add character-level features
    for (let c = 0; c < word.length; c++) {
      const charCode = word.charCodeAt(c)
      const idx = (charCode * 7 + c) % dimension
      embedding[idx] += 0.1 * Math.cos(charCode + c)
    }
  }

  // Normalize the embedding
  return normalizeVector(embedding)
}

/**
 * Simple string hash function for deterministic results
 */
function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash)
}

/**
 * Normalize a vector to unit length
 */
function normalizeVector(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0))
  if (magnitude === 0) {
    return vec
  }
  return vec.map((val) => val / magnitude)
}

/**
 * Calculate cosine similarity between two vectors.
 * Returns value between -1 (opposite) and 1 (identical).
 */
export function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length) {
    throw new Error(`Vector dimension mismatch: ${vec1.length} vs ${vec2.length}`)
  }

  let dotProduct = 0
  let magnitude1 = 0
  let magnitude2 = 0

  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i]
    magnitude1 += vec1[i] * vec1[i]
    magnitude2 += vec2[i] * vec2[i]
  }

  magnitude1 = Math.sqrt(magnitude1)
  magnitude2 = Math.sqrt(magnitude2)

  if (magnitude1 === 0 || magnitude2 === 0) {
    return 0
  }

  return dotProduct / (magnitude1 * magnitude2)
}

/**
 * EmbeddingProvider class for generating and comparing embeddings
 */
export class EmbeddingProvider {
  private config: EmbeddingConfig
  private dimension: number

  constructor(config: Partial<EmbeddingConfig> = {}) {
    this.config = {
      provider: config.provider || 'mock',
      dimension: config.dimension,
      apiKey: config.apiKey,
      model: config.model || 'text-embedding-3-small',
    }

    // Set default dimension based on provider
    if (this.config.provider === 'openai') {
      this.dimension = this.config.dimension || 1536
    } else {
      this.dimension = this.config.dimension || DEFAULT_DIMENSION
    }
  }

  /**
   * Generate embedding for text (async for API compatibility)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (this.config.provider === 'openai') {
      return this.generateOpenAIEmbedding(text)
    }
    return this.generateEmbeddingSync(text)
  }

  /**
   * Generate embedding synchronously (mock only)
   */
  generateEmbeddingSync(text: string): number[] {
    return generateMockEmbedding(text, this.dimension)
  }

  /**
   * Generate embedding using OpenAI API
   */
  private async generateOpenAIEmbedding(text: string): Promise<number[]> {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key required for openai provider')
    }

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        model: this.config.model,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`OpenAI API error: ${error}`)
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> }
    return data.data[0].embedding
  }

  /**
   * Compute similarity between two texts
   */
  async computeSimilarity(text1: string, text2: string): Promise<number> {
    const [embedding1, embedding2] = await Promise.all([
      this.generateEmbedding(text1),
      this.generateEmbedding(text2),
    ])
    return cosineSimilarity(embedding1, embedding2)
  }

  /**
   * Compute similarity using pre-computed embeddings
   */
  computeSimilarityFromEmbeddings(embedding1: number[], embedding2: number[]): number {
    return cosineSimilarity(embedding1, embedding2)
  }

  /**
   * Get the configured dimension
   */
  getDimension(): number {
    return this.dimension
  }

  /**
   * Check if using mock provider
   */
  isMock(): boolean {
    return this.config.provider === 'mock'
  }
}

/**
 * Create an embedding provider based on available API keys
 */
export function createEmbeddingProvider(apiKey?: string): EmbeddingProvider {
  if (apiKey) {
    return new EmbeddingProvider({
      provider: 'openai',
      apiKey,
    })
  }
  return new EmbeddingProvider({ provider: 'mock' })
}
