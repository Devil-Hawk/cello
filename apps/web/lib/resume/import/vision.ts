// Picture -> text, with a vision model. One multimodal call, made directly with
// the OpenAI SDK pointed at OpenRouter (the same client as
// lib/harness/providers/openrouter.ts). The harness runner is text-only and
// this is the one multimodal call, so a runner abstraction is not justified.
//
// The transcript is NOT trusted: the structure step cannot check it against the
// picture, so the client shows it next to the picture for the user to confirm
// before anything is saved.

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { withPolicy } from '@/lib/harness/prompts'
import { stripCodeFence } from './llm'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Tried in order; the next one is used when a model is unknown or rejects the
 * input. ponytail: hard-coded list; resolve from /api/v1/models when an id expires.
 */
export const VISION_MODELS = ['google/gemini-3.1-flash-lite', 'mistralai/mistral-small-3.2-24b-instruct']

export const TRANSCRIBE_PROMPT =
  'Transcribe this resume exactly, line by line. Keep headings and bullets as they appear. Add nothing, correct nothing, and do not summarise. Return only the text.'

export const VISION_TIMEOUT_MS = 60_000

export interface TranscribeInput {
  bytes: Buffer
  mimeType: string
  filename?: string | null
}

function isPdf(input: TranscribeInput): boolean {
  return input.mimeType === 'application/pdf'
}

function dataUrl(input: TranscribeInput): string {
  return `data:${input.mimeType};base64,${input.bytes.toString('base64')}`
}

/** A 4xx that means "try another model", as opposed to a bad key or a budget. */
function isModelProblem(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  return status === 400 || status === 404 || status === 422
}

export async function transcribeWithOpenRouter(
  apiKey: string,
  input: TranscribeInput,
  signal?: AbortSignal
): Promise<string> {
  const client = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: { 'HTTP-Referer': 'https://cello.app', 'X-Title': 'Cello - Job Search Assistant' },
  })
  const filePart = isPdf(input)
    ? { type: 'file', file: { filename: input.filename || 'resume.pdf', file_data: dataUrl(input) } }
    : { type: 'image_url', image_url: { url: dataUrl(input) } }

  let lastError: unknown
  for (const model of VISION_MODELS) {
    try {
      const res = await client.chat.completions.create(
        {
          model,
          temperature: 0,
          max_tokens: 8000,
          // The text part comes first, then the picture or PDF.
          messages: [
            { role: 'system', content: withPolicy() },
            {
              role: 'user',
              content: [{ type: 'text', text: TRANSCRIBE_PROMPT }, filePart] as unknown as string,
            },
          ],
        },
        { signal: signal ?? AbortSignal.timeout(VISION_TIMEOUT_MS) }
      )
      const text = stripCodeFence(res.choices[0]?.message?.content ?? '')
      if (!text) throw new Error('The model returned no text')
      return text
    } catch (err) {
      lastError = err
      if (!isModelProblem(err)) throw err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No vision model could read this file')
}

/** For an account whose only key is Anthropic. */
export async function transcribeWithAnthropic(apiKey: string, input: TranscribeInput): Promise<string> {
  const client = new Anthropic({ apiKey })
  const data = input.bytes.toString('base64')
  const block = isPdf(input)
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
    : {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: input.mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
          data,
        },
      }
  const response = await client.messages.create(
    {
      // The unversioned alias, so the model rolls forward instead of retiring.
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      system: withPolicy(),
      messages: [{ role: 'user', content: [block, { type: 'text', text: TRANSCRIBE_PROMPT }] }],
    },
    { signal: AbortSignal.timeout(VISION_TIMEOUT_MS) }
  )
  const textBlock = response.content.find((b) => b.type === 'text')
  const text = textBlock && textBlock.type === 'text' ? stripCodeFence(textBlock.text) : ''
  if (!text) throw new Error('No text response from the model')
  return text
}
