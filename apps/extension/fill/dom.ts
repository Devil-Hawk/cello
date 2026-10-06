// Small DOM helpers shared by the reader, the detector and the filler.

export const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
export const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** True when the element takes up room on the page and is not hidden by style. */
export function isVisible(el: Element): boolean {
  const e = el as HTMLElement
  if (!e.isConnected) return false
  const st = getComputedStyle(e)
  if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false
  if (parseFloat(st.opacity) === 0) return false
  const r = e.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

export function labelsOf(el: HTMLElement): HTMLElement[] {
  const labels = (el as HTMLInputElement).labels
  return labels ? (Array.from(labels) as HTMLElement[]) : []
}

/** A field counts as visible when it, or the label a styled checkbox hides behind, is. */
export function fieldVisible(el: HTMLElement): boolean {
  return isVisible(el) || labelsOf(el).some(isVisible)
}

/** The text a person reads as this field's question. */
export function labelOf(el: HTMLElement): string {
  const labelled = labelsOf(el)
  if (labelled.length) return text(labelled[0])
  const ids = el.getAttribute('aria-labelledby')
  if (ids) {
    const t = ids
      .split(/\s+/)
      .map((id) => text(el.ownerDocument.getElementById(id)))
      .filter(Boolean)
      .join(' ')
    if (t) return t
  }
  return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || ''
}
