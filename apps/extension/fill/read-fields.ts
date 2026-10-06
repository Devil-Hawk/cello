import type { FieldInfo } from '../lib/fill-contract'
import { CHALLENGE_INPUT } from './classify'
import { fieldVisible, labelOf, labelsOf, text } from './dom'

export type FieldKind = 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'file' | 'password'

export interface ReadField extends FieldInfo {
  kind: FieldKind
  /** The element, or every radio in the group. */
  els: HTMLElement[]
  form: HTMLFormElement | null
}

const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])
// Anything inside a challenge widget is off limits: never read, never written.
const CHALLENGE_BOX = '.g-recaptcha, .h-captcha, .cf-turnstile, .grecaptcha-badge, [data-cello-skip]'

type FormEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

function groupLabel(first: HTMLElement): string {
  const fieldset = first.closest('fieldset')
  const legend = fieldset?.querySelector('legend')
  if (legend) return text(legend)
  const group = first.closest('[role="radiogroup"], [role="group"]')
  return group?.getAttribute('aria-label') ?? (first as HTMLInputElement).name ?? ''
}

function optionLabel(el: HTMLElement): string {
  return text(labelsOf(el)[0]) || (el as HTMLInputElement).value
}

/** Every visible, fillable field on the page, one entry per field (a radio group is one). */
export function readFields(root: ParentNode = document): ReadField[] {
  const out: ReadField[] = []
  const used = new Set<string>()
  const radios = new Map<string, ReadField>()

  const unique = (base: string): string => {
    let k = base
    let n = 2
    while (used.has(k)) k = `${base}#${n++}`
    used.add(k)
    return k
  }

  root.querySelectorAll<FormEl>('input, select, textarea').forEach((el, i) => {
    const tag = el.tagName.toLowerCase()
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag
    if (SKIP_TYPES.has(type)) return
    if (el.disabled || (el as HTMLInputElement).readOnly) return
    if (CHALLENGE_INPUT.test(el.name || '') || CHALLENGE_INPUT.test(el.id || '') || el.closest(CHALLENGE_BOX)) return
    // A hosted form's file input is usually hidden behind an Attach button.
    if (type !== 'file' && !fieldVisible(el)) return

    const form = el.form
    const required = (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true'
    const base = el.name || el.id || `f${i}`

    if (type === 'radio') {
      const gk = `${form ? Array.from(document.forms).indexOf(form) : -1}:${el.name}`
      const existing = radios.get(gk)
      if (existing) {
        existing.els.push(el)
        existing.options.push(optionLabel(el))
        existing.required = existing.required || required
        return
      }
      const f: ReadField = {
        key: unique(base),
        label: groupLabel(el),
        name: el.name,
        autocomplete: el.autocomplete || '',
        type: 'radio',
        options: [optionLabel(el)],
        required,
        kind: 'radio',
        els: [el],
        form,
      }
      radios.set(gk, f)
      out.push(f)
      return
    }

    const kind: FieldKind =
      tag === 'select'
        ? 'select'
        : tag === 'textarea'
          ? 'textarea'
          : type === 'checkbox' || type === 'file' || type === 'password'
            ? type
            : 'text'
    out.push({
      key: unique(base),
      label: labelOf(el),
      name: el.name || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      type: tag === 'select' ? 'select' : type,
      options:
        el instanceof HTMLSelectElement
          ? Array.from(el.options)
              .filter((o) => o.value !== '')
              .map((o) => text(o))
          : [],
      required,
      kind,
      els: [el],
      form,
    })
  })
  return out
}

/** The fields as the server sees them: no elements. */
export function toInfo(fields: ReadField[]): FieldInfo[] {
  return fields.map(({ key, label, name, autocomplete, type, options, required }) => ({
    key,
    label,
    name,
    autocomplete,
    type,
    options,
    required,
  }))
}

/** A hash input for "did the form change since preparing": order and shape, not values. */
export function fieldsSignature(fields: FieldInfo[]): string {
  return fields.map((f) => `${f.type}|${f.name}|${f.label.toLowerCase()}|${f.required ? 1 : 0}`).join('\n')
}
