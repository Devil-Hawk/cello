// The one maintained taxonomy of role types (blueprint 6.1): the kind of job a posting is, apart from its
// level. "AI Engineer, Senior" is type `ai-engineer` at level `senior`; a type never encodes level.
//
// Synonyms are whole titles and patterns are phrases that may sit inside one, both written the way
// normaliseTitle writes a title: lower case, no punctuation, no level words, abbreviations spelled out
// (swe is "software engineer", fde is "forward deployed engineer", mle is "machine learning engineer").
//
// A change is a pull request that bumps TAXONOMY_VERSION, brings at least 5 labelled titles for a new type
// and re-runs S2. `pnpm role-types:sync` writes the `role_types` table from this module.
// Pure data: no I/O.

export const TAXONOMY_VERSION = 1

export interface RoleTypeDef {
  id: string
  label: string
  /** A `job_function` value (lib/jobs/classify.ts). */
  family: string
  /** Whole normalised titles. */
  synonyms: readonly string[]
  /** Phrases on word boundaries inside a normalised title. */
  patterns: readonly string[]
  related: readonly string[]
}

const t = (id: string, label: string, family: string, synonyms: string[], patterns: string[], related: string[] = []): RoleTypeDef =>
  ({ id, label, family, synonyms, patterns, related })

