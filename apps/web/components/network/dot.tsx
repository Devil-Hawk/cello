// The small copper dot for "a follow-up is due": on a Network row, on the Network key in the bar and in the phone's menu.
export function DueDot({ className = '' }: { className?: string }) {
  return <span role="img" aria-label="Follow-up due" className={`inline-block h-2 w-2 shrink-0 rounded-full bg-r-copper ${className}`} />
}
