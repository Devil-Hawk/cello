'use client'

// One posting from an employer's live list, read now and not stored. It is laid out like the record: who, what, where
// and for how much as the employer stated it, then the requirements read by code, the whole posting, pay and place,
// and the company. "Not saved. Interested or Apply keeps it." Acting stores it once for this person (keepPreview) and
// the preview address then redirects to its record. Check my chance runs the declared step and stores nothing.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Disclosure } from '@/components/ui/disclosure'
import { Key } from '@/components/ui/key'
import { QuickChatSlot } from '@/components/layout/quick-chat-slot'
import { LogoTile } from '@/components/roles/role-tile'
import { FitProvider } from '@/components/roles/record/fit-state'
import { FitStrip } from '@/components/roles/record/fit-strip'
import { Posting } from '@/components/roles/record/posting'
import { Requirements } from '@/components/roles/record/requirements'
import { postedAgo } from '@/components/roles/logic'
import { companyHref } from '@/lib/routes/companies'
import { recordHref } from '@/lib/routes/roles'
import { keepPreview, previewChance } from '@/app/(app)/companies/actions'
import type { PreviewData } from '@/app/(app)/companies/[id]/read'
import { companyPageHref, type CompanyQuery } from './company-logic'

export const PREVIEW_NOT_SAVED = 'Not saved. Interested or Apply keeps it.'

export interface PreviewViewProps {
  data: PreviewData
  /** The list's address, so Back returns to the same page and filters. */
  query: CompanyQuery
  now?: number
}

export function PreviewView({ data, query, now = Date.now() }: PreviewViewProps) {
  const router = useRouter()
  const [view, setView] = useState(data.fit)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const back = companyPageHref(data.employerId, query)

  async function keep(intent: 'keep' | 'save', then?: (id: string) => Promise<boolean>) {
    setBusy(intent)
    setNote(null)
    try {
      const r = await keepPreview(data.employerId, data.key, intent)
      if (!r.ok) {
        setNote(r.sentence)
        return
      }
      if (then && !(await then(r.id))) {
        setNote('Saved, but your reaction was not. Open the role to try again.')
      }
      router.push(recordHref(r.id))
    } catch {
      setNote('Could not save that. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const interested = (id: string) =>
    fetch(`/api/roles/${id}/reaction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reaction: 'interested', surface: 'company' }) }).then((r) => r.ok, () => false)

  async function check() {
    setBusy('check')
    setNote(null)
    try {
      const r = await previewChance(data.employerId, data.key)
      if (r.ok) setView(r.view)
      else setNote(r.sentence)
    } catch {
      setNote('Could not check your chance. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const facts = [data.type, data.level, data.location, data.pay, postedAgo(data.postedAt, now)].filter(Boolean).join(' · ')
  return (
    <FitProvider key={view.readAt ?? 'code'} view={view} kinds={data.kinds} correctUrl={null}>
      <article className="mx-auto max-w-[860px] space-y-8 pb-20">
        <p>
          <Link href={back} className="r-body underline underline-offset-4">
            {`Back to ${data.company.name}`}
          </Link>
        </p>
        <header className="space-y-4">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <LogoTile name={data.company.name} domain={data.company.domain} logoUrl={data.company.logoUrl} companyId={data.employerId} size={64} />
            <div className="min-w-0 flex-1 basis-56">
              <h1 className="flex flex-col">
                <span className="r-name">{data.title}</span>
                <Link href={companyHref(data.employerId)} className="r-name hover:underline">
                  {data.company.name}
                </Link>
              </h1>
              {facts && <p className="r-meta mt-1">{facts}</p>}
            </div>
          </div>
          <FitStrip />
          <p className="r-body">{PREVIEW_NOT_SAVED}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Key disabled={busy !== null} onClick={() => keep('keep', interested)}>
              Interested
            </Key>
            <Key variant="raised" disabled={busy !== null} onClick={() => keep('keep')}>
              Apply
            </Key>
            <Key variant="raised" disabled={busy !== null} onClick={() => keep('save')}>
              Save
            </Key>
            <Key variant="ghost" disabled={busy !== null} onClick={() => keep('keep')}>
              Change type
            </Key>
            {data.fit.items.length > 0 && (
              <Key variant="ghost" disabled={busy !== null} onClick={check}>
                Check my chance
              </Key>
            )}
          </div>
          {note && (
            <p role="alert" className="r-meta">
              {note}
            </p>
          )}
          <QuickChatSlot about={{ kind: 'posting', ref: `${data.employerId}:${data.key}` }} />
        </header>

        <div className="r-sheet-lead">
          {view.items.length > 0 && (
            <Disclosure title="Requirements" count={view.items.length}>
              <Requirements />
            </Disclosure>
          )}
          <Disclosure title="The posting" defaultOpen>
            <Posting text={data.description} partial={data.partial} company={data.company.name} url={data.url} tier={data.tier} closed={false} checkedAt={null} />
          </Disclosure>
          <Disclosure title="Pay and place">
            <dl className="r-body space-y-3">
              <div>
                <dt className="r-meta">Pay</dt>
                <dd>{data.pay ?? 'The posting does not state pay.'}</dd>
              </div>
              <div>
                <dt className="r-meta">Place</dt>
                <dd>{data.location ?? 'The posting does not state a place.'}</dd>
              </div>
            </dl>
          </Disclosure>
          <Disclosure title="The company">
            <div className="flex items-start gap-3">
              <LogoTile name={data.company.name} domain={data.company.domain} logoUrl={data.company.logoUrl} companyId={data.employerId} size={48} />
              <div className="space-y-1">
                <Link href={companyHref(data.employerId)} className="r-name hover:underline">
                  {data.company.name}
                </Link>
                {data.company.domain && <p className="r-meta">{data.company.domain}</p>}
              </div>
            </div>
            <Key asChild variant="raised" className="mt-4">
              <a href={data.url} target="_blank" rel="noopener noreferrer">
                {`Open on ${data.company.name}'s site`} <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
              </a>
            </Key>
          </Disclosure>
        </div>
      </article>
    </FitProvider>
  )
}

/** The posting that was listed a moment ago and is not any more. */
export function PreviewClosed({ company, back }: { company: string; back: string }) {
  return (
    <div className="mx-auto max-w-[860px] space-y-4">
      <h1 className="r-display">This role is no longer listed.</h1>
      <p className="r-body">{`${company} has taken it down since the list was read.`}</p>
      <Key asChild variant="raised">
        <Link href={back}>{`Back to ${company}`}</Link>
      </Key>
    </div>
  )
}
