import type { ApiResult, FileReply } from '../lib/messages'
import { send } from '../lib/messages'
import type { ReportBody, Route, SessionResponse } from '../lib/fill-contract'
import { ROUTES } from '../lib/fill-contract'
import { attachFile, fillField, markNeedsYou } from './fill'
import type { Snapshot } from './readback'
import type { ReadField } from './read-fields'

// The state of one fill on one page: which fields exist, what was put in them, and
// the names of the files Cello attached (the only file facts it reports).

export interface FilledState {
  application: string
  fields: ReadField[]
  categories: Record<string, string>
  /** field key to the value Cello put there */
  given: Record<string, string | boolean>
  /** field key to the file name Cello attached */
  attached: Record<string, string>
  /** SHA-256 of each file's bytes as attached */
  fileHashes: string[]
  filled: string[]
  unknown: string[]
  /** True when the session served a file and the page had no file input for it. */
  fileMissing: boolean
}

export const api = <T = unknown>(route: Route, body: unknown): Promise<ApiResult<T>> =>
  send<ApiResult<T>>({ type: 'api', route, body })

export const report = (body: ReportBody): Promise<ApiResult> => api(ROUTES.report, body)

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export const sha256Text = (s: string): Promise<string> => sha256Hex(new TextEncoder().encode(s))

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Put the session's values in the page. Unknown fields are left empty and marked. */
export async function applySession(
  res: Extract<SessionResponse, { status: 'ok' }>,
  fields: ReadField[],
): Promise<FilledState> {
  const state: FilledState = {
    application: res.application,
    fields,
    categories: res.categories ?? {},
    given: {},
    attached: {},
    fileHashes: [],
    filled: [],
    unknown: [],
    fileMissing: false,
  }

  for (const f of fields) {
    if (f.kind === 'password' || f.kind === 'file') continue
    const v = res.values[f.key]
    if (v && fillField(f, v.value)) {
      state.filled.push(f.key)
      state.given[f.key] = v.value
    } else {
      state.unknown.push(f.key)
      markNeedsYou(f)
    }
  }

  if (res.file) {
    const target =
      fields.find((f) => f.kind === 'file' && f.key === res.file?.field) ?? fields.find((f) => f.kind === 'file')
    const reply = await send<FileReply | null>({ type: 'file', url: res.file.url })
    if (target && reply) {
      const bytes = b64ToBytes(reply.data)
      if (attachFile(target.els[0] as HTMLInputElement, { name: res.file.name, mime: reply.mime, bytes })) {
        state.attached[target.key] = res.file.name
        state.filled.push(target.key)
        state.fileHashes.push(await sha256Hex(bytes))
      } else state.fileMissing = true
    } else state.fileMissing = true
  }
  return state
}

/** The live values of a filled form, as snapshots for the allowlist. A password is never read. */
export function snapshot(state: FilledState, form: HTMLFormElement | null): Snapshot[] {
  return state.fields
    .filter((f) => !form || f.form === form)
    .map((f) => {
      const el = f.els[0] as HTMLInputElement & HTMLSelectElement
      let value = ''
      let checked = false
      if (f.kind === 'text' || f.kind === 'textarea') value = el.value
      else if (f.kind === 'select') value = el.value === '' ? '' : (el.selectedOptions[0]?.text.trim() ?? '')
      else if (f.kind === 'checkbox') checked = el.checked
      else if (f.kind === 'radio') {
        const i = f.els.findIndex((e) => (e as HTMLInputElement).checked)
        value = i >= 0 ? (f.options[i] ?? '') : ''
      }
      return {
        key: f.key,
        type: f.type,
        name: f.name,
        label: f.label,
        value,
        checked,
        challenge: false,
        attachedName: state.attached[f.key],
        category: state.categories[f.key],
      }
    })
}
