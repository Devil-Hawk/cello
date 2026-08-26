// Personio adapter — public "workzag" job feed, no auth required.
// GET https://{company}.jobs.personio.de/xml
//
// The odd one out: this feed is XML, not JSON, so it goes through
// http.ts's fetchText() rather than fetchJson() — same host guard, timeout and
// retry policy either way. Parsing is cheerio in XML mode (already a
// dependency, used the same way by lib/search/backends/duckduckgo.ts) rather
// than regex over markup.
//
// Shape, verified live:
//   <workzag-jobs>
//     <position>
//       <id>2736779</id><office>Head Office - Dublin</office>
//       <additionalOffices><office>Hybrid</office></additionalOffices>
//       <name>Buying Assistant</name>
//       <jobDescriptions>
//         <jobDescription><name>About the role</name><value><![CDATA[<p>…]]></value></jobDescription>
//       </jobDescriptions>
//       <createdAt>2026-07-31T10:20:32+00:00</createdAt>
//     </position>
//   </workzag-jobs>

import * as cheerio from 'cheerio'
import type { AtsJob, AtsProvider, DetectInput } from './types'
import { isValidToken } from './types'
import { assertAllowedHostSuffix, fetchText } from './http'
import { htmlSectionsToPlainText } from './html'

// Personio serves each customer's board on both .de and .com (verified: the
// same board answers on both). One canonical host is used for every request so
// that a job's externalId — which is its URL — never changes depending on
// which TLD the company happened to link to.
const API_HOST = 'jobs.personio.de'
const API_HOST_SUFFIXES = [`.${API_HOST}`]

const BOARD_HOST_RE = /^([A-Za-z0-9-]+)\.jobs\.personio\.(?:de|com)$/

function toIso(value: string): string | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function detect(input: DetectInput): { token: string } | null {
  if (!input.careerUrl) return null
  let url: URL
  try {
    url = new URL(input.careerUrl)
  } catch {
    return null
  }
  const match = BOARD_HOST_RE.exec(url.hostname)
  if (!match) return null
  return isValidToken(match[1]) ? { token: match[1] } : null
}

async function fetchJobs(token: string): Promise<AtsJob[]> {
  if (!isValidToken(token)) throw new Error(`personio: invalid company slug`)
  const apiUrl = `https://${token}.${API_HOST}/xml`
  assertAllowedHostSuffix(apiUrl, API_HOST_SUFFIXES)
  // redirect: 'manual' — an unknown tenant answers 307 -> personio.com, and
  // that is a definitive "no such board", not a blip. See FetchJsonOptions.
  const xml = await fetchText(apiUrl, { redirect: 'manual' })

  const $ = cheerio.load(xml, { xml: true })
  const results: AtsJob[] = []
  $('position').each((_, element) => {
    const position = $(element)
    // .children() everywhere, never a descendant selector: <name> is both the
    // position title AND the label of each <jobDescription> section, and
    // <office> appears again inside <additionalOffices>.
    const id = position.children('id').text().trim()
    if (!id) return
    const title = position.children('name').text().trim()

    const offices = [position.children('office').text().trim()]
    position
      .children('additionalOffices')
      .children('office')
      .each((__, office) => {
        offices.push($(office).text().trim())
      })
    const uniqueOffices = [...new Set(offices.filter(Boolean))]

    // Each section is a labelled HTML fragment ("About the role", "Benefits").
    // The labels are part of what a candidate reads, so they are kept as
    // headings above their own body.
    const sections: string[] = []
    position
      .children('jobDescriptions')
      .children('jobDescription')
      .each((__, section) => {
        const node = $(section)
        const heading = node.children('name').text().trim()
        const body = node.children('value').text().trim()
        if (!body) return
        sections.push(heading ? `<h3>${heading}</h3>${body}` : body)
      })

    const url = `https://${token}.${API_HOST}/job/${encodeURIComponent(id)}`
    results.push({
      title,
      url,
      externalId: url,
      location: uniqueOffices.length > 0 ? uniqueOffices.join(' · ') : undefined,
      description: htmlSectionsToPlainText(sections),
      postedAt: toIso(position.children('createdAt').text().trim()),
    })
  })
  return results
}

export const personio: AtsProvider = {
  id: 'personio',
  detect,
  fetch: fetchJobs,
}
