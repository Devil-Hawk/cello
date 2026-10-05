// The registry is the one definition of every tool. These tests fail if the agent tools and
// the MCP tools can drift, if a name breaks the naming rule, or if a tool loses the
// conventions every tool follows.

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const approvals = vi.hoisted(() => ({ queueApproval: vi.fn(), autoApprove: vi.fn() }))
vi.mock('../approvals', async (orig) => ({ ...(await orig<typeof import('../approvals')>()), queueApproval: approvals.queueApproval, autoApprove: approvals.autoApprove }))

import { CELLO_TOOL_NAMES, UNTRUSTED_TOOL_NAMES } from '../tool-names'
import { SCHEDULED_TASKS_ON } from '../schedule-schemas'
import type { AgentContext } from '../context'
import { makeFakeAdmin } from '../testing/fake-admin'
import { CELLO_TOOLS, MCP_TOOLS, toolByName } from './registry'
import { toAgentTools } from './langchain'
import { registerCelloTools } from './mcp'

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  admin: makeFakeAdmin(),
  userId: 'u1',
  userEmail: 'dana@example.com',
  apiKeys: { openrouter: 'k', userId: 'u1' },
  isDemo: false,
  threadId: 't1',
  conversationId: 'c1',
  autonomy: 'ask',
  traceId: 'trace-1',
  deadlineAt: Date.now() + 60_000,
  ...over,
})

