// The servers tab: a server's tools with the tier the rule gave each, the Never switch, and the states around loading
// them. No DOM renderer exists here, so the list is a view of its state (markup) and the two requests are functions.

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { McpTab, RULE, TIER_WORDS, ToolsView, readTools, setNever, withNever, type McpToolView } from './mcp-tab'

const text = (s: string) => s.replace(/<!-- -->/g, '')
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

const tools: McpToolView[] = [
  { name: 'read_note', description: 'Read one note.', tier: 'read', never: false },
  { name: 'send_note', description: 'Send a note to someone.', tier: 'confirm', never: false },
  { name: 'wipe', description: 'Delete everything.', tier: 'never', never: true },
]

describe('the rule and the tier words', () => {
  it('says the rule in the words of the plan', () => {
    expect(RULE).toBe('Cello uses a tool freely only when its server says it only reads and it sends nothing to anyone. Every other tool asks you first. A tool you mark Never is left out.')
    expect(TIER_WORDS).toEqual({ read: 'Reads freely', confirm: 'Asks you first', never: 'Never' })
  })

  it('puts the rule above the list of servers', () => {
    const out = text(renderToStaticMarkup(<McpTab onStatus={() => undefined} />))
    expect(out).toContain(RULE)
  })
})

describe('ToolsView', () => {
  const view = (state: Parameters<typeof ToolsView>[0]['state']) =>
    text(renderToStaticMarkup(<ToolsView server="notes" state={state} onNever={() => undefined} onRetry={() => undefined} />))

  it('says it is reading while the tools load', () => {
    expect(view({ phase: 'loading' })).toContain('Reading the tools on notes')
  })

  it('shows each tool with its tier word and a Never use switch named for it', () => {
    const out = view({ phase: 'ready', tools })
    expect(out).toContain('read_note')
    expect(out).toContain('Read one note.')
    expect(out).toContain('Reads freely')
    expect(out).toContain('Asks you first')
    expect(out).toContain('aria-label="Never use send_note"')
    expect(out).toContain('>Never use<')
    expect(out).toContain('role="switch"')
    // only the tool marked Never is on
    expect(out.match(/checked=""/g)?.length).toBe(1)
    expect(out).toMatch(/aria-label="Never use wipe"[^>]*checked=""|checked=""[^>]*aria-label="Never use wipe"/)
  })

  it('names the next step when it cannot connect', () => {
    const out = view({ phase: 'error', error: 'Could not reach notes. Check the address and try again.' })
    expect(out).toContain('Could not reach notes. Check the address and try again.')
    expect(out).toContain('>Try again<')
  })

  it('says so when the server lists no tools', () => {
    expect(view({ phase: 'ready', tools: [] })).toContain('This server lists no tools.')
  })

  it('keeps every switch at least 44px', () => {
    expect(view({ phase: 'ready', tools })).toContain('min-h-11')
  })
})

describe('readTools', () => {
  it('reads the server\'s tools from the settings route', async () => {
    const f = reply(200, { ok: true, tools })
    expect(await readTools('s 1', f)).toEqual({ ok: true, tools })
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/settings/mcp?tools=s%201')
  })

  it('gives back the route\'s words when it cannot connect', async () => {
    expect(await readTools('s1', reply(200, { ok: false, error: 'Could not reach notes. Check the address and try again.' }))).toEqual({ ok: false, error: 'Could not reach notes. Check the address and try again.' })
    expect(await readTools('s1', reply(404, { error: 'That server was not found.' }))).toEqual({ ok: false, error: 'That server was not found.' })
  })

  it('says what to do when the request does not arrive', async () => {
    const r = await readTools('s1', vi.fn(async () => { throw new Error('offline') }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/Try again|try again/)
  })
})

describe('setNever', () => {
  it('patches the server with the tool and the mark, ', async () => {
    const f = reply(200, { server: { id: 's1', name: 'notes', toolRules: { send_note: 'never' } } })
    expect(await setNever('s1', 'send_note', true, f)).toEqual({ ok: true })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/settings/mcp?id=s1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ tool: 'send_note', never: true })
  })

  it('shows the route\'s error when it refuses', async () => {
    expect(await setNever('s1', 'x', true, reply(400, { error: 'Bad tool.' }))).toEqual({ ok: false, error: 'Bad tool.' })
  })
})

describe('withNever', () => {
  it('marks a tool Never at once and leaves the others', () => {
    const next = withNever(tools, 'send_note', true)
    expect(next.find((t) => t.name === 'send_note')).toMatchObject({ never: true, tier: 'never' })
    expect(next.find((t) => t.name === 'read_note')).toEqual(tools[0])
  })
})
