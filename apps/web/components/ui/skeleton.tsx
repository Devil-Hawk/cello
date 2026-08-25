import * as React from 'react'
import { cn } from '@/lib/utils'

/** Shimmer placeholder block — size it with width/height classes. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton', className)} {...props} />
}

export { Skeleton }
