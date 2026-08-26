// Question: "Which resume variants perform better?" (resume_documents -> application outcome)
//
// applications.resume_version is written by NOTHING in this codebase today
// (grepped: read nowhere either, as of the langgraph port — app/api/agents/
// coach/route.ts was the last reader, and it built that field into an
// AgentContext the coach unit never actually consulted) so it cannot be used
// to link an application to the resume that was actually sent.
// The real, grounded link is resume_documents.job_id === applications.job_id:
// a resume_documents row with job_id pointing at this application's job means
// lib/harness/agents/cv_tailor (or the resume studio) produced a
// job-specific tailored version for it. That gives exactly one honest,
// checkable comparison today: applications with a tailored resume on file vs
// applications with none (which fell back to the base resume /
// profiles.resume_text). A finer cut by resume_documents.ats_score is added
// as a caveat only, not a separate ranked bucket, because ats_score is
// frequently null and splitting further would shrink every bucket below the
// per-bucket minimum.

import { insufficientData, answered } from '../types'
import type { QuestionResult, ResumeVariantData } from '../types'
import type { ApplicationRow, ActivityRow, ResumeDocumentRow } from '../datasource'
import { MIN_TOTAL_FOR_RESUME_VARIANTS, MIN_PER_BUCKET, NOT_ENOUGH } from '../thresholds'
import { buildBucket, interviewedApplicationIds, repliedApplicationIds, pct } from '../bucket'

const QUESTION = 'resumeVariants'

export function analyzeResumeVariants(
  applications: ApplicationRow[],
  activities: ActivityRow[],
  resumeDocuments: ResumeDocumentRow[]
): QuestionResult<ResumeVariantData> {
  const total = applications.length
  if (total < MIN_TOTAL_FOR_RESUME_VARIANTS) {
    return insufficientData(QUESTION, total, MIN_TOTAL_FOR_RESUME_VARIANTS, NOT_ENOUGH(total, MIN_TOTAL_FOR_RESUME_VARIANTS, 'applications'))
  }

  const jobIdsWithTailoredResume = new Set(resumeDocuments.filter((r) => r.jobId !== null).map((r) => r.jobId as string))
  const tailored = applications.filter((a) => jobIdsWithTailoredResume.has(a.jobId))
  const untailored = applications.filter((a) => !jobIdsWithTailoredResume.has(a.jobId))

  const repliedIds = repliedApplicationIds(activities)
  const interviewedIds = interviewedApplicationIds(applications, activities)
  const buckets = [
    buildBucket('tailored resume on file', tailored, repliedIds, interviewedIds),
    buildBucket('no tailored resume on file', untailored, repliedIds, interviewedIds),
  ]

  const comparable = buckets.filter((b) => !b.thinBucket)
  if (comparable.length < 2) {
    return insufficientData(
      QUESTION,
      total,
      MIN_TOTAL_FOR_RESUME_VARIANTS,
      `Not enough data yet — ${tailored.length} application(s) used a tailored resume and ${untailored.length} did not, but at least one side has fewer than ${MIN_PER_BUCKET}. Need about ${MIN_PER_BUCKET} applications on both sides to compare.`
    )
  }

  const [tailoredBucket, untailoredBucket] = buckets
  const better = (tailoredBucket.replyRate ?? 0) >= (untailoredBucket.replyRate ?? 0) ? tailoredBucket : untailoredBucket
  return answered(
    QUESTION,
    total,
    MIN_TOTAL_FOR_RESUME_VARIANTS,
    { totalApplications: total, totalWithResumeLink: tailored.length, buckets },
    `${better.label} performs better so far: ${pct(better.replyRate)} reply rate vs ${pct((better === tailoredBucket ? untailoredBucket : tailoredBucket).replyRate)}.`,
    []
  )
}
