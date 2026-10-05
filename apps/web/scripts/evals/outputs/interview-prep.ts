// Interview prep kits, through the real kit writer.
//
//   sh scripts/evals/outputs/run.sh interview-prep --label before|after [--quick] [--stub]
//
// before: the release/1 kit (legacy/writers.ts): stories shown as the model wrote them.
// after:  synthesizeKit: stories cite resume lines and the ones that do not trace
//         are removed, company questions are dropped with no research.
// Shown stories are checked against the whole resume by the yardstick judge, the
// number of stories against the label, the company questions against whether
// research was on file, and the guidance for specificity.

import { synthesizeKit } from '@/lib/harness/agents/interview_prep'
import { legacyKit } from './legacy/writers'
import { WRITER_MODEL, YARDSTICK_MODEL, freeRunner, job, load, metricFrom, report, resumeText, run, start, yardstick } from './lib/evalkit'
import type { Metric } from './lib/report'

interface Item {
  id: string
  resume: string
  jobId: string
  company: string
  context: string
  hasResearch: boolean
  maxStories: number
}

async function main() {
  const args = start()
  const items = load<Item>('interview-prep', args)
  const writer = freeRunner(WRITER_MODEL)
  const tracedRows: { id: string; ok: boolean }[] = []
  const countRows: { id: string; ok: boolean }[] = []
  const companyRows: { id: string; ok: boolean }[] = []
  const guidanceRows: { id: string; ok: boolean }[] = []
  const rows: unknown[] = []

  for (const item of items) {
    const resume = resumeText(item.resume)
    const j = job(item.jobId)
    let stories: { situation: string; task: string; action: string; result: string }[] = []
    let questions: { category: string; guidance: string }[] = []
    try {
      if (args.label === 'before') {
        const kit = await legacyKit(writer, { title: j.title, company: item.company, description: j.description, resumeText: resume, context: item.context })
        stories = kit.stories
        questions = kit.questions
      } else {
        const kit = await synthesizeKit(writer, { job: { id: 'job-1', title: j.title, description: j.description }, company: { name: item.company }, resumeText: resume, context: item.context })
        stories = kit.starStories
        questions = kit.questions
      }
    } catch (e) {
      console.log(`${item.id} no kit: ${e instanceof Error ? e.message.slice(0, 80) : e}`)
    }

    countRows.push({ id: item.id, ok: stories.length <= item.maxStories })
    if (!item.hasResearch) companyRows.push({ id: item.id, ok: !questions.some((q) => q.category === 'company-specific') })
    for (const [k, s] of stories.entries()) {
      const text = `Situation: ${s.situation}\nTask: ${s.task}\nAction: ${s.action}\nResult: ${s.result}`
      const verdict = await yardstick('story', `<resume>\n${resume}\n</resume>\n<story>\n${text}\n</story>`)
      if (typeof verdict?.supported === 'boolean') tracedRows.push({ id: `${item.id}#${k + 1}`, ok: verdict.supported })
    }
    for (const [k, q] of questions.filter((x) => x.guidance).slice(0, 4).entries()) {
      const verdict = await yardstick('guidance', `<resume>\n${resume.slice(0, 1500)}\n</resume>\n<job>${j.title} at ${item.company}</job>\n<guidance>\n${q.guidance}\n</guidance>`)
      if (typeof verdict?.specific === 'boolean') guidanceRows.push({ id: `${item.id}#${k + 1}`, ok: verdict.specific })
    }
    rows.push({ id: item.id, stories: stories.length, questions: questions.length })
    console.log(`${item.id} stories=${stories.length}/${item.maxStories} questions=${questions.length}`)
  }

  const metrics: Metric[] = [
    metricFrom('shown stories traced to the resume (yardstick)', tracedRows, `${tracedRows.length} stories judged`),
    metricFrom('story count within label', countRows),
    metricFrom('no company questions without research', companyRows),
    metricFrom('guidance specific (yardstick)', guidanceRows, `${guidanceRows.length} lines judged`),
  ]
  report('interview-prep', args, `yardstick ${YARDSTICK_MODEL}`, metrics, rows)
}

run(main)
