// Account portals: employers whose application form sits behind an account the person has to make and
// sign in to. Cello never creates an account or signs in. It says so up front, and when the extension
// reports a login wall it says the same thing in the same words.

const PORTALS: [RegExp, string][] = [
  [/(^|\.)myworkdayjobs\.com$|(^|\.)workday\.com$/, 'Workday'],
  [/(^|\.)icims\.com$/, 'iCIMS'],
  [/(^|\.)taleo\.net$/, 'Taleo'],
  [/(^|\.)successfactors\.(com|eu)$/, 'SuccessFactors'],
  [/(^|\.)oraclecloud\.com$/, 'Oracle'],
  [/(^|\.)brassring\.com$/, 'BrassRing'],
  [/(^|\.)ultipro\.com$/, 'UKG'],
  [/(^|\.)amazon\.jobs$/, 'Amazon'],
]

export interface Portal {
  name: string
  sentence: string
}

export function portalOf(url: string | null | undefined): Portal | null {
  if (!url) return null
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  const hit = PORTALS.find(([re]) => re.test(host))
  return hit ? { name: hit[1], sentence: 'This site needs an account.' } : null
}
