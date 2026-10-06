import { describe, expect, it } from 'vitest'
import { normaliseTitle, ROLE_TYPES, typeTitle } from './index'

const typed = (raw: string, dept?: string) => typeTitle(raw, dept).role_type

// Three titles each type takes and three it does not, written the way a posting writes them.
const CASES: Record<string, { takes: string[]; refuses: string[] }> = {
  'forward-deployed-engineer': { takes: ['Forward Deployed Engineer', 'FDE', 'Deployment Strategist'], refuses: ['Software Engineer', 'Deployment Manager', 'Solutions Engineer'] },
  'ai-engineer': { takes: ['AI Engineer', 'Applied AI Engineer', 'LLM Engineer'], refuses: ['AI Product Manager', 'Machine Learning Engineer', 'Account Executive, AI'] },
  'ml-engineer': { takes: ['Machine Learning Engineer', 'MLE', 'Senior ML Engineer'], refuses: ['Machine Learning Scientist', 'Data Engineer', 'ML Product Manager'] },
  'applied-scientist': { takes: ['Applied Scientist', 'Machine Learning Scientist', 'Applied Research Scientist'], refuses: ['Research Scientist', 'Data Scientist', 'Software Engineer'] },
  'research-engineer': { takes: ['Research Engineer', 'Research Software Engineer', 'AI Research Engineer'], refuses: ['Research Scientist', 'Machine Learning Engineer', 'Software Engineer'] },
  'research-scientist': { takes: ['Research Scientist', 'AI Researcher', 'ML Researcher'], refuses: ['Research Engineer', 'Applied Scientist', 'Data Scientist'] },
  'data-scientist': { takes: ['Data Scientist', 'Senior Product Data Scientist', 'Statistician'], refuses: ['Data Engineer', 'Data Analyst', 'Applied Scientist'] },
  'data-engineer': { takes: ['Data Engineer', 'Data Platform Engineer', 'ETL Developer'], refuses: ['Data Scientist', 'Platform Engineer', 'Analytics Engineer'] },
  'analytics-engineer': { takes: ['Analytics Engineer', 'BI Engineer', 'dbt Developer'], refuses: ['Data Engineer', 'Data Analyst', 'Software Engineer'] },
  'data-analyst': { takes: ['Data Analyst', 'Product Analyst', 'Business Intelligence Analyst'], refuses: ['Business Analyst', 'Data Scientist', 'Data Engineer'] },
  'backend-engineer': { takes: ['Backend Engineer', 'Back-End Developer', 'Software Engineer, Backend'], refuses: ['Frontend Engineer', 'Software Engineer', 'Full Stack Engineer'] },
  'fullstack-engineer': { takes: ['Full Stack Engineer', 'Fullstack Developer', 'Full-Stack Software Engineer'], refuses: ['Backend Engineer', 'Frontend Engineer', 'Software Engineer'] },
  'frontend-engineer': { takes: ['Frontend Engineer', 'Front-End Developer', 'React Developer'], refuses: ['Backend Engineer', 'Mobile Engineer', 'Product Designer'] },
  'mobile-engineer': { takes: ['iOS Engineer', 'Android Developer', 'React Native Engineer'], refuses: ['Frontend Engineer', 'Backend Engineer', 'Software Engineer'] },
  'platform-engineer': { takes: ['Platform Engineer', 'Site Reliability Engineer', 'SRE'], refuses: ['Data Platform Engineer', 'Backend Engineer', 'Security Engineer'] },
  'security-engineer': { takes: ['Security Engineer', 'Application Security Engineer', 'Penetration Tester'], refuses: ['Platform Engineer', 'Software Engineer', 'Security Guard'] },
  'solutions-engineer': { takes: ['Solutions Engineer', 'Sales Engineer', 'Solutions Architect'], refuses: ['Forward Deployed Engineer', 'Account Executive', 'Software Engineer'] },
  'product-engineer': { takes: ['Product Engineer', 'Growth Engineer', 'Software Engineer, Product'], refuses: ['Product Manager', 'Software Engineer', 'Product Designer'] },
  'developer-relations': { takes: ['Developer Advocate', 'Developer Relations Engineer', 'DevRel'], refuses: ['Software Developer', 'Community Manager', 'Solutions Engineer'] },
  'software-engineer': { takes: ['Software Engineer', 'SWE', 'Senior Software Developer'], refuses: ['Backend Engineer', 'Product Manager', 'Data Engineer'] },
  'embedded-engineer': { takes: ['Embedded Engineer', 'Firmware Engineer', 'Robotics Software Engineer'], refuses: ['Software Engineer', 'Platform Engineer', 'Mechanical Engineer'] },
  'quality-engineer': { takes: ['QA Engineer', 'SDET', 'Test Automation Engineer'], refuses: ['Software Engineer', 'Product Manager', 'Security Engineer'] },
  'engineering-manager': { takes: ['Engineering Manager', 'Senior Engineering Manager', 'Director of Engineering'], refuses: ['Product Manager', 'Software Engineer', 'Marketing Manager'] },
  'product-manager': { takes: ['Product Manager', 'Technical Product Manager', 'AI Product Manager'], refuses: ['Software Engineer', 'Product Designer', 'Program Manager'] },
  designer: { takes: ['Product Designer', 'UX Designer', 'Interaction Designer'], refuses: ['Product Manager', 'Frontend Engineer', 'Graphic Designer'] },
  'other-sales': { takes: ['Account Executive', 'Sales Development Representative', 'Business Development Manager'], refuses: ['Software Engineer', 'Product Marketing Manager', 'Sales Engineer'] },
  'other-marketing': { takes: ['Product Marketing Manager', 'Content Marketing Manager', 'Growth Marketing Manager'], refuses: ['Account Executive', 'Product Manager', 'Product Designer'] },
  'other-support': { takes: ['Customer Support Specialist', 'Customer Success Manager', 'Help Desk Technician'], refuses: ['Software Engineer', 'Account Executive', 'Recruiter'] },
  'other-operations': { takes: ['Program Manager', 'Operations Manager', 'Project Manager'], refuses: ['Software Engineer', 'Account Executive', 'Product Manager'] },
  'other-finance': { takes: ['Accountant', 'Financial Analyst', 'Controller'], refuses: ['Data Analyst', 'Software Engineer', 'Recruiter'] },
  'other-hr': { takes: ['Recruiter', 'Talent Acquisition Partner', 'HR Business Partner'], refuses: ['Software Engineer', 'Account Executive', 'Accountant'] },
  'other-legal': { takes: ['Corporate Counsel', 'Paralegal', 'Attorney'], refuses: ['Software Engineer', 'Accountant', 'Recruiter'] },
}

