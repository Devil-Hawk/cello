// Review of an outreach draft: the deterministic checks (length, banned phrases,
// one ask, greeting, sign-off, invented history, company named), then the claims
// judge and the specificity judge. The review itself lives in ./outreach-review.
//
// The draft routes no longer regenerate through the unit runner: they run the Writer
// (lib/workflows/writer.ts), which checks once and sends a failing draft back once.
// What stays here is the pure review the evals and the verdict rows read.

export { checksFor, correctiveList, reviewOutreachDraft } from './outreach-review'
export type { OutreachReview, ReviewDeps } from './outreach-review'
