// Maps a classified email + stage decision onto an `activities` row. This is
// the piece that was entirely missing before — no email ever produced a
// timeline entry, which is why interviews "disappeared".

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Json } from '@cello/shared'
import type { ActivityType, ApplicationStatus } from './types'
import type { StageDecision } from './stage'
import { recordInteraction } from '../interactions/store'

export function activityTypeForStatus(status: ApplicationStatus, decision: StageDecision): ActivityType {
  if (status === 'interview' || status === 'screen') return 'interview_scheduled'
  if (status === 'offer') return 'offer_received'
  if (status === 'rejected') return 'rejected'
  if (decision.action === 'advanced' || decision.action === 'ignored_regression' || decision.action === 'ignored_terminal') {
    return 'stage_change'
  }
  return 'email_received'
}

export interface ActivityContent {
  title: string
  description: string
}

export function buildActivityContent(params: {
  status: ApplicationStatus
  decision: StageDecision
  companyName: string
  jobTitle: string
  subject: string
  reasoning: string | null
  interviewDateTime: string | null
}): ActivityContent {
  const { status, decision, companyName, jobTitle, subject, reasoning, interviewDateTime } = params

  if (decision.action === 'ignored_terminal' || decision.action === 'ignored_regression') {
    return {
      title: `Email received (no stage change) — ${companyName}`,
      description: `${decision.reason}. Subject: "${subject}"`,
    }
  }

  switch (status) {
    case 'interview':
      return {
        title: `Interview scheduled — ${companyName}`,
        description: interviewDateTime
          ? `${jobTitle} interview detected for ${new Date(interviewDateTime).toLocaleString()}. Subject: "${subject}"`
          : `${jobTitle} interview confirmed. Subject: "${subject}"`,
      }
    case 'screen':
      return {
        title: `Phone screen scheduled — ${companyName}`,
        description: interviewDateTime
          ? `Screen for ${jobTitle} detected for ${new Date(interviewDateTime).toLocaleString()}. Subject: "${subject}"`
          : `Screen for ${jobTitle} scheduled. Subject: "${subject}"`,
      }
    case 'offer':
      return {
        title: `Offer received — ${companyName}`,
        description: `${jobTitle} offer detected. Subject: "${subject}"`,
      }
    case 'accepted':
      return {
        title: `Offer accepted — ${companyName}`,
        description: `${jobTitle} — welcome/acceptance signal detected. Subject: "${subject}"`,
      }
    case 'rejected':
      return {
        title: `Application rejected — ${companyName}`,
        description: `${jobTitle} — rejection detected. Subject: "${subject}"`,
      }
    case 'applied':
      return {
        title: `Application confirmed — ${companyName}`,
        description: `${jobTitle} application confirmation detected. Subject: "${subject}"`,
      }
    default:
      return {
        title: `Job-related email — ${companyName}`,
        description: reasoning || `Subject: "${subject}"`,
      }
  }
}

export interface RecordStageActivityInput {
  userId: string
  applicationId: string
  companyId: string | null
  jobId: string | null
  status: ApplicationStatus
  decision: StageDecision
  companyName: string
  jobTitle: string
  subject: string
  reasoning: string | null
  interviewDateTime: string | null
  occurredAt: string
  metadata: Record<string, unknown>
}

/**
 * The single write path for a Gmail-detected stage signal: one `activities`
 * row (always — even an ignored/no-op signal is worth a record, per
 * buildActivityContent), plus a STEP 5 interactions projection when the
 * signal is actually timeline-worthy. Shared by /api/gmail/sync and
 * /api/gmail/share so the projection logic lives in ONE place instead of
 * being duplicated across the two near-identical route bodies (ponytail:
 * root-cause at the shared chokepoint, not the call site).
 *
 * Interview/screen emails project every time — matching
 * activityTypeForStatus's own unconditional interview branch, because a
 * second interview invite while already in the interview stage is still
 * real news for the timeline. Everything else projects only on an actual
 * stage move (decision.action === 'advanced'); an ignored regression or a
 * "no status detected" email still gets its activities row (today's
 * behavior, unchanged) but not a timeline entry.
 */
export async function recordStageActivity(client: SupabaseClient, input: RecordStageActivityInput): Promise<void> {
  const activityType = activityTypeForStatus(input.status, input.decision)
  const content = buildActivityContent(input)

  const { data, error } = await client
    .from('activities')
    .insert({
      application_id: input.applicationId,
      type: activityType,
      title: content.title,
      description: content.description,
      metadata: input.metadata as Json,
      occurred_at: input.occurredAt,
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error(
      `[gmail] recordStageActivity: activities insert failed for application ${input.applicationId}: ${error?.message}`
    )
    return
  }

  const isInterviewSignal = input.status === 'interview' || input.status === 'screen'
  if (!isInterviewSignal && input.decision.action !== 'advanced') return

  await recordInteraction(client, {
    userId: input.userId,
    companyId: input.companyId,
    jobId: input.jobId,
    applicationId: input.applicationId,
    kind: isInterviewSignal ? 'interview' : 'stage_change',
    occurredAt: input.occurredAt,
    title: content.title,
    body: content.description,
    refTable: 'activities',
    refId: (data as { id: string }).id,
    metadata: { subject: input.subject },
  })
}
