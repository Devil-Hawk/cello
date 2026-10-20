import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CELLO_TOOL_NAMES } from '@/lib/agents/tool-names'
import { agentView } from '@/lib/commands'
import { toolName } from '@/lib/commands/views'
import { SkillEvalsSchema, runCheck, runChecks, skillsRead, type Check } from './agent-checks'

// The doors module imports the cookie-backed client; nothing here calls it.
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))

const SKILLS_DIR = path.join(process.cwd(), 'skills')
const NAMES = ['answer-questions', 'board-reader', 'cold-outreach', 'company-research', 'compare-roles', 'cover-letter', 'find-roles', 'follow-up', 'negotiation', 'reply', 'role-fit', 'search-strategy', 'tailor-resume', 'visa-sponsorship']
// Cello's own skills for Chat (lib/agents/backends.ts CELLO_SKILLS). The other six are kept as they were.
const CELLO_V2 = ['find-roles', 'company-research', 'tailor-resume', 'answer-questions', 'cold-outreach', 'follow-up', 'compare-roles', 'board-reader']
// What Chat can call: every command in its view, plus the Researcher it hands research to and the file reader.
const CHAT_TOOLS = new Set<string>([...agentView().map(toolName), 'task', 'read_file'])

describe('the checks', () => {
  const c = (check: Record<string, unknown>): Check => ({ ...check, note: 'n' }) as Check

  it('matches and not_matches', () => {
    expect(runCheck(c({ type: 'matches', pattern: 'band', flags: 'i' }), 'The BAND is Strong').ok).toBe(true)
    expect(runCheck(c({ type: 'matches', pattern: 'band' }), 'nothing').ok).toBe(false)
    expect(runCheck(c({ type: 'not_matches', pattern: '\\d+%' }), 'a 40% match').ok).toBe(false)
    expect(runCheck(c({ type: 'not_matches', pattern: '\\d+%' }), 'a strong match').ok).toBe(true)
  })

  it('counts words', () => {
    expect(runCheck(c({ type: 'max_words', value: 3 }), 'one two three').ok).toBe(true)
    expect(runCheck(c({ type: 'max_words', value: 3 }), 'one two three four').ok).toBe(false)
    expect(runCheck(c({ type: 'min_words', value: 3 }), 'one two').ok).toBe(false)
    expect(runCheck(c({ type: 'max_words', value: 3 }), '   ').ok).toBe(true)
  })

  it('looks before and after a marker', () => {
    const text = 'Built billing at Acme.\n\nNot added: Kubernetes'
    expect(runCheck(c({ type: 'before_not_matches', marker: 'Not added:', pattern: 'Kubernetes' }), text).ok).toBe(true)
    expect(runCheck(c({ type: 'before_not_matches', marker: 'Not added:', pattern: 'Kubernetes' }), 'Runs Kubernetes.\n\nNot added: none').ok).toBe(false)
    expect(runCheck(c({ type: 'after_matches', marker: 'Not added:', pattern: 'Kubernetes' }), text).ok).toBe(true)
    // No marker at all: nothing is "after" it, so the answer left out the section it was told to write.
    expect(runCheck(c({ type: 'after_matches', marker: 'Not added:', pattern: 'Kubernetes' }), 'Runs Kubernetes.').ok).toBe(false)
    expect(runCheck(c({ type: 'before_not_matches', marker: 'Not added:', pattern: 'Kubernetes' }), 'Runs Kubernetes.').ok).toBe(false)
  })

  it('allows only the urls it was given, ignoring trailing punctuation', () => {
    const check = c({ type: 'urls_subset', allowed: ['https://a.example/about'] })
    expect(runCheck(check, 'See https://a.example/about.').ok).toBe(true)
    expect(runCheck(check, 'See (https://a.example/about) and https://b.example/x').ok).toBe(false)
    expect(runCheck(check, 'No links.').ok).toBe(true)
  })

  it('reports what failed', () => {
    const out = runChecks([c({ type: 'matches', pattern: 'x' }), c({ type: 'not_matches', pattern: 'y' })], 'y')
    expect(out).toMatchObject({ passed: 0, total: 2 })
    expect(out.failures).toHaveLength(2)
  })

  it('reads which skills a first action loaded', () => {
    expect(
      skillsRead([
        { name: 'read_file', args: { file_path: '/skills/role-fit/SKILL.md' } },
        { name: 'read_file', args: { file_path: '/skills/cover-letter/SKILL.md' } },
        { name: 'read_file', args: { file_path: '/memories/taste.md' } },
        { name: 'get_role', args: { id: 'x' } },
      ])
    ).toEqual(['role-fit', 'cover-letter'])
  })
})

