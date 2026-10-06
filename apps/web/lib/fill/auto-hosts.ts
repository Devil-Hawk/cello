// The sites Cello may send on without a click. Empty on purpose: a host joins this list only after the
// owner has watched one real automatic send there reach its confirmation. Until then every ready
// application says "Cello cannot send on this site yet" and stays for the person to send.

export interface AutoHost {
  /** The hosted form's hostname, exactly. */
  host: string
  /** Regular expression source for the posting's address; named groups `board` and `job`. */
  urlPattern: string
  /** Texts of the one submit control, as the host words them. */
  submitLabels: string[]
  /** Regular expression sources that mean the host confirmed the application, on the page after Send. */
  confirmationPatterns: string[]
  /** Regular expression sources for the address of the host's confirmation page. */
  confirmationUrls: string[]
}

export const AUTO_HOSTS: AutoHost[] = []
