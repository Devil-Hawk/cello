'use client'

import Link from 'next/link'
import { LogOut, User } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { accountRoutes, older } from '@/lib/routes'

export interface ShellUser {
  email: string
  fullName: string | null
  avatarUrl: string | null
}

// The avatar sphere is the only sphere in the product. It opens everything that
// is not a key in the bar: Profile, Network, Chat, Settings, and the old pages
// that have no new home yet, then Sign out.
export function AccountMenu({ user, onSignOut }: { user: ShellUser; onSignOut: () => void }) {
  const who = user.fullName || user.email
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${who}`}
          className="r-key r-key-ghost r-key-bare min-h-11 min-w-11"
        >
          <span className="r-sphere grid h-8 w-8 place-items-center rounded-full">
            <User className="h-4 w-4" aria-hidden />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="end" sideOffset={8}>
        <DropdownMenuLabel className="font-normal">
          <p className="text-body font-medium text-foreground">{user.fullName || 'You'}</p>
          <p className="text-caption text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {accountRoutes().map((r) => (
          <DropdownMenuItem key={r.href + r.label} asChild className="min-h-11 cursor-pointer">
            <Link href={r.href}>{r.label}</Link>
          </DropdownMenuItem>
        ))}
        {older.length > 0 && <DropdownMenuSeparator />}
        {older.map((r) => (
          <DropdownMenuItem key={r.href} asChild className="min-h-11 cursor-pointer text-muted-foreground">
            <Link href={r.href}>{r.label}</Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="min-h-11 cursor-pointer" onClick={onSignOut}>
          <LogOut className="mr-2 h-4 w-4" aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
