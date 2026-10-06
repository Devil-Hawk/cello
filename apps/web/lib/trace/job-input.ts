// Routes keyed by a job id (analyze, follow-up) would otherwise show a bare uuid as
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
    // Both callers pass the person's own client, so the view returns their one row; limit(1) keeps a service-role caller safe.
    const { data } = await db.from('person_jobs').select('title, viewer_company_name').eq('id', jobId).limit(1).maybeSingle()
    const job = data as { title?: string; viewer_company_name?: string | null } | null
    if (!job) return
    setTraceInput({ jobTitle: job.title ?? null, companyName: job.viewer_company_name ?? null })
  } catch {
    // Observability only: the id in the metadata is enough.
  }
}
