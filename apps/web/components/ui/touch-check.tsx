import type { ReactNode } from 'react'

/** A checkbox whose real input fills the whole 44px label, so the box is a 44px target at every width. */
export function TouchCheck({ label, ariaLabel, checked, disabled, onChange, className = '' }: {
  label: ReactNode
  ariaLabel: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  className?: string
}) {
  return (
    <label className={`relative inline-flex min-h-11 min-w-11 cursor-pointer items-center gap-2 ${className}`}>
      <input
        type="checkbox"
        role="switch"
        className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span aria-hidden className="h-4 w-4 shrink-0 rounded border border-input bg-card peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50" />
      {label}
    </label>
  )
}
