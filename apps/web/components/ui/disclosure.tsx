import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

// A disclosure group: a hairline, a heading at Title size with a count or one
// token of what is inside, a chevron, and a body that opens in place. Native
// details and summary, so it works with no script and keeps its own state.
export interface DisclosureProps {
  title: string
  /** A count ("9") or one token ("6 sections"). */
  count?: string | number
  defaultOpen?: boolean
  className?: string
  children: React.ReactNode
}

export function Disclosure({ title, count, defaultOpen, className, children }: DisclosureProps) {
  return (
    <details className={cn('r-dg', className)} open={defaultOpen}>
      <summary>
        <span>{title}</span>
        {count !== undefined && <span className="r-dg-count">{count}</span>}
        <ChevronDown className="r-dg-chevron h-[18px] w-[18px]" aria-hidden />
      </summary>
      <div className="r-dg-body pb-4">{children}</div>
    </details>
  )
}
