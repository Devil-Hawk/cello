-- eval_verdicts gains the two claim-level judges.
--
-- groundedness lists every statement in a draft that the sender's own sources
-- do not back; specificity checks the draft carries a detail from the job post
-- or company research. The older factuality and closed_qa rows stay readable.
-- Another change may widen this same list, so keep the union on merge.

alter table public.eval_verdicts
    drop constraint if exists eval_verdicts_judge_check;

alter table public.eval_verdicts
    add constraint eval_verdicts_judge_check
        check (judge in ('factuality', 'closed_qa', 'containment', 'deterministic', 'groundedness', 'specificity'));
