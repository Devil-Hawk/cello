// Question: "What evidence recurs in successful applications?"
//
// "Successful" = an application whose stage reached interview/offer/accepted
// (same SUCCESS_STAGES as the interview funnel elsewhere in this module).
// Evidence text comes from resume_documents rows tailored for that
// application's job (resume_documents.job_id === applications.job_id — a
// job can have at most one application per user, enforced by
// applications' own unique_application_per_job constraint, so this join is
// unambiguous). Prefers the structured content_json.sections[].bullets;
// falls back to splitting the plain-text `content` into bullet-shaped lines
// when content_json is null (every resume_documents row always has
// `content`, never content_json — see lib/resume/types.ts).
//
// A "phrase" here is one full bullet/line, not an extracted keyword — this is
// a straightforward recurrence count, not NLP. It reports what LITERALLY
// repeats across multiple successful applications' resumes, verbatim, so a
// human can judge for themselves whether it's meaningful.

import { insufficientData, answered } from '../types'
import type { QuestionResult, RecurringEvidenceData } from '../types'
import type { ApplicationRow, ResumeDocumentRow } from '../datasource'
import { MIN_SUCCESSFUL_FOR_EVIDENCE, MIN_PHRASE_OCCURRENCES, NOT_ENOUGH } from '../thresholds'

const QUESTION = 'recurringEvidence'
const SUCCESS_STAGES = new Set(['interview', 'offer', 'accepted'])
const MIN_PHRASE_LENGTH = 15
const MAX_PHRASE_LENGTH = 220
const MAX_PHRASES_RETURNED = 10

function extractLines(doc: ResumeDocumentRow): string[] {
  if (doc.contentJson?.sections?.length) {
    return doc.contentJson.sections.flatMap((s) => s.bullets ?? [])
  }
  return doc.content
    .split('\n')
    .map((l) => l.replace(/^[\s\-•*]+/, '').trim())
    .filter((l) => l.length > 0)
}

function normalize(line: string): string {
  return line.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function analyzeRecurringEvidence(applications: ApplicationRow[], resumeDocuments: ResumeDocumentRow[]): QuestionResult<RecurringEvidenceData> {
  const successful = applications.filter((a) => SUCCESS_STAGES.has(a.stage))
  if (successful.length < MIN_SUCCESSFUL_FOR_EVIDENCE) {
    return insufficientData(
      QUESTION,
      successful.length,
      MIN_SUCCESSFUL_FOR_EVIDENCE,
      NOT_ENOUGH(successful.length, MIN_SUCCESSFUL_FOR_EVIDENCE, 'successful applications (reached interview stage or further)')
    )
  }

  const appIdByJobId = new Map(successful.map((a) => [a.jobId, a.id]))
  const phraseToAppIds = new Map<string, Set<string>>()

  for (const doc of resumeDocuments) {
    if (!doc.jobId) continue
    const appId = appIdByJobId.get(doc.jobId)
    if (!appId) continue
    const uniqueLines = new Set(extractLines(doc).map(normalize))
    for (const line of uniqueLines) {
      if (line.length < MIN_PHRASE_LENGTH || line.length > MAX_PHRASE_LENGTH) continue
      let set = phraseToAppIds.get(line)
      if (!set) {
        set = new Set()
        phraseToAppIds.set(line, set)
      }
      set.add(appId)
    }
  }

  const phrases = [...phraseToAppIds.entries()]
    .map(([phrase, appIds]) => ({ phrase, occurrences: appIds.size, applicationIds: [...appIds] }))
    .filter((p) => p.occurrences >= MIN_PHRASE_OCCURRENCES)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, MAX_PHRASES_RETURNED)

  const summary =
    phrases.length > 0
      ? `${phrases.length} phrase(s) recur across ${MIN_PHRASE_OCCURRENCES}+ of ${successful.length} successful applications' resumes. Top: "${phrases[0].phrase}" (${phrases[0].occurrences}/${successful.length}).`
      : `${successful.length} successful applications is enough volume to check, but no single resume line repeats across ${MIN_PHRASE_OCCURRENCES}+ of them — no recurring evidence found yet.`

  return answered(
    QUESTION,
    successful.length,
    MIN_SUCCESSFUL_FOR_EVIDENCE,
    { totalSuccessfulApplications: successful.length, phrases },
    summary,
    ['Verbatim line recurrence only, not semantic similarity — differently-worded versions of the same accomplishment are not merged.']
  )
}
