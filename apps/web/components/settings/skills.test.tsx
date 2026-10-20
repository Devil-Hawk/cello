// The skills page: Cello's own skills with why one is off on a kind of model, the person's skills with their switch
// and Delete, pasting a SKILL.md and importing a folder. No DOM renderer exists here, so the page is views of state
// (markup) plus the functions that read a folder and talk to /api/settings/skills (fetch mocked).

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CelloSkillsView,
  INTRO,
  Skills,
  YoursView,
  readFolder,
  removeSkill,
  sendSkill,
  setSkillEnabled,
  type CelloSkillView,
  type FolderFile,
  type PersonSkillView,
} from './skills'

const text = (s: string) => s.replace(/<!-- -->/g, '')
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))
const file = (path: string, body: string, size = body.length): FolderFile => ({ path, size, text: async () => body })
const calls = (f: ReturnType<typeof reply>) => f.mock.calls as unknown as [string, RequestInit][]

const cello: CelloSkillView[] = [
  {
    name: 'find-roles',
    description: 'Use when the person asks for roles to look at.',
    tiers: { free: { on: true, reason: null }, local: { on: false, reason: 'Not measured on this kind of model yet.' }, paid: { on: false, reason: 'Picked 2 of 3 times, it needs 3 of 3.' } },
  },
]
const mine: PersonSkillView[] = [
  { id: 'k1', name: 'tone-check', description: 'Use when a draft sounds stiff.', source: 'Pasted', enabled: true, created_at: '2026-10-20T10:00:00Z' },
  { id: 'k2', name: 'visa-notes', description: 'Use for visa questions.', source: 'Folder: visa-notes', enabled: false, created_at: '2026-10-20T11:00:00Z' },
]

describe('the page', () => {
  it('says what a skill is and starts with nothing to read yet', () => {
    const out = text(renderToStaticMarkup(<Skills />))
    expect(out).toContain('A skill tells Cello how to do one thing. It never gives Cello a new tool.')
    expect(INTRO).toBe('A skill tells Cello how to do one thing. It never gives Cello a new tool.')
    expect(out).toContain('Reading your skills')
  })

  it('offers pasting and a folder import', () => {
    const out = text(renderToStaticMarkup(<Skills />))
    expect(out).toContain('Paste a SKILL.md')
    expect(out).toContain('>Add skill<')
    expect(out).toContain('Import a folder')
    expect(out).toContain('type="file"')
    expect(out).toContain('webkitdirectory')
  })
})

describe('Cello\'s skills', () => {
  it('shows the label, the description and a line per kind of model, with no switch', () => {
    const out = text(renderToStaticMarkup(<CelloSkillsView skills={cello} />))
    expect(out).toContain('Find roles')
    expect(out).toContain('Use when the person asks for roles to look at.')
    expect(out).toContain('Free models: On')
    expect(out).toContain('Models on this computer: Off. Not measured on this kind of model yet.')
    expect(out).toContain('Paid models: Off. Picked 2 of 3 times, it needs 3 of 3.')
    expect(out).not.toContain('role="switch"')
  })
})

