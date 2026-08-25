import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Known company domains → proper names
const KNOWN_COMPANIES: Record<string, string> = {
  'amazon.jobs': 'Amazon',
  'amazon.com': 'Amazon',
  'google.com': 'Google',
  'careers.google.com': 'Google',
  'meta.com': 'Meta',
  'facebook.com': 'Meta',
  'apple.com': 'Apple',
  'jobs.apple.com': 'Apple',
  'microsoft.com': 'Microsoft',
  'careers.microsoft.com': 'Microsoft',
  'netflix.com': 'Netflix',
  'jobs.netflix.com': 'Netflix',
  'openai.com': 'OpenAI',
  'anthropic.com': 'Anthropic',
  'stripe.com': 'Stripe',
  'airbnb.com': 'Airbnb',
  'uber.com': 'Uber',
  'lyft.com': 'Lyft',
  'salesforce.com': 'Salesforce',
  'adobe.com': 'Adobe',
  'nvidia.com': 'NVIDIA',
  'tesla.com': 'Tesla',
  'spacex.com': 'SpaceX',
  'twitter.com': 'X (Twitter)',
  'x.com': 'X',
  'linkedin.com': 'LinkedIn',
  'dropbox.com': 'Dropbox',
  'spotify.com': 'Spotify',
  'snap.com': 'Snap',
  'snapchat.com': 'Snap',
  'tiktok.com': 'TikTok',
  'bytedance.com': 'ByteDance',
  'palantir.com': 'Palantir',
  'coinbase.com': 'Coinbase',
  'robinhood.com': 'Robinhood',
  'databricks.com': 'Databricks',
  'snowflake.com': 'Snowflake',
  'figma.com': 'Figma',
  'notion.so': 'Notion',
  'slack.com': 'Slack',
  'zoom.us': 'Zoom',
  'twitch.tv': 'Twitch',
  'discord.com': 'Discord',
  'reddit.com': 'Reddit',
  'pinterest.com': 'Pinterest',
  'instacart.com': 'Instacart',
  'doordash.com': 'DoorDash',
  'grubhub.com': 'Grubhub',
  'plaid.com': 'Plaid',
  'square.com': 'Square',
  'block.xyz': 'Block',
  'affirm.com': 'Affirm',
  'chime.com': 'Chime',
  'brex.com': 'Brex',
  'ramp.com': 'Ramp',
  'rippling.com': 'Rippling',
  'gusto.com': 'Gusto',
  'airtable.com': 'Airtable',
  'asana.com': 'Asana',
  'monday.com': 'monday.com',
  'atlassian.com': 'Atlassian',
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'vercel.com': 'Vercel',
  'supabase.com': 'Supabase',
  'cloudflare.com': 'Cloudflare',
  'datadog.com': 'Datadog',
  'mongodb.com': 'MongoDB',
  'hashicorp.com': 'HashiCorp',
}

function getDomainFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function getProperName(domain: string): string | null {
  // Direct match
  if (KNOWN_COMPANIES[domain]) return KNOWN_COMPANIES[domain]

  // Try without jobs/careers prefix
  const withoutPrefix = domain.replace(/^(jobs|careers)\./, '')
  if (KNOWN_COMPANIES[withoutPrefix]) return KNOWN_COMPANIES[withoutPrefix]

  // Try base domain
  const baseDomain = domain.split('.').slice(-2).join('.')
  if (KNOWN_COMPANIES[baseDomain]) return KNOWN_COMPANIES[baseDomain]

  return null
}

function getLogoUrl(domain: string): string {
  // Convert job domains to main domain
  const logoDomain = domain
    .replace(/\.(jobs|careers)$/, '.com')
    .replace(/^(jobs|careers)\./, '')
  return `https://www.google.com/s2/favicons?domain=${logoDomain}&sz=128`
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get all companies for this user
  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, name, domain, career_url, logo_url')
    .eq('user_id', user.id)

  if (error || !companies) {
    return NextResponse.json({ error: 'Failed to fetch companies' }, { status: 500 })
  }

  const updates: { id: string; oldName: string; newName: string; logoUrl: string }[] = []

  for (const company of companies) {
    // Get domain from company.domain or extract from career_url
    let domain = company.domain
    if (!domain && company.career_url) {
      domain = getDomainFromUrl(company.career_url)
    }

    if (!domain) continue

    // Check if we have a proper name for this company
    const properName = getProperName(domain)
    const logoUrl = getLogoUrl(domain)

    // Update if name differs or logo_url is missing
    if (properName && (properName !== company.name || !company.logo_url)) {
      const { error: updateError } = await supabase
        .from('companies')
        .update({
          name: properName,
          domain: domain,
          logo_url: logoUrl,
        })
        .eq('id', company.id)

      if (!updateError) {
        updates.push({
          id: company.id,
          oldName: company.name,
          newName: properName,
          logoUrl,
        })
      }
    } else if (!company.logo_url || !company.domain) {
      // Just update domain and logo_url
      await supabase
        .from('companies')
        .update({
          domain: domain,
          logo_url: logoUrl,
        })
        .eq('id', company.id)
    }
  }

  return NextResponse.json({
    success: true,
    message: `Updated ${updates.length} companies`,
    updates,
  })
}
