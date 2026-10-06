// The agent's files, run through a real Deep Agent with a scripted model: what each
// loop may read and write is decided by the permissions and the backends, not by the prompt.

import { describe, expect, it } from 'vitest'
import { createDeepAgent } from 'deepagents'
import { MemorySaver } from '@langchain/langgraph'
import { HumanMessage, ToolMessage } from '@langchain/core/messages'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ARTIFACT_WRITE_TYPES,
  NO_TASTE_YET,
  PERMISSIONS,
  READ_ONLY_TASTE,
  USE_ARTIFACT_TOOLS,
  celloBackend,
  globToRegExp,
  pageText,
} from './backends'
import { createArtifact } from './artifacts'
import { makeFakeAdmin, type FakeAdmin } from './testing/fake-admin'
import { ScriptedChatModel, callTools, say } from './testing/scripted-model'

const USER = 'u1'

/** A tool message's text, whether its content is a string or content blocks. */
const textOf = (m: ToolMessage): string =>
  typeof m.content === 'string' ? m.content : m.content.map((b) => (b as { text?: string }).text ?? '').join('')

function setup(opts: { role: 'orchestrator' | 'researcher' }) {
  const admin: FakeAdmin = makeFakeAdmin({}, { artifacts: { defaults: () => ({ current_version: 1, updated_at: '2026-10-05T00:00:00Z' }) } })
  admin.rpcHandlers.artifact_add_version = async () => 2
  const skills = mkdtempSync(path.join(tmpdir(), 'cello-skills-'))
  mkdirSync(path.join(skills, 'role-fit'))
  writeFileSync(path.join(skills, 'role-fit', 'SKILL.md'), '---\nname: role-fit\ndescription: Judge fit.\n---\n# Role fit\nSay Strong, Possible or Stretch.\n')
  const backend = celloBackend({ admin, userId: USER, skillsDir: skills })
  const build = (script: ConstructorParameters<typeof ScriptedChatModel>[0]['script']) => {
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script })
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
