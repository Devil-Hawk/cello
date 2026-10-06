-- Stub of pg_net for local checks. Records each call in net.calls and sends nothing.
create schema if not exists net;

create table net.calls (
  id bigserial primary key,
  method text,
  url text,
  headers jsonb,
  body jsonb,
  params jsonb,
  timeout_milliseconds int,
  created_at timestamptz default now()
);

create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint language sql as $$
  insert into net.calls (method, url, headers, body, params, timeout_milliseconds)
  values ('POST', url, headers, body, params, timeout_milliseconds)
  returning id
$$;
