// The sentences the draft card shows about a cover letter: why it is the length
// it is, and what it says about the company. Client-safe.

import type { LetterTier } from '@/lib/writing/checks'

export interface LetterMetaLike {
  tier: LetterTier
  evidence: { job: string; resume: string }[]
  companyFact: { text: string; url: string } | null
  hasJobPost?: boolean
  hasCompanyFacts?: boolean
}

export function letterNote(meta: LetterMetaLike): { tier: string; company: { text: string; url: string | null } } {
  const n = meta.evidence.length
  const requirements = `${n} of this role's requirements`
  let tier: string
  if (meta.tier === 'full') tier = `Full letter. Your resume backs ${requirements}.`
  else if (meta.tier === 'focused') tier = `Short letter. Your resume backs ${requirements}, so the letter stays on ${n === 1 ? 'that' : 'those'}.`
  else if (meta.hasJobPost === false) tier = 'Brief letter. The posting has no description, so the letter speaks to the title only.'
  else tier = "Brief letter. None of this role's listed requirements trace to your resume, so the letter stays short."

  const company = meta.companyFact
    ? { text: `Mentions: ${meta.companyFact.text}`, url: meta.companyFact.url }
    : meta.hasCompanyFacts === false
      ? { text: 'No company research on file, so the letter says nothing about the company. Research it from the company page.', url: null }
      : { text: 'The letter does not mention anything specific about the company.', url: null }
  return { tier, company }
}
