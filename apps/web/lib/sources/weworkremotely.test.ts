import { describe, expect, it } from 'vitest'
import { parseWwrFeed } from './weworkremotely'

// A hand-built but structurally faithful RSS fixture — same element names,
// namespaces, and quirks (entity-escaped <description> HTML, an empty
// <region> on one item, a non-WWR link on another) as the real feed captured
// live from https://weworkremotely.com/remote-jobs.rss on 2026-07-28.
const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss">
  <channel>
    <title>We Work Remotely: Remote jobs in design, programming, marketing and more</title>
    <link>https://weworkremotely.com/remote-jobs.rss</link>
    <description>We Work Remotely: Remote jobs in design, programming, marketing and more</description>
    <language>en-US</language>
    <ttl>60</ttl>
    <item>
      <media:content url="https://wwr-pro.s3.amazonaws.com/logos/0001/logo.gif" type="image/png"/>
      <title>Acme Corp: Senior Backend Engineer | Remote</title>
      <region>Anywhere in the World</region>
      <country></country>
      <state></state>
      <skills></skills>
      <category>Programming</category>
      <type>Full-Time</type>
      <description>&lt;p&gt;We are hiring a &lt;strong&gt;Senior Backend Engineer&lt;/strong&gt; for our platform team. Tools &amp;amp; frameworks: Node.js &amp;amp; Postgres.&lt;/p&gt;
&lt;ul&gt;
&lt;li&gt;5+ years experience&lt;/li&gt;
&lt;li&gt;Distributed systems&lt;/li&gt;
&lt;/ul&gt;</description>
      <pubDate>Tue, 28 Jul 2026 21:42:15 +0000</pubDate>
      <expires_at>Thu, 27 Aug 2026 21:42:15 +0000</expires_at>
      <guid>https://weworkremotely.com/remote-jobs/acme-corp-senior-backend-engineer-remote</guid>
      <link>https://weworkremotely.com/remote-jobs/acme-corp-senior-backend-engineer-remote</link>
    </item>
    <item>
      <title>Freelance Copywriter Wanted</title>
      <region></region>
      <country></country>
      <state></state>
      <skills></skills>
      <category>Copywriting</category>
      <type>Contract</type>
      <description>&lt;p&gt;No colon in this title, so the whole string is the role and the company falls back to &amp;quot;We Work Remotely&amp;quot;.&lt;/p&gt;</description>
      <pubDate>Mon, 27 Jul 2026 10:00:00 +0000</pubDate>
      <guid>https://weworkremotely.com/remote-jobs/freelance-copywriter-wanted</guid>
      <link>https://weworkremotely.com/remote-jobs/freelance-copywriter-wanted</link>
    </item>
    <item>
      <title>Evil Corp: Untrusted Redirect Job</title>
      <region>Anywhere</region>
      <category>Programming</category>
      <description>&lt;p&gt;This item's link points off-domain and must be dropped entirely.&lt;/p&gt;</description>
      <pubDate>Mon, 27 Jul 2026 09:00:00 +0000</pubDate>
      <guid>https://evil.example.com/jobs/1</guid>
      <link>https://evil.example.com/jobs/1</link>
    </item>
    <item>
      <title></title>
      <region>Anywhere</region>
      <category>Programming</category>
      <description>&lt;p&gt;Missing title must be dropped entirely.&lt;/p&gt;</description>
      <pubDate>Mon, 27 Jul 2026 08:00:00 +0000</pubDate>
      <guid>https://weworkremotely.com/remote-jobs/no-title</guid>
      <link>https://weworkremotely.com/remote-jobs/no-title</link>
    </item>
  </channel>
</rss>
`

describe('parseWwrFeed — rss-parser swap parity', () => {
  it('maps a well-formed item into the existing JobLead shape', async () => {
    const leads = await parseWwrFeed(FEED_XML)
    const acme = leads.find((l) => l.url.includes('acme-corp-senior-backend-engineer'))
    expect(acme).toBeDefined()
    expect(acme).toMatchObject({
      company: 'Acme Corp',
      title: 'Senior Backend Engineer | Remote',
      url: 'https://weworkremotely.com/remote-jobs/acme-corp-senior-backend-engineer-remote',
      location: 'Anywhere in the World',
      salary: null,
      source: 'weworkremotely',
      externalId: 'https://weworkremotely.com/remote-jobs/acme-corp-senior-backend-engineer-remote',
      companyDomain: null,
      postedAt: new Date('Tue, 28 Jul 2026 21:42:15 +0000').toISOString(),
      tags: ['Programming', 'Anywhere in the World'],
    })
    // HTML stripped to plain text, entities decoded exactly once.
    expect(acme?.description).toContain('We are hiring a Senior Backend Engineer for our platform team.')
    expect(acme?.description).toContain('Tools & frameworks: Node.js & Postgres.')
    expect(acme?.description).not.toMatch(/<[a-z][\s\S]*>/i)
    expect(acme?.description).not.toContain('&amp;')
  })

  it('falls back to the default company when the title has no "Company: Role" colon', async () => {
    const leads = await parseWwrFeed(FEED_XML)
    const copy = leads.find((l) => l.url.includes('freelance-copywriter'))
    expect(copy).toBeDefined()
    expect(copy?.company).toBe('We Work Remotely')
    expect(copy?.title).toBe('Freelance Copywriter Wanted')
  })

  it('falls back location to category when region is empty', async () => {
    const leads = await parseWwrFeed(FEED_XML)
    const copy = leads.find((l) => l.url.includes('freelance-copywriter'))
    expect(copy?.location).toBe('Copywriting')
    expect(copy?.tags).toEqual(['Copywriting'])
  })

  it('drops items whose link is not on weworkremotely.com (host trust boundary)', async () => {
    const leads = await parseWwrFeed(FEED_XML)
    expect(leads.some((l) => l.url.includes('evil.example.com'))).toBe(false)
  })

  it('drops items with no title', async () => {
    const leads = await parseWwrFeed(FEED_XML)
    expect(leads.some((l) => l.url.includes('no-title'))).toBe(false)
  })

  it('returns exactly the surviving items (4 in, 1 dropped for bad host, 1 for no title)', async () => {
    const leads = await parseWwrFeed(FEED_XML)
    expect(leads).toHaveLength(2)
  })

  it('returns [] for non-string input, same as the old regex-based version', async () => {
    // @ts-expect-error — exercising the runtime typeof guard for non-TS callers
    await expect(parseWwrFeed(undefined)).resolves.toEqual([])
  })

  it('returns [] (never throws) on unparseable XML', async () => {
    await expect(parseWwrFeed('<rss><channel><item><title>Unclosed')).resolves.toEqual([])
  })
})
