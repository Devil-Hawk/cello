---
name: tailor-resume
description: "Tailor the person's resume for one role by reordering and rewording what is already true. Use when they ask to \"tailor\", \"update\" or \"optimize\" their resume for a job. Never adds a skill, employer, date or number the resume does not already have."
---

# Tailor a resume

Use this when the person wants their resume shaped for one role. The result is a new version of a resume document, never an overwrite.

## Inputs you need

- The role: `get_role` with its id.
- The resume: `my_profile` with section `resume`. If there is none, stop and tell the person to upload one in Settings. Do not write one from nothing.

## Procedure

1. List what the posting asks for, most important first. Keep the exact words of its keywords.
2. For each, look for it in the resume. Mark it present, present under other words, or absent.
3. Rewrite only what is present. Move the strongest matching experience up, lead each bullet with what was done and the result, and use the posting's own word where the resume says the same thing in other words.
4. Leave out nothing that is true and relevant. Cut lines only to fit one page, weakest match first.
5. Create it with `create_artifact`, type `resume`, passing the role id. The Writer checks it against the original.

## Output

- The tailored resume text.
- Then a line starting `Not added:` listing each requirement the resume does not support, one per item. These are the honest gaps. The person decides what to do about them.
- Then `Changes:` with three to six short lines, each saying what moved or was reworded and why.

## Rules

- Never add a skill, tool, employer, title, date, degree or number that is not in the original resume. A keyword the posting wants but the resume lacks goes under `Not added:`, never into a bullet.
- Do not round up. "Contributed to" does not become "led".
- No buzzwords: leverage, spearheaded, passionate, results-oriented, world-class. Name what was built, run or led.
- No em dashes. Active voice.
