// What the Roles page and the record show about one role. Plain data: every
// view in components/roles takes these as props, so a fixture renders them
// without Supabase. Every value is read from a stored row, never from text a
// model wrote about the role, except `read`, which is Cello's own sentence.

import type { Chance, PassReason, Reaction } from '@/lib/scoring/types'

/** A role's type as a row shows it. `origin` is who typed it; a type a model set carries Cello's read mark. */
export interface RoleTypeView {
  id: string
  label: string
  /** The person's own correction (Change type), not Cello's typing. */
  own: boolean
  origin: 'code' | 'model' | null
}

export interface RoleItem {
  id: string
  title: string
  company: string
  /** The page the logo and the name open: the shared employer's id when there is one, else the person's own company row. */
  companyId: string | null
  domain: string | null
  logoUrl: string | null
  location: string | null
  postedAt: string | null
  /** The employer's words about pay, as stated. */
  pay: string | null
  /** The level, as the classifier stored it ("senior"). */
  level: string | null
  /** The role type the person sees: their own word for the title, else the posting's. Null when nothing could tell it. */
  type: RoleTypeView | null
  /** The person pasted the link, so the role is here even when its type is not one of theirs. */
  pasted: boolean
  legit: 'agency' | 'repost' | null
  /** Cello's band for the person's chance, null until checked. */
  chance: Chance | null
  /** The want probability, only to order rows; never shown. */
  wantP: number | null
  /** One sentence of Cello's read of why the person might want it. */
  read: string | null
  savedAt: string | null
  hiddenReason: 'not_for_me' | 'unclassified' | null
  /** The posting was seen closed. */
  closed: boolean
  /** The person's own earlier reaction, from role_reactions. */
  reaction: { reaction: Reaction; reason: PassReason | null } | null
}

/** One of today's picks, with the sentence that explains it. */
export interface PickItem extends RoleItem {
  explanation: string
  kind: 'top' | 'explore'
}
