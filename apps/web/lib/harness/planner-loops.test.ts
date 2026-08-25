// Guards the planner's ability to emit LOOP and FAN-OUT steps.
//
// WHY THIS FILE EXISTS
//   The executor has supported until-condition loops since it was written:
//   runLoop() in dynamic.ts, LoopSpecSchema in schemas.ts, a hard iteration
//   cap, forward-progress detection, and passing tests in executor.test.ts.
//   None of it ever ran. `grep -c loop lib/harness/planner.ts` returned 0 and
//   the planner's output contract in prompts/planner.md documented exactly
//   four fields — label, agent_type, input, dependsOn — so the model was never
//   told `loop` existed and never emitted one.
//
//   The user-visible symptom: "apply to 10 jobs" planned a flat DAG, sourced
//   whatever a single query returned, and reported success four short.
//
//   The fix was entirely in the prompt, which makes it exactly the kind of fix
//   that silently regresses — a future edit to planner.md that trims the
//   output-contract section would put us straight back to flat plans with no
//   test failing. So the first block below asserts the CONTRACT IS TAUGHT, and
//   the rest assert the schema still accepts what the prompt tells the model
//   to produce. The two halves have to agree or the feature is dead again.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PlanSchema } from './schemas'

const PLANNER_MD = readFileSync(
  path.resolve(process.cwd(), 'prompts/planner.md'),
  'utf8'
)

describe('the planner prompt actually teaches the loop contract', () => {
  it('documents `loop` with the exact key names the schema validates', () => {
    // If any of these drift, the model emits a shape PlanSchema rejects and
    // the planner silently falls back to defaultPlan().
    for (const token of ['loop', 'maxIterations', 'until', 'gte']) {
      expect(PLANNER_MD).toContain(token)
    }
  })

  it('documents `fanOut` with the keys the schema requires', () => {
    for (const token of ['fanOut', 'overDep', 'overKey', 'itemKey']) {
      expect(PLANNER_MD).toContain(token)
    }
  })

  it('tells the model both fields exist in the output contract', () => {
    // The contract line is what the model copies. Documenting loops further
    // down the page while the JSON shape omits them is how this broke.
    const contractLine = PLANNER_MD.split('\n').find(
      (l) => l.includes('"goal"') && l.includes('"steps"')
    )
    expect(contractLine, 'output-contract JSON line not found').toBeTruthy()
    expect(contractLine).toContain('loop')
    expect(contractLine).toContain('fanOut')
  })

  it('makes the self-check ask about counted goals', () => {
    // The planner reliably forgot to loop even when the goal said "10". The
    // self-check is the backstop; if it stops mentioning numbers, the backstop
    // is gone.
    const selfCheck = PLANNER_MD.slice(PLANNER_MD.indexOf('## Self-check'))
    expect(selfCheck.toLowerCase()).toContain('number')
    expect(selfCheck).toContain('loop')
  })
})

describe('PlanSchema accepts what the prompt asks the model for', () => {
  /** The canonical "apply to 10 jobs" shape: a looped source feeding a
   *  fanned-out tailor. This is the plan the whole change exists to make
   *  possible, so it is the plan the test asserts. */
  const applyToTenPlan = {
    goal: 'Apply to 10 AI engineer roles at Series A+ startups',
    steps: [
      {
        label: 'source',
        agent_type: 'sourcer',
        input: { query: 'AI engineer' },
        dependsOn: [],
        loop: { maxIterations: 5, until: { key: 'found', op: 'gte', value: 10 } },
      },
      {
        label: 'score',
        agent_type: 'matcher',
        input: {},
        dependsOn: ['source'],
      },
      {
        label: 'tailor',
        agent_type: 'cv_tailor',
        input: {},
        dependsOn: ['score'],
        fanOut: { overDep: 'score', overKey: 'matches', itemKey: 'job', maxChildren: 10 },
      },
    ],
  }

  it('validates the looped-source + fanned-out-tailor plan end to end', () => {
    const parsed = PlanSchema.safeParse(applyToTenPlan)
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true)
  })

  it('accepts a .length dot-path in until.key, which the prompt promises works', () => {
    const plan = structuredClone(applyToTenPlan)
    plan.steps[0].loop!.until.key = 'matches.length'
    expect(PlanSchema.safeParse(plan).success).toBe(true)
  })

  it.each(['gte', 'gt', 'lte', 'lt', 'eq', 'neq'])('accepts the documented op %s', (op) => {
    const plan = structuredClone(applyToTenPlan)
    plan.steps[0].loop!.until.op = op
    expect(PlanSchema.safeParse(plan).success).toBe(true)
  })
})

describe('the bounds the prompt promises the model it does not have to enforce', () => {
  function planWithLoop(loop: unknown) {
    return {
      goal: 'g',
      steps: [{ label: 'a', agent_type: 'sourcer', input: {}, dependsOn: [], loop }],
    }
  }

  it('rejects maxIterations above the hard cap of 10', () => {
    // The prompt tells the model "choose maxIterations for the work, not for
    // safety" — that promise is only honest because the schema refuses 11.
    expect(PlanSchema.safeParse(planWithLoop({ maxIterations: 11, until: { key: 'found', op: 'gte', value: 10 } })).success).toBe(false)
  })

  it('rejects a non-positive maxIterations', () => {
    expect(PlanSchema.safeParse(planWithLoop({ maxIterations: 0, until: { key: 'found', op: 'gte', value: 1 } })).success).toBe(false)
  })

  it('rejects an unknown comparison op', () => {
    expect(PlanSchema.safeParse(planWithLoop({ maxIterations: 3, until: { key: 'found', op: 'approximately', value: 10 } })).success).toBe(false)
  })

  it('rejects loop and fanOut on the same step — the prompt calls them mutually exclusive', () => {
    const plan = {
      goal: 'g',
      steps: [
        { label: 'a', agent_type: 'sourcer', input: {}, dependsOn: [] },
        {
          label: 'b',
          agent_type: 'cv_tailor',
          input: {},
          dependsOn: ['a'],
          loop: { maxIterations: 2, until: { key: 'found', op: 'gte', value: 1 } },
          fanOut: { overDep: 'a', overKey: 'items', itemKey: 'item', maxChildren: 3 },
        },
      ],
    }
    expect(PlanSchema.safeParse(plan).success).toBe(false)
  })

  it('rejects a fanOut whose overDep is not one of the step\'s own dependsOn', () => {
    // The prompt states this requirement; the schema is what makes it true.
    const plan = {
      goal: 'g',
      steps: [
        { label: 'a', agent_type: 'sourcer', input: {}, dependsOn: [] },
        { label: 'b', agent_type: 'matcher', input: {}, dependsOn: [] },
        {
          label: 'c',
          agent_type: 'cv_tailor',
          input: {},
          dependsOn: ['a'],
          fanOut: { overDep: 'b', overKey: 'items', itemKey: 'item', maxChildren: 3 },
        },
      ],
    }
    expect(PlanSchema.safeParse(plan).success).toBe(false)
  })

  it('still accepts a plain step with neither loop nor fanOut', () => {
    // The change must not make the ordinary case harder to express.
    const plan = { goal: 'g', steps: [{ label: 'a', agent_type: 'sourcer', input: {}, dependsOn: [] }] }
    expect(PlanSchema.safeParse(plan).success).toBe(true)
  })
})
