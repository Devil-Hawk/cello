// lane-stub: K16 answer_bank
// The saved answers the Writer may use: the person's own, from `answer_bank`. K16 builds that table;
// until it is on main there are none. Deleted when this lane rebases after K16 (lanes.md step 12).

export interface SavedAnswer {
  id: string
  question: string
  answer: string
  updated_at: string
  /** Only the person's own answers are ever candidates (`origin = 'person'`). */
  origin: 'person'
}

export async function savedAnswers(_userId: string): Promise<SavedAnswer[]> {
  return []
}
