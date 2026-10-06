import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { LogoTile, RoleTitle, type TileState } from './role-tile'

export interface RoleRowProps {
  id: string
  title: string
  company: string
  companyId?: string | null
  domain?: string | null
  logoUrl?: string | null
  /** One line of facts: type, place, posted. Plain text, never a score alone. */
  meta?: ReactNode
  /** Interested, Not for me and the like. Wrap under the title on a phone. */
  actions?: ReactNode
  state?: TileState
  tileSize?: 40 | 48 | 56 | 64
  className?: string
}

/** A role on a list: the tile, the title and company at one weight, one line of facts, then the actions. */
export function RoleRow({
  id,
  title,
  company,
  companyId,
  domain,
  logoUrl,
  meta,
  actions,
  state,
  tileSize = 48,
  className,
}: RoleRowProps) {
  return (
    <div className={cn('r-row flex flex-wrap items-start gap-x-3 gap-y-2 px-2 py-3', className)}>
      <LogoTile name={company} domain={domain} logoUrl={logoUrl} companyId={companyId} size={tileSize} state={state} />
      <div className="min-w-0 flex-1 basis-48">
        <RoleTitle id={id} title={title} company={company} companyId={companyId} />
        {meta && <p className="r-meta mt-1">{meta}</p>}
      </div>
      {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
