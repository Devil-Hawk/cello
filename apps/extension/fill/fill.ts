import { norm } from './dom'
import type { ReadField } from './read-fields'

// Fill with the page's own setters, then tell the page the value changed. No key
// or click event is ever sent. A password, a hidden input or a challenge input is
// never written (read-fields does not list the last two, and 'password' is skipped here).

type Value = string | boolean

function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true, composed: true }))
}

// The prototype's own setter, not any instance property the page's framework added.
function setNative(el: HTMLElement, prop: 'value' | 'checked', v: string | boolean): void {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), prop)
  if (desc?.set) desc.set.call(el, v)
  else (el as unknown as Record<string, unknown>)[prop] = v
}

const truthy = (v: Value): boolean => v === true || /^(yes|true|checked|on)$/i.test(String(v))

/** Writes one value. Returns false when the page has no way to take it. */
export function fillField(f: ReadField, v: Value): boolean {
  const el = f.els[0]
  if (!el) return false
  switch (f.kind) {
    case 'text':
    case 'textarea': {
      if (typeof v !== 'string' || v === '') return false
      setNative(el, 'value', v)
      fire(el, 'input')
      fire(el, 'change')
      return true
    }
    case 'select': {
      const sel = el as HTMLSelectElement
      const want = norm(String(v))
      const opt = Array.from(sel.options).find((o) => norm(o.text) === want || norm(o.value) === want)
      if (!opt) return false
      setNative(sel, 'value', opt.value)
      fire(sel, 'input')
      fire(sel, 'change')
      return true
    }
    case 'checkbox': {
      setNative(el, 'checked', truthy(v))
      fire(el, 'input')
      fire(el, 'change')
      return true
    }
    case 'radio': {
      const want = norm(String(v))
      const i = f.options.findIndex((o) => norm(o) === want)
      const target = f.els[i]
      if (!target) return false
      setNative(target, 'checked', true)
      fire(target, 'input')
      fire(target, 'change')
      return true
    }
    default:
      return false
  }
}

export interface FileBytes {
  name: string
  mime: string
  bytes: Uint8Array
}

/** Puts the resume on a file input the way a person's pick would. */
export function attachFile(input: HTMLInputElement, file: FileBytes): boolean {
  try {
    const dt = new DataTransfer()
    dt.items.add(new File([file.bytes as BlobPart], file.name, { type: file.mime }))
    input.files = dt.files
    fire(input, 'input')
    fire(input, 'change')
    return input.files.length === 1
  } catch {
    return false
  }
}

/** Leave a field empty and show the person it is theirs to fill. */
export function markNeedsYou(f: ReadField): void {
  for (const el of f.els) {
    el.setAttribute('data-cello', 'needs-you')
    el.style.outline = '2px solid #b45309'
    el.style.outlineOffset = '2px'
  }
}

export function clearMark(f: ReadField): void {
  for (const el of f.els) {
    el.removeAttribute('data-cello')
    el.style.outline = ''
    el.style.outlineOffset = ''
  }
}
