import { isVisible, norm, text } from './dom'
import type { ReadField } from './read-fields'

// The page checks a send makes before its one click. Each returns what it found;
// auto.ts turns a finding into a stop cause.

const PLACEHOLDER = /^(select|choose|please|pick|--|\u2014)/i

/** True when a field Cello did not fill already holds an answer. */
export function holdsAnAnswer(f: ReadField): boolean {
  const el = f.els[0] as HTMLInputElement & HTMLSelectElement
  switch (f.kind) {
    case 'text':
    case 'textarea':
      return el.value.trim() !== ''
    case 'checkbox':
      return el.checked
    case 'radio':
      return f.els.some((e) => (e as HTMLInputElement).checked)
    case 'select': {
      if (el.value === '') return false
      const first = el.options[0]
      if (el.selectedIndex === 0 && first && (first.disabled || PLACEHOLDER.test(text(first)))) return false
      return true
    }
    default:
      return false
  }
}

/** What the field holds now, compared with what Cello put there. */
export function holdsValue(f: ReadField, given: string | boolean): boolean {
  const el = f.els[0] as HTMLInputElement & HTMLSelectElement
  switch (f.kind) {
    case 'text':
    case 'textarea':
      return el.value === given
    case 'checkbox':
      return el.checked === (given === true || /^(yes|true|checked|on)$/i.test(String(given)))
    case 'radio': {
      const i = f.els.findIndex((e) => (e as HTMLInputElement).checked)
      return i >= 0 && norm(f.options[i]) === norm(String(given))
    }
    case 'select': {
      const want = norm(String(given))
      const sel = el.selectedOptions[0]
      return !!sel && (norm(text(sel)) === want || norm(sel.value) === want)
    }
    default:
      return true
  }
}

export type SubmitFinding =
  | { ok: true; control: HTMLButtonElement | HTMLInputElement; label: string }
  | { ok: false; reason: 'none' | 'many' | 'hidden' | 'label' }

/** Exactly one submit control owned by the form, visible, enabled, with a label on the host's list. */
export function findSubmit(form: HTMLFormElement, labels: string[]): SubmitFinding {
  const all = Array.from(form.elements).filter(
    (e): e is HTMLButtonElement | HTMLInputElement =>
      (e instanceof HTMLButtonElement || e instanceof HTMLInputElement) && (e.type === 'submit' || e.type === 'image'),
  )
  if (all.length === 0) return { ok: false, reason: 'none' }
  if (all.length > 1) return { ok: false, reason: 'many' }
  const control = all[0] as HTMLButtonElement | HTMLInputElement
  if (control.disabled || !isVisible(control)) return { ok: false, reason: 'hidden' }
  const label = norm(control instanceof HTMLInputElement ? control.value : text(control))
  if (!labels.some((l) => norm(l) === label)) return { ok: false, reason: 'label' }
  return { ok: true, control, label }
}

/** The number of visible error messages on the page: an alert or a field error with text. */
export function errorCount(doc: Document = document): number {
  return Array.from(doc.querySelectorAll('[role="alert"], .error, .field-error, .form-error')).filter(
    (e) => isVisible(e) && text(e) !== '',
  ).length
}
