// The agent's files, run through a real Deep Agent with a scripted model: what each
// loop may read and write is decided by the permissions and the backends, not by the prompt.

import { describe, expect, it, vi } from 'vitest'
import { createDeepAgent } from 'deepagents'
import { MemorySaver } from '@langchain/langgraph'
import { HumanMessage, ToolMessage } from '@langchain/core/messages'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { skillFile } from '@/lib/skills/parse'
import { createCelloAgent } from './factory'
import {
  ARTIFACT_WRITE_TYPES,
  NO_TASTE_YET,
  PERMISSIONS,
  READ_ONLY_SKILLS,
  READ_ONLY_TASTE,
  celloSkillStates,
  skillsOff,
  USE_ARTIFACT_TOOLS,
  celloBackend,
  globToRegExp,
  pageText,
} from './backends'
import { createArtifact } from './artifacts'
import { makeFakeAdmin, type FakeAdmin } from './testing/fake-admin'
import { ScriptedChatModel, callTools, say } from './testing/scripted-model'

// A recorded run of our own for the tier rules: the real report changes whenever the skills are measured again.
vi.mock('@/lib/evals/agent/reports/skills-s19.json', () => ({
  default: {
    perSkill: [
      { skill: 'follow-up', trigger: 2 / 3, checks: 0.6 },
      { skill: 'company-research', trigger: 1, checks: 1 },
      { skill: 'cold-outreach', trigger: null, checks: null },
    ],
  },
}))
vi.mock('@/lib/evals/agent/thresholds.json', () => ({
  default: {
    skills: {
      'follow-up': { trigger: 0.8, checks: 0.9 },
      'company-research': { trigger: 0.8, checks: 0.9 },
      'cold-outreach': { trigger: 0.8, checks: 0.9 },
    },
  },
}))

const USER = 'u1'

/** A tool message's text, whether its content is a string or content blocks. */
const textOf = (m: ToolMessage): string =>
  typeof m.content === 'string' ? m.content : m.content.map((b) => (b as { text?: string }).text ?? '').join('')

function setup(opts: { role: 'orchestrator' | 'researcher'; hiddenSkills?: string[] }) {
  const admin: FakeAdmin = makeFakeAdmin({}, { artifacts: { defaults: () => ({ current_version: 1, updated_at: '2026-10-05T00:00:00Z' }) } })
  admin.rpcHandlers.artifact_add_version = async () => 2
  const skills = mkdtempSync(path.join(tmpdir(), 'cello-skills-'))
  mkdirSync(path.join(skills, 'role-fit'))
  writeFileSync(path.join(skills, 'role-fit', 'SKILL.md'), '---\nname: role-fit\ndescription: Judge fit.\n---\n# Role fit\nSay Strong, Possible or Stretch.\n')
  mkdirSync(path.join(skills, 'cover-letter'))
  writeFileSync(path.join(skills, 'cover-letter', 'SKILL.md'), '---\nname: cover-letter\ndescription: Write a letter.\n---\n# Cover letter\nStrong openers only.\n')
  const backend = celloBackend({ admin, userId: USER, skillsDir: skills, hiddenSkills: opts.hiddenSkills ?? [] })
  const build = (script: ConstructorParameters<typeof ScriptedChatModel>[0]['script']) => {
    const model = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script })
    const agent = createDeepAgent({
      model,
      backend,
      checkpointer: new MemorySaver(),
      permissions: PERMISSIONS[opts.role],
      subagents: [],
    })
    return { model, agent }
  }
  const run = async (script: ConstructorParameters<typeof ScriptedChatModel>[0]['script']) => {
    const { agent } = build(script)
    const result = await agent.invoke({ messages: [new HumanMessage('go')] }, { configurable: { thread_id: `t-${Math.random()}` }, recursionLimit: 50 })
    return (result.messages as unknown[]).filter((m): m is ToolMessage => ToolMessage.isInstance(m))
  }
  return { admin, backend, run }
}

