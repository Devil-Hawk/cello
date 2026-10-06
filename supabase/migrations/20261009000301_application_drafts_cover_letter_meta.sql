-- Cover letters record why they are the length they are.
--
-- cover_letter_meta holds the evidence tier (full, focused, brief), the word
-- count, the job line and resume line pairs the tier was counted from, the
-- company fact the letter mentions with its source link, and the checks that
-- ran, so the draft card can explain the letter instead of just showing it.

alter table public.application_drafts
    add column if not exists cover_letter_meta jsonb
        check (cover_letter_meta is null or jsonb_typeof(cover_letter_meta) = 'object');

comment on column public.application_drafts.cover_letter_meta is
    'Evidence tier, word count, cited job and resume lines, company fact with link, and the deterministic checks for the cover letter. Null on drafts written before this column existed.';
