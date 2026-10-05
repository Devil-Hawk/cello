// Words and phrases no written output may carry. Items 2 to 4 of
// prompts/_voice.md (buzzwords, filler openers, status-line filler), plus
// phrases that make a cold email read as mass-sent. The test next to this file
// reads _voice.md and fails when the two drift apart.

/** From _voice.md item 2. Matched with common suffixes ("leveraged", "robustness"). */
export const VOICE_BUZZWORDS = [
  'leverage',
  'synergy',
  'seamless',
  'robust',
  'cutting-edge',
  'innovative',
  'spearheaded',
  'passionate',
  'results-oriented',
  'proven track record',
  'facilitated',
  'best practices',
  'move the needle',
  'stakeholder alignment',
  'actionable insights',
  'unlock value',
  'world-class',
  'game-changing',
  'holistic',
  'championed',
  'orchestrated',
] as const

/** From _voice.md items 3 and 4. */
export const VOICE_FILLER = [
  'i am writing to express',
  'i am excited to',
  'i hope this finds you well',
  'i am reaching out',
  'great job',
  'keep it up',
  'just checking in',
  'circling back',
  'touching base',
] as const

/** Phrases specific to cold email and follow-up. */
export const EMAIL_PHRASES = [
  'i came across',
  'i wanted to reach out',
  'strong match',
  'just following up',
  'in case it slipped',
  'bumping this',
] as const

const SUFFIX = '(?:s|es|ed|d|ing|ness|ly)?'

function toRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  // "leverage" must also catch "leveraged" and "leveraging".
  const stem = phrase === 'leverage' ? 'leverag(?:e|es|ed|ing)' : `${escaped}${SUFFIX}`
  return new RegExp(`\\b${stem}\\b`, 'i')
}

const ALL = [...VOICE_BUZZWORDS, ...VOICE_FILLER, ...EMAIL_PHRASES]
const COMPILED = ALL.map((phrase) => ({ phrase, re: toRegex(phrase) }))

/** Banned phrases found in `text`, as written in the list, in list order. */
export function findBannedPhrases(text: string): string[] {
  return COMPILED.filter(({ re }) => re.test(text)).map(({ phrase }) => phrase)
}
