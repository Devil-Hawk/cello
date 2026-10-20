---
name: cold-outreach
description: "Draft a first email to a real contact at a company with an open role. Use when the person wants to reach out to a hiring manager, recruiter or team member. Under 120 words, one reason they fit, one ask. A draft only, sent only by the person after they check it."
---

# Cold outreach

Use this for a first note to someone the person has not written to before.

## Inputs you need

- The role and company: call `roles_get` with the role's id. Call `companies_get` if you need what Cello holds about the company.
- The contact: call `people_find` with the name. If the person has not given a name, or none is found, write the greeting "Hi there," and tell them no contact is on record. Never guess a name or an email address.
- The resume: its text in the conversation, or the stored one that the Writer reads when you call `documents_draft`.

## Procedure

1. Pick the one strongest true reason this person fits this role. It must come from the resume or from the role's own covered requirements.
2. Make one small ask: a short call, or being pointed to the right person.
3. Write under 120 words, plain text, no bullet points. Use the contact's name if you have it.
4. To keep it, call `documents_draft` with type `message`, the role's id, the contact's id if there is one, and instructions that state the one reason and the one ask.
5. Show the draft. Say it is a draft and nothing has been sent. The person sends it themselves after checking it.

## Output

The subject line and the body, then which contact it is for, and one line: "Draft only. Nothing has been sent."

## Rules

- Never claim a relationship that was not given to you: no "as we discussed", "following up on your note", "great meeting you".
- One reason and one ask. A list of qualifications reads as a mass mailing.
- No flattery about the company unless a supplied fact backs it. No "I hope this finds you well", no "I am reaching out".
- Cello cannot send from here. Never say an email was sent.
- Every fact in the draft comes from the resume or the role. No invented number or employer.
- No em dashes.
