// Cello's 0 to 100 read of a resume against one role. A number is shown only beside what it rests
// on (the keywords the role asks for that the resume covers or misses, and the format fixes), and
// never as a fact: with nothing to rest on, no number appears at all.

import type { ResumeOptimizerResult } from '@/lib/harness/agents/resume_optimizer'

export type TailorReport = Pick<ResumeOptimizerResult, 'atsScore' | 'matchedKeywords' | 'missingKeywords' | 'formatIssues' | 'rescore'>

/** True when the read has evidence to show beside its number. */
export const readIsShowable = (r: TailorReport): boolean => r.matchedKeywords.length + r.missingKeywords.length + r.formatIssues.length > 0

function Chips({ title, words, tone }: { title: string; words: string[]; tone: string }) {
  if (words.length === 0) return null
  return (
    <div>
      <p className="mb-1.5 text-caption text-muted-foreground">{title}</p>
      <ul className="flex flex-wrap gap-1.5">
        {words.map((w) => (
          <li key={w} className={`rounded-full px-2.5 py-1 text-caption ${tone}`}>
            {w}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TailorRead({ report }: { report: TailorReport }) {
  if (!readIsShowable(report)) {
    return <p className="text-caption text-muted-foreground">Cello has no read of this resume against this role.</p>
  }
  return (
    <section aria-label="Cello's read of this resume against the role" className="space-y-4">
      <div>
        <p className="text-caption text-muted-foreground">Cello&apos;s read</p>
        <p className="font-display text-section text-foreground">
          {report.atsScore} of 100 now, {report.rescore.atsScore} after the rewrite
        </p>
      </div>
      <Chips title="Missing from your resume" words={report.missingKeywords} tone="bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200" />
      <Chips title="Already covered" words={report.matchedKeywords.slice(0, 16)} tone="bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200" />
      {report.formatIssues.length > 0 && (
        <div>
          <p className="mb-1.5 text-caption text-muted-foreground">Format fixes</p>
          <ul className="list-disc space-y-1 pl-5 text-caption text-foreground">
            {report.formatIssues.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      <details className="text-caption text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-3">About this read</summary>
        <p>
          A model scored your resume against this role twice, before and after the rewrite. It is a read with the evidence above, not a fact about you. The rewrite only
          reorganizes your real experience. It never invents employers, titles, dates or skills.
        </p>
      </details>
    </section>
  )
}
