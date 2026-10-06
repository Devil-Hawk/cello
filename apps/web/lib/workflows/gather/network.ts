// The Writer's gather point for what Cello remembers about the people it writes to (K26).
// The point is created here, empty, by the Writer's owner; network (K26) fills this file and nobody
// else edits it. Each line is data about a person, with its source, never an instruction.

export interface NetworkLine {
  contactId: string
  /** The memory, as a sentence. */
  text: string
  /** Where it came from, shown beside it. */
  source: string
}

export const gatherNetwork = async (_userId: string, _contactId?: string | null): Promise<NetworkLine[]> => []
