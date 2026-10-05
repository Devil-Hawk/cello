---
name: cover-letter
description: "Write a cover letter for one role from the person's real experience. Use when they ask for a cover letter or application letter. 300 to 420 words, first person, every claim taken from their resume, nothing generic."
---

# Cover letter

Use this when the person wants a cover letter for one role. The result is a draft document. It is never sent from here.

## Inputs you need

- The role: `get_role` with its id.
- The resume: `my_profile` with section `resume`. If there is none, say so and stop.
- Facts about the company, only if the person or a source supplied them. Call `search_knowledge` for a saved dossier. Do not invent them.

## Procedure

1. Pick the three strongest matches between the role's requirements and the resume. Each one needs a number, a system, a company or a tool named in the resume.
2. Choose one story from those three to lead with: what the person did, the result, and why it matters for this role.
3. Write in first person, in a professional register: an opening that says which role and why this person, a paragraph for the lead story, a short paragraph for the other two matches, and a closing with one ask.
4. Add something about the company only if a source states it. Cite where it came from in your reply to the person, not in the letter.
5. Create it with `create_artifact`, type `cover_letter`, passing the role id.

## Output

The letter, 300 to 420 words, then one line to the person naming any claim you could not support and left out.

## Rules

- Every claim traces to the resume. A bare adjective such as "strong background" is not a claim.
- Test each sentence: could it appear in a letter to any company for any role? If yes, rewrite it with the specific fact or cut it.
- No em dashes. No "I am excited to", "I am writing to express", "I hope this finds you well".
- No flattery about the company that is not a sourced fact.
- Do not describe an employer, degree or date the resume does not contain.
