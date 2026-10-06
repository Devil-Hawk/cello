import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CELLO_TOOL_NAMES } from '@/lib/agents/tool-names'
import { assertFree, GENERATORS, JUDGE, parseJson } from './free.eval'
import { majority, oldAction, passesNew, passesOld, tally, tokenOf, type CaseSpec } from './score'

const cases = JSON.parse(readFileSync(path.join(__dirname, 'tool-selection.cases.json'), 'utf8')).cases as CaseSpec[]
const SKILLS = ['role-fit', 'tailor-resume', 'cover-letter', 'cold-outreach', 'follow-up', 'company-research', 'visa-sponsorship', 'negotiation', 'search-strategy']
const OLD_TOOLS = ['list_jobs', 'list_runs', 'explain_match', 'get_application', 'list_contacts', 'get_dossier', 'check_sponsorship', 'web_search', 'source_jobs', 'score_jobs', 'optimize_resume', 'tailor_cv', 'draft_outreach', 'research_company', 'research_companies', 'trigger_run', 'search_kb', 'remember_preference']

describe('the tool selection cases', () => {
  it('are thirty, ten of them about delegation, each with ids that are unique', () => {
    expect(cases).toHaveLength(30)
    expect(cases.filter((c) => c.category === 'delegation')).toHaveLength(10)
    expect(new Set(cases.map((c) => c.id)).size).toBe(30)
  })

  it('allow only tools that exist, in both the new and the earlier vocabulary', () => {
    const newOk = new Set<string>([...CELLO_TOOL_NAMES, 'task', 'answer', ...SKILLS.map((s) => `read_file:/skills/${s}/SKILL.md`)])
    const oldOk = new Set<string>([...OLD_TOOLS, 'final', 'ask'])
    for (const c of cases) {
      for (const t of c.allowed_new) expect(newOk.has(t), `${c.id} allows ${t}`).toBe(true)
      for (const t of c.allowed_old) expect(oldOk.has(t), `${c.id} allows ${t} (earlier)`).toBe(true)
      expect(c.allowed_new.length).toBeGreaterThan(0)
      expect(c.allowed_old.length).toBeGreaterThan(0)
    }
  })

  it('never allow an action that sends or saves for a case that did not ask for it', () => {
    for (const c of cases) {
      if (!['s18', 's19'].includes(c.id)) expect(c.allowed_new, c.id).not.toContain('remember')
      if (c.id !== 's22') expect(c.allowed_new, c.id).not.toContain('request_approval')
      if (c.id !== 's23') expect(c.allowed_new, c.id).not.toContain('schedule_task')
    }
  })
})

describe('scoring', () => {
  const single = { category: 'single' as const, allowed_new: ['get_role', 'read_file:/skills/role-fit/SKILL.md', 'answer'] }
  const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args })

  it('names a skill load by its path', () => {
    expect(tokenOf(call('read_file', { file_path: '/skills/role-fit/SKILL.md' }))).toBe('read_file:/skills/role-fit/SKILL.md')
    expect(tokenOf(call('get_role'))).toBe('get_role')
  })

  it('passes when every call is allowed, and fails when any is not', () => {
    expect(passesNew(single, [call('get_role')])).toBe(true)
    expect(passesNew(single, [call('get_role'), call('read_file', { file_path: '/skills/role-fit/SKILL.md' })])).toBe(true)
    expect(passesNew(single, [call('get_role'), call('request_approval')])).toBe(false)
    expect(passesNew(single, [call('read_file', { file_path: '/skills/cover-letter/SKILL.md' })])).toBe(false)
  })

  it('counts a reply with no tool as an answer only where an answer is allowed', () => {
    expect(passesNew(single, [])).toBe(true)
    expect(passesNew({ category: 'single', allowed_new: ['get_role'] }, [])).toBe(false)
  })

  it('treats planning as a good first move only for a delegation case', () => {
    expect(passesNew({ category: 'delegation', allowed_new: ['research'] }, [call('write_todos')])).toBe(true)
    expect(passesNew({ category: 'single', allowed_new: ['get_role'] }, [call('write_todos')])).toBe(false)
    expect(passesNew({ category: 'single', allowed_new: ['get_role'] }, [call('write_todos'), call('get_role')])).toBe(true)
    expect(passesNew({ category: 'single', allowed_new: ['get_role'] }, [call('write_todos'), call('research')])).toBe(false)
  })

  it("reads the earlier Copilot's JSON action, in a fence or with text around it", () => {
    expect(oldAction('{"action":"tool","tool":"list_jobs","args":{}}')).toBe('list_jobs')
    expect(oldAction('Sure.\n```json\n{"action":"final","message":"hi"}\n```')).toBe('final')
    expect(oldAction('{"action":"ask","question":"which?"}')).toBe('ask')
    expect(oldAction('I would call list_jobs')).toBe('unparsed')
    expect(passesOld({ allowed_old: ['list_jobs'] }, 'unparsed')).toBe(false)
  })

  it('takes the majority of the models for a case, and tallies by category and by model', () => {
    expect(majority([true, true, false])).toBe(true)
    expect(majority([true, false, false])).toBe(false)
    expect(majority([true, false])).toBe(false)
    const t = tally([
      { category: 'delegation', byModel: { a: true, b: true, c: false } },
      { category: 'delegation', byModel: { a: false, b: false, c: true } },
      { category: 'single', byModel: { a: true, b: true, c: true } },
    ])
    expect(t).toMatchObject({ overall: 2 / 3, delegation: 0.5, single: 1, cases: 3 })
    expect(t.perModel).toEqual({ a: 2 / 3, b: 2 / 3, c: 2 / 3 })
  })
})

describe('free models only', () => {
  it('refuses a model that is not free, so an eval cannot spend money', () => {
    expect(() => assertFree('anthropic/claude-3.5-sonnet')).toThrow(/not a :free model/)
    expect(() => assertFree('qwen/qwen3.8-27b:free')).not.toThrow()
    for (const m of [...GENERATORS, JUDGE]) expect(m.endsWith(':free')).toBe(true)
  })

  it('judges with a different family than the generators it judges', () => {
    const family = (m: string) => m.split('/')[0]
    expect([...GENERATORS].slice(0, 2).map(family)).not.toContain(family(JUDGE))
  })

  it('reads a JSON object out of text around it', () => {
    expect(parseJson('here: {"a":1} done')).toEqual({ a: 1 })
    expect(parseJson('```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(parseJson('nothing')).toBeNull()
  })
})
