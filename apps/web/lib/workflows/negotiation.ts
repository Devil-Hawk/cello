// The Offer suggestion: when an application reaches the offer stage Chat offers "Prepare to negotiate",
// which starts the negotiation skill (skills/negotiation). Code decides when to offer it; the skill
// does the talking and uses only numbers the person gave or a source supports.
//
// Chat shows it through its `lib/chat/extend/learning-writer.ts` point (K24a).

export interface OfferSuggestion {
  /** The words on the button. */
  label: 'Prepare to negotiate'
  skill: 'negotiation'
  applicationId: string
  /** What Chat sends as the person's message when they press it. */
  message: string
}

export interface ApplicationForOffer {
  id: string
  stage: string
  jobTitle?: string | null
  companyName?: string | null
}

/** The suggestion for an application at the offer stage, null for any other stage. */
export function offerSuggestion(app: ApplicationForOffer): OfferSuggestion | null {
  if (app.stage !== 'offer') return null
  const where = [app.jobTitle, app.companyName].filter(Boolean).join(' at ')
  return {
    label: 'Prepare to negotiate',
    skill: 'negotiation',
    applicationId: app.id,
    message: where ? `Help me prepare to negotiate my offer for ${where}.` : 'Help me prepare to negotiate my offer.',
  }
}
