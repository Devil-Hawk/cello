// The research text lives on a `research` artifact (K17): the first save creates it, a refresh that
// changed the text adds a version, a refresh that changed nothing adds none, and the row stays the index.

import { describe, expect, it } from 'vitest'
import { artifactWorld } from '@/lib/artifacts/testing'
import { upsertDossier } from './store'

const world = () => artifactWorld({ companies: [{ id: 'co1', user_id: 'u1', name: 'Stripe' }] }, { company_dossiers: { unique: [['company_id']] } })
const base = { company_id: 'co1', user_id: 'u1', summary: 'Builds payments.', sponsors_visa: 'likely' as const, sources: [{ title: 'About', url: 'https://stripe.com/about' }] }

describe('upsertDossier', () => {
  it('writes the row and a research artifact with the text', async () => {
    const { admin, client } = world()
    const row = await upsertDossier(client, base)
    expect(admin.tables.company_dossiers).toHaveLength(1)
    expect(admin.tables.artifacts).toHaveLength(1)
    expect(admin.tables.artifacts[0]).toMatchObject({ type: 'research', company_id: 'co1', title: 'Research on Stripe', idempotency_key: `k17:company_dossiers:${row.id}` })
    expect(admin.tables.artifact_versions[0].content_text).toContain('Builds payments.')
    expect((admin.tables.artifact_versions[0].content as { dossier_id: string }).dossier_id).toBe(row.id)
  })

  it('a refresh with new text adds a version, and one with the same text adds none', async () => {
    const { admin, client } = world()
    await upsertDossier(client, base)
    await upsertDossier(client, base)
    expect(admin.tables.artifact_versions).toHaveLength(1)
    await upsertDossier(client, { ...base, summary: 'Builds payments and billing.' })
    expect(admin.tables.artifact_versions).toHaveLength(2)
    expect(admin.tables.artifacts).toHaveLength(1)
    expect(admin.tables.artifact_versions[1].content_text).toContain('billing')
  })

  it('a failure writing the version does not lose the row', async () => {
    const { admin, client } = world()
    admin.rpcHandlers.artifact_add_version = async () => {
      throw new Error('boom')
    }
    await upsertDossier(client, base)
    await upsertDossier(client, { ...base, summary: 'Changed.' })
    expect(admin.tables.company_dossiers[0]).toMatchObject({ summary: 'Changed.' })
  })
})
