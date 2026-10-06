// What the extension actually sends to the fill routes (apps/extension/lib/fill-contract.ts), turned into
// the shapes of contract.ts. The extension names a field by its key, sends the input's type and not a
// kind, calls the application `application`, and reads values back as a record. The server takes the
// kind and the category of every field from its own classification of the form, never from what the
// extension says about itself, and records only what the read-back allowlist allows.

import { z } from 'zod'
import { classify, type FormField } from '@/lib/answers'
import type { Category } from '@/lib/answers/categories'
import { FIELD_KINDS, FillReport, STOP_CAUSES, readBackFor, type FieldCategory, type FieldKind } from './contract'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WireField = z.object({
  key: z.string().min(1).max(200),
  label: z.string().max(500).default(''),
  name: z.string().max(200).default(''),
  type: z.string().max(40).default('text'),
  kind: z.enum(FIELD_KINDS).optional(),
  options: z.array(z.string().max(300)).max(200).default([]),
  required: z.boolean().default(false),
})

export const SessionBody = z.object({
  url: z.string().url().max(2000),
  fields: z.array(WireField).max(300),
  auto: z.boolean().default(false),
  application: z.string().max(100).optional(),
  application_id: z.string().max(100).optional(),
})

/** One field as the server knows it: its own kind and category, and what the form said about options. */
export interface ServerField {
  key: string
  label: string
  required: boolean
  kind: FieldKind
  category: FieldCategory
  options: string[]
}

// categories that carry no read-back rule of their own are plain values
const PLAIN: Partial<Record<Category, FieldCategory>> = { contact: 'other', relocation: 'other', start_date: 'other', notice: 'other', education: 'other', experience: 'other' }

export function serverFields(raw: z.infer<typeof SessionBody>['fields'], company: string | null): ServerField[] {
  return raw.map((f) => {
    const kind: FieldKind = f.kind ?? ((FIELD_KINDS as readonly string[]).includes(f.type) ? (f.type as FieldKind) : 'text')
    const label = f.label || f.name
    const c = classify({ id: f.key, label, options: f.options }, company).category
    return { key: f.key, label, required: f.required, kind, category: PLAIN[c] ?? (c as FieldCategory), options: f.options }
  })
}

/** The fields the resolver may value: never a password, a hidden or challenge input, or a file. */
export function formFieldsOf(fields: readonly ServerField[]): FormField[] {
  return fields
    .filter((f) => f.label.trim() !== '' && f.kind !== 'password' && f.kind !== 'hidden' && f.kind !== 'challenge' && f.kind !== 'file')
    .map((f) => ({
      id: f.key,
      label: f.label,
      required: f.required,
      options: f.options.length ? f.options : undefined,
      kind: f.kind === 'textarea' ? 'long_text' : f.kind === 'checkbox' ? 'yes_no' : f.kind === 'select' || f.kind === 'radio' ? 'select' : f.kind === 'number' || f.kind === 'date' ? f.kind : undefined,
    }))
}

// --- reports ---------------------------------------------------------------------

const Plain = z.union([z.string().max(10_000), z.boolean(), z.array(z.string().max(300)).max(50)])

/** A read-back entry in either spelling: the contract's { value | answered_by_you | file_name } or the extension's bare value, { answered_by_you } or { file }. */
function entryOf(v: unknown): { answered: boolean; file?: string; value?: unknown } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    const e = (o.entry && typeof o.entry === 'object' ? o.entry : o) as Record<string, unknown>
    if (e.answered_by_you === true) return { answered: true }
    const file = e.file_name ?? e.file
    if (typeof file === 'string') return { answered: false, file }
    return { answered: false, value: e.value }
  }
  return { answered: false, value: v }
}

/**
 * What may be recorded from a read-back: only keys of the server's own field list, with the server's kind
 * and category, in the form the allowlist gives that field. A sensitive field records that the person
 * answered it, whatever came with it; a password, hidden or challenge input records nothing.
 */
