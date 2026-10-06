import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }), usePathname: () => '/' }))
// Chat is closed in a static render, so stand in for the one field the quick chat draws when it is open.
vi.mock('@/components/chat/quick-chat', () => ({ QuickChat: () => <input aria-label="Chat about this" /> }))

import { Shell } from './shell'
import { RecordView } from '@/components/roles/record/record-view'
import { fixtureRecord } from '@/components/roles/fixtures'

const user = { email: 'sam@example.com', fullName: 'Sam Rivera', avatarUrl: null }
const fields = (html: string) => (html.match(/aria-label="Chat about this"/g) ?? []).length

describe('the quick chat', () => {
  it('is mounted once on a page the shell owns', () => {
    const html = renderToStaticMarkup(
      <Shell pathname="/today" user={user} onSignOut={() => undefined}>
        <p>page</p>
      </Shell>,
    )
    expect(fields(html)).toBe(1)
  })

  it('is mounted once on the record, where it carries the role', () => {
    const html = renderToStaticMarkup(
      <Shell pathname="/roles/10000000-0000-4000-8000-000000000001" user={user} onSignOut={() => undefined}>
        <RecordView data={fixtureRecord()} />
      </Shell>,
    )
    expect(fields(html)).toBe(1)
  })
})
