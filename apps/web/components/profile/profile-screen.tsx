'use client'

// The page's client half: wires the view to the router (reload after a save) and to toasts.

import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import { correctFact } from './correct-fact'
import { ProfileView, type ProfileViewProps } from './profile-view'

export function ProfileScreen(props: Omit<ProfileViewProps, 'refresh' | 'onStatus' | 'onCorrect'>) {
  const router = useRouter()
  const { toast } = useToast()
  return (
    <ProfileView
      {...props}
      refresh={() => router.refresh()}
      onStatus={(status, message) => toast({ title: message, variant: status === 'error' ? 'destructive' : 'default' })}
      onCorrect={async (fact, raw) => {
        const problem = await correctFact(fact, raw)
        if (!problem) router.refresh()
        return problem
      }}
    />
  )
}
