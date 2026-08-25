// Matcher Agent specific types

import type { Job, UserProfile, MatchDetails } from '@cello/shared'

/**
 * Input for matching a single job against a user profile
 */
export interface MatchInput {
  job: Job
  user: UserProfile
}

/**
 * Result of matching a single job
 */
export interface SingleMatchResult {
  jobId: string
  score: number
  highlights: string[]
  gaps: string[]
  details: MatchDetails
}

/**
 * Configuration for the embedding provider
 */
export interface EmbeddingConfig {
  /** Provider type: 'mock' for testing, 'openai' for production */
  provider: 'mock' | 'openai'
  /** Embedding dimension (default: 384 for mock, 1536 for OpenAI) */
  dimension?: number
  /** OpenAI API key (required for 'openai' provider) */
  apiKey?: string
  /** Model to use for OpenAI embeddings */
  model?: string
}

/**
 * Skill extracted from job description
 */
export interface ExtractedSkill {
  name: string
  required: boolean
  category: SkillCategory
}

/**
 * Categories of skills
 */
export type SkillCategory =
  | 'programming_language'
  | 'framework'
  | 'database'
  | 'cloud'
  | 'tool'
  | 'soft_skill'
  | 'other'

/**
 * Experience requirements extracted from job
 */
export interface ExperienceRequirement {
  yearsMin: number
  yearsMax: number | null
  level: ExperienceLevel
}

/**
 * Experience level classification
 */
export type ExperienceLevel =
  | 'entry'
  | 'junior'
  | 'mid'
  | 'senior'
  | 'lead'
  | 'principal'
  | 'executive'

/**
 * Location matching result
 */
export interface LocationMatchResult {
  score: number
  jobLocation: string | null
  userLocations: string[]
  remoteCompatible: boolean
  exactMatch: boolean
}

/**
 * Weights for calculating overall match score
 */
export interface ScoringWeights {
  skills: number
  experience: number
  location: number
}

/**
 * Default scoring weights
 */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  skills: 0.5,
  experience: 0.3,
  location: 0.2,
}

/**
 * Common technical skills for keyword matching
 */
export const COMMON_SKILLS: Record<SkillCategory, string[]> = {
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

/**
 * Experience level indicators in job descriptions
 */
export const EXPERIENCE_INDICATORS: Record<ExperienceLevel, string[]> = {
  entry: ['entry level', 'entry-level', 'graduate', 'new grad', '0-1 years', '0-2 years'],
  junior: ['junior', 'associate', '1-2 years', '1-3 years', '2 years'],
  mid: ['mid level', 'mid-level', '3-5 years', '3+ years', '4+ years'],
  senior: ['senior', 'sr.', '5+ years', '5-7 years', '6+ years', '7+ years'],
  lead: ['lead', 'tech lead', 'team lead', '7+ years', '8+ years'],
  principal: ['principal', 'staff', 'architect', '10+ years'],
  executive: ['director', 'vp', 'vice president', 'cto', 'head of', 'chief'],
}
