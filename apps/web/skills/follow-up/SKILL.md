---
name: follow-up
description: "Draft a single follow-up to an email already sent. Use when the person asks to follow up, nudge or send a second note to a contact who has not replied. Shorter than the first note, gives one new reason to reply, never \"just checking in\". A draft only."
---

# Follow-up

Use this only for a second note to someone who has been emailed already.

## Check first

1. Call `people_find` with the contact's name. If its result shows the contact wrote back, do not follow up. Tell the person about the reply and when it came.
2. Find the first email. It is in the person's message, or call `chat_recall` with the contact's name or the subject. If you cannot find it, say Cello does not see a first email, ask them to paste it, and offer cold-outreach instead.
3. If a follow-up was already sent, do not write another. One is the limit. Say when it went.
4. If the first email went out less than three days ago, say it is early and ask whether they still want to follow up now.

## Procedure

1. Re-read the first email. Find one genuine new reason to reply: a sharper ask, a small added fact from the resume, or an easier next step such as a 15 minute call this week.
2. Write it shorter than the first note, under 90 words, low pressure and easy to ignore. Do not presume the person ignored the first email. They may not have seen it or may have answered elsewhere.
3. To keep it, call `documents_draft` with type `follow_up`, the role's id if there is one, the contact's id, and instructions that state the new reason.
4. Show the draft. Say it is a draft and nothing has been sent.

## Output

The follow-up subject and body, one line saying when the first email was sent, and one line: "Draft only. Nothing has been sent."

## Rules

- Never write "just checking in", "circling back", "touching base" or "following up on my last email". A note with no new information is a second copy of the first.
- Never invent a reason, a mutual contact or a deadline.
- Cello cannot send from here. Never say a follow-up was sent.
- No em dashes. Plain text.
