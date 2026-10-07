'use client'

import Link from 'next/link'
import { LogOut } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { accountRoutes, older } from '@/lib/routes'
import { AvatarKey, type ShellUser } from './account-menu'

// The menu itself. It loads the first time the avatar is pressed (account-menu.tsx),
// so the menu's code is not part of any page's first load, and it opens on arrival.
export default function AccountMenuPopup({ user, onSignOut }: { user: ShellUser; onSignOut: () => void }) {
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <AvatarKey user={user} expanded />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="end" sideOffset={8}>
        <DropdownMenuLabel className="font-normal">
          <p className="text-body font-medium text-foreground">{user.fullName || 'You'}</p>
          <p className="text-caption text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {accountRoutes(user.chatOpen).map((r) => (
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