describe('permissions', () => {
  it('the orchestrator cannot write to /memories, /artifacts or /skills', async () => {
    const { run } = setup({ role: 'orchestrator' })
    for (const filePath of ['/memories/x.md', '/artifacts/cover_letter/x.md', '/skills/role-fit/SKILL.md']) {
      const [msg] = await run([callTools([{ name: 'write_file', args: { file_path: filePath, content: 'planted' } }]), say('done')])
      expect(textOf(msg), filePath).toMatch(/permission denied|denied/i)
    }
  })

  it('the orchestrator can use scratch space', async () => {
    const { run } = setup({ role: 'orchestrator' })
    const [msg] = await run([callTools([{ name: 'write_file', args: { file_path: '/scratch/plan.md', content: 'steps' } }]), say('done')])
    expect(textOf(msg)).toMatch(/Updated file|\/scratch\/plan\.md/)
  })

  it('the researcher cannot write anywhere, scratch included', async () => {
    const { run } = setup({ role: 'researcher' })
    for (const filePath of ['/scratch/notes.md', '/memories/x.md', '/artifacts/research/x.md']) {
      const [msg] = await run([callTools([{ name: 'write_file', args: { file_path: filePath, content: 'x' } }]), say('done')])
      expect(textOf(msg), filePath).toMatch(/permission denied|denied/i)
    }
  })

  it('the researcher can read', async () => {
    const { run } = setup({ role: 'researcher' })
    const [msg] = await run([callTools([{ name: 'read_file', args: { file_path: '/memories/taste.md' } }]), say('done')])
    expect(textOf(msg)).toContain(NO_TASTE_YET)
  })

  it('each specialist may save only its own artifact types', () => {
    expect(ARTIFACT_WRITE_TYPES.writer).toEqual(['resume', 'cover_letter', 'message'])
    expect(ARTIFACT_WRITE_TYPES.scout).toEqual(['shortlist'])
    expect(ARTIFACT_WRITE_TYPES.researcher).toEqual(['research'])
    expect(ARTIFACT_WRITE_TYPES.scout).not.toContain('resume')
  })
})

