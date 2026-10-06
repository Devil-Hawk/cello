'use client'

// The shared logo tile and role title. Every page that shows a role beside its
// employer uses these two, so the role title rule (directive 34) is built once:
// the title and the company name share the `r-name` class (same size, weight
// and colour), both wrap and neither truncates, the title opens the record in
// one click, and the logo and the company name open Company.

import Link from 'next/link'
import { useState } from 'react'
import { Tile } from '@/components/ui/tile'
import { companyHref } from '@/lib/routes/companies'
import { recordHref } from '@/lib/routes/roles'
import { clsx as cn } from 'clsx'

/** The favicon service, from a domain. Job hosts become the employer's own domain (amazon.jobs to amazon.com). */
export function logoSrc(domain?: string | null, logoUrl?: string | null): string | null {
  if (logoUrl) return logoUrl
  if (!domain) return null
  const d = domain.replace(/^www\./, '').replace(/\.(jobs|careers)$/, '.com').replace(/^(jobs|careers)\./, '')
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`
}

export type TileState = 'default' | 'ring' | 'flat'

export interface LogoTileProps {
  name: string
  domain?: string | null
  logoUrl?: string | null
  /** 28 to 96. */
  size?: number
  /** Where the tile goes. Pass the company's id as companyId to use its page. */
  href?: string
  companyId?: string | null
  /** ring: needs the person (the one lead tile). flat: finished or closed. */
  state?: TileState
}

export function LogoTile({ name, domain, logoUrl, size = 48, href, companyId, state = 'default' }: LogoTileProps) {
  const [failed, setFailed] = useState(false)
  const src = failed ? null : logoSrc(domain, logoUrl)
  const to = href ?? (companyId ? companyHref(companyId) : undefined)
  const tile = (
    <Tile size={size} kind={src ? 'logo' : 'initial'} ring={state === 'ring'} flat={state === 'flat'} aria-hidden={to ? true : undefined} role={to ? undefined : 'img'} aria-label={to ? undefined : name}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" onError={() => setFailed(true)} loading="lazy" />
      ) : (
        <span aria-hidden>{name.trim().charAt(0).toUpperCase()}</span>
      )}
    </Tile>
  )
  if (!to) return tile
  return (
    <Link href={to} aria-label={`${name}, company page`} className="inline-flex flex-none rounded-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
      {tile}
    </Link>
  )
}

export interface RoleTitleProps {
  id: string
  title: string
  company?: string | null
  companyId?: string | null
  /** stacked: the company directly under the title. inline: both on one wrapping line. */
  layout?: 'stacked' | 'inline'
  className?: string
}

export function RoleTitle({ id, title, company, companyId, layout = 'stacked', className }: RoleTitleProps) {
  return (
    <span className={cn(layout === 'stacked' ? 'flex flex-col' : 'flex flex-wrap items-baseline gap-x-2', 'min-w-0', className)}>
      <Link href={recordHref(id)} className="r-name hover:underline">
        {title}
      </Link>
      {company &&
        (companyId ? (
          <Link href={companyHref(companyId)} className="r-name hover:underline">
            {company}
          </Link>
        ) : (
          <span className="r-name">{company}</span>
        ))}
    </span>
  )
}
