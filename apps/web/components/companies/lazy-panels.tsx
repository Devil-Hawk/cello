'use client'

import dynamic from 'next/dynamic'

// ponytail: both panels sit in closed disclosures and read their own data after load, so they ship as separate
// chunks that load once the page is up and stay out of its first paint. Upgrade: none needed unless a panel must
// be in the server HTML.
export const ContactNetworkPanel = dynamic(() => import('@/components/contacts/contact-network-panel').then((m) => m.ContactNetworkPanel), { ssr: false })
export const DossierPanel = dynamic(() => import('./dossier-panel').then((m) => m.DossierPanel), { ssr: false })
