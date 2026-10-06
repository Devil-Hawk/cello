import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
// ponytail: clsx, not tailwind-merge. Relief classes do not collide with utility classes, and
// tailwind-merge is about 7 KB of every page's first load. Add it back if a caller needs to override a utility.
import { clsx as cn } from 'clsx'

// A key: lit on its top edge, resting on a contact shadow, 1px proud. It sits
// down when pressed. Every key is at least 44px each way (min-h-11 min-w-11).
// The look itself lives in app/relief.css; this file only picks class names.
const keyVariants = cva('r-key min-h-11 min-w-11 font-r', {
  variants: {
    variant: {
      ink: 'r-key-ink',
      raised: 'r-key-raised',
      ghost: 'r-key-ghost',
    },
  },
  defaultVariants: { variant: 'ink' },
})

export interface KeyProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof keyVariants> {
  /** Render the child element (a link) as the key. */
  asChild?: boolean
  /** The page this key stands for is the current one. */
  current?: boolean
}

const Key = React.forwardRef<HTMLButtonElement, KeyProps>(
  ({ className, variant, asChild = false, current, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? 'button')}
        aria-current={current ? 'page' : undefined}
        className={cn(keyVariants({ variant }), className)}
        {...props}
      />
    )
  },
)
Key.displayName = 'Key'

export { Key, keyVariants }
