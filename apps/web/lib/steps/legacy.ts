// Model calls that exist today and do not yet map to one of the declared ids of
// blueprint 5.2. Each keeps the name it has always had in the spend ledger and
// Langfuse, names its measure, and names the package that retires it. The source
// test counts them, and the last step of the build leaves none.

import { defineModelStep, type ModelStep } from './define'

const BELOW = 'This work waits until a model is available.'

function legacy(id: string, measure: string, retiredBy: string): ModelStep {
  return defineModelStep({ id, kind: 'step', measure, minRung: 'R2', below: BELOW, legacy: { retiredBy } })
}

/** The agent units' generation names (lib/graph/unit.ts, UNIT_GENERATION_NAME). */
export const LEGACY_STEPS: Record<string, ModelStep> = Object.fromEntries(
  [
    // Chat's own turn: replaced by the Deep Agents loop.
    legacy('plan-copilot-step', 'S14', 'K24a'),
    legacy('write-final-answer', 'S14', 'K24a'),
    legacy('write-summary', 'S14', 'K24a'),
    // Memory: replaced by the Learner.
    legacy('distill-insight', 'S16', 'K15'),
    legacy('plan-strategy', 'S16', 'K15'),
    legacy('analyze-pipeline', 'S16', 'K15'),
    // Scoring and goal fit: replaced by chance.
    legacy('score-job-match', 'S3', 'K17'),
    legacy('score-job-batch', 'S3', 'K17'),
    legacy('judge-goal-fit', 'S3', 'K17'),
    // Writing: replaced by the Writer to Reviewer workflow.
    legacy('tailor-cv', 'S5', 'K17'),
    legacy('optimize-resume', 'S5', 'K17'),
    legacy('draft-outreach-message', 'S6', 'K17'),
    legacy('draft-follow-up', 'S6', 'K17'),
    legacy('draft-application-follow-up', 'S6', 'K17'),
    legacy('write-digest', 'T12', 'K20'),
    // Reading the web and the record.
    legacy('source-jobs', 'T1', 'K6'),
    legacy('enrich-job', 'S1', 'K8a'),
    // Reading the person's own sources for claims: replaced by role.evidence.
    legacy('extract-resume-claims', 'S20', 'K17b'),
    legacy('extract-kb-evidence', 'S20', 'K17b'),
    legacy('find-contacts', 'S18', 'K26'),
    legacy('research-company', 'S13', 'K24b'),
    // Applying: replaced by the advancer.
    legacy('apply-to-job', 'T10', 'K13'),
    legacy('verify-application', 'T10', 'K13'),
  ].map((step) => [step.id, step])
)

/** The legacy step for a generation name. Throws for a name nobody declared, so a
 *  new call cannot ship as an unnamed step. */
export function legacyStep(name: string): ModelStep {
  const step = LEGACY_STEPS[name]
  if (!step) throw new Error(`No declared model step is called "${name}"`)
  return step
}
