// While Cello fills, nothing may leave the browser. A capture-phase listener cancels
// every submit event; the main-world script (ats-main.content.ts) also stops
// form.submit() and requestSubmit(), which raise no event, while this attribute is set.

export const HOLD_ATTR = 'data-cello-hold'

export function holdSubmits(): () => void {
  const cancel = (e: Event): void => {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  document.documentElement.setAttribute(HOLD_ATTR, '1')
  window.addEventListener('submit', cancel, true)
  return () => {
    window.removeEventListener('submit', cancel, true)
    document.documentElement.removeAttribute(HOLD_ATTR)
  }
}
