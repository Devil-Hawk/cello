-- A refresh compares what a source lists now with what is stored, and writes only
-- the rows whose description actually changed. Reading every stored description
-- back to compare (up to 20 KB each, per company, every hour for the ones the
-- user marked as dream companies) would cost more egress than the refresh is
-- worth; a 32 character fingerprint costs nothing. The database computes it, so
-- no writer can forget to keep it current.
alter table public.jobs
  add column if not exists description_md5 text
  generated always as (md5(description)) stored;