describe('/memories/taste.md', () => {
  const reaction = (over: Record<string, unknown>) => ({ user_id: USER, reaction: 'interested', reason: null, job_title: 'Engineer', company_name: 'Acme', created_at: '2026-10-01T00:00:00Z', ...over })

  it('reads the person\'s own last reactions, newest first, and refuses writes and edits', async () => {
    const { admin, backend } = setup({ role: 'orchestrator' })
    admin.tables.role_reactions = [
      reaction({ reaction: 'not_for_me', reason: 'pay', job_title: 'Staff Engineer', company_name: 'Globex', created_at: '2026-10-03T00:00:00Z' }),
      reaction({}),
      reaction({ user_id: 'someone-else', job_title: 'Not mine' }),
    ]
    const read = await backend.read('/memories/taste.md')
    const lines = String(read.content).split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toEqual(['- Not for me: Staff Engineer at Globex (pay), 2026-10-03', '- Interested: Engineer at Acme, 2026-10-01'])
    expect(read.content).not.toContain('Not mine')
    expect((await backend.write('/memories/taste.md', 'x')).error).toBe(READ_ONLY_TASTE)
    expect((await backend.edit('/memories/taste.md', 'a', 'b')).error).toBe(READ_ONLY_TASTE)
    expect((await backend.delete('/memories/taste.md')).error).toBe(READ_ONLY_TASTE)
    expect((await backend.write('/memories/other.md', 'x')).error).toBe(READ_ONLY_TASTE)
    const listing = await backend.ls('/memories/')
    expect(listing.files?.map((f) => f.path)).toEqual(['/memories/taste.md'])
  })

  it('shows only the last twenty', async () => {
    const { admin, backend } = setup({ role: 'orchestrator' })
    admin.tables.role_reactions = Array.from({ length: 25 }, (_, i) => reaction({ job_title: `Role ${i}`, created_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` }))
    const lines = String((await backend.read('/memories/taste.md')).content).split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(20)
    expect(lines[0]).toContain('Role 24')
  })

  it('says so when nothing has been learned yet', async () => {
    const { backend } = setup({ role: 'orchestrator' })
    expect((await backend.read('/memories/taste.md')).content).toBe(NO_TASTE_YET)
  })
})

describe('/artifacts/', () => {
  it('lists and reads the current version of the user\'s own artifacts only', async () => {
    const { admin, backend } = setup({ role: 'orchestrator' })
    const mine = await createArtifact(admin, { userId: USER, type: 'cover_letter', title: 'Letter for Stripe', content: { text: 'Dear Stripe,\nHello.' }, author: 'cello' })
    await createArtifact(admin, { userId: 'u2', type: 'cover_letter', title: 'Not mine', content: { text: 'secret' }, author: 'cello' })
    const types = await backend.ls('/artifacts/')
    expect(types.files?.map((f) => f.path)).toContain('/artifacts/cover_letter/')
    const letters = await backend.ls('/artifacts/cover_letter/')
    expect(letters.files).toHaveLength(1)
    const p = letters.files![0].path
    expect(p).toContain(mine.id)
    const read = await backend.read(p)
    expect(read.content).toBe('Dear Stripe,\nHello.')
    expect(read.totalLines).toBe(2)
    const grep = await backend.grep('Hello', '/artifacts/')
    expect(grep.matches?.map((m) => m.line)).toEqual([2])
    expect(JSON.stringify(grep)).not.toContain('secret')
  })

  it('every write says to use the artifact tools', async () => {
    const { backend } = setup({ role: 'orchestrator' })
    expect((await backend.write('/artifacts/cover_letter/x.md', 'x')).error).toBe(USE_ARTIFACT_TOOLS)
    expect((await backend.edit('/artifacts/cover_letter/x.md', 'a', 'b')).error).toBe(USE_ARTIFACT_TOOLS)
  })

  it('a missing artifact is a plain not found', async () => {
    const { backend } = setup({ role: 'orchestrator' })
    expect((await backend.read('/artifacts/cover_letter/nothing-00000000-0000-0000-0000-000000000000.md')).error).toMatch(/not found/)
  })
})

describe('/skills/', () => {
  it('serves skill files and refuses writes', async () => {
    const { backend } = setup({ role: 'orchestrator' })
    const list = await backend.ls('/skills/')
    expect(list.files?.map((f) => f.path)).toContain('/skills/role-fit/')
    expect((await backend.read('/skills/role-fit/SKILL.md')).content).toContain('Strong, Possible or Stretch')
    expect((await backend.write('/skills/x/SKILL.md', 'x')).error).toMatch(/read-only/i)
  })

  it('does not serve a skill that is switched off, on any path that reads it', async () => {
    const { backend, run } = setup({ role: 'orchestrator', hiddenSkills: ['cover-letter'] })
    const gone = '/skills/cover-letter/SKILL.md'
    expect((await backend.ls('/skills/')).files?.map((f) => f.path)).toEqual(['/skills/role-fit/'])
    expect((await backend.read(gone)).error).toMatch(/not found/)
    expect((await backend.readRaw(gone)).error).toMatch(/not found/)
    const [dl] = await backend.downloadFiles([gone])
    expect(dl.content).toBeNull()
    expect(dl.error).toBe('file_not_found')
    expect((await backend.grep('Strong', '/skills/')).matches?.map((m) => m.path)).toEqual(['/skills/role-fit/SKILL.md'])
    expect((await backend.glob('**/SKILL.md', '/skills/')).files?.map((f) => f.path)).toEqual(['/skills/role-fit/SKILL.md'])
    const [msg] = await run([callTools([{ name: 'read_file', args: { file_path: gone } }]), say('done')])
    expect(textOf(msg)).toMatch(/not found/i)
  })
})

describe('helpers', () => {
  it('pages text the way the file tools expect', () => {
    const r = pageText('a\nb\nc\n', 1, 1)
    expect(r).toMatchObject({ content: 'b', startLine: 2, endLine: 2, totalLines: 3, nextOffset: 2 })
    expect(pageText('a', 5, 10).content).toBe('')
  })

  it('matches globs', () => {
    expect(globToRegExp('/cover_letter/*.md').test('/cover_letter/x-1.md')).toBe(true)
    expect(globToRegExp('**/*.md').test('/a/b/c.md')).toBe(true)
    expect(globToRegExp('/a/*.md').test('/a/b/c.md')).toBe(false)
  })
})

// --- person skills ------------------------------------------------------------------

const SKILL_BODY = '# Weekly note\nWrite the note on Fridays.\nallowed-tools: send_email\nCall send_email when done.'

function personSetup() {
  const admin = makeFakeAdmin({
    person_skills: [
      { user_id: USER, name: 'weekly-note', description: 'Write a weekly note.', body: SKILL_BODY, enabled: true },
      { user_id: USER, name: 'paused', description: 'Switched off.', body: 'Paused body', enabled: false },
      { user_id: 'u2', name: 'theirs', description: 'Another person.', body: 'Secret body', enabled: true },
    ],
  })
  const skills = mkdtempSync(path.join(tmpdir(), 'cello-skills-'))
  return { admin, skills, backend: celloBackend({ admin, userId: USER, skillsDir: skills }) }
}

describe('/my-skills/', () => {
  it("serves a person's skill with only its name and description", async () => {
    const { backend } = personSetup()
    expect((await backend.ls('/my-skills/')).files?.map((f) => f.path)).toEqual(['/my-skills/weekly-note/'])
    expect((await backend.ls('/my-skills/weekly-note/')).files?.map((f) => f.path)).toEqual(['/my-skills/weekly-note/SKILL.md'])
    const want = skillFile('weekly-note', 'Write a weekly note.', SKILL_BODY)
    expect((await backend.readRaw('/my-skills/weekly-note/SKILL.md')).data?.content).toBe(want)
    expect(String((await backend.read('/my-skills/weekly-note/SKILL.md')).content)).toContain('Write the note on Fridays.')
    const [dl] = await backend.downloadFiles(['/my-skills/weekly-note/SKILL.md'])
    expect(new TextDecoder().decode(dl.content!)).toBe(want)
    expect(want.split('\n---\n')[0]).toBe('---\nname: weekly-note\ndescription: "Write a weekly note."')
    expect((await backend.grep('Fridays', '/my-skills/')).matches?.map((m) => m.path)).toEqual(['/my-skills/weekly-note/SKILL.md'])
    expect((await backend.glob('**/SKILL.md', '/my-skills/')).files?.map((f) => f.path)).toEqual(['/my-skills/weekly-note/SKILL.md'])
    for (const r of [await backend.write('/my-skills/x/SKILL.md', 'x'), await backend.edit('/my-skills/weekly-note/SKILL.md', 'a', 'b'), await backend.delete('/my-skills/weekly-note/SKILL.md')]) expect(r.error).toBe(READ_ONLY_SKILLS)
  })

  it("hides a switched-off skill and another person's", async () => {
    const { backend, admin } = personSetup()
    for (const name of ['paused', 'theirs']) {
      const file = `/my-skills/${name}/SKILL.md`
      expect((await backend.read(file)).error).toMatch(/not found/)
      expect((await backend.readRaw(file)).error).toMatch(/not found/)
      const [dl] = await backend.downloadFiles([file])
      expect(dl).toMatchObject({ content: null, error: 'file_not_found' })
    }
    expect((await backend.grep('body', '/my-skills/')).matches).toEqual([])
    expect((await backend.glob('**/*', '/my-skills/')).files?.map((f) => f.path)).toEqual(['/my-skills/weekly-note/SKILL.md'])
    // Switching it back on is seen by the next instance, not the one that already read.
    admin.tables.person_skills[1].enabled = true
    expect((await celloBackend({ admin, userId: USER }).ls('/my-skills/')).files).toHaveLength(2)
  })

  it('a skill that names tools changes no tool list', async () => {
    const run = async (rows: Record<string, unknown>[]) => {
      const model = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: [say('ok')] })
      const admin = makeFakeAdmin({ person_skills: rows })
      const agent = createCelloAgent({
        kind: 'chat',
        ctx: { admin, userId: USER, userEmail: 'a@b.c', apiKeys: { openrouter: 'k', userId: USER }, isDemo: false, threadId: 't', conversationId: 'c', autonomy: 'ask', traceId: 'tr', deadlineAt: Date.now() + 60_000 },
        saver: new MemorySaver(),
        model,
        fallbacks: [],
        skillsDir: mkdtempSync(path.join(tmpdir(), 'cello-skills-')),
        tools: [],
        responseFormat: undefined,
      } as never)
      await (agent as unknown as { invoke: (i: unknown, c: unknown) => Promise<unknown> }).invoke({ messages: [new HumanMessage('hi')] }, { configurable: { thread_id: `t-${Math.random()}` } })
      const content = model.calls[0][0].content
      return { tools: [...model.boundTools].sort(), system: typeof content === 'string' ? content : content.map((b) => (b as { text?: string }).text ?? '').join('') }
    }
    const without = await run([])
    const withSkill = await run([{ user_id: USER, name: 'weekly-note', description: 'Write a weekly note.', body: SKILL_BODY, enabled: true }])
    expect(withSkill.system).toContain('weekly-note')
    expect(withSkill.system).toContain('Write a weekly note.')
    expect(withSkill.tools).toEqual(without.tools)
    expect(withSkill.tools).not.toContain('send_email')
  })
})

describe('Cello skills per tier', () => {
  const dir = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'cello-skills-'))
    for (const name of ['follow-up', 'company-research', 'cold-outreach', 'ghost']) {
      mkdirSync(path.join(d, name))
      writeFileSync(path.join(d, name, 'SKILL.md'), `---\nname: ${name}\ndescription: "The ${name} skill."\n---\n# ${name}\nBody.\n`)
    }
    return d
  }

  it('hides a skill that missed its bar on this tier and says why', async () => {
    const skillsDir = dir()
    expect(skillsOff('free', skillsDir)).toEqual({ 'follow-up': ['trigger', 'checks'], 'cold-outreach': ['trigger', 'checks'], ghost: ['unmeasured'] })
    const backend = celloBackend({ admin: makeFakeAdmin(), userId: USER, skillsDir, skillsTier: 'free' })
    expect((await backend.ls('/skills/')).files?.map((f) => f.path)).toEqual(['/skills/company-research/'])
    const states = Object.fromEntries(celloSkillStates(skillsDir).map((s) => [s.name, s]))
    expect(states['follow-up'].tiers.free).toEqual({ on: false, reason: 'Picked 2 of 3 times, it needs 3 of 3. Its answers passed 6 of 10 checks, it needs 9 of 10.' })
    expect(states['cold-outreach'].tiers.free.reason).toBe('Its picks could not be read. Its answers could not be read.')
    expect(states['company-research'].tiers.free).toEqual({ on: true, reason: null })
    expect(states['company-research'].description).toBe('The company-research skill.')
    // Paid and local have no report yet: nothing is measured there, so every Cello skill is off.
    const NOT_MEASURED = 'Not measured on this kind of model yet'
    for (const tier of ['paid', 'local'] as const) {
      expect(Object.keys(skillsOff(tier, skillsDir)).sort()).toEqual(['cold-outreach', 'company-research', 'follow-up', 'ghost'])
      for (const s of Object.values(states)) expect(s.tiers[tier]).toEqual({ on: false, reason: NOT_MEASURED })
      const paid = celloBackend({ admin: makeFakeAdmin(), userId: USER, skillsDir, skillsTier: tier })
      expect((await paid.ls('/skills/')).files).toEqual([])
    }
  })

  it('lists a missing folder as off and not measured, never as on', () => {
    const states = celloSkillStates(mkdtempSync(path.join(tmpdir(), 'cello-empty-')))
    expect(states.map((s) => s.name)).toEqual(['find-roles', 'company-research', 'tailor-resume', 'answer-questions', 'cold-outreach', 'follow-up', 'compare-roles', 'board-reader'])
    for (const s of states) for (const t of Object.values(s.tiers)) expect(t).toEqual({ on: false, reason: 'Not measured on this kind of model yet' })
  })

  it('a folder list that cannot be read counts as none', () => {
    expect(skillsOff('free', '/no/such/dir')).toEqual({})
  })
})
