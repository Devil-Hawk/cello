'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import { ResumeUploadCard, type ResumeStatus } from './resume-upload-card'

export interface ProfileTabProps {
  initialFullName: string
  email: string
  initialResumeStatus: ResumeStatus
  initialResumeInfo: string | null
  onStatus: (status: 'success' | 'error', message: string) => void
}

/** Profile settings: full name (profiles.full_name), read-only email, resume upload. */
export function ProfileTab({
  initialFullName,
  email,
  initialResumeStatus,
  initialResumeInfo,
  onStatus,
}: ProfileTabProps) {
  const supabase = createClient()
  const [fullName, setFullName] = useState(initialFullName)
  const [isSaving, setIsSaving] = useState(false)

  async function saveProfile() {
    setIsSaving(true)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      onStatus('error', 'Not authenticated')
      setIsSaving(false)
      return
    }

    const { error } = await supabase
      .from('profiles')
      .update({ full_name: fullName })
      .eq('id', user.id)

    if (error) {
      onStatus('error', 'Failed to save profile')
    } else {
      onStatus('success', 'Profile saved successfully')
    }

    setIsSaving(false)
  }

  return (
    <div className="space-y-6">
      <h2 className="font-display text-section text-foreground">Profile</h2>

      <div className="space-y-5">
        <div>
          <label htmlFor="settings-full-name" className="text-body font-medium text-foreground">
            Full name
          </label>
          <Input
            id="settings-full-name"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="mt-1.5"
            placeholder="Your name"
            autoComplete="name"
          />
        </div>

        <div>
          <label htmlFor="settings-email" className="text-body font-medium text-foreground">
            Email
          </label>
          <Input
            id="settings-email"
            type="email"
            value={email}
            className="mt-1.5 cursor-not-allowed bg-sunken"
            disabled
          />
          <p className="mt-1 text-caption text-muted-foreground">
            Email is managed by your sign-in provider
          </p>
        </div>

        <ResumeUploadCard
          initialStatus={initialResumeStatus}
          initialInfo={initialResumeInfo}
          onStatus={onStatus}
        />

        <Button onClick={saveProfile} disabled={isSaving}>
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save changes
        </Button>
      </div>
    </div>
  )
}
