import type { Metadata, Viewport } from 'next'
import { Space_Grotesk, Space_Mono, DM_Sans } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@/components/providers/theme-provider'
import { Toaster } from '@/components/ui/toaster'

// Display face — an engineered grotesque with real character, tuned for the
// instrument-panel headings and the wordmark.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

// Readout face — the monospace sibling of the display family. Carries the
// numeric vitals, eyebrow labels, and anything that should read like a gauge.
const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-readout',
  display: 'swap',
})

// Body face — refined, highly readable prose.
const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Cello - Career Engine for Leads & Opportunities',
  description: 'AI-powered job hunting tool that helps you catch opportunities within minutes of posting',
  keywords: ['job search', 'career', 'AI', 'job tracking', 'applications'],
  authors: [{ name: 'Ankit Punjabi' }],
  manifest: '/manifest.json',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // No maximumScale / userScalable:false here — locking pinch-zoom fails
  // WCAG 1.4.4 (Resize Text) and is exactly what axe-core's meta-viewport
  // rule flags. Letting the browser's native zoom work costs nothing.
  //
  // viewportFit: 'cover' lets the page draw under the iOS notch/home
  // indicator instead of letterboxing around them — required for the
  // `env(safe-area-inset-*)` the mobile bottom nav uses (see
  // components/layout/mobile-nav.tsx) to resolve to anything but 0.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F4F2EC' },
    { media: '(prefers-color-scheme: dark)', color: '#0D0F14' },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${spaceGrotesk.variable} ${spaceMono.variable} ${dmSans.variable} font-sans antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