describe('Yours', () => {
  const view = (skills: PersonSkillView[], busy: string | null = null) =>
    text(renderToStaticMarkup(<YoursView skills={skills} busy={busy} onToggle={() => undefined} onDelete={() => undefined} />))

  it('names the next step when there is none', () => {
    expect(view([])).toContain('You have not added a skill yet. Paste a SKILL.md or import a folder.')
  })

  it('shows source, that nothing measured it, a switch named for the skill and Delete', () => {
    const out = view(mine)
    expect(out).toContain('tone-check')
    expect(out).toContain('Use when a draft sounds stiff.')
    expect(out).toContain('Pasted')
    expect(out).toContain('Folder: visa-notes')
    expect(out).toContain('Not measured: no eval set')
    expect(out).toContain('aria-label="Use tone-check"')
    expect(out).toContain('role="switch"')
    expect(out.match(/checked=""/g)?.length).toBe(1)
    expect(out.match(/>Delete</g)?.length).toBe(2)
    expect(out).toContain('min-h-11')
  })

  it('locks a row while its change is being saved', () => {
    expect(view(mine, 'k1').match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('readFolder', () => {
  it('refuses a folder with no SKILL.md at its top, before anything is sent', async () => {
    const r = await readFolder([file('pack/docs/SKILL.md', 'nested'), file('pack/notes.md', 'x')])
    expect(r).toEqual({ ok: false, message: 'That folder has no SKILL.md.', fix: 'Pick the folder that holds it.' })
  })

  it('takes SKILL.md as the skill, the other .md files as references with paths inside the folder, and the folder\'s name', async () => {
    const r = await readFolder([
      file('pack/SKILL.md', '---\nname: pack\n---\nBody'),
      file('pack/refs/a.md', 'A'),
      file('pack/b.md', 'B'),
      file('pack/image.png', 'nope'),
      file('pack/.git/config.md', 'hidden'),
    ])
    expect(r).toEqual({
      ok: true,
      markdown: '---\nname: pack\n---\nBody',
      references: [
        { path: 'refs/a.md', text: 'A' },
        { path: 'b.md', text: 'B' },
      ],
      folder: 'pack',
    })
  })

  it('refuses more than 200 KB in all without reading the files', async () => {
    const big = file('pack/refs/big.md', '', 150_000)
    const spy = vi.spyOn(big, 'text')
    const r = await readFolder([file('pack/SKILL.md', 'x', 60_000), big])
    expect(r).toEqual({ ok: false, message: 'That is more than 200 KB.', fix: 'Remove some files and try again.' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('talking to the skills route', () => {
  it('posts pasted text as markdown', async () => {
    const f = reply(200, { skill: mine[0] })
    expect(await sendSkill({ markdown: '---\n---' }, f)).toEqual({ ok: true, skill: mine[0] })
    const [url, init] = calls(f)[0]
    expect(url).toBe('/api/settings/skills')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ markdown: '---\n---' })
  })

  it('posts a folder with its references and name', async () => {
    const f = reply(200, { skill: mine[1] })
    await sendSkill({ markdown: 'm', references: [{ path: 'a.md', text: 'A' }], folder: 'pack' }, f)
    expect(JSON.parse(calls(f)[0][1].body as string)).toEqual({ markdown: 'm', references: [{ path: 'a.md', text: 'A' }], folder: 'pack' })
  })

  it('shows the route\'s message and fix on every refusal', async () => {
    const body = { error: 'exists', message: 'You already have a skill named tone-check.', fix: 'Delete it first, or change the name in the file.' }
    expect(await sendSkill({ markdown: 'm' }, reply(409, body))).toEqual({ ok: false, message: body.message, fix: body.fix })
    const demo = { error: 'demo', message: 'A demo account cannot add skills.', fix: 'Sign up to add your own.' }
    expect(await setSkillEnabled('k1', false, reply(403, demo))).toEqual({ ok: false, message: demo.message, fix: demo.fix })
    expect(await removeSkill('k1', reply(404, { error: 'not_found', message: 'That skill was not found.' }))).toMatchObject({ ok: false, message: 'That skill was not found.' })
  })

  it('says what to do when the request does not arrive', async () => {
    const r = await sendSkill({ markdown: 'm' }, vi.fn(async () => { throw new Error('offline') }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toBeTruthy()
    expect(!r.ok && r.fix).toBeTruthy()
  })

  it('switches a skill with PATCH and deletes it with DELETE', async () => {
    const f = reply(200, { skill: { ...mine[0], enabled: false } })
    expect(await setSkillEnabled('k1', false, f)).toEqual({ ok: true })
    expect(calls(f)[0][0]).toBe('/api/settings/skills')
    expect(calls(f)[0][1].method).toBe('PATCH')
    expect(JSON.parse(calls(f)[0][1].body as string)).toEqual({ id: 'k1', enabled: false })
    const g = reply(200, { ok: true })
    expect(await removeSkill('k 1', g)).toEqual({ ok: true })
    expect(calls(g)[0][0]).toBe('/api/settings/skills?id=k%201')
    expect(calls(g)[0][1].method).toBe('DELETE')
  })
})
