// The list the scrape workflow passes to the rendered tier: comma separated company ids, at most 50.
// scrape.yml checks the same shape in bash before the script starts; this is the script's own check.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_COMPANY_IDS = 50

/** The ids, without repeats, or null when the text is empty, too long or has anything that is not a UUID. */
export function parseCompanyIds(text: string): string[] | null {
  const ids = text.split(',').map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0 || ids.length > MAX_COMPANY_IDS || !ids.every((id) => UUID.test(id))) return null
  return [...new Set(ids)]
}
