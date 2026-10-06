// One entry per page of the set (blueprint 4.0). Until a page ships, its file
// points at main's old page; the lane that builds the page flips it in its own
// pull request (shipped: true and the new href).
export interface PageRoute {
  label: string
  href: string
  /** The page of the new set is live at href (false while href is an old page). */
  shipped: boolean
  /** Shows as a key in the bar. */
  bar: boolean
}
