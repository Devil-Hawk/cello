---
name: follow-up
description: "Draft a single follow-up to an email already sent. Use when the person asks to follow up, nudge or send a second note to a contact who has not replied. Shorter than the first note, gives one new reason to reply, never \"just checking in\"."
---

# Follow-up

Use this only for a second note to someone who has been emailed already.

## Check first

1. Find the first email with `pipeline` or `search_knowledge`. If no first email was sent, there is nothing to follow up. Say so and offer cold outreach instead.
2. If the contact has replied, do not follow up. Tell the person about the reply.
3. If a follow-up was already sent, do not write another. One is the limit. Say when it went.
4. If the first email went out less than three days ago, say it is early and ask whether they still want to follow up now.

## Procedure

1. Re-read the first email. Find one genuine new reason to reply: a sharper ask, a small added fact from the resume, or an easier next step such as a 15 minute call this week.
2. Write it shorter than the first note, under 90 words, low pressure and easy to ignore. Do not presume the person ignored the first email. They may not have seen it or may have answered elsewhere.
3. Create it with `create_artifact`, type `follow_up`, passing the role id and the contact id, then `request_approval` if the person wants it sent.

## Output

The follow-up subject and body, and one line saying when the first email was sent.

## Rules

- Never write "just checking in", "circling back", "touching base" or "following up on my last email". A note with no new information is a second copy of the first.
- Never invent a reason, a mutual contact or a deadline.
- No em dashes. Plain text.
- You cannot send. It waits for the person's approval.
