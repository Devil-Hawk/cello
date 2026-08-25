'use client'

// PrepForInterviewButton — self-contained "Prep for interview" action.
//
// Contract (plan Section 1E): props are { jobId, applicationId?, label?,
// variant?, size? }; only `jobId` is required. Clicking it POSTs to
// /api/interview/generate, then navigates to the generated kit at /prep/[id].
// Degrades with a toast when there is no resume / no LLM key.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { GraduationCap, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'

export interface PrepForInterviewButtonProps {
  jobId: string
  /** Reserved for future context (e.g. linking a kit to an application). */
  applicationId?: string
  label?: string
  variant?: 'default' | 'outline' | 'secondary' | 'ghost'
  size?: 'sm' | 'default'
}

export function PrepForInterviewButton({
  jobId,
  label = 'Prep for interview',
  variant = 'outline',
  size = 'sm',
}: PrepForInterviewButtonProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)

  async function handleClick() {
    if (!jobId || loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/interview/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        if (data?.needsResume) {
          toast({
            title: 'Add your resume first',
            description: 'Upload a resume in Settings so STAR stories can be drawn from your real experience.',
            variant: 'destructive',
          })
        } else if (data?.needsKey) {
          toast({
            title: 'Add an API key',
            description: 'Configure an OpenRouter key in Settings to generate an interview kit.',
            variant: 'destructive',
          })
        } else {
          toast({
            title: 'Could not build the kit',
            description: typeof data?.error === 'string' ? data.error : 'Please try again.',
            variant: 'destructive',
          })
        }
        return
      }

      const kitId = data?.kit?.id
      if (kitId) {
        toast({ title: 'Interview kit ready', description: 'Opening your prep kit.' })
        router.push(`/prep/${kitId}`)
      } else {
        toast({ title: 'Interview kit ready', description: 'Find it on the Prep page.' })
        router.push('/prep')
      }
    } catch {
      toast({
        title: 'Could not build the kit',
        description: 'Network error — please try again.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button variant={variant} size={size} onClick={handleClick} disabled={loading}>
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <GraduationCap className="h-4 w-4" />
      )}
      {label}
    </Button>
  )
}
