import { describe, expect, it } from 'vitest'
import {
  RECONNECT_MAX_ATTEMPTS,
  buildCopilotRequestBody,
  classifyStreamError,
  findResolvedAssistantMessage,
  reconnectDelayMs,
} from './reconnect'

describe('reconnectDelayMs', () => {
  it('backs off exponentially starting at 1s', () => {
    expect(reconnectDelayMs(1)).toBe(1000)
    expect(reconnectDelayMs(2)).toBe(2000)
    expect(reconnectDelayMs(3)).toBe(4000)
  })

  it('caps at 8s so retries never balloon', () => {
    expect(reconnectDelayMs(4)).toBe(8000)
    expect(reconnectDelayMs(5)).toBe(8000)
    expect(reconnectDelayMs(RECONNECT_MAX_ATTEMPTS)).toBe(8000)
    expect(reconnectDelayMs(20)).toBe(8000)
  })

  it('never goes negative for a non-positive attempt', () => {
    expect(reconnectDelayMs(0)).toBe(1000)
    expect(reconnectDelayMs(-3)).toBe(1000)
  })
})

describe('classifyStreamError', () => {
  it('classifies a real AbortController abort (the user Stop button) as stopped', () => {
    const controller = new AbortController()
    let caught: unknown
    controller.signal.addEventListener('abort', () => {})
    try {
      controller.abort()
      // Simulate what fetch/reader actually throw on an aborted signal.
      throw new DOMException('The user aborted a request.', 'AbortError')
    } catch (e) {
      caught = e
    }
    expect(classifyStreamError(caught)).toBe('stopped')
  })

  it('classifies a generic network TypeError (a real drop) as dropped', () => {
    expect(classifyStreamError(new TypeError('Failed to fetch'))).toBe('dropped')
    expect(classifyStreamError(new TypeError('Load failed'))).toBe('dropped')
  })

  it('classifies a non-AbortError DOMException as dropped', () => {
    expect(classifyStreamError(new DOMException('boom', 'NetworkError'))).toBe('dropped')
  })

  it('classifies an arbitrary thrown value as dropped', () => {
    expect(classifyStreamError('a string error')).toBe('dropped')
    expect(classifyStreamError(undefined)).toBe('dropped')
  })
})

describe('findResolvedAssistantMessage', () => {
  it('returns null for a non-array or empty transcript', () => {
    expect(findResolvedAssistantMessage(undefined)).toBeNull()
    expect(findResolvedAssistantMessage(null)).toBeNull()
    expect(findResolvedAssistantMessage([])).toBeNull()
  })

  it('returns null when the server has not caught up yet (last row still the user turn)', () => {
    const rows = [
      { role: 'user', content: 'find me jobs' },
      { role: 'assistant', content: 'earlier reply' },
      { role: 'user', content: 'do it again' },
    ]
    expect(findResolvedAssistantMessage(rows)).toBeNull()
  })

  it('returns the last row once the assistant has actually answered', () => {
    const rows = [
      { role: 'user', content: 'find me jobs' },
      { role: 'assistant', content: 'here you go', id: 'm2', trace: [] },
    ]
    expect(findResolvedAssistantMessage(rows)).toEqual(rows[1])
  })
})

describe('buildCopilotRequestBody', () => {
  const settings = { enabledAgents: ['sourcer', 'matcher'], model: 'default', thinkingMode: 'auto' as const, bypassMode: false }

  it('sends a fresh message with no conversationId for a brand-new turn', () => {
    const body = buildCopilotRequestBody({ message: 'hello' }, settings, 2, 'default', undefined)
    expect(body).toEqual({ message: 'hello', thinkingMode: 'auto', bypassMode: false })
  })

  it('includes conversationId once known', () => {
    const body = buildCopilotRequestBody({ message: 'hello' }, settings, 2, 'default', 'conv-1')
    expect(body.conversationId).toBe('conv-1')
  })

  it('omits enabledAgents when every agent is on (matches allAgentsCount)', () => {
    const body = buildCopilotRequestBody({ message: 'hi' }, settings, 2, 'default', undefined)
    expect(body.enabledAgents).toBeUndefined()
  })

  it('sends enabledAgents when a strict subset is enabled', () => {
    const body = buildCopilotRequestBody({ message: 'hi' }, settings, 5, 'default', undefined)
    expect(body.enabledAgents).toEqual(['sourcer', 'matcher'])
  })

  it('sends empty message + directive for a resume, never the original message text', () => {
    const body = buildCopilotRequestBody(
      { message: 'ignored', resumeId: 'turn-1', directive: 'go ahead' },
      settings,
      2,
      'default',
      'conv-1'
    )
    expect(body.message).toBe('')
    expect(body.directive).toBe('go ahead')
  })

  it('only sends model when it differs from the default sentinel', () => {
    const withDefault = buildCopilotRequestBody({ message: 'hi' }, settings, 2, 'default', undefined)
    expect(withDefault.model).toBeUndefined()
    const withOverride = buildCopilotRequestBody({ message: 'hi' }, { ...settings, model: 'gpt-5' }, 2, 'default', undefined)
    expect(withOverride.model).toBe('gpt-5')
  })

  it('passes confirmToolCall and editMessageId through only when set', () => {
    const plain = buildCopilotRequestBody({ message: 'hi' }, settings, 2, 'default', undefined)
    expect(plain.confirmToolCall).toBeUndefined()
    expect(plain.editMessageId).toBeUndefined()

    const confirmed = buildCopilotRequestBody(
      { message: '', resumeId: 't1', confirmToolCall: true },
      settings,
      2,
      'default',
      'conv-1'
    )
    expect(confirmed.confirmToolCall).toBe(true)

    const edited = buildCopilotRequestBody({ message: 'redo', editMessageId: 'm1' }, settings, 2, 'default', undefined)
    expect(edited.editMessageId).toBe('m1')
  })
})