export const ROLE_TYPES: readonly RoleTypeDef[] = [
  t('forward-deployed-engineer', 'Forward Deployed Engineer', 'engineering',
    ['forward deployed engineer', 'forward deployed software engineer', 'forward deployed ai engineer', 'deployment strategist', 'deployed engineer'],
    ['forward deployed'], ['solutions-engineer', 'ai-engineer']),
  t('ai-engineer', 'AI Engineer', 'engineering',
    ['ai engineer', 'applied ai engineer', 'llm engineer', 'genai engineer', 'generative ai engineer', 'ai software engineer', 'software engineer ai', 'agent engineer', 'prompt engineer'],
    ['ai engineer', 'llm engineer', 'genai engineer', 'generative ai engineer', 'ai software engineer', 'software engineer ai', 'agent engineer', 'prompt engineer'],
    ['ml-engineer', 'forward-deployed-engineer', 'product-engineer']),
  t('ml-engineer', 'ML Engineer', 'data',
    ['machine learning engineer', 'ml engineer', 'mlops engineer', 'deep learning engineer', 'computer vision engineer', 'nlp engineer', 'ml infrastructure engineer'],
    ['machine learning engineer', 'ml engineer', 'mlops', 'deep learning engineer', 'computer vision engineer', 'nlp engineer', 'ml infrastructure', 'ml platform engineer'],
    ['ai-engineer', 'applied-scientist', 'research-engineer']),
  t('applied-scientist', 'Applied Scientist', 'data',
    ['applied scientist', 'machine learning scientist', 'applied ml scientist', 'applied research scientist'],
    ['applied scientist', 'machine learning scientist', 'applied ml scientist', 'applied research scientist'],
    ['ml-engineer', 'research-scientist', 'data-scientist']),
  t('research-engineer', 'Research Engineer', 'engineering',
    ['research engineer', 'research software engineer', 'ai research engineer'],
    ['research engineer', 'research software engineer'], ['research-scientist', 'ml-engineer']),
  t('research-scientist', 'Research Scientist', 'data',
    ['research scientist', 'ai researcher', 'ml researcher'],
    ['research scientist', 'ai researcher', 'ml researcher'], ['applied-scientist', 'research-engineer']),
  t('data-scientist', 'Data Scientist', 'data',
    ['data scientist', 'product data scientist', 'decision scientist', 'statistician'],
    ['data scientist', 'decision scientist', 'statistician'], ['applied-scientist', 'data-analyst']),
  t('data-engineer', 'Data Engineer', 'data',
    ['data engineer', 'data platform engineer', 'data infrastructure engineer', 'big data engineer', 'etl developer'],
    ['data engineer', 'data platform engineer', 'data infrastructure engineer', 'big data engineer', 'etl developer'], ['analytics-engineer', 'platform-engineer']),
  t('analytics-engineer', 'Analytics Engineer', 'data',
    ['analytics engineer', 'bi engineer', 'business intelligence engineer', 'dbt developer'],
    ['analytics engineer', 'bi engineer', 'business intelligence engineer', 'dbt developer'], ['data-engineer', 'data-analyst']),
  t('data-analyst', 'Data Analyst', 'data',
    ['data analyst', 'product analyst', 'business intelligence analyst'],
    ['data analyst', 'product analyst', 'business intelligence analyst', 'bi analyst'], ['analytics-engineer', 'data-scientist']),
  t('backend-engineer', 'Backend Engineer', 'engineering',
    ['backend engineer', 'back end engineer', 'backend developer', 'back end developer', 'server engineer', 'api engineer', 'distributed systems engineer', 'software engineer backend'],
    ['backend engineer', 'back end engineer', 'backend developer', 'back end developer', 'backend software engineer', 'back end software engineer', 'server engineer', 'api engineer', 'distributed systems engineer', 'software engineer backend', 'software developer backend'],
    ['software-engineer', 'platform-engineer']),
  t('fullstack-engineer', 'Full-stack Engineer', 'engineering',
    ['full stack engineer', 'fullstack engineer', 'full stack developer', 'fullstack developer'],
    ['full stack', 'fullstack'], ['backend-engineer', 'frontend-engineer', 'product-engineer']),
  t('frontend-engineer', 'Frontend Engineer', 'engineering',
    ['frontend engineer', 'front end engineer', 'frontend developer', 'front end developer', 'ui engineer', 'web engineer', 'react developer'],
    ['frontend engineer', 'front end engineer', 'frontend developer', 'front end developer', 'frontend software engineer', 'front end software engineer', 'ui engineer', 'web engineer', 'react developer'],
    ['fullstack-engineer', 'mobile-engineer']),
  t('mobile-engineer', 'Mobile Engineer', 'engineering',
    ['ios engineer', 'android engineer', 'mobile engineer', 'ios developer', 'android developer', 'mobile developer', 'react native engineer', 'react native developer'],
    ['ios engineer', 'android engineer', 'mobile engineer', 'ios developer', 'android developer', 'mobile developer', 'ios software engineer', 'android software engineer', 'mobile software engineer', 'react native'],
    ['frontend-engineer']),
  t('platform-engineer', 'Platform or Infrastructure Engineer', 'engineering',
    ['platform engineer', 'infrastructure engineer', 'cloud engineer', 'devops engineer', 'site reliability engineer', 'sre', 'production engineer', 'developer productivity engineer'],
    ['platform engineer', 'infrastructure engineer', 'cloud engineer', 'devops', 'site reliability', 'sre', 'production engineer', 'developer productivity', 'developer experience engineer'],
    ['backend-engineer', 'security-engineer']),
  t('security-engineer', 'Security Engineer', 'engineering',
    ['security engineer', 'application security engineer', 'product security engineer', 'appsec engineer', 'detection engineer', 'offensive security engineer', 'penetration tester'],
    ['security engineer', 'appsec', 'detection engineer', 'penetration tester', 'offensive security'], ['platform-engineer']),
  t('solutions-engineer', 'Solutions Engineer', 'engineering',
    ['solutions engineer', 'solutions architect', 'sales engineer', 'customer engineer', 'implementation engineer', 'pre sales engineer'],
    ['solutions engineer', 'solution engineer', 'solutions architect', 'solution architect', 'sales engineer', 'customer engineer', 'implementation engineer', 'pre sales engineer', 'presales engineer'],
    ['forward-deployed-engineer', 'developer-relations']),
  t('product-engineer', 'Product Engineer', 'engineering',
    ['product engineer', 'growth engineer', 'software engineer product'],
    ['product engineer', 'growth engineer', 'software engineer product'], ['fullstack-engineer', 'ai-engineer']),
  t('developer-relations', 'Developer Relations', 'engineering',
    ['developer advocate', 'developer relations', 'devrel', 'developer evangelist', 'community engineer'],
    ['developer advocate', 'developer relations', 'devrel', 'developer evangelist', 'community engineer'], ['solutions-engineer']),
  t('software-engineer', 'Software Engineer', 'engineering',
    ['software engineer', 'software developer', 'programmer'],
    ['software engineer', 'software developer', 'software development engineer', 'programmer'], ['backend-engineer', 'fullstack-engineer']),
  t('embedded-engineer', 'Embedded or Firmware Engineer', 'engineering',
    ['embedded engineer', 'firmware engineer', 'embedded software engineer', 'robotics software engineer'],
    ['embedded', 'firmware', 'robotics software'], ['software-engineer']),
  t('quality-engineer', 'Test or Quality Engineer', 'engineering',
    ['qa engineer', 'sdet', 'test engineer', 'quality engineer', 'test automation engineer'],
    ['qa engineer', 'sdet', 'test engineer', 'quality engineer', 'test automation', 'software engineer in test'], ['software-engineer']),
  t('engineering-manager', 'Engineering Manager', 'engineering',
    ['engineering manager', 'manager of software engineering', 'head of engineering', 'director of engineering'],
    ['engineering manager', 'manager of software engineering', 'manager software engineering', 'head of engineering', 'director of engineering', 'vp of engineering', 'vp engineering'], ['software-engineer']),
  t('product-manager', 'Product Manager', 'product',
    ['product manager', 'technical product manager', 'ai product manager', 'product owner'],
    ['product manager', 'product owner', 'product management'], []),
  t('designer', 'Designer', 'design',
    ['product designer', 'ux designer', 'ui designer', 'interaction designer'],
    ['product designer', 'ux designer', 'ui designer', 'interaction designer', 'ux ui designer'], ['frontend-engineer']),
  // The other families take main's classify.ts rules (lib/jobs/classify.ts), so they carry no phrases here.
  t('other-sales', 'Sales', 'sales', [], [], []),
  t('other-marketing', 'Marketing', 'marketing', [], [], []),
  t('other-support', 'Support', 'support', [], [], []),
  t('other-operations', 'Operations', 'operations', [], [], []),
  t('other-finance', 'Finance', 'finance', [], [], []),
  t('other-hr', 'People', 'hr', [], [], []),
  t('other-legal', 'Legal', 'legal', [], [], []),
  // Never set by tier 1: a title tier 1 cannot place goes on to tier 2, which may answer `other`.
  t('other', 'Other', 'other', [], [], []),
]

