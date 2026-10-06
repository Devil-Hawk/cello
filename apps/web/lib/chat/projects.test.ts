import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { ensureProject, joinApplication } from './projects'

// The reader behind ensureProject reads a role through the scoring module; applications need only their own table.
vi.mock('@/lib/agents/scoring-port', () => ({ roleView: vi.fn() }))

const seed = () =>
  makeFakeAdmin(
    {
      applications: [
        { id: 'app1', user_id: 'u1', stage: 'applied', applied_at: null, jobs: { title: 'Senior Backend Engineer, Payments', companies: { name: 'Vantage Loom' } } },
        { id: 'app2', user_id: 'u2', stage: 'applied', applied_at: null, jobs: { title: 'Other', companies: { name: 'Other Co' } } },
      ],
      projects: [],
      chats: [
        { id: 'c1', user_id: 'u1', project_id: null },
        { id: 'c2', user_id: 'u1', project_id: null },
        { id: 'c3', user_id: 'u1', project_id: 'existing' },
      ],
    },
    { projects: { unique: [['application_id']] } }
  )

describe('ensureProject', () => {
  it('makes the application\'s group once, titled from its role and company, however many chats ask', async () => {
    const db = seed()
    const [a, b] = await Promise.all([ensureProject(db, 'u1', 'app1'), ensureProject(db, 'u1', 'app1')])
    expect(a).toBeTruthy()
    expect(a).toBe(b)
    expect(db.tables.projects).toHaveLength(1)
    expect(db.tables.projects[0]).toMatchObject({ user_id: 'u1', kind: 'application', application_id: 'app1', created_by: 'code', title: 'Vantage Loom: Senior Backend Engineer, Payments' })
  })

  it('refuses another person\'s application', async () => {
    const db = seed()
    expect(await ensureProject(db, 'u1', 'app2')).toBeNull()
    expect(db.tables.projects).toHaveLength(0)
  })
})

describe('joinApplication', () => {
  it('puts a chat started from the application in its group, and leaves a chat that already has one', async () => {
    const db = seed()
    expect(await joinApplication(db, 'u1', 'c1', 'app1')).toBe(true)
    expect(await joinApplication(db, 'u1', 'c2', 'app1')).toBe(true)
    expect(db.tables.chats[0].project_id).toBe(db.tables.chats[1].project_id)
    expect(db.tables.chats[0].project_id).toBe(db.tables.projects[0].id)
    expect(await joinApplication(db, 'u1', 'c3', 'app1')).toBe(false)
    expect(db.tables.chats[2].project_id).toBe('existing')
  })
})

describe('nothing shows a group', () => {
  // Directive 42: the person never sees one. No page, route or component names it.
  const roots = ['app/(app)/chat', 'app/(app)/ask', 'app/api/chat', 'components/chat']
  const files = (dir: string): string[] =>
    statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir).flatMap((f) => files(path.join(dir, f))) : /\.(ts|tsx)$/.test(dir) && !/\.test\./.test(dir) ? [dir] : []

  it('has no screen, route or component that says the word', () => {
    const offenders = roots.flatMap(files).filter((f) => /project/i.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