describe('the twelve tools', () => {
  it('are the named tools, with scheduling held back while scheduled tasks are closed', () => {
    const offered = CELLO_TOOL_NAMES.filter((n) => SCHEDULED_TASKS_ON || n !== 'schedule_task')
    expect(CELLO_TOOLS.map((t) => t.name).sort()).toEqual([...offered].sort())
    expect(CELLO_TOOLS).toHaveLength(12)
    expect(SCHEDULED_TASKS_ON).toBe(false)
  })

  it('no name contains run or thread', () => {
    for (const t of CELLO_TOOLS) expect(t.name, t.name).not.toMatch(/run|thread/i)
  })

  it('every description says what it does and is short enough to read in a tool list', () => {
    for (const t of CELLO_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(80)
      expect(t.description.length, t.name).toBeLessThan(900)
      expect(t.description, t.name).not.toMatch(/\u2014/)
      expect(t.description, t.name).not.toMatch(/\b(thread|graph|tick)\b/i)
    }
  })

  it('every read tool takes response_format and limit, and every write tool an idempotency key', () => {
    for (const t of CELLO_TOOLS) {
      const shape = t.schema.shape as Record<string, z.ZodTypeAny>
      if (t.kind === 'read') {
        expect(Object.keys(shape), t.name).toEqual(expect.arrayContaining(['response_format', 'limit']))
      } else {
        expect(Object.keys(shape), t.name).toContain('idempotency_key')
      }
    }
  })

  it('limits are bounded and response_format defaults to concise', () => {
    for (const t of CELLO_TOOLS) {
      const json = z.toJSONSchema(t.schema) as { properties: Record<string, { maximum?: number; default?: unknown; enum?: string[] }> }
      if (json.properties.limit) expect(json.properties.limit.maximum, t.name).toBeLessThanOrEqual(25)
      if (json.properties.response_format) {
        expect(json.properties.response_format.enum, t.name).toEqual(['concise', 'detailed'])
        expect(json.properties.response_format.default, t.name).toBe('concise')
      }
    }
  })

  it('every argument says what it is for', () => {
    const missing: string[] = []
    for (const t of CELLO_TOOLS) {
      const json = z.toJSONSchema(t.schema) as { properties: Record<string, { description?: string; type?: string; properties?: unknown }> }
      for (const [key, prop] of Object.entries(json.properties)) {
        if (!prop.description) missing.push(`${t.name}.${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('the untrusted flags agree with the names the guard middleware knows', () => {
    for (const t of CELLO_TOOLS) expect(t.untrusted, t.name).toBe(UNTRUSTED_TOOL_NAMES.has(t.name))
  })

  it('the write tools that save text people may have written are marked untrusted only where they read it', () => {
    expect(toolByName('create_artifact')?.untrusted).toBe(false)
    expect(toolByName('get_role')?.untrusted).toBe(true)
    expect(toolByName('research')?.untrusted).toBe(true)
  })
})

describe('the agent tools and the MCP tools are the same tools', () => {
  it('the agent tools carry the registry name, description and schema', () => {
    const tools = toAgentTools(ctx())
    expect(tools.map((t) => t.name)).toEqual(CELLO_TOOLS.map((t) => t.name))
    for (const tool of tools) {
      const def = toolByName(tool.name)!
      expect(tool.description).toBe(def.description)
      expect(z.toJSONSchema(tool.schema as z.ZodType)).toEqual(z.toJSONSchema(def.schema))
    }
  })

  it('a tool list can be narrowed, and a Researcher holds only read tools', () => {
    const names = toAgentTools(ctx(), { names: ['search_knowledge', 'people'] }).map((t) => t.name)
    expect(names).toEqual(['people', 'search_knowledge'])
    for (const n of names) expect(toolByName(n)?.kind).toBe('read')
  })

  async function mcpClient(c: AgentContext) {
    const server = new McpServer({ name: 'cello', version: '1.0.0' })
    registerCelloTools(server, c)
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(a), client.connect(b)])
    return client
  }

  it('the MCP server lists the same tools with the same names, descriptions and argument shapes', async () => {
    const client = await mcpClient(ctx())
    const listed = (await client.listTools()).tools
    expect(listed.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort())
    for (const mcp of listed) {
      const def = toolByName(mcp.name)!
      expect(mcp.description).toBe(def.description)
      const want = z.toJSONSchema(def.schema, { io: 'input' }) as { properties: Record<string, { description?: string; type?: string }>; required?: string[] }
      const got = mcp.inputSchema as { properties: Record<string, { description?: string; type?: string }>; required?: string[] }
      expect(Object.keys(got.properties).sort(), mcp.name).toEqual(Object.keys(want.properties).sort())
      for (const key of Object.keys(want.properties)) {
        expect(got.properties[key].description, `${mcp.name}.${key}`).toBe(want.properties[key].description)
        expect(got.properties[key].type, `${mcp.name}.${key}`).toBe(want.properties[key].type)
      }
      expect([...(got.required ?? [])].sort(), mcp.name).toEqual([...(want.required ?? [])].sort())
    }
  })

  it('remember is the one tool not served over MCP, because it needs the conversation to check the persons words', async () => {
    const client = await mcpClient(ctx())
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('remember')
    expect(CELLO_TOOLS.filter((t) => !t.mcp).map((t) => t.name)).toEqual(['remember'])
  })

  it('over MCP request_approval queues and says waiting, and nothing is approved or sent from the call', async () => {
    approvals.queueApproval.mockReset().mockResolvedValue({ ok: true, created: true, approval: { id: 'ap1', status: 'pending', action: 'send_email' } })
    approvals.autoApprove.mockReset()
    // Even a context that arrives claiming a task that may act is treated as ask over MCP.
    const client = await mcpClient(ctx({ scheduledTaskId: 'task-1', autonomy: 'act', rules: { allow_send_email: true } }))
    const result = await client.callTool({ name: 'request_approval', arguments: { action: 'send_email', artifact_id: 'a1' } })
    expect(result.isError).toBe(false)
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ status: 'waiting', approval_id: 'ap1' })
    expect(approvals.queueApproval).toHaveBeenCalledTimes(1)
    expect(approvals.autoApprove).not.toHaveBeenCalled()
  })

  it('an error the tool returns on purpose comes back as an MCP error with the fix', async () => {
    approvals.queueApproval.mockReset().mockResolvedValue({ ok: false, error: 'No artifact with id nope.', fix: 'Use an artifact_id returned by create_artifact.' })
    const client = await mcpClient(ctx())
    const result = await client.callTool({ name: 'request_approval', arguments: { action: 'send_email', artifact_id: 'nope' } })
    expect(result.isError).toBe(true)
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ error: 'No artifact with id nope.', fix: 'Use an artifact_id returned by create_artifact.' })
  })

  it('arguments that break the schema are refused before any handler runs', async () => {
    approvals.queueApproval.mockReset()
    const client = await mcpClient(ctx())
    const result = await client.callTool({ name: 'request_approval', arguments: { action: 'delete_everything', artifact_id: 'a1' } })
    expect(result.isError).toBe(true)
    expect(approvals.queueApproval).not.toHaveBeenCalled()
  })
})
