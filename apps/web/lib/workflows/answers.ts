// The saved answers the Writer may use: the person's own words from `answer_bank` (origin person, not declined,
// with an answer). A model's or code's answer is never a candidate.

import { createAdminClient } from '@/lib/harness/supabase-admin'

export interface SavedAnswer {
  id: string
  question: string
  answer: string
  updated_at: string
  /** Only the person's own answers are ever candidates (`origin = 'person'`). */
  origin: 'person'
}

export async function savedAnswers(userId: string): Promise<SavedAnswer[]> {
  const { data, error } = await createAdminClient()
    .from('answer_bank')
    .select('id, question, answer, updated_at')
    .eq('user_id', userId)
    .eq('origin', 'person')
    .eq('declined', false)
    .not('answer', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(`saved answers could not be read: ${error.message}`)
  return ((data as { id: string; question: string; answer: unknown; updated_at: string }[] | null) ?? []).flatMap((r) => {
    const answer = typeof r.answer === 'string' ? r.answer : r.answer == null ? '' : JSON.stringify(r.answer)
    return answer ? [{ id: r.id, question: r.question, answer, updated_at: r.updated_at, origin: 'person' as const }] : []
  })
}
