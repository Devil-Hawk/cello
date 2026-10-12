# Skills (s19)

Trigger accuracy: 41% (11/27). Output checks: 73% (58/80). Models: dots-studio/dots-3-note-preview:free, cohere/north-mini-code:free, apodex/apodex-1.1-mini:free (output on the first two).

Run: 2026-10-09 at 51ac7510, `skills.eval.test.ts` with `AGENT_EVAL_GATE=0`, `AGENT_EVAL_GENERATORS=dots-studio/dots-3-note-preview:free,cohere/north-mini-code:free,apodex/apodex-1.1-mini:free`. Two passes: 136 requests in the first, then 26 in the second, which reused 89 cached answers. The first pass had apodex-1.1-mini as an output voter and it errored on most output cases. Trigger votes come from all three models; output checks come from dots-3-note-preview and north-mini-code. The cover-letter output check could not be read because both output voters errored on its two cases.

**All nine skills are failing** and are switched off (`SKILLS_OFF` in `lib/agents/backends.ts`, derived from `skills-s19.json`): cold-outreach, cover-letter, follow-up, negotiation, role-fit and tailor-resume missed trigger and checks; company-research, search-strategy and visa-sponsorship missed trigger only. The engine therefore serves no skills (a skill is served on none of: the skills middleware, `ls`/`read_file`/`glob`/`grep` on `/skills`). The Researcher still gets company-research and visa-sponsorship by code, since their output checks are 100% and only a missed `checks` bar takes a skill from it. A skill earns its way back with a new run that meets both of its bars (`lib/evals/agent/thresholds.json`); evals still measure switched-off skills. The 33% on most skills is mostly the should-not-load case alone: negotiation-t2 and search-strategy-t1 were the only should-load cases the majority loaded.

| skill | trigger | bar | output checks | bar | errors | result |
|---|---|---|---|---|---|---|
| cold-outreach | 33% | 0.8 | 70% | 0.9 | 0 | failing (trigger, checks) |
| company-research | 33% | 0.8 | 100% | 0.9 | 0 | failing (trigger) |
| cover-letter | 33% | 0.8 | cannot read | 0.9 | 2 | failing (trigger, checks) |
| follow-up | 33% | 0.8 | 88% | 0.9 | 0 | failing (trigger, checks) |
| negotiation | 67% | 0.8 | 75% | 0.9 | 0 | failing (trigger, checks) |
| role-fit | 33% | 0.8 | 80% | 0.9 | 0 | failing (trigger, checks) |
| search-strategy | 67% | 0.8 | 100% | 0.9 | 0 | failing (trigger) |
| tailor-resume | 33% | 0.8 | 75% | 0.9 | 0 | failing (trigger, checks) |
| visa-sponsorship | 33% | 0.8 | 100% | 0.9 | 0 | failing (trigger) |

| skill | case | should load | loaded by | right |
|---|---|---|---|---|
| cold-outreach | cold-outreach-t1 | true | 1/3 | false |
| cold-outreach | cold-outreach-t2 | true | 0/3 | false |
| cold-outreach | cold-outreach-t3 | false | 0/3 | true |
| company-research | company-research-t1 | true | 0/3 | false |
| company-research | company-research-t2 | true | 0/3 | false |
| company-research | company-research-t3 | false | 0/3 | true |
| cover-letter | cover-letter-t1 | true | 0/3 | false |
| cover-letter | cover-letter-t2 | true | 0/3 | false |
| cover-letter | cover-letter-t3 | false | 0/3 | true |
| follow-up | follow-up-t1 | true | 1/3 | false |
| follow-up | follow-up-t2 | true | 1/3 | false |
| follow-up | follow-up-t3 | false | 0/3 | true |
| negotiation | negotiation-t1 | true | 0/3 | false |
| negotiation | negotiation-t2 | true | 2/3 | true |
| negotiation | negotiation-t3 | false | 0/3 | true |
| role-fit | role-fit-t1 | true | 0/3 | false |
| role-fit | role-fit-t2 | true | 0/3 | false |
| role-fit | role-fit-t3 | false | 0/3 | true |
| search-strategy | search-strategy-t1 | true | 2/3 | true |
| search-strategy | search-strategy-t2 | true | 1/3 | false |
| search-strategy | search-strategy-t3 | false | 0/3 | true |
| tailor-resume | tailor-resume-t1 | true | 1/3 | false |
| tailor-resume | tailor-resume-t2 | true | 0/3 | false |
| tailor-resume | tailor-resume-t3 | false | 0/3 | true |
| visa-sponsorship | visa-sponsorship-t1 | true | 1/3 | false |
| visa-sponsorship | visa-sponsorship-t2 | true | 0/3 | false |
| visa-sponsorship | visa-sponsorship-t3 | false | 0/3 | true |

| skill | model | checks | failed |
|---|---|---|---|
| cold-outreach | dots-3-note-preview | 3/5 | makes an ask; no em dashes |
| cold-outreach | north-mini-code | 4/5 | makes an ask |
| company-research | dots-3-note-preview | 4/4 | none |
| company-research | north-mini-code | 4/4 | none |
| cover-letter | dots-3-note-preview | cannot read | error: JSON error injected into SSE stream |
| cover-letter | north-mini-code | cannot read | error: empty completion, provider returned error |
| follow-up | dots-3-note-preview | 4/4 | none |
| follow-up | north-mini-code | 3/4 | gives an easy next step |
| negotiation | dots-3-note-preview | 3/4 | no em dashes |
| negotiation | north-mini-code | 3/4 | says it has no reliable market data |
| role-fit | dots-3-note-preview | 5/5 | none |
| role-fit | north-mini-code | 3/5 | names the gap; cites the matching resume line |
| search-strategy | dots-3-note-preview | 4/4 | none |
| search-strategy | north-mini-code | 4/4 | none |
| tailor-resume | dots-3-note-preview | 4/4 | none |
| tailor-resume | north-mini-code | 2/4 | does not claim a skill the resume lacks; lists the unsupported requirement as a gap |
| visa-sponsorship | dots-3-note-preview | 4/4 | none |
| visa-sponsorship | north-mini-code | 4/4 | none |