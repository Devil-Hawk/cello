// Maps a classified email + stage decision onto an `activities` row. This is
// the piece that was entirely missing before — no email ever produced a
// timeline entry, which is why interviews "disappeared".

import type { ActivityType, ApplicationStatus } from './types'
import type { StageDecision } from './stage'

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