describe('tier 1: each type takes three titles and refuses three', () => {
  it('covers every type but `other`, which tier 1 never sets', () => {
    expect(Object.keys(CASES).sort()).toEqual(ROLE_TYPES.map((r) => r.id).filter((id) => id !== 'other').sort())
  })

  for (const [id, { takes, refuses }] of Object.entries(CASES)) {
    it.each(takes)(`${id} takes %s`, (title) => {
      expect(typed(title)).toBe(id)
    })
    it.each(refuses)(`${id} refuses %s`, (title) => {
      expect(typed(title)).not.toBe(id)
    })
  }

  it('never answers `other`: a title nothing places stays untyped for tier 2', () => {
    for (const t of ['Zookeeper', 'Lead', '', 'Chief Happiness Officer', 'ソフトウェアエンジニア']) expect(typed(t)).toBeNull()
  })
})

describe('the cases the blueprint names', () => {
  it('"AI Product Manager" is a product manager, never an ai engineer', () => {
    expect(typed('AI Product Manager')).toBe('product-manager')
    expect(typed('Senior AI Product Manager, Growth')).toBe('product-manager')
  })

  it('"Sales Engineer" is a solutions engineer, never a backend engineer', () => {
    expect(typed('Sales Engineer')).toBe('solutions-engineer')
  })

  it('the most specific match wins and software-engineer comes last', () => {
    expect(typed('Software Engineer, Backend')).toBe('backend-engineer')
    expect(typed('Staff Software Engineer, Machine Learning Platform')).toBe('software-engineer')
    expect(typed('Software Engineer')).toBe('software-engineer')
    expect(typed('Data Platform Engineer')).toBe('data-engineer')
    expect(typeTitle('Software Engineer, Backend').type_prov).toMatchObject({ rule: 'synonym', pattern: 'software engineer backend', taxonomy_version: 1 })
    expect(typeTitle('Staff Software Engineer, Payments').type_prov).toMatchObject({ rule: 'pattern', pattern: 'software engineer' })
  })

  it('a title with two possible types answers one: "Data Engineer, ML Platform" is a data engineer', () => {
    expect(typed('Data Engineer, ML Platform')).toBe('data-engineer')
  })

  it('an engineering manager keeps classify.ts\'s level, and a tech lead keeps the field\'s type', () => {
    expect(typed('Senior Engineering Manager')).toBe('engineering-manager')
    expect(normaliseTitle('Senior Engineering Manager').level).toBe('manager')
    expect(typed('Director of Engineering')).toBe('engineering-manager')
    expect(normaliseTitle('Director of Engineering').level).toBe('director')
    expect(typed('Backend Tech Lead')).toBe('backend-engineer')
    expect(normaliseTitle('Backend Tech Lead').level).toBe('manager')
  })

  it('"member of technical staff" is read by the department, so two employers\' answers never reach each other', () => {
    const applied = typeTitle('Member of Technical Staff', 'Applied AI')
    const infra = typeTitle('Member of Technical Staff', 'Infrastructure')
    expect(applied.role_type).toBe('ai-engineer')
    expect(infra.role_type).toBe('platform-engineer')
    expect(applied).toMatchObject({ title_norm: 'member of technical staff', dept_norm: 'applied ai', type_prov: { rule: 'department' } })
    expect(infra.dept_norm).toBe('infrastructure')
    // no department, or a department that names no job: no answer, not a guess
    expect(typed('Member of Technical Staff')).toBeNull()
    expect(typed('Staff Engineer', 'Payments')).toBeNull()
    expect(typed('Staff Engineer', 'Platform')).toBe('platform-engineer')
    // a title that is not ambiguous ignores the department
    expect(typeTitle('Backend Engineer', 'Applied AI').dept_norm).toBe('')
    expect(typed('Backend Engineer', 'Applied AI')).toBe('backend-engineer')
  })

  it('level words alone, a 200-character title and a non-English title never throw and are not guessed', () => {
    expect(typed('Lead')).toBeNull()
    expect(typed('Senior Lead Principal')).toBeNull()
    expect(typed('Engineer '.repeat(30))).toBeNull()
    expect(typed('Ingénieur Logiciel Senior')).toBeNull()
    expect(typed('Softwareentwickler (m/w/d)')).toBeNull()
  })
})
