'use client'

// DEV-ONLY fixture for the copilot markdown renderer rewrite. Not linked
// from product navigation — exists purely so the rewritten
// components/copilot/markdown.tsx can be screenshotted and read back for
// verification with real, representative assistant output (a GFM table,
// fenced code, links, nested lists, a blockquote, bold/italic, and the
// mid-stream unclosed-fence / half-built-table cases) instead of paying for
// a live model turn. Safe to delete once the renderer has landed.

import { useEffect, useState } from 'react'
import { Markdown } from '@/components/copilot/markdown'
import { splitMarkdownBlocks } from '@/components/copilot/render/block-split'

function Bubble({ label, content }: { label: string; content: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-label uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="w-full rounded-card border border-border bg-card px-4 py-3 text-foreground">
        <Markdown content={content} />
      </div>
    </div>
  )
}

const KITCHEN_SINK = `## Top matches from this week's sourcing run

I ran the sourcer against **14 companies** on your watch list and scored everything against your resume. Here's where things stand.

> Three of these are fresh enough that no other candidate has likely applied yet — the newest was posted 6 hours ago.

### Best matches

| Role | Company | Match | Posted | Apply |
| --- | --- | ---: | --- | --- |
| Senior ML Engineer | Anthropic | 92% | 6h ago | [Greenhouse](https://boards.greenhouse.io/anthropic) |
| Platform Engineer | Vercel | 87% | 1d ago | [Lever](https://jobs.lever.co/vercel) |
| Staff Backend Engineer | Stripe | 81% | 2d ago | [Greenhouse](https://boards.greenhouse.io/stripe) |

Next steps I'd recommend, in order:

1. Review the Anthropic role first — it's the strongest match and the *most time-sensitive*.
2. For Vercel, I can tailor your resume automatically:
   - Emphasize the Next.js migration work at your current job
   - Pull the on-call/reliability bullet up higher
3. Stripe wants a cover letter; I'll draft one once you confirm you want to apply.

Here's the diff I'd apply to your summary line for the Vercel role:

\`\`\`diff
- Backend engineer with 6 years building distributed systems.
+ Backend engineer with 6 years building distributed systems, including two
+ years running Next.js/edge infrastructure at scale.
\`\`\`

Want me to go ahead and tailor + apply to the top match?`

const CODE_AND_TASKS = `Here's the resume tailoring script I'll run:

\`\`\`ts
export async function tailorResume(jobId: string) {
  const job = await getJob(jobId)
  const resume = await getBaseResume()
  return diffAndRewrite(resume, job.requirements)
}
\`\`\`

Checklist before I submit:

- [x] Resume tailored to job description
- [x] Cover letter drafted
- [ ] Salary expectations confirmed
- [ ] ~~Portfolio link added~~ (not required for this role)

Running \`tailorResume\` takes about 4 seconds and never overwrites your base resume.`

const UNCLOSED_FENCE = `Let me pull the observation payload so you can see the raw tool output:

\`\`\`json
{
  "jobId": "9c1e2f0a",
  "title": "Senior ML Engineer",
  "score": 0.92,
  "signals": [
    "posted 6h ago",`

const COMP_TABLE_FULL = `Comparing your three strongest matches by comp and level:

| Company | Level | Base | Equity |
| --- | --- | ---: | ---: |
| Anthropic | L5 | $210k | 0.02% |
| Vercel | Senior | $195k | 0.05% |
| Stripe | L4 | $205k | 0.03% |

I'd lead with Anthropic given the strongest technical match, then Stripe as a close second.`

// Deliberately mid-row, not on a clean line boundary — proves the freeze
// isn't just "stopped between blocks".
const FREEZE_EARLY = COMP_TABLE_FULL.slice(0, COMP_TABLE_FULL.indexOf('| Vercel') + 9)
// Table complete, but the closing sentence is still mid-word.
const FREEZE_LATE = COMP_TABLE_FULL.slice(0, COMP_TABLE_FULL.indexOf("I'd lead") + 15)

function StreamSim() {
  const [content, setContent] = useState(FREEZE_EARLY)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (!playing) return
    if (content.length >= COMP_TABLE_FULL.length) {
      setPlaying(false)
      return
    }
    const id = setTimeout(() => {
      // Reveal 1-3 chars at a time, like small token chunks arriving.
      const step = 1 + Math.floor(Math.random() * 3)
      setContent(COMP_TABLE_FULL.slice(0, content.length + step))
    }, 35)
    return () => clearTimeout(id)
  }, [playing, content])

  const blocks = splitMarkdownBlocks(content)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setContent('')
            setPlaying(true)
          }}
          className="rounded-control border border-border bg-card px-2.5 py-1 text-caption text-foreground hover:bg-muted"
        >
          Replay stream
        </button>
        <span className="text-caption text-muted-foreground">
          {blocks.length} block{blocks.length === 1 ? '' : 's'} · tail is block #{blocks.length} ·{' '}
          {content.length}/{COMP_TABLE_FULL.length} chars
        </span>
      </div>
      <div className="w-full rounded-card border border-border bg-card px-4 py-3 text-foreground">
        <Markdown content={content} />
      </div>
    </div>
  )
}

export default function MarkdownFixturePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8 py-8">
      <div>
        <h1 className="font-display text-title text-foreground">Markdown renderer fixture</h1>
        <p className="mt-1 text-caption text-muted-foreground">
          Dev-only harness for components/copilot/markdown.tsx. Static assistant-message samples plus a
          simulated token stream, rendered through the real production component.
        </p>
      </div>

      <Bubble label="1 · Kitchen sink — headings, bold/italic, blockquote, table, nested list, links, code" content={KITCHEN_SINK} />
      <Bubble label="2 · Fenced code (highlighted), task list, strikethrough, inline code" content={CODE_AND_TASKS} />
      <Bubble label="3 · Unclosed fence — the model's turn ends mid-token, no closing ```" content={UNCLOSED_FENCE} />

      <div className="space-y-1.5">
        <div className="text-label uppercase tracking-wide text-muted-foreground">
          4 · Half-built table, frozen mid-row (deterministic, not a live timer)
        </div>
        <div className="w-full rounded-card border border-border bg-card px-4 py-3 text-foreground">
          <Markdown content={FREEZE_EARLY} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-label uppercase tracking-wide text-muted-foreground">
          5 · Same message, table complete, trailing sentence still mid-word
        </div>
        <div className="w-full rounded-card border border-border bg-card px-4 py-3 text-foreground">
          <Markdown content={FREEZE_LATE} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-label uppercase tracking-wide text-muted-foreground">
          6 · Live simulated stream (~1-3 chars every 35ms) — click to replay
        </div>
        <StreamSim />
      </div>
    </div>
  )
}
