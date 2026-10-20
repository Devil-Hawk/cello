import { describe, expect, it } from 'vitest'
import { classifyMcpTool, recipientKeys, scanInput } from './mcp-rule'

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

  it('treats a recipient named inside a longer key, and a sending name, as not free even with readOnlyHint true', () => {
    for (const key of ['recipient_email', 'email_address', 'to_email', 'phone_number', 'recipientId', 'mailto', 'notify_channel', 'webhookUrl', 'target_url']) {
      expect(recipientKeys(schema({ [key]: {} })), key).toEqual([key])
      expect(classifyMcpTool({ name: 'lookup', readOnlyHint: true, inputSchema: schema({ [key]: {} }) }, open), key).toBe('confirm')
    }
    const send = { name: 'send_message', readOnlyHint: true, inputSchema: schema({ recipient_email: {}, message: {} }) }
    expect(classifyMcpTool(send, open)).toBe('confirm')
    for (const name of ['send_note', 'postUpdate', 'gmail_list', 'submit_form', 'publish', 'reply_all', 'get_message']) {
      expect(classifyMcpTool({ name, readOnlyHint: true, inputSchema: schema({ query: {} }) }, open), name).toBe('confirm')
    }
    expect(classifyMcpTool({ name: 'list_postings', readOnlyHint: true, inputSchema: schema({ query: {}, total: {}, stop: {} }) }, open)).toBe('read')
  })

  it('walks items and stops at depth 4', () => {
    const list = schema({ rows: { type: 'array', items: { type: 'object', properties: { Email: {} } } } })
    expect(recipientKeys(list)).toEqual(['Email'])
    const deep = schema({ a: { properties: { b: { properties: { c: { properties: { d: { properties: { to: {} } } } } } } } } })
    expect(recipientKeys(deep)).toEqual(['to'])
    expect(recipientKeys(null)).toEqual([])
  })

  it('leaves out a tool marked Never and every tool for a demo', () => {
    const read = { name: 'search', readOnlyHint: true, inputSchema: schema({ query: {} }) }
    expect(classifyMcpTool(read, { never: ['search'], isDemo: false })).toBe('never')
    expect(classifyMcpTool(read, { never: [], isDemo: true })).toBe('never')
    expect(classifyMcpTool({ ...read, name: 'other' }, { never: ['search'], isDemo: false })).toBe('read')
  })
})

