# Skills (s19)

Trigger accuracy: 37% (10/27). Output checks: 83% (66/80). Models: nvidia/nemotron-3-super-120b-a12b:free, nvidia/nemotron-3-ultra-550b-a55b:free, nvidia/nemotron-3.5-lightning:free (output on the first two).

Run: 2026-10-07 at 39cd479c, `skills.eval.test.ts` with `AGENT_EVAL_GATE=0`, `AGENT_EVAL_GENERATORS=nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-lightning:free`. 88 requests, 30 cache hits, 19 retries. Trigger votes come from those three nemotron models only: the default generators (gemma-4-26b, laguna-s-2.1) and gemma-4-31b answered HTTP 429, so these numbers may move with other models. The 33% on most skills is the should-not-load case alone: only negotiation-t2 was loaded and right (2/3); company-research-t1, search-strategy-t1 and visa-sponsorship-t1 were loaded by 1/3 (wrong). The `off` column in the json is false because it was written before the switch-off.

**All nine skills are failing** and are switched off (`SKILLS_OFF` in `lib/agents/backends.ts`): cold-outreach, cover-letter and negotiation missed trigger and checks; company-research, follow-up, role-fit, search-strategy, tailor-resume and visa-sponsorship missed trigger. The engine therefore serves no skills (a skill is served on none of: the skills middleware, `ls`/`read_file`/`glob`/`grep` on `/skills`). The Researcher still gets company-research and visa-sponsorship by code, since their output checks are 100% and only a missed `checks` bar takes a skill from it. A skill earns its way back with a new run that meets both of its bars (`lib/evals/agent/thresholds.json`); evals still measure switched-off skills.

| skill | trigger | bar | output checks | bar | errors | result |
|---|---|---|---|---|---|---|
| cold-outreach | 33% | 0.8 | 80% | 0.9 | 0 | failing (trigger, checks) |
| company-research | 33% | 0.8 | 100% | 0.9 | 0 | failing (trigger) |
| cover-letter | 33% | 0.8 | 83% | 0.9 | 1 | failing (trigger, checks) |
| follow-up | 33% | 0.8 | 100% | 0.9 | 0 | failing (trigger) |
| negotiation | 67% | 0.8 | 88% | 0.9 | 0 | failing (trigger, checks) |
| role-fit | 33% | 0.8 | 100% | 0.9 | 0 | failing (trigger) |
| search-strategy | 33% | 0.8 | 100% | 0.9 | 0 | failing (trigger) |
| tailor-resume | 33% | 0.8 | 100% | 0.9 | 1 | failing (trigger) |
| visa-sponsorship | 33% | 0.8 | 100% | 0.9 | 0 | failing (trigger) |

| skill | case | should load | loaded by | right |
|---|---|---|---|---|
| cold-outreach | cold-outreach-t1 | true | 0/3 | false |
| cold-outreach | cold-outreach-t2 | true | 0/3 | false |
| cold-outreach | cold-outreach-t3 | false | 0/3 | true |
| company-research | company-research-t1 | true | 1/3 | false |
| company-research | company-research-t2 | true | 0/3 | false |
| company-research | company-research-t3 | false | 0/3 | true |
| cover-letter | cover-letter-t1 | true | 0/3 | false |
| cover-letter | cover-letter-t2 | true | 0/3 | false |
| cover-letter | cover-letter-t3 | false | 0/3 | true |
| follow-up | follow-up-t1 | true | 0/3 | false |
| follow-up | follow-up-t2 | true | 0/3 | false |
| follow-up | follow-up-t3 | false | 0/3 | true |
| negotiation | negotiation-t1 | true | 0/3 | false |
| negotiation | negotiation-t2 | true | 2/3 | true |
| negotiation | negotiation-t3 | false | 0/3 | true |
| role-fit | role-fit-t1 | true | 0/3 | false |
| role-fit | role-fit-t2 | true | 0/3 | false |
| role-fit | role-fit-t3 | false | 0/3 | true |
| search-strategy | search-strategy-t1 | true | 1/3 | false |
| search-strategy | search-strategy-t2 | true | 0/3 | false |
| search-strategy | search-strategy-t3 | false | 0/3 | true |
| tailor-resume | tailor-resume-t1 | true | 0/3 | false |
| tailor-resume | tailor-resume-t2 | true | 0/3 | false |
| tailor-resume | tailor-resume-t3 | false | 0/3 | true |
| visa-sponsorship | visa-sponsorship-t1 | true | 1/3 | false |
| visa-sponsorship | visa-sponsorship-t2 | true | 0/3 | false |
| visa-sponsorship | visa-sponsorship-t3 | false | 0/3 | true |

| skill | model | checks | failed |
|---|---|---|---|
| cold-outreach | nemotron-3-super-120b-a12b | 4/5 | makes an ask |
| cold-outreach | nemotron-3-ultra-550b-a55b | 4/5 | no em dashes |
| company-research | nemotron-3-super-120b-a12b | 4/4 | none |
| company-research | nemotron-3-ultra-550b-a55b | 4/4 | none |
| cover-letter | nemotron-3-super-120b-a12b | cannot read | error: empty completion, provider returned error |
| cover-letter | nemotron-3-ultra-550b-a55b | 5/6 | long enough |
| follow-up | nemotron-3-super-120b-a12b | 4/4 | none |
| follow-up | nemotron-3-ultra-550b-a55b | 4/4 | none |
| negotiation | nemotron-3-super-120b-a12b | 3/4 | says it has no reliable market data |
| negotiation | nemotron-3-ultra-550b-a55b | 4/4 | none |
| role-fit | nemotron-3-super-120b-a12b | 5/5 | none |
| role-fit | nemotron-3-ultra-550b-a55b | 5/5 | none |
| search-strategy | nemotron-3-super-120b-a12b | 4/4 | none |
| search-strategy | nemotron-3-ultra-550b-a55b | 4/4 | none |
| tailor-resume | nemotron-3-super-120b-a12b | cannot read | error: empty completion, provider returned error |
| tailor-resume | nemotron-3-ultra-550b-a55b | 4/4 | none |
| visa-sponsorship | nemotron-3-super-120b-a12b | 4/4 | none |
| visa-sponsorship | nemotron-3-ultra-550b-a55b | 4/4 | none |