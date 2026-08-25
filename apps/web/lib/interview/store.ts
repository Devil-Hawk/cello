// CRUD for public.interview_kits via a Supabase client.
//
// interview_kits is not in @cello/shared's generated Database type, so this uses
// an untyped client — the RLS-scoped server/client for user reads, or the
// service-role admin client for writes. Row shapes are declared here and mirror
// supabase/migrations/20260717000002_phase3_tables.sql.

import type { SupabaseClient } from '@supabase/supabase-js'

const TABLE = 'interview_kits'

export type KitStatus = 'ready' | 'practiced'

/** One tailored interview question. */
export interface InterviewQuestion {
  category: string // behavioral | technical | role-specific | company-specific | reverse
  question: string
  guidance: string
  sampleAnswer: string
}

/** A STAR story mined ONLY from the user's real resume. */
export interface StarStory {
  situation: string
  task: string
  action: string
  result: string
  /** The question this story best answers (free text, may be empty). */
  mapsToQuestion: string
}

/** Row shape of public.interview_kits (hand-declared; not in Database type). */
export interface InterviewKitRow {
  id: string
  user_id: string
  job_id: string
  company_id: string | null
  questions: InterviewQuestion[] | null
  prep_notes: string | null
  star_stories: StarStory[] | null
  status: KitStatus
  created_at: string
  updated_at: string
  // Optional joined fields when the query embeds them.
  jobs?: { title?: string | null } | { title?: string | null }[] | null
  companies?: { name?: string | null } | { name?: string | null }[] | null
}

export interface UpsertKitInput {
  user_id: string
  job_id: string
  company_id?: string | null
  questions: InterviewQuestion[]
  prep_notes: string
  star_stories: StarStory[]
  status?: KitStatus
}

/** Insert or refresh the kit for (user, job). Conflict target = unique(user_id, job_id). */
export async function upsertKit(
  client: SupabaseClient,
  input: UpsertKitInput
): Promise<InterviewKitRow> {
  const row = {
    user_id: input.user_id,
    job_id: input.job_id,
    company_id: input.company_id ?? null,
    questions: input.questions,
    prep_notes: input.prep_notes,
    star_stories: input.star_stories,
    status: input.status ?? 'ready',
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await client
    .from(TABLE)
    .upsert(row, { onConflict: 'user_id,job_id' })
    .select('*')
    .single()
  if (error) throw new Error(`upsertKit failed: ${error.message}`)
  return data as InterviewKitRow
}

/** A single kit by id, scoped to the owner. */
export async function getKit(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<InterviewKitRow | null> {
  const { data } = await client
    .from(TABLE)
    .select('*, jobs(title), companies(name)')
    .eq('id', id)
    .eq('user_id', userId)
    .single()
  return (data as InterviewKitRow | null) ?? null
}

/** The kit for a specific job, if one exists. */
export async function getKitByJob(
  client: SupabaseClient,
  userId: string,
  jobId: string
): Promise<InterviewKitRow | null> {
  const { data } = await client
    .from(TABLE)
    .select('*, jobs(title), companies(name)')
    .eq('user_id', userId)
    .eq('job_id', jobId)
    .maybeSingle()
  return (data as InterviewKitRow | null) ?? null
}

/** All kits for a user, newest first. */
export async function listKits(
  client: SupabaseClient,
  userId: string,
  opts: { limit?: number } = {}
): Promise<InterviewKitRow[]> {
  const { data, error } = await client
    .from(TABLE)
    .select('*, jobs(title), companies(name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(200, Math.max(1, opts.limit ?? 100)))
  if (error) throw new Error(`listKits failed: ${error.message}`)
  return (data as InterviewKitRow[]) ?? []
}

/** Toggle a kit between ready and practiced. */
export async function setStatus(
  client: SupabaseClient,
  userId: string,
  id: string,
  status: KitStatus
): Promise<InterviewKitRow> {
  const { data, error } = await client
    .from(TABLE)
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw new Error(`setStatus failed: ${error.message}`)
  return data as InterviewKitRow
}