// The shapes a read-only-claiming tool can hide a recipient in. Each is one of the fixture tools from the round 3 review.
describe('classifyMcpTool on schemas that hide a recipient', () => {
  const read = (inputSchema: unknown, name = 'lookup') => classifyMcpTool({ name, readOnlyHint: true, inputSchema }, open)
  const params = { recipient_email: { type: 'string' }, message: { type: 'string' } }

  it('follows $ref into $defs and definitions, and ends on a cycle', () => {
    expect(read({ type: 'object', properties: { params: { $ref: '#/$defs/P' } }, $defs: { P: { type: 'object', properties: params } } })).toBe('confirm')
    expect(read({ type: 'object', properties: { params: { $ref: '#/definitions/P' } }, definitions: { P: { type: 'object', properties: params } } })).toBe('confirm')
    expect(read({ type: 'object', properties: { params: { $ref: '#/$defs/P' } }, $defs: { P: { type: 'object', properties: { query: {} }, additionalProperties: false } } })).toBe('read')
    const cycle = { type: 'object', additionalProperties: false, properties: { node: { $ref: '#/$defs/N' } }, $defs: { N: { type: 'object', additionalProperties: false, properties: { child: { $ref: '#/$defs/N' }, label: {} } } } }
    expect(read(cycle)).toBe('read')
    expect(scanInput(cycle).keys).toEqual([])
  })

  it('treats a $ref it cannot resolve as hiding something', () => {
    expect(read({ type: 'object', additionalProperties: false, properties: { a: { $ref: '#/$defs/Missing' } } })).toBe('confirm')
    expect(read({ type: 'object', additionalProperties: false, properties: { a: { $ref: 'https://x.test/schema.json' } } })).toBe('confirm')
  })

  it('walks anyOf, oneOf, allOf, items, prefixItems, additionalProperties and patternProperties', () => {
    expect(read({ type: 'object', anyOf: [{ properties: params }, { properties: { query: {} } }] })).toBe('confirm')
    expect(read({ type: 'object', oneOf: [{ properties: { query: {} } }, { properties: { cc: {} } }] })).toBe('confirm')
    expect(read({ type: 'object', allOf: [{ properties: { query: {} } }, { properties: { bcc: {} } }] })).toBe('confirm')
    expect(read({ type: 'object', additionalProperties: false, properties: { rows: { type: 'array', items: { type: 'object', properties: { Email: {} } } } } })).toBe('confirm')
    expect(read({ type: 'object', additionalProperties: false, properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'object', properties: { phone: {} } }] } } })).toBe('confirm')
    expect(read({ type: 'object', additionalProperties: false, properties: { extra: { type: 'object', additionalProperties: { type: 'object', properties: { to: {} } } } } })).toBe('confirm')
    expect(read({ type: 'object', additionalProperties: false, properties: { m: { type: 'object', additionalProperties: false, patternProperties: { '^x_': { type: 'object', properties: { webhook: {} } } } } } })).toBe('confirm')
    expect(read({ type: 'object', anyOf: [{ properties: { query: {} } }, { properties: { limit: {} } }], additionalProperties: false })).toBe('read')
  })

  it('finds the recipient word inside a longer key name', () => {
    for (const key of ['receiver', 'receivers', 'Receiver_Name', 'emails', 'sms', 'mobile', 'contactInfo', 'destination', 'chat_id', 'chatId', 'user_id', 'userIds', 'bcc_list', 'to_addrs']) {
      expect(read({ type: 'object', additionalProperties: false, properties: { [key]: {} } }), key).toBe('confirm')
    }
    for (const key of ['query', 'limit', 'tokens', 'total', 'chat', 'user', 'idx', 'stop', 'cursor']) {
      expect(read({ type: 'object', additionalProperties: false, properties: { [key]: {} } }), key).toBe('read')
    }
  })

  it('calls an open object, with no declared properties, a Confirm tool', () => {
    expect(read({ type: 'object', additionalProperties: true })).toBe('confirm')
    expect(read({ type: 'object' })).toBe('confirm')
    expect(read({ type: 'object', properties: { query: {} }, additionalProperties: false })).toBe('read')
    expect(read({ type: 'object', properties: { filters: { type: 'object' } }, additionalProperties: false })).toBe('confirm')
    expect(read({ type: 'object', properties: { filters: { type: 'object', additionalProperties: false, properties: { tag: {} } } }, additionalProperties: false })).toBe('read')
    expect(read(undefined)).toBe('read')
  })

  it('treats a schema nested past the depth limit as Confirm, and still finds a recipient at depth 5', () => {
    const nest = (leaf: Record<string, unknown>, levels: number) => {
      let node: unknown = { type: 'object', additionalProperties: false, properties: leaf }
      for (let i = 0; i < levels; i++) node = { type: 'object', additionalProperties: false, properties: { [`level${i}`]: node } }
      return node
    }
    expect(read(nest({ to: {} }, 4))).toBe('confirm')
    expect(recipientKeys(nest({ to: {} }, 4))).toEqual(['to'])
    expect(read(nest({ query: {} }, 3))).toBe('read')
    expect(read(nest({ query: {} }, 12))).toBe('confirm')
  })

  it('never frees a tool whose name says send, post, mail, message, notify, publish, invite, share or write', () => {
    const q = { type: 'object', additionalProperties: false, properties: { query: {} } }
    for (const name of ['send_note', 'post_update', 'mail_merge', 'get_message', 'notify_team', 'publish_page', 'invite_user', 'share_doc', 'write_file', 'shareNotes', 'writeLog']) {
      expect(read(q, name), name).toBe('confirm')
    }
    expect(read(q, 'list_postings')).toBe('read')
  })
})

