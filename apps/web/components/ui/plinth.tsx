import * as React from 'react'
import { cn } from '@/lib/utils'

// The navigation bar's body: a raised plinth resting on the ground. `tabs` is
// the phone's bottom plinth, square at the screen edge.
export interface PlinthProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'div' | 'nav' | 'header'
  kind?: 'bar' | 'tabs'
}

export function Plinth({ as: Tag = 'div', kind = 'bar', className, ...props }: PlinthProps) {
  return <Tag className={cn(kind === 'bar' ? 'r-plinth' : 'r-plinth-tabs', className)} {...props} />
}
