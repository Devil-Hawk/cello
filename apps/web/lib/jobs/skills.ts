// Keyword-based skill extraction from free-text job/resume content — no LLM,
// no network. Ported from packages/agents/src/matcher/{scoring,types}.ts
// (the extractSkillsFromText half only — the rest of scoring.ts is a full
// job/resume matcher that nothing in apps/web calls) as part of the
// langgraph port (docs/superpowers/specs/2026-08-16-langgraph-port-design.md,
// step 12); lib/harness/agents/sourcer.ts is the only caller, using it to
// seed search keywords from a resume.
//
// ponytail: preserved as-is, not fixed here — COMMON_SKILLS.programming_language
// includes bare single-letter/two-letter entries ('r', 'go'), and matching is a
// plain substring `.includes()`, so 'r' matches inside almost any English
// sentence (e.g. "communicator"). Pre-existing in the ported source, never
// caught because nothing tested it there either; sourcer.ts only reads
// `.name` to seed search keywords, where a stray "r" keyword is harmless
// noise, not a wrong result. Upgrade to word-boundary matching if a future
// caller needs precision.

export type SkillCategory = 'programming_language' | 'framework' | 'database' | 'cloud' | 'tool' | 'soft_skill' | 'other'

export interface ExtractedSkill {
  name: string
  required: boolean
  category: SkillCategory
}

const COMMON_SKILLS: Record<SkillCategory, string[]> = {
  programming_language: [
    'javascript', 'typescript', 'python', 'java', 'c++', 'c#', 'go', 'golang',
    'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'r', 'matlab',
    'perl', 'haskell', 'elixir', 'erlang', 'clojure', 'lua', 'dart',
  ],
  framework: [
    'react', 'angular', 'vue', 'svelte', 'next.js', 'nextjs', 'nuxt',
    'express', 'fastify', 'nest', 'nestjs', 'django', 'flask', 'fastapi',
    'spring', 'spring boot', 'rails', 'laravel', '.net', 'asp.net',
    'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'pandas', 'numpy',
  ],
  database: [
    'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'elasticsearch',
    'dynamodb', 'cassandra', 'sqlite', 'oracle', 'sql server', 'mariadb',
    'neo4j', 'couchdb', 'firebase', 'supabase', 'prisma', 'drizzle',
  ],
  cloud: [
    'aws', 'amazon web services', 'gcp', 'google cloud', 'azure',
    'kubernetes', 'k8s', 'docker', 'terraform', 'cloudflare', 'vercel',
    'heroku', 'digitalocean', 'lambda', 'ec2', 's3', 'cloudformation',
  ],
  tool: [
    'git', 'github', 'gitlab', 'bitbucket', 'jira', 'confluence',
    'jenkins', 'circleci', 'github actions', 'travis', 'webpack', 'vite',
    'babel', 'eslint', 'prettier', 'jest', 'vitest', 'cypress', 'playwright',
    'grafana', 'prometheus', 'datadog', 'splunk', 'new relic',
  ],
  soft_skill: [
    'leadership', 'communication', 'teamwork', 'problem solving',
    'agile', 'scrum', 'kanban', 'mentoring', 'collaboration',
  ],
  other: [],
}

/** Every known skill found in `text`, tagged by category and whether it fell
 *  in a "requirements" section vs a "nice to have" one (best-effort: a text
 *  with neither heading is treated as all-required). */
export function extractSkillsFromText(text: string): ExtractedSkill[] {
  const skills: ExtractedSkill[] = []
  const normalizedText = text.toLowerCase()
  const seenSkills = new Set<string>()

  const requiredSection = normalizedText.match(
    /requirements?:?([\s\S]*?)(?:nice to have|preferred|bonus|about|we offer|benefits|$)/i
  )
  const niceToHaveSection = normalizedText.match(/(?:nice to have|preferred|bonus):?([\s\S]*?)(?:about|we offer|benefits|$)/i)

  const requiredText = requiredSection?.[1] || normalizedText
  const niceToHaveText = niceToHaveSection?.[1] || ''

  for (const [category, skillList] of Object.entries(COMMON_SKILLS)) {
    for (const skill of skillList) {
      if (seenSkills.has(skill)) continue

      const isInRequired = requiredText.includes(skill)
      const isInNiceToHave = niceToHaveText.includes(skill)

      if (isInRequired || isInNiceToHave) {
        skills.push({ name: skill, required: isInRequired && !isInNiceToHave, category: category as SkillCategory })
        seenSkills.add(skill)
      }
    }
  }

  return skills
}
