// Abstract LLM Client supporting OpenAI and Anthropic

import type { AgentApiKeys } from '../types'
import type { CompletionOptions } from './types'
import { ANALYST_SYSTEM_PROMPT } from './prompts'

/**
 * Abstract interface for LLM clients
 */
export interface LLMClient {
  /**
   * Send a prompt to the LLM and get a completion
   */
  complete(prompt: string, options?: CompletionOptions): Promise<string>

  /**
   * Get the provider name
   */
  readonly provider: string
}

/**
 * OpenAI LLM Client implementation
 */
export class OpenAILLMClient implements LLMClient {
  readonly provider = 'openai'
  private apiKey: string
  private model: string
  private baseUrl: string
  private extraHeaders: Record<string, string>

  constructor(
    apiKey: string,
    model: string = 'gpt-4-turbo-preview',
    baseUrl: string = 'https://api.openai.com/v1',
    extraHeaders: Record<string, string> = {}
  ) {
    this.apiKey = apiKey
    this.model = model
    this.baseUrl = baseUrl
    this.extraHeaders = extraHeaders
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: options?.systemPrompt ?? ANALYST_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: options?.maxTokens ?? 2000,
        temperature: options?.temperature ?? 0.7,
      }),
    })

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: { message?: string }
      }
      throw new Error(
        `OpenAI API error: ${response.status} - ${error.error?.message || 'Unknown error'}`
      )
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return data.choices?.[0]?.message?.content || ''
  }
}

/**
 * Anthropic LLM Client implementation
 */
export class AnthropicLLMClient implements LLMClient {
  readonly provider = 'anthropic'
  private apiKey: string
  private model: string

  constructor(apiKey: string, model: string = 'claude-3-sonnet-20240229') {
    this.apiKey = apiKey
    this.model = model
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options?.maxTokens ?? 2000,
        system: options?.systemPrompt ?? ANALYST_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    })

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: { message?: string }
      }
      throw new Error(
        `Anthropic API error: ${response.status} - ${error.error?.message || 'Unknown error'}`
      )
    }

    const data = (await response.json()) as {
      content?: Array<{ text?: string }>
    }
    return data.content?.[0]?.text || ''
  }
}

/**
 * Mock LLM Client for testing
 */
export class MockLLMClient implements LLMClient {
  readonly provider = 'mock'

  private mockResponse: string | null = null
  private errorMessage: string | null = null

  /** Number of times complete() has been called */
  callCount = 0

  /** The last prompt passed to complete() */
  lastPrompt: string | null = null

  async complete(prompt: string, _options?: CompletionOptions): Promise<string> {
    this.callCount++
    this.lastPrompt = prompt

    if (this.errorMessage) {
      throw new Error(this.errorMessage)
    }

    if (this.mockResponse) {
      return this.mockResponse
    }

    // Return realistic mock responses based on prompt content
    return this.generateMockResponse(prompt)
  }

  /**
   * Set a custom mock response for the next call
   */
  setMockResponse(response: string): void {
    this.mockResponse = response
  }

  /**
   * Configure the client to throw an error on next call
   */
  simulateError(message: string): void {
    this.errorMessage = message
  }

  /**
   * Reset the mock client state
   */
  reset(): void {
    this.mockResponse = null
    this.errorMessage = null
    this.callCount = 0
    this.lastPrompt = null
  }

  /**
   * Generate realistic mock responses based on prompt type
   */
  private generateMockResponse(prompt: string): string {
    // Detect if this is a full analysis prompt (JSON format)
    if (prompt.includes('Required Analysis') || prompt.includes('JSON format')) {
      return JSON.stringify({
        summary:
          'This is a senior backend engineering role focused on building scalable platform infrastructure. The ideal candidate has strong experience with Node.js, cloud services, and microservices architecture.',
        talkingPoints: [
          'Highlight your 8 years of backend development experience, directly matching their 5+ year requirement',
          'Emphasize your Node.js and TypeScript expertise from previous roles at Google and Stripe',
          'Discuss your experience leading teams of 5-10 engineers, demonstrating leadership capabilities',
          'Share specific examples of microservices architectures you have designed and implemented',
        ],
        companyInsights: [
          'The company appears to be a fast-growing startup in the AI space based on the notes',
          'They emphasize a remote-first culture, suggesting distributed team experience is valued',
          'Competitive compensation and equity suggest they are well-funded and investing in talent',
        ],
        interviewTips: [
          'Prepare to discuss system design for scalable backend services',
          'Review your experience with AWS services as they prefer AWS over other cloud providers',
          'Prepare behavioral questions about leading engineering teams through technical challenges',
          'Research the company AI products and prepare thoughtful questions about their technical roadmap',
        ],
      })
    }

    // Summary prompt
    if (
      prompt.toLowerCase().includes('summarize') ||
      prompt.toLowerCase().includes('summary')
    ) {
      return 'This is a senior backend engineering role focused on building scalable platform infrastructure. The ideal candidate has strong experience with Node.js and cloud services.'
    }

    // Talking points prompt
    if (prompt.toLowerCase().includes('talking points')) {
      return JSON.stringify([
        'Your 8 years of backend experience directly matches their requirement',
        'Your Node.js and TypeScript expertise is highly relevant',
        'Your team leadership experience demonstrates management capabilities',
      ])
    }

    // Company insights prompt
    if (prompt.toLowerCase().includes('company') && prompt.toLowerCase().includes('insight')) {
      return JSON.stringify([
        'Fast-growing startup in the AI space',
        'Remote-first culture',
        'Competitive compensation package',
      ])
    }

    // Interview tips prompt
    if (prompt.toLowerCase().includes('interview') && prompt.toLowerCase().includes('tip')) {
      return JSON.stringify([
        'Prepare system design examples',
        'Review AWS services',
        'Prepare leadership stories',
      ])
    }

    // Default response
    return 'Mock LLM response for testing purposes.'
  }
}

/**
 * Factory function to create the appropriate LLM client based on available API keys
 * Prefers Anthropic when both keys are available
 */
export function createLLMClient(apiKeys: AgentApiKeys): LLMClient {
  // Prefer Anthropic when both are available
  if (apiKeys.anthropic) {
    return new AnthropicLLMClient(apiKeys.anthropic)
  }

  if (apiKeys.openai) {
    return new OpenAILLMClient(apiKeys.openai)
  }

  // OpenRouter is OpenAI-wire-compatible, so the OpenAI client works verbatim
  // against a different base URL. Most Cello users hold ONLY this key.
  if (apiKeys.openrouter) {
    return new OpenAILLMClient(
      apiKeys.openrouter,
      'anthropic/claude-sonnet-5',
      'https://openrouter.ai/api/v1',
      { 'HTTP-Referer': 'https://cello.app', 'X-Title': 'Cello - Job Search Assistant' }
    )
  }

  // Return mock client when no keys available
  return new MockLLMClient()
}
