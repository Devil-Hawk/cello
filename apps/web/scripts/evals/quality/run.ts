// Free-model evals for the prompts the quality package owns: planner,
// analyst, distill, memory extraction, company verify and the goal judge.
//
//   cd apps/web
//   npx tsx scripts/evals/quality/run.ts --label before            every prompt, Release 1 text
//   npx tsx scripts/evals/quality/run.ts --label after             every prompt, current text
//   npx tsx scripts/evals/quality/run.ts --quick --check           3 cases per prompt, no judge, bars from thresholds.json
//   npx tsx scripts/evals/quality/run.ts --prompt planner --label after
//   npx tsx scripts/evals/quality/run.ts --labels                  (re)write the goal judge's reference labels
//
// Only ":free" models run. The generator and the judge are from different
// families. Answers are cached, so a rerun is free. The key comes from
// OPENROUTER_API_KEY or ~/.cello-secrets.env and is never printed.
//
// Exit codes: 0 pass (or skipped because the free quota is spent), 1 a bar was
// missed, 2 the script broke.

import { FreeClient, GENERATOR, JUDGE, BudgetStop, QuotaError } from './lib/free'
import { loadThresholds, misses, readReport, writeReport, type SuiteCtx, type SuiteResult, type Variant } from './lib/report'

const SUITES = ['planner', 'analyst', 'distill', 'memory_extract', 'company_verify', 'goal_judge'] as const

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(name)

function table(results: SuiteResult[]): string {
  const lines: string[] = []
  for (const r of results) {
    lines.push(`${r.prompt} (${r.variant}${r.quick ? ', quick' : ''}, ${r.requests} requests)`)
    for (const [k, v] of Object.entries(r.metrics)) lines.push(`  ${k.padEnd(22)} ${v}`)
  }
  return lines.join('\n')
}

async function main(): Promise<number> {
  const quick = flag('--quick')
  const variant: Variant = (arg('--label') as Variant | undefined) ?? 'after'
  if (variant !== 'before' && variant !== 'after') throw new Error('--label is before or after')
  const only = arg('--prompt')
  const names = only && only !== 'all' ? SUITES.filter((s) => s === only) : [...SUITES]
  if (names.length === 0) throw new Error(`unknown prompt "${only}", one of ${SUITES.join(', ')}`)

  const maxRequests = Number(arg('--max-requests') ?? process.env.EVAL_MAX_REQUESTS ?? (quick ? 60 : 300))
  const free = new FreeClient({ maxRequests })
  const left = await free.remainingToday()
  console.log(`free requests left today: ${left ?? 'unknown'}, budget for this run: ${maxRequests}`)
  if (left !== null && left <= 0) {
    console.log('Skipped: the free model quota for today is spent')
    return 0
  }

  const ctx: SuiteCtx = { free, variant, quick, generator: GENERATOR, judge: JUDGE }

  if (flag('--labels')) {
    const { ensureLabels } = await import('./suites/goal_judge')
    const labels = await ensureLabels(ctx, true)
    console.log(`wrote ${Object.keys(labels).length} reference labels, ${Object.values(labels).filter((l) => l.consensus).length} with a consensus`)
    return 0
  }

  const results: SuiteResult[] = []
  try {
    for (const name of names) {
      const { run } = (await import(`./suites/${name}`)) as { run: (c: SuiteCtx) => Promise<SuiteResult> }
      console.log(`running ${name} (${variant}${quick ? ', quick' : ''})...`)
      const result = await run(ctx)
      writeReport(result)
      results.push(result)
    }
  } catch (err) {
    if (err instanceof QuotaError || err instanceof BudgetStop) {
      console.log(`Skipped: ${err.message}`)
      console.log(table(results))
      return 0
    }
    throw err
  }

  console.log(table(results))

  if (!flag('--check')) return 0
  const thresholds = loadThresholds()
  const all: string[] = []
  for (const r of results) {
    const bars = thresholds[r.prompt]
    if (!bars) continue
    all.push(...misses(r, bars, r.variant === 'after' ? readReport(r.prompt, 'before', false) : null))
  }
  if (all.length > 0) {
    console.log(`\nBelow the bar:\n${all.map((m) => `  ${m}`).join('\n')}`)
    return 1
  }
  console.log('\nAll bars met.')
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(2)
  }
)
