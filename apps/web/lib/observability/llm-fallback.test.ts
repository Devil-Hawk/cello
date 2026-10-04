import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeLlmFailure, warnLlmFallback } from './llm-fallback'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('describeLlmFailure', () => {
  it('keeps the class and HTTP status, drops secrets, and caps the length', () => {
    const err = Object.assign(new Error(`401 bad key sk-or-v1-${'a'.repeat(40)} ${'x'.repeat(500)}`), { status: 401 })
    const out = describeLlmFailure(err)
    expect(out.errorClass).toBe('Error')
    expect(out.status).toBe(401)
    expect(out.message).not.toContain('sk-or-v1-aaaa')
    expect(out.message.length).toBeLessThanOrEqual(200)
  })

  it('handles a thrown non-Error and omits status when there is none', () => {
    expect(describeLlmFailure('boom')).toEqual({ errorClass: 'string', message: 'boom' })
  })
})

describe('warnLlmFallback', () => {
  it('writes exactly one greppable warn line naming the scope and the fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnLlmFallback('gmail-classify', 'regex-patterns', new Error('nope'))
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0][0])
    expect(line.startsWith('[llm:fallback] {')).toBe(true)
    expect(line).toContain('"scope":"gmail-classify"')
    expect(line).toContain('"fallback":"regex-patterns"')
  })
})
