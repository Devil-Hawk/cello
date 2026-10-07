'use client'

// DEV-ONLY fixture for Chat's markdown renderer. Not linked
// from product navigation - exists purely so the rewritten
// components/chat/markdown.tsx can be screenshotted and read back for
// verification with real, representative assistant output (a GFM table,
// fenced code, links, nested lists, a blockquote, bold/italic, and the
// mid-stream unclosed-fence / half-built-table cases) instead of paying for
// a live model turn. Safe to delete once the renderer has landed.

import { useEffect, useState } from 'react'
import { Markdown } from '@/components/chat/markdown'
import { splitMarkdownBlocks } from '@/components/chat/render/block-split'
import { ApplicationMadeView } from '@/components/chat/application-made'
import { ModelPicker } from '@/components/chat/model-picker'
import { AnswerParts, type Named } from '@/components/chat/parts'
import { StatusTurn } from '@/components/chat/status-turn'
import { Tiles, type TileData } from '@/components/chat/tiles'
import type { Card } from '@/lib/chat/cards'
import type { Part } from '@/lib/chat/types'

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

> Three of these are fresh enough that no other candidate has likely applied yet - the newest was posted 6 hours ago.

### Best matches

| Role | Company | Match | Posted | Apply |
| --- | --- | ---: | --- | --- |
| Senior ML Engineer | Anthropic | 92% | 6h ago | [Greenhouse](https://boards.greenhouse.io/anthropic) |
| Platform Engineer | Vercel | 87% | 1d ago | [Lever](https://jobs.lever.co/vercel) |
| Staff Backend Engineer | Stripe | 81% | 2d ago | [Greenhouse](https://boards.greenhouse.io/stripe) |

Next steps I'd recommend, in order:

1. Review the Anthropic role first - it's the strongest match and the *most time-sensitive*.
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

// Deliberately mid-row, not on a clean line boundary - proves the freeze
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

// Parts and cards as the page draws them. The card's pay is the stored row's; the model's text below states another
// and the card still shows the stored one.
const FIXTURE_CARDS: Card[] = [
  { kind: 'role', id: 'r1', title: 'Senior Backend Engineer, Payments', company: 'Vantage Loom', companyId: 'c1', logoUrl: null, place: 'New York, NY (Hybrid)', chance: 'strong', pay: '$190,000 - $230,000', state: 'applied' },
  { kind: 'company', id: 'c1', name: 'Vantage Loom', logoUrl: null, domain: 'vantage.example.com', openCount: 3, keptCount: 1, following: true },
]
const FIXTURE_NAMES: Named[] = [
  { kind: 'role', ref: 'r1', name: 'Senior Backend Engineer, Payments' },
  { kind: 'company', ref: 'c1', name: 'Vantage Loom' },
]
const FIXTURE_PARTS: Part[] = [
  { card: { kind: 'role', ref: 'r1' } },
  { about: [{ kind: 'role', ref: 'r1' }], text: 'The posting states **$190,000 to $230,000**, and a model that wrote $250,000 here would be ignored by the card above. See [Vantage Loom](cello:company/c1).' },
  { about: [{ kind: 'company', ref: 'c1' }], text: 'It has **3** roles open and you have one application there.' },
  { about: [], text: 'A part about nothing in particular has no lead.' },
]
const FIXTURE_TILES: TileData[] = [
  { id: 't1', kind: 'role', ref: 'r1', name: 'Senior Backend Engineer, Payments', origin: 'person' },
  { id: 't2', kind: 'company', ref: 'c1', name: 'Vantage Loom', origin: 'model' },
  { id: 't3', kind: 'made', ref: 'm1', name: 'A made thing with a title long enough to need cutting at a phone width', origin: 'person' },
]

const FIXTURE_RUNGS = [
  { rung: 'R2' as const, label: 'This computer', why: 'Not set up.', models: [] },
  { rung: 'R3' as const, label: 'Free models', why: '', models: [{ id: 'qwen/qwen3.8-27b:free', label: 'qwen3.8-27b' }] },
  { rung: 'R4' as const, label: 'Your own key', why: 'Above your highest. Change in Settings.', models: [{ id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' }] },
]

export default function ChatFixture() {
  return (
    <div className="mx-auto max-w-3xl space-y-8 py-8">
      <div>
        <h1 className="font-display text-title text-foreground">Markdown renderer fixture</h1>
        <p className="mt-1 text-caption text-muted-foreground">
          Dev-only harness for components/chat/markdown.tsx. Static assistant-message samples plus a
          simulated token stream, rendered through the real production component.
        </p>
      </div>

      <Bubble label="1 · Kitchen sink - headings, bold/italic, blockquote, table, nested list, links, code" content={KITCHEN_SINK} />
      <Bubble label="2 · Fenced code (highlighted), task list, strikethrough, inline code" content={CODE_AND_TASKS} />
      <Bubble label="3 · Unclosed fence - the model's turn ends mid-token, no closing ```" content={UNCLOSED_FENCE} />

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
        <div className="text-label uppercase tracking-wide text-muted-foreground">6 · Tiles, then an answer in parts with a role card</div>
        <div className="w-full space-y-4 rounded-card border border-border bg-card px-4 py-3 text-foreground">
          <Tiles tiles={FIXTURE_TILES} onRemove={() => undefined} onAdd={() => undefined} />
          <AnswerParts parts={FIXTURE_PARTS} names={FIXTURE_NAMES} tileCount={3} cards={FIXTURE_CARDS} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-label uppercase tracking-wide text-muted-foreground">8 · A status turn, the model picker, and an application's made things and chats</div>
        <div className="w-full space-y-4 rounded-card border border-border bg-card px-4 py-3 text-foreground">
          <StatusTurn line={{ eventId: 'e1', sentence: 'Cello is filling the form for Vantage Loom.', applicationId: 'a1', state: 'applying', at: '2026-10-05T10:00:00Z', approval: null }} />
          <ModelPicker choice={{ rung: 'R3', model: 'qwen/qwen3.8-27b:free', effort: 'medium' }} rungs={FIXTURE_RUNGS} estimate="Free" onPick={() => undefined} />
          <ApplicationMadeView made={[{ id: 'm1', type: 'comparison', title: 'Vantage Loom and Ramp', updated_at: '2026-10-05T10:00:00Z' }]} chats={[{ id: 'c1', title: 'Apply to Vantage Loom' }]} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-label uppercase tracking-wide text-muted-foreground">
          7 · Live simulated stream (~1-3 chars every 35ms) - click to replay
        </div>
        <StreamSim />
      </div>
    </div>
  )
}
