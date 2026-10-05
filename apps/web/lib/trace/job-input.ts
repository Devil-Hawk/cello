// Routes keyed by a job id (analyze, coach) would otherwise show a bare uuid as
// the Langfuse root input. This reads the title and company so the trace says
// what it is about, and keeps the id in the trace metadata. The extra query
// runs only when the trace actually captures content: otherwise the input is
// dropped anyway.

import type { AdminClient } from '../harness/types'
import { currentTraceContext, setTraceInput, setTraceMeta } from './spans'

export async function traceJobInput(db: AdminClient, jobId: string): Promise<void> {
  setTraceMeta({ job_id: jobId })
  if (!currentTraceContext()?.buffer.captureContent) return
  try {
    const { data } = await db.from('jobs').select('title, companies(name)').eq('id', jobId).single()
    const job = data as { title?: string; companies?: { name?: string | null } | { name?: string | null }[] | null } | null
    if (!job) return
    const company = Array.isArray(job.companies) ? job.companies[0] : job.companies
    setTraceInput({ jobTitle: job.title ?? null, companyName: company?.name ?? null })
  } catch {
    // Observability only: the id in the metadata is enough.
  }
}
