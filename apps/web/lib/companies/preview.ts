// roles.preview: one posting read live from the employer's own page and captured the way a stored role is
// (cleaned, kept whole as Markdown, its requirements read one by one), and never stored. A person looks at a role
// before they act on it; acting (Interested, Apply, Save, Change type) is what stores it.
//
// restoreClearedPosting is `roles.get` for a role whose body was cleared at the storage alert: it reads the
// posting live the same way and stores the body again. When the site cannot be read the role keeps what it has
// (the requirement quotes and the hash) and the caller says so.

import type { SupabaseClient } from '@supabase/supabase-js'
import { postingCapture } from '../ingest/markdown'
import { jobFromDetail, readDetail } from '../ingest/reader/detail'
import { makeSiteFetcher, type SiteFetcher } from '../ingest/reader/site-fetch'
import type { PostingCapture } from '../jobs/relevance-types'
import { parseRequirements, type Requirements } from '../jobs/requirements'

type Db = SupabaseClient<any, any, any>

export interface PostingPreview extends PostingCapture {
  title: string
  location: string | null
  salary_range: string | null
  requirements: Requirements
}

/** The posting at `url`, or null when the page cannot be read, is not that posting, or is not a job page. Never throws, never writes. */
export async function previewPosting(input: { url: string; title?: string; fetcher?: SiteFetcher }): Promise<PostingPreview | null> {
  if (!/^https?:\/\//i.test(input.url)) return null
  const fetcher = input.fetcher ?? makeSiteFetcher({ mode: 'inline' })
  try {
    const res = await fetcher.get(input.url)
    if (!res.ok) return null
    const detail = readDetail(res.text, res.finalUrl)
    const job = jobFromDetail(res.finalUrl, detail, input.title ? { title: input.title } : undefined, { requirePosting: true })
    if (!job) return null
    const cap = postingCapture(job)
    return {
      title: job.title,
      location: job.location ?? null,
      salary_range: job.salary ?? null,
      ...cap,
      requirements: parseRequirements({ title: job.title, description: job.description ?? '', descriptionMd: cap.description_md, location: job.location, salaryRange: job.salary }),
    }
  } catch {
    return null
  }
}

/** Read a cleared posting again and store its body, for the person who holds the role. Returns what is stored now, or null when nothing could be read. */
export async function restoreClearedPosting(
  db: Db,
  input: { userId: string; jobId: string; fetcher?: SiteFetcher }
): Promise<PostingCapture | null> {
  const { data } = await db.from('person_jobs').select('id, url, title, description_state').eq('viewer_id', input.userId).eq('id', input.jobId).maybeSingle()
  const role = data as { id: string; url: string; title: string; description_state: string | null } | null
  if (!role || role.description_state !== 'cleared') return null
  const preview = await previewPosting({ url: role.url, title: role.title, fetcher: input.fetcher })
  if (!preview?.description_md) return null
  const stored: PostingCapture = {
    description_md: preview.description_md,
    description_state: preview.description_state,
    description_source: preview.description_source,
    apply_url: preview.apply_url,
    description_md5: preview.description_md5,
  }
  // an apply link the page did not state leaves the stored one alone
  const { apply_url, ...body } = stored
  const { error } = await db.from('jobs').update({ ...body, ...(apply_url ? { apply_url } : {}) }).eq('id', input.jobId)
  return error ? null : stored
}