export function allowedReadBack(raw: unknown, known: readonly Pick<ServerField, 'key' | 'kind' | 'category'>[]) {
  const byKey = new Map(known.map((f) => [f.key, f]))
  const pairs: [string, unknown][] = Array.isArray(raw)
    ? raw.flatMap((x) => (x && typeof x === 'object' && typeof (x as { key?: unknown }).key === 'string' ? [[(x as { key: string }).key, x] as [string, unknown]] : []))
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>)
      : []
  const out: { key: string; kind: FieldKind; category: FieldCategory; entry: { answered_by_you: true } | { file_name: string } | { value: z.infer<typeof Plain> } }[] = []
  for (const [key, v] of pairs.slice(0, 300)) {
    const f = byKey.get(key)
    if (!f) continue
    const mode = readBackFor(f)
    if (mode === 'never') continue
    const e = entryOf(v)
    const base = { key, kind: f.kind, category: f.category }
    if (mode === 'file_name') {
      if (e.file) out.push({ ...base, entry: { file_name: e.file.slice(0, 300) } })
    } else if (mode === 'answered_by_you') {
      if (e.answered || e.value !== undefined) out.push({ ...base, entry: { answered_by_you: true } })
    } else {
      const p = Plain.safeParse(e.value)
      if (p.success) out.push({ ...base, entry: { value: p.data } })
    }
  }
  return out
}

/** The parts of a report the contract's schema does not carry. */
export interface ReportExtra {
  fieldsHash: string | null
  valuesHash: string | null
  submitLabel: string | null
  fileHashes: string[]
  screenshot: string | null
  filled: number | null
  total: number | null
  detail: string | null
}

const str = (v: unknown, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : null)

/** Shape the body before the read-back is looked at. `id` is null when the extension named no application (a form it could not match). */
export function readReport(body: unknown): { id: string | null; raw: Record<string, unknown>; extra: ReportExtra } | { message: string } {
  if (!body || typeof body !== 'object') return { message: 'Say which application and what happened.' }
  const raw = body as Record<string, unknown>
  const id = str(raw.application_id, 100) ?? str(raw.application, 100)
  if (id !== null && !UUID.test(id)) return { message: 'Say which application and what happened.' }
  return {
    id,
    raw,
    extra: {
      fieldsHash: str(raw.fields_hash, 100),
      valuesHash: str(raw.values_hash, 100),
      submitLabel: str(raw.submit_label, 200),
      fileHashes: Array.isArray(raw.file_hashes) ? raw.file_hashes.filter((h): h is string => typeof h === 'string').slice(0, 10).map((h) => h.slice(0, 100)) : [],
      screenshot: str(raw.screenshot, 600_000),
      filled: typeof raw.filled === 'number' ? raw.filled : null,
      total: typeof raw.total === 'number' ? raw.total : null,
      detail: str(raw.detail ?? raw.cause, 200),
    },
  }
}

/** The contract's FillReport from a body whose read-back has been through the allowlist. */
export function toFillReport(raw: Record<string, unknown>, id: string, values: ReturnType<typeof allowedReadBack> | undefined, now = new Date()) {
  const cause = (STOP_CAUSES as readonly string[]).includes(raw.cause as string) ? raw.cause : undefined
  const given = raw.confirmation && typeof raw.confirmation === 'object' ? (raw.confirmation as Record<string, unknown>) : null
  const text = given?.text ?? raw.text
  const url = given?.url ?? raw.url ?? raw.final_url
  return FillReport.safeParse({
    application_id: id,
    phase: raw.phase,
    cause,
    final_url: raw.final_url ?? raw.url ?? undefined,
    values,
    confirmation: typeof text === 'string' && typeof url === 'string' ? { text, url, seen_at: typeof given?.seen_at === 'string' ? given.seen_at : now.toISOString(), reference: given?.reference } : undefined,
  })
}

/** A screenshot the extension sent: a JPEG data URL that fits the attempts bucket (256 KB), or the reason it does not. */
export function readScreenshot(data: string | null): { bytes: Buffer | null } | { error: string } {
  if (data === null) return { bytes: null }
  const m = /^data:image\/jpe?g;base64,([A-Za-z0-9+/=]+)$/.exec(data)
  if (!m) return { error: 'The screenshot must be a JPEG.' }
  const bytes = Buffer.from(m[1], 'base64')
  if (bytes.length > 262_144) return { error: 'The screenshot is too large. Keep it under 256 KB.' }
  return { bytes }
}
