// Shared inputs for the resume tests: the owner's REPRO resume in each shape the
// importers produce, and one canonical structured Resume. Test-only.

import { ResumeSchema, type Resume } from './schema'

/** The REPRO resume pasted as plain text (REPRO 04). */
export const PASTE_TEXT = `Jordan Rivera
Seattle, WA | jordan.rivera@example.com | (206) 555-0142 | linkedin.com/in/jordanrivera

SUMMARY
Product-minded software engineer with 8 years building data platforms and customer-facing web apps. Led teams of up to six engineers and shipped systems serving 2M monthly users.

EXPERIENCE
Senior Software Engineer, Northwind Analytics
Seattle, WA | Mar 2021 - Present
• Led a team of 6 engineers to rebuild the reporting pipeline, cutting p95 query latency from 14s to 2.1s.
• Designed an event-ingestion service on Kafka and Postgres handling 40k events per second.
• Mentored 4 junior engineers; two were promoted within 18 months.

Software Engineer, Contoso Health
Bellevue, WA | Jun 2018 - Feb 2021
• Built a patient-scheduling web app in React and Node used by 120 clinics.
• Reduced cloud spend by 31% by right-sizing services and adding autoscaling.

Junior Developer, Fabrikam Labs
Portland, OR | Aug 2016 - May 2018
• Maintained a Django internal tools suite for 300 staff.
• Wrote the first CI pipeline for the team using GitHub Actions.

EDUCATION
B.S. Computer Science, University of Washington | 2012 - 2016

SKILLS
Languages: Python, TypeScript, SQL, Go
Platforms: AWS, Kafka, Postgres, Docker, Kubernetes
Practices: Mentoring, system design, on-call, code review`

/** What mammoth + turndown produce from the REPRO DOCX: Heading 1 at the same level as the name. */
export const DOCX_STYLE_MD = `# Jordan Rivera

Seattle, WA | jordan.rivera@example.com | (206) 555-0142

# Summary

Product-minded software engineer with 8 years building data platforms.

# Experience

## Senior Software Engineer, Northwind Analytics

*Seattle, WA | Mar 2021 - Present*

- Led a team of 6 engineers to rebuild the reporting pipeline.
- Designed an event-ingestion service on Kafka and Postgres.

# Skills

**Languages:** Python, TypeScript, SQL, Go`

/** What the PDF text inference produced: a glued date and a wrapped bullet. */
export const PDF_INFER_MD = `# Jordan Rivera

Seattle, WA | jordan.rivera@example.com | (206) 555-0142

## EXPERIENCE

**Senior Software Engineer, Northwind Analytics Mar 2021 - Present**

- Led a team of 6 engineers to rebuild the reporting pipeline, cutting p95 query latency from

14s to 2.1s.

- Designed an event-ingestion service on Kafka and Postgres.`

/** The legacy tailored text: plain, run-on, no markdown (what the old optimizer saved). */
export const LEGACY_TAILORED_TEXT = `Jordan Rivera
Seattle, WA | jordan.rivera@example.com | (206) 555-0142 | linkedin.com/in/jordanrivera

SUMMARY
Backend-leaning software engineer with 8 years building data platforms, Kafka and Postgres pipelines and customer-facing web apps.

EXPERIENCE
Senior Software Engineer, Northwind Analytics | Seattle, WA | Mar 2021 - Present
- Led a team of 6 engineers to rebuild the reporting pipeline, cutting p95 query latency from 14s to 2.1s.
- Designed an event-ingestion service on Kafka and Postgres handling 40k events per second.

Software Engineer, Contoso Health | Bellevue, WA | Jun 2018 - Feb 2021
- Built a patient-scheduling web app in React and Node used by 120 clinics.

EDUCATION
B.S. Computer Science, University of Washington | 2012 - 2016

SKILLS
Languages: Python, TypeScript, SQL, Go
Platforms: AWS, Kafka, Postgres, Docker, Kubernetes`

export const CANONICAL_RESUME: Resume = ResumeSchema.parse({
  basics: {
    name: 'Jordan Rivera',
    label: 'Senior Software Engineer',
    email: 'jordan@example.com',
    phone: '(206) 555-0100',
    location: { city: 'Seattle', region: 'WA' },
    profiles: [{ network: 'LinkedIn', url: 'linkedin.com/in/jr' }],
    summary: 'Product-minded engineer with 8 years building data platforms.',
  },
  work: [
    {
      name: 'Northwind Analytics',
      position: 'Senior Software Engineer',
      location: 'Seattle, WA',
      startDate: '2021-03',
      current: true,
      highlights: ['Led a team of 6 engineers.', 'Cut p95 latency from 14s to 2.1s.'],
    },
    {
      name: 'Contoso Health',
      position: 'Software Engineer',
      startDate: '2018-06',
      endDate: '2021-02',
      highlights: ['Built a scheduling app used by 120 clinics.'],
    },
  ],
  education: [{ institution: 'University of Washington', studyType: 'B.S.', area: 'Computer Science', endDate: '2016' }],
  skills: [
    { name: 'Languages', keywords: ['Go', 'TypeScript', 'SQL'] },
    { name: 'Platforms', keywords: ['AWS (EKS, S3)', 'Kafka'] },
  ],
  meta: { cello: { templateId: 'modern' } },
})
