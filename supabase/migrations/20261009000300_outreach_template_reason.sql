-- Outreach drafts say why they are the standard template.
--
-- used_llm already records that no model wrote the text. template_reason adds
-- the cause, so the card can tell the user what to do next: add a key, raise
-- the spending cap, try again, or edit the text by hand. Null for a model
-- draft and for rows written before this column existed.

alter table public.outreach_messages
    add column if not exists template_reason text
        check (template_reason in ('missing_key', 'spend_cap', 'provider_error', 'unusable_output'));

alter table public.outreach_messages
    drop constraint if exists outreach_template_reason_needs_template;
alter table public.outreach_messages
    add constraint outreach_template_reason_needs_template
        check (template_reason is null or used_llm is false);

comment on column public.outreach_messages.template_reason is
    'Why the text is the standard template instead of a written draft: missing_key, spend_cap, provider_error or unusable_output. Null for a model draft.';
