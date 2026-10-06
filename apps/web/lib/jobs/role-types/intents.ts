// Main's 14 role intents (lib/jobs/role-taxonomy.ts) as role type ids: where an intent maps to two
// types, the caller takes both. A test fails when an old id has no row or maps to an id not in the module.

export const INTENT_ROLE_TYPES = {
  'swe-ai-ml': ['ai-engineer', 'ml-engineer'],
  'ai-engineer': ['ai-engineer'],
  'ml-engineer': ['ml-engineer'],
  'data-scientist': ['data-scientist'],
  'data-engineer': ['data-engineer'],
  'data-analyst': ['data-analyst'],
  'swe-backend': ['backend-engineer'],
  'swe-frontend': ['frontend-engineer'],
  'swe-fullstack': ['fullstack-engineer'],
  'mobile-engineer': ['mobile-engineer'],
  'devops-sre': ['platform-engineer'],
  'security-engineer': ['security-engineer'],
  'qa-engineer': ['quality-engineer'],
  'product-manager': ['product-manager'],
} as const satisfies Record<string, readonly string[]>

export type IntentId = keyof typeof INTENT_ROLE_TYPES

/** The role types an old intent id stands for; empty for an id main does not have. */
export function roleTypesForIntent(id: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(INTENT_ROLE_TYPES, id) ? INTENT_ROLE_TYPES[id as IntentId] : []
}
