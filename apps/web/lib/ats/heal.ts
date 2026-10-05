// Healing what is already stored. Before board verification existed, a board
// guessed from a company's name was saved as the company's (source 'probe'),
// so some tracked companies still carry a namesake's board and its roles
// (Amazon -> Personio "amazon": London marketing posts from 2017). On the next
// refresh such a board is verified like a fresh guess; when it fails, the
// mapping and the roles that came from it are cleared.
//
// One call site (refreshCompany); the only storage it needs is
// AtsStore.clearBoardJobs, which keeps any role an application points at.

import type { AtsJob, AtsProviderId } from './types'
import { findPageBoards } from './detect'
import { verifyBoard, type VerifiedBy } from './verify'
import { isKnownEmployer, knownBoard } from '../companies/known-companies'

export interface CachedBoard {
  provider: AtsProviderId
  token: string
  /** How the mapping was first stored (metadata.ats.source). */
  source?: string
  /** Set once the board was verified (metadata.ats.verified_by). */
  verifiedBy?: string
}

export interface HealCompany {
  id: string
  name: string
  domain: string | null
  career_url: string | null
}

export interface BoardClearer {
  clearBoardJobs(companyId: string, source: AtsProviderId): Promise<{ deleted: number; closed: number }>
}

export type HealOutcome =
  | { kept: true; verifiedBy?: VerifiedBy }
  | { kept: false; cleared: { deleted: number; closed: number } }

/** The part of a supabase-js client the RPC needs (typed loosely: the function is newer than the generated types). */
interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

/** AtsStore.clearBoardJobs for the two supabase-js stores. Throws on failure, with nothing changed. */
export async function clearBoardJobsRpc(
  client: unknown,
  companyId: string,
  source: AtsProviderId
): Promise<{ deleted: number; closed: number }> {
  const { data, error } = await (client as RpcClient).rpc('clear_unverified_board_jobs', {
    p_company_id: companyId,
    p_source: source,
  })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as { deleted?: number; closed?: number } | null
  return { deleted: row?.deleted ?? 0, closed: row?.closed ?? 0 }
}

/** Only a guessed, never-verified board needs checking. */
export function needsVerification(cached: CachedBoard): boolean {
  return cached.source === 'probe' && !cached.verifiedBy
}

/**
 * Verify a stored guessed board against the jobs it just returned. A pass keeps
 * it (and says how it verified). A fail clears the mapping's roles through the
 * store and says so. A store error throws and nothing is decided.
 */
export async function healStoredBoard(
  store: BoardClearer,
  company: HealCompany,
  cached: CachedBoard,
  jobs: readonly AtsJob[],
  now?: number
): Promise<HealOutcome> {
  if (!needsVerification(cached)) return { kept: true }

  const curated = knownBoard({ domain: company.domain, careerUrl: company.career_url })
  if (curated && curated.provider === cached.provider && curated.token === cached.token) {
    return { kept: true, verifiedBy: 'known_board' }
  }

  const evidence = { unreachable: false }
  const verifiedBy = await verifyBoard({
    evidence,
    provider: cached.provider,
    token: cached.token,
    jobs,
    company: { name: company.name, domain: company.domain },
    pageBoards: () => findPageBoards({ careerUrl: company.career_url, domain: company.domain }),
    knownEmployer: isKnownEmployer({ domain: company.domain, name: company.name, careerUrl: company.career_url }),
    now,
  })
  if (verifiedBy) return { kept: true, verifiedBy }
  // The provider could not be asked (timeout, 5xx): that is no verdict, so keep
  // the board and its roles as they are and look again on the next refresh.
  if (evidence.unreachable) return { kept: true }

  return { kept: false, cleared: await store.clearBoardJobs(company.id, cached.provider) }
}
