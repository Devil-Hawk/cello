import { describe, expect, it } from 'vitest'
import { normalizePostingUrl, postingUrlHash } from './posting'

// The same three values are pinned in supabase/checks/pipeline_core.sql.
describe('postingUrlHash', () => {
  it('gives the SQL function\'s value for the same address', () => {
    expect(postingUrlHash('https://www.Example.com/jobs/1/?utm=x#a')).toBe('146b9aaefc0354376878bb90633bb37a42fcf4d392fe9c7139a04b6ca3960a58')
    expect(postingUrlHash('https://boards.greenhouse.io/stripe/jobs/123')).toBe('79bd0d6270c0f4a50e82f1ff93943496b94558ad0d9d315edb699d90e79b6b8c')
    expect(postingUrlHash('https://careers.example.com/open?gh_jid=987&x=1')).toBe('92381f34147564b691b88f3afd15096e00c0078dc091847ec56595214dd27db6')
  })

  it('treats tracking, www, case and a trailing slash as the same posting, and a Greenhouse job id as a different one', () => {
    const base = postingUrlHash('https://example.com/jobs/1')
    expect(postingUrlHash('http://WWW.example.com/Jobs/1/?utm_source=a#top')).toBe(base)
    expect(postingUrlHash('https://example.com/jobs/2')).not.toBe(base)
    expect(postingUrlHash('https://example.com/open?gh_jid=1')).not.toBe(postingUrlHash('https://example.com/open?gh_jid=2'))
  })

  it('has no hash for an empty address', () => {
    expect(postingUrlHash('  ')).toBeNull()
    expect(normalizePostingUrl('')).toBeNull()
  })
})
