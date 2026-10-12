// The shape of "where a stored value came from" (blueprint 3.2, directive 20).
// Types only, pushed first so the lanes that fill it build against it.

/** Who made a stored value: the person, plain code, or a model step. */
export type Origin = 'person' | 'code' | 'model'

/** What a model value rests on: a stored row, or a verbatim quote. */
export type Evidence = { table: string; id: string } | { quote: string }

/** Written beside every model value. `rung` is the ladder rung that ran it. */
export interface Prov {
  step: string
  model: string
  rung: 'R0' | 'R0s' | 'R1' | 'R2' | 'R3' | 'R4'
  evidence: Evidence[]
  at: string
}

/** For code: the rule that decided. For the person: the door they used. */
export type CodeProv = { rule: string }
export type PersonProv = { door: string }

/** The three columns every model-touched table carries. */
export interface ProvenanceColumns {
  origin: Origin
  prov: Prov | CodeProv | PersonProv | null
  confirmed_at: string | null
}