export const ROLE_TYPE_IDS: readonly string[] = ROLE_TYPES.map((r) => r.id)
const BY_ID: ReadonlyMap<string, RoleTypeDef> = new Map(ROLE_TYPES.map((r) => [r.id, r]))

export function getRoleType(id: string): RoleTypeDef | undefined {
  return BY_ID.get(id)
}

/** A person chooses at most this many types. */
export const MAX_ROLE_TYPES = 8

/**
 * Titles that name no particular job: "member of technical staff" in Applied AI and in Infrastructure are
 * different jobs, so their key carries the posting's department (title_types.dept_norm). Every other
 * title's answer is shared by every employer.
 */
export const AMBIGUOUS_TITLES: readonly string[] = ['member of technical staff', 'technical staff', 'engineer', 'generalist', 'founding engineer']

/**
 * Titles that are another job, whatever else they say ("AI Product Manager" is never an AI engineer). Main's
 * shared exclusion list; a type's own whole-title synonym still wins ("sales engineer" is solutions-engineer).
 */
export const SHARED_EXCLUSIONS: readonly string[] = [
  'product manager', 'product owner', 'program manager', 'project manager', 'project coordinator', 'executive assistant',
  'administrative assistant', 'office manager', 'recruiter', 'sourcer', 'talent acquisition', 'account executive',
  'account manager', 'sales development', 'customer success', 'customer support', 'technical writer', 'marketing manager',
  'business analyst', 'solutions consultant', 'chief of staff',
]

/** The families whose types SHARED_EXCLUSIONS apply to. */
export const EXCLUDED_FAMILIES: readonly string[] = ['engineering', 'data']
