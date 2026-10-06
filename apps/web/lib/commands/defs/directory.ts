// The Companies pages' own commands. K10's wrappers over K6's functions (companies.list, companies.search,
// companies.add, companies.roles and roles.preview) are in defs/relevance.ts, not here. `companies.list` should
// wrap the `companies_page` function of migration 20261117500000, which pages by key, not the offset
// `list_company_directory`.

import { z } from 'zod'
import { defineCommand, type AnyCommand } from '../define'
import { codeText, untrustedText } from '../text'

// ---------------------------------------------------------------------------
// companies.get: one employer, as the Chat card shows it
// ---------------------------------------------------------------------------

export const companiesGet = defineCommand({
  id: 'companies.get',
  label: 'Company',
  input: z.strictObject({ id: z.string().uuid() }),
  output: z.object({
    id: codeText(40),
    name: untrustedText(200),
    domain: untrustedText(200).nullable(),
    logo_url: untrustedText(1000).nullable(),
    /** The last whole read's total open roles; null when it has not read one. */
    open: z.number().int().nullable(),
    /** Roles kept for this person here. */
    kept: z.number().int(),
    following: z.boolean(),
    /** Why Cello cannot read the site, or null. A count is never shown for a site that cannot be read. */
    cannot_read: codeText(40).nullable(),
  }),
  callers: ['session', 'chat', 'assistant', 'agent'],
  kind: 'code',
  sends: false,
  egress: 'none',
  measure: 'T12',
  async run(ctx, input) {
    const admin = ctx.admin()
    const { data: employer } = await admin.from('company_directory').select('id, name, domain, logo_url, open_count, cannot_read_reason').eq('id', input.id).not('verified_at', 'is', null).maybeSingle()
    const e = employer as { id: string; name: string; domain: string | null; logo_url: string | null; open_count: number | null; cannot_read_reason: string | null } | null
    if (!e) throw new Error('Cello does not have that employer.')
    const [kept, own] = await Promise.all([
      admin.from('person_roles').select('job_id, jobs!inner(employer_id)', { count: 'exact', head: true }).eq('user_id', ctx.userId).is('hidden_reason', null).eq('jobs.employer_id', e.id),
      admin.from('companies').select('id').eq('user_id', ctx.userId).eq('employer_id', e.id).eq('watching', true).limit(1),
    ])
    return {
      id: e.id,
      name: e.name,
      domain: e.domain,
      logo_url: e.logo_url,
      open: e.cannot_read_reason ? null : e.open_count,
      kept: kept.count ?? 0,
      following: ((own.data ?? []) as unknown[]).length > 0,
      cannot_read: e.cannot_read_reason,
    }
  },
})

export const directoryCommands: AnyCommand[] = [companiesGet]
