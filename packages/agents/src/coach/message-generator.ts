// Message generation using LLM for Coach Agent

import type { LLMClient } from '../analyst/llm-client'
import type { MessageContext, MessageType, CoachCompletionOptions } from './types'
import {
  COACH_SYSTEM_PROMPT,
  generateFollowUpPrompt,
  generateThankYouPrompt,
  generateColdOutreachPrompt,
  generateCheckInPrompt,
  DEFAULT_TEMPLATES,
} from './templates'

/**
 * Default options for message generation
 */
const DEFAULT_OPTIONS: CoachCompletionOptions = {
  maxTokens: 500,
  temperature: 0.7,
}

/**
 * Generate a follow-up message using LLM
 */
export async function generateFollowUpMessage(
  client: LLMClient,
  context: MessageContext,
  options?: CoachCompletionOptions
): Promise<string> {
  const prompt = generateFollowUpPrompt(context)
  return generateMessage(client, prompt, options)
}

/**
 * Generate a thank you message using LLM
 */
export async function generateThankYouMessage(
  client: LLMClient,
  context: MessageContext,
  options?: CoachCompletionOptions
): Promise<string> {
  const prompt = generateThankYouPrompt(context)
  return generateMessage(client, prompt, options)
}

/**
 * Generate a cold outreach message using LLM
 */
export async function generateColdOutreachMessage(
  client: LLMClient,
  context: MessageContext,
  options?: CoachCompletionOptions
): Promise<string> {
  const prompt = generateColdOutreachPrompt(context)
  return generateMessage(client, prompt, options)
}

/**
 * Generate a check-in message using LLM
 */
export async function generateCheckInMessage(
  client: LLMClient,
  context: MessageContext,
  options?: CoachCompletionOptions
): Promise<string> {
  const prompt = generateCheckInPrompt(context)
  return generateMessage(client, prompt, options)
}

/**
 * Generate any type of message using LLM
 */
export async function generateMessageByType(
  client: LLMClient,
  messageType: MessageType,
  context: MessageContext,
  options?: CoachCompletionOptions
): Promise<string> {
  switch (messageType) {
    case 'follow_up':
      return generateFollowUpMessage(client, context, options)
    case 'thank_you':
      return generateThankYouMessage(client, context, options)
    case 'cold_outreach':
      return generateColdOutreachMessage(client, context, options)
    case 'check_in':
      return generateCheckInMessage(client, context, options)
    default:
      return generateFollowUpMessage(client, context, options)
  }
}

/**
 * Generate a message using the LLM client
 */
async function generateMessage(
  client: LLMClient,
  prompt: string,
  options?: CoachCompletionOptions
): Promise<string> {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options }

  const response = await client.complete(prompt, {
    maxTokens: mergedOptions.maxTokens,
    temperature: mergedOptions.temperature,
    systemPrompt: COACH_SYSTEM_PROMPT,
  })

  return response.trim()
}

/**
 * Get a fallback template message when LLM is unavailable
 */
export function getFallbackMessage(
  messageType: MessageType,
  context: MessageContext
): string {
  const template = DEFAULT_TEMPLATES[messageType]
  return template(context)
}

/**
 * Generate message with fallback to templates on error
 */
export async function generateMessageWithFallback(
  client: LLMClient,
  messageType: MessageType,
  context: MessageContext,
  options?: CoachCompletionOptions
): Promise<{ message: string; usedFallback: boolean }> {
  try {
    const message = await generateMessageByType(client, messageType, context, options)
    return { message, usedFallback: false }
  } catch {
    const message = getFallbackMessage(messageType, context)
    return { message, usedFallback: true }
  }
}
