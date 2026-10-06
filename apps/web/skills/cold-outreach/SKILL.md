---
name: cold-outreach
description: "Draft a first email to a real contact at a company with an open role. Use when the person wants to reach out to a hiring manager, recruiter or team member. Under 120 words, one reason they fit, one ask. A draft only, sent only after they approve it."
---

# Cold outreach

Use this for a first note to someone the person has not written to before.

## Inputs you need

- The role and company: `get_role`.
- The contact: `people` with the company id. Prefer a contact whose email status is verified. If it is inferred, tell the person that before they approve.
- The resume: `my_profile` with section `resume`.

## Procedure

1. Pick the one strongest true reason this person fits this role. It must come from the resume or from the role's own match reasons.
2. Make one small ask: a short call, or being pointed to the right person.
3. Write under 120 words, plain text, no bullet points. Use the contact's name if you have it. If you do not, write "Hi there," and never guess a name.
4. Create it with `create_artifact`, type `message`, passing the role id and the contact id.
5. Show the draft and its review. If the person wants it sent, call `request_approval` with `send_email`. Then say it is waiting for their approval in Needs you.

## Output

The subject line and the body, then which contact it is for and how sure the email address is.

## Rules

- Never claim a relationship that was not given to you: no "as we discussed", "following up on your note", "great meeting you".
- One reason and one ask. A list of qualifications reads as a mass mailing.
- No flattery about the company unless a supplied fact backs it. No "I hope this finds you well", no "I am reaching out".
- You cannot send. Never say an email was sent until you are told the person approved it.
