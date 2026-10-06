'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Key } from '@/components/ui/key'

// The appearance key: the sun in the light, the moon in the dark. next-themes
// sets the class before first paint from the system setting or the remembered
// choice, so the right icon shows with no flash.
export function ThemeKey() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Key
      variant="ghost"
      aria-label="Switch between light and dark"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <Sun className="h-[18px] w-[18px] dark:hidden" aria-hidden />
      <Moon className="hidden h-[18px] w-[18px] dark:block" aria-hidden />
    </Key>
  )
}
