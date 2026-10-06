// How a table says where its values come from (blueprint 3.2).
//   origin   the table carries origin, prov and confirmed_at on each row.
//   code     every value is made by code, by definition.
//   person   every value is the person's own entry, by definition.
// `retiredBy` marks a table that still holds model-written text without the three
// columns and names the package that replaces it, so the gap is on the list and
// not hidden.

export interface ProvenanceTable {
  table: string
  provenance: 'origin' | 'code' | 'person'
  retiredBy?: string
}