describe('the skills', () => {
  it('are exactly these', () => {
    expect(readdirSync(SKILLS_DIR).sort()).toEqual([...NAMES].sort())
  })

  for (const name of NAMES) {
    describe(name, () => {
      const skill = readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8')
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? ''
      // The description is a double-quoted YAML scalar. Unquoted, a colon in it breaks the file: the loader
      // skips the whole skill with an error in the log, and the model never learns it exists.
      const rawDescription = /^description:\s*(.+)$/m.exec(frontmatter)?.[1] ?? ''
      const description = rawDescription.startsWith('"') ? (JSON.parse(rawDescription) as string) : ''

      it('has a name that matches its folder and a quoted description that says when to use it', () => {
        expect(rawDescription.startsWith('"')).toBe(true)
        expect(/^name:\s*(.+)$/m.exec(frontmatter)?.[1]).toBe(name)
        expect(description.length).toBeGreaterThan(60)
        expect(description.length).toBeLessThanOrEqual(1024)
        expect(description).toMatch(/\bUse when\b|\bUse this\b|\bUse it\b/)
      })

      it('has no em dash and no engine words for the person to read', () => {
        expect(skill).not.toContain('\u2014')
        expect(skill).not.toMatch(/\b(agent run|thread|graph|tick)\b/i)
      })

      it('calls only tools that exist', () => {
        const allowed = new Set<string>([...CELLO_TOOL_NAMES, ...CHAT_TOOLS, 'write_todos', 'web_search', 'read_page'])
        // A tool is named after "call", "use" or "then" in these files; values such as a type or a section are not.
        const called = [...skill.matchAll(/\b(?:[Cc]all|[Uu]se|then)\s+`([a-z][a-z_]*)`/g)].map((m) => m[1])
        for (const n of called) expect(allowed.has(n), `${name} calls ${n}, which is not a tool`).toBe(true)
      })

      it('has an evals.json with three trigger cases (two load, one does not) and an output case with checks', () => {
        const evals = SkillEvalsSchema.parse(JSON.parse(readFileSync(path.join(SKILLS_DIR, name, 'evals.json'), 'utf8')))
        expect(evals.skill).toBe(name)
        expect(evals.trigger.filter((t) => t.load)).toHaveLength(2)
        expect(evals.trigger.filter((t) => !t.load)).toHaveLength(1)
        for (const o of evals.output) expect(o.checks.length).toBeGreaterThanOrEqual(2)
      })

      it('has output checks that fail on an answer that breaks the skill, so they are not vacuous', () => {
        const evals = SkillEvalsSchema.parse(JSON.parse(readFileSync(path.join(SKILLS_DIR, name, 'evals.json'), 'utf8')))
        for (const o of evals.output) {
          // An empty answer and a rambling em dash answer must each break at least one check.
          expect(runChecks(o.checks, '').failures.length).toBeGreaterThan(0)
          expect(runChecks(o.checks, 'It is fine \u2014 trust me. '.repeat(40)).failures.length).toBeGreaterThan(0)
        }
      })
    })
  }
})

describe('Cello skills for Chat', () => {
  // company-research is also the Researcher's procedure, so its reading steps name the Researcher's own read tools.
  const researcherReads = (name: string) => (name === 'company-research' ? ['web_search', 'read_page'] : [])
  const backticked = (text: string) => [...text.matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1])

  it('has the Chat tools the skills rely on', () => {
    for (const t of ['roles_find', 'roles_get', 'roles_compare', 'companies_get', 'people_find', 'documents_draft', 'applications_start', 'chat_recall', 'postings_read']) expect(CHAT_TOOLS.has(t), t).toBe(true)
  })

  it('every Cello skill names only tools Chat has', () => {
    for (const name of CELLO_V2) {
      const skill = readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8')
      const allowed = new Set<string>([...CHAT_TOOLS, ...researcherReads(name)])
      const called = [...skill.matchAll(/\b(?:[Cc]all|[Uu]se|then)\s+`([a-z][a-z_]*)`/g)].map((m) => m[1])
      // A name shaped like a Chat tool (object_verb) is a tool wherever it appears.
      const shaped = backticked(skill).filter((n) => /^(roles|companies|people|documents|applications|chat|postings)_[a-z]+$/.test(n))
      for (const n of [...called, ...shaped]) expect(allowed.has(n), `${name} names ${n}, which Chat does not have`).toBe(true)
      for (const old of CELLO_TOOL_NAMES) {
        // Names with an underscore are never ordinary words; a single word counts only in backticks.
        const found = old.includes('_') ? new RegExp(`\\b${old}\\b`).test(skill) : backticked(skill).includes(old)
        expect(found, `${name} still names the old tool ${old}`).toBe(false)
      }
    }
  })

  it('opens the skill with the tools that make it work', () => {
    const read = (n: string) => readFileSync(path.join(SKILLS_DIR, n, 'SKILL.md'), 'utf8')
    expect(read('board-reader')).toContain('`postings_read`')
    expect(read('find-roles')).toContain('`roles_find`')
    expect(read('compare-roles')).toContain('`roles_compare`')
    expect(read('company-research')).toContain('`task`')
    expect(read('answer-questions')).toMatch(/demographic/)
    expect(read('answer-questions')).toMatch(/veteran/)
  })
})

