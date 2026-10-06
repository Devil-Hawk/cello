export interface OwnedTable {
  table: string
  /** True when the expired-demo sweep deletes this table's rows. */
  demoWipe: boolean
  /** The owner column for account deletion, when it is not user_id. The demo sweep reads user_id only. */
  column?: string
}
