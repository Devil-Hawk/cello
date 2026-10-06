// The declared model steps (blueprint 5.2). A call a package moves behind a step
// is declared here or, for a lane's own steps, in that lane's module with
// defineModelStep. lib/steps/source.test.ts fails on any model call outside the
// steps, the two loops and the per-lane allowlists in ./allow.
//
// minRung and below are blueprint 11.2's targets until K22c's rung evals write
// lib/steps/rungs.json.

import { defineModelStep } from './define'

export { defineModelStep, declareStep, StepOutputError } from './define'
export type { ModelStep, ModelStepDef, StepCallContext, StepResult, StepKind } from './define'
export { embedStep } from './embed'
export { LEGACY_STEPS, legacyStep } from './legacy'
export { CENTRAL_POLICY, withPolicy } from './policy'

/** How well a role fits one person, scored from their record. Moved over as it
 *  was; its prompt is not changed by being declared (13.2). */
export const chanceStep = defineModelStep({
  id: 'chance',
  kind: 'step',
  measure: 'S3',
  minRung: 'R2',
  below: 'Roles are ordered by title match and date.',
})

/** Reading a resume that is a scan or a photo: the model sees the PDF and writes it out as Markdown.
 *  Free hosted models or better; a person's own Anthropic or OpenAI key works too. */
export const resumePhotoStep = defineModelStep({
  id: 'resume.photo',
  kind: 'step',
  measure: 'P6',
  minRung: 'R3',
  below: 'Reading a photo needs a model. Paste the text instead.',
})

/** Sorting one email: is it about a job application, and what happened. */
export const inboxClassifyStep = defineModelStep({
  id: 'inbox.classify',
  kind: 'step',
  measure: 'S8',
  minRung: 'R1',
  below: 'The email is shown as not sorted yet, with one tap to sort it.',
})
