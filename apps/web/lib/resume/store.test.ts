import { describe, expect, it } from 'vitest'
import { createResumeVersion, deriveResumeColumns } from './store'
import { resumeToMarkdown, resumeToPlainText } from './render'
import { CANONICAL_RESUME } from './test-fixtures'

/** The slice of the Supabase client createResumeVersion touches. */
function fakeClient(rows: Array<Record<string, unknown>> = []) {
  const inserted: Array<Record<string, unknown>> = []
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            order: () => ({
              limit: () => ({ maybeSingle: async () => ({ data: rows[0] ?? null, error: null }) }),
            }),
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        inserted.push(row)
        return { select: () => ({ single: async () => ({ data: { id: 'new', ...row }, error: null }) }) }
      },
    }),
  }
  return { client: client as never, inserted }
}

describe('createResumeVersion', () => {
  it('writes the structure, the Markdown, the template and the plain text together', async () => {
    const { client, inserted } = fakeClient()
    await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    const row = inserted[0] as { content: string; content_json: Record<string, unknown>; version: number }
    expect(row.version).toBe(1)
    expect(row.content_json.resume).toEqual(CANONICAL_RESUME)
    expect(row.content_json.markdown).toBe(resumeToMarkdown(CANONICAL_RESUME))
    expect(row.content_json.templateId).toBe('modern')
    expect(row.content).toBe(resumeToPlainText(CANONICAL_RESUME))
  })

  it('numbers the next version in the bucket', async () => {
    const { client, inserted } = fakeClient([{ version: 4 }])
    await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'edited' })
    expect((inserted[0] as { version: number }).version).toBe(5)
  })

  it('throws before any insert when the resume is invalid', async () => {
    const { client, inserted } = fakeClient()
    const bad = { ...CANONICAL_RESUME, basics: { ...CANONICAL_RESUME.basics, name: '' } }
    await expect(createResumeVersion(client, { userId: 'u', jobId: null, resume: bad, source: 'base' })).rejects.toThrow()
    expect(inserted).toHaveLength(0)
  })

  it('derives the same columns the seeder uses', () => {
    const cols = deriveResumeColumns(CANONICAL_RESUME)
    expect(cols.content).toBe(resumeToPlainText(CANONICAL_RESUME))
  })
})
