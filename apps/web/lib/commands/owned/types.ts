export interface OwnedTable {
  table: string
  /** True when the expired-demo sweep deletes this table's rows. */
  demoWipe: boolean
  /** The owner column, when it is not user_id. */
  column?: string
}
