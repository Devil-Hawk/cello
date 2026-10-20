import { describe, expect, it } from 'vitest'
import { classifyMcpTool, recipientKeys } from './mcp-rule'

const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties })
const open = { never: [], isDemo: false }

describe('classifyMcpTool', () => {
  it('calls send_email behind Confirm', () => {
    const tool = { name: 'send_email', inputSchema: schema({ to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }) }
    expect(classifyMcpTool(tool, open)).toBe('confirm')
    expect(recipientKeys(tool.inputSchema)).toEqual(['to'])
  })

  it('needs read-only and no recipient for a free read', () => {
    const q = schema({ query: { type: 'string' } })
    expect(classifyMcpTool({ name: 'search', readOnlyHint: true, inputSchema: q }, open)).toBe('read')
    expect(classifyMcpTool({ name: 'search', readOnlyHint: true, inputSchema: schema({ message: { type: 'object', properties: { to: { type: 'string' } } } }) }, open)).toBe('confirm')
    expect(classifyMcpTool({ name: 'search', readOnlyHint: false, inputSchema: q }, open)).toBe('confirm')
    expect(classifyMcpTool({ name: 'search', inputSchema: q }, open)).toBe('confirm')
  })

  it('walks items and stops at depth 4', () => {
    const list = schema({ rows: { type: 'array', items: { type: 'object', properties: { Email: {} } } } })
    expect(recipientKeys(list)).toEqual(['Email'])
    const deep = schema({ a: { properties: { b: { properties: { c: { properties: { d: { properties: { to: {} } } } } } } } } })
    expect(recipientKeys(deep)).toEqual([])
    expect(recipientKeys(null)).toEqual([])
  })

  it('leaves out a tool marked Never and every tool for a demo', () => {
    const read = { name: 'search', readOnlyHint: true, inputSchema: schema({ query: {} }) }
    expect(classifyMcpTool(read, { never: ['search'], isDemo: false })).toBe('never')
    expect(classifyMcpTool(read, { never: [], isDemo: true })).toBe('never')
    expect(classifyMcpTool({ ...read, name: 'other' }, { never: ['search'], isDemo: false })).toBe('read')
  })
})
