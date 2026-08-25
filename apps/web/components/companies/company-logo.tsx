'use client'

import { useState } from 'react'
import { Building2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Domain for a company, falling back to the career URL's hostname. */
export function getCompanyDomain(domain: string | null, careerUrl: string): string | null {
  if (domain) return domain
  try {
    return new URL(careerUrl).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Best-effort logo URL: explicit logo_url, else favicon service from the domain. */
export function getCompanyLogoSrc(
  logoUrl: string | null,
  domain: string | null,
  careerUrl: string
): string | null {
  if (logoUrl) return logoUrl
  const resolved = getCompanyDomain(domain, careerUrl)
  if (!resolved) return null
  // Convert job domains to the main domain (amazon.jobs → amazon.com)
  const logoDomain = resolved
    .replace(/\.(jobs|careers)$/, '.com')
    .replace(/^(jobs|careers)\./, '')
  return `https://www.google.com/s2/favicons?domain=${logoDomain}&sz=128`
}

export interface CompanyLogoProps {
  src: string | null
  name: string
  /** Container classes — size it here (defaults to 40px). */
  className?: string
}

/** Framed company logo with an icon fallback when the image is missing/broken. */
export function CompanyLogo({ src, name, className }: CompanyLogoProps) {
  const [hasError, setHasError] = useState(false)

  return (
    <div
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-control border bg-white p-1',
        className
      )}
    >
      {!src || hasError ? (
        <Building2 className="h-1/2 w-1/2 text-muted-foreground" />
      ) : (
        <img
          src={src}
          alt={name}
          className="h-full w-full object-contain"
          onError={() => setHasError(true)}
        />
      )}
    </div>
  )
}
