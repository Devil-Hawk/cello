import { describe, expect, it } from 'vitest'
import { artifactWorld } from '@/lib/artifacts/testing'
import { createResumeVersion, deleteVersion, deriveResumeColumns, getBaseResume, getLatestVersion, getVersionById, listVersions, updateVersionMeta } from './store'
import { resumeToMarkdown, resumeToPlainText } from './render'
import { CANONICAL_RESUME } from './test-fixtures'

const world = artifactWorld

const resume = (name: string) => ({ ...CANONICAL_RESUME, basics: { ...CANONICAL_RESUME.basics, name } })

describe('createResumeVersion', () => {
  it('writes the structure, the Markdown, the template and the plain text together, on a base artifact', async () => {
    const { admin, client } = world()
    const doc = await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    expect(doc).toMatchObject({ user_id: 'u', job_id: null, version: 1, source: 'base' })
    expect(doc.content_json?.resume).toEqual(CANONICAL_RESUME)
    expect(doc.content_json?.markdown).toBe(resumeToMarkdown(CANONICAL_RESUME))
    expect(doc.content_json?.templateId).toBe('modern')
    expect(doc.content).toBe(resumeToPlainText(CANONICAL_RESUME))
    expect(admin.tables.artifacts).toHaveLength(1)
    expect(admin.tables.artifacts[0]).toMatchObject({ user_id: 'u', type: 'resume', is_base: true, job_id: null })
    expect(admin.tables.artifact_versions[0]).toMatchObject({ version: 1, author: 'user', content_text: resumeToPlainText(CANONICAL_RESUME) })
  })

  it('numbers the next version in the bucket and keeps one artifact', async () => {
    const { admin, client } = world()
    await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    const second = await createResumeVersion(client, { userId: 'u', jobId: null, resume: resume('Edited'), source: 'edited' })
    expect(second.version).toBe(2)
    expect(admin.tables.artifacts).toHaveLength(1)
    expect((await getBaseResume(client, 'u'))?.version).toBe(2)
    expect((await listVersions(client, 'u', null)).map((v) => v.version)).toEqual([2, 1])
  })

  it('throws before any write when the resume is invalid', async () => {
    const { admin, client } = world()
    const bad = { ...CANONICAL_RESUME, basics: { ...CANONICAL_RESUME.basics, name: '' } }
    await expect(createResumeVersion(client, { userId: 'u', jobId: null, resume: bad, source: 'base' })).rejects.toThrow()
    expect(admin.tables.artifacts ?? []).toHaveLength(0)
  })

  it('a tailored version has its own bucket, written by Cello, and the base is untouched', async () => {
    const { admin, client } = world({ person_jobs: [{ id: 'j1', viewer_id: 'u', title: 'Backend Engineer' }] })
    await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    const tailored = await createResumeVersion(client, { userId: 'u', jobId: 'j1', resume: resume('Tailored'), source: 'tailored', atsScore: 88 })
    expect(tailored).toMatchObject({ job_id: 'j1', version: 1, source: 'tailored', ats_score: 88 })
    expect(admin.tables.artifacts).toHaveLength(2)
    expect(admin.tables.artifacts.find((a) => a.job_id === 'j1')).toMatchObject({ is_base: false, title: 'Resume for Backend Engineer' })
    expect(admin.tables.artifact_versions.find((v) => v.artifact_id === tailored.artifact_id)).toMatchObject({ author: 'cello' })
    expect((await getLatestVersion(client, 'u', 'j1'))?.content_json?.resume?.basics.name).toBe('Tailored')
    expect((await getBaseResume(client, 'u'))?.version).toBe(1)
  })

  it('a resume edited after the move appears in the next version read from the base', async () => {
    const { client } = world()
    await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    await createResumeVersion(client, { userId: 'u', jobId: null, resume: resume('After the edit'), source: 'edited' })
    expect((await getBaseResume(client, 'u'))?.content).toContain('After the edit')
  })

  it('appends to a bucket the copy made, continuing its numbers, and finds it by its copied key', async () => {
    const { admin, client } = world({
      artifacts: [{ id: 'a1', user_id: 'u', type: 'resume', title: 'Base resume', job_id: null, is_base: true, current_version: 2, idempotency_key: 'k17:resume_documents:u:base' }],
      artifact_versions: [
        { id: 'old-1', artifact_id: 'a1', version: 1, author: 'user', content: { text: 'one', source: 'base' }, content_text: 'one', created_at: '2026-01-01T00:00:00Z' },
        { id: 'old-2', artifact_id: 'a1', version: 2, author: 'user', content: { text: 'two', source: 'edited', title: 'Mine' }, content_text: 'two', created_at: '2026-01-02T00:00:00Z' },
      ],
    })
    const before = await getBaseResume(client, 'u')
    expect(before).toMatchObject({ id: 'old-2', version: 2, content: 'two', title: 'Mine', source: 'edited', content_json: null })
    const next = await createResumeVersion(client, { userId: 'u', jobId: null, resume: resume('Three'), source: 'edited' })
    expect(next.version).toBe(3)
    expect(admin.tables.artifacts).toHaveLength(1)
  })

  it('two first writes at once make one artifact and two versions', async () => {
    const { admin, client } = world()
    const [a, b] = await Promise.all([
      createResumeVersion(client, { userId: 'u', jobId: null, resume: resume('A'), source: 'base' }),
      createResumeVersion(client, { userId: 'u', jobId: null, resume: resume('B'), source: 'base' }),
    ])
    expect(admin.tables.artifacts).toHaveLength(1)
    expect([a.version, b.version].sort()).toEqual([1, 2])
  })

  it('derives the same columns the seeder uses', () => {
    expect(deriveResumeColumns(CANONICAL_RESUME).content).toBe(resumeToPlainText(CANONICAL_RESUME))
  })
})

describe('reading and changing a version', () => {
  it('a version is only the owner\'s to read', async () => {
    const { client } = world()
    const doc = await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    expect((await getVersionById(client, 'u', doc.id))?.id).toBe(doc.id)
    expect(await getVersionById(client, 'someone-else', doc.id)).toBeNull()
  })

  it('metadata can be patched and the text cannot', async () => {
    const { client } = world()
    const doc = await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    const patched = await updateVersionMeta(client, 'u', doc.id, { title: 'Renamed', atsScore: 71 })
    expect(patched).toMatchObject({ title: 'Renamed', ats_score: 71, content: doc.content })
    expect(await getVersionById(client, 'u', doc.id)).toMatchObject({ title: 'Renamed', ats_score: 71 })
    await expect(updateVersionMeta(client, 'u', doc.id, {})).rejects.toThrow('nothing to update')
    await expect(updateVersionMeta(client, 'someone-else', doc.id, { title: 'x' })).rejects.toThrow('no such version')
  })

  it('deleting a version leaves gaps: the next version still counts up', async () => {
    const { client } = world()
    await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    const two = await createResumeVersion(client, { userId: 'u', jobId: null, resume: resume('Two'), source: 'edited' })
    await deleteVersion(client, 'u', two.id)
    expect((await listVersions(client, 'u', null)).map((v) => v.version)).toEqual([1])
    expect((await createResumeVersion(client, { userId: 'u', jobId: null, resume: resume('Three'), source: 'edited' })).version).toBe(3)
  })

  it('another person cannot delete a version', async () => {
    const { client } = world()
    const doc = await createResumeVersion(client, { userId: 'u', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    await deleteVersion(client, 'someone-else', doc.id)
    expect(await getVersionById(client, 'u', doc.id)).not.toBeNull()
  })
})
