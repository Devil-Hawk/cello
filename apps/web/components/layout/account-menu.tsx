'use client'

import { forwardRef, useState, type ButtonHTMLAttributes, type ComponentType } from 'react'
import { User } from 'lucide-react'

export interface ShellUser {
  email: string
  fullName: string | null
  avatarUrl: string | null
}

export interface AvatarKeyProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  user: ShellUser
  expanded?: boolean
}

/** The avatar sphere as a key: the only sphere in the product. */
export const AvatarKey = forwardRef<HTMLButtonElement, AvatarKeyProps>(function AvatarKey({ user, expanded = false, ...props }, ref) {
  const who = user.fullName || user.email
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Account menu for ${who}`}
      aria-haspopup="menu"
      aria-expanded={expanded}
      className="r-key r-key-ghost r-key-bare min-h-11 min-w-11"
      {...props}
    >
      <span className="r-sphere grid h-8 w-8 place-items-center rounded-full">
        <User className="h-4 w-4" aria-hidden />
      </span>
    </button>
  )
})

type PopupProps = { user: ShellUser; onSignOut: () => void }

// It opens everything that is not a key in the bar: Profile, Network, Chat,
// Settings, the old pages that have no new home yet, then Sign out. The menu's
// code (Radix) loads the first time the avatar is pressed, so no page carries it
// in its first load; the key stays where it is until the menu takes its place.
export function AccountMenu({ user, onSignOut }: PopupProps) {
  const [Popup, setPopup] = useState<ComponentType<PopupProps> | null>(null)
  if (Popup) return <Popup user={user} onSignOut={onSignOut} />
  return <AvatarKey user={user} onClick={() => void import('./account-menu-popup').then((m) => setPopup(() => m.default))} />
}
