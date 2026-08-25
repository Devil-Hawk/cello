-- Functions and Triggers for Cello

-- Function to automatically create a profile when a user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    insert into public.profiles (id, email, full_name, avatar_url)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
        new.raw_user_meta_data->>'avatar_url'
    );
    return new;
end;
$$;

-- Trigger to create profile on signup
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- Function to update the updated_at timestamp
create or replace function public.update_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- Triggers for updated_at
create trigger profiles_updated_at
    before update on public.profiles
    for each row execute procedure public.update_updated_at();

create trigger applications_updated_at
    before update on public.applications
    for each row execute procedure public.update_updated_at();

-- Function to create an activity when application stage changes
create or replace function public.log_stage_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    if old.stage is distinct from new.stage then
        insert into public.activities (
            application_id,
            type,
            title,
            description,
            metadata,
            occurred_at
        ) values (
            new.id,
            'status_changed',
            'Status changed to ' || new.stage,
            'Application moved from ' || coalesce(old.stage, 'none') || ' to ' || new.stage,
            jsonb_build_object('old_stage', old.stage, 'new_stage', new.stage),
            now()
        );
    end if;
    return new;
end;
$$;

-- Trigger for stage changes
create trigger log_application_stage_change
    after update on public.applications
    for each row execute procedure public.log_stage_change();

-- Function to get application stats for a user
create or replace function public.get_application_stats(user_uuid uuid)
returns table (
    stage text,
    count bigint
)
language sql
security definer set search_path = public
as $$
    select stage, count(*)
    from public.applications
    where user_id = user_uuid
    group by stage;
$$;

-- Function to get upcoming follow-ups
create or replace function public.get_upcoming_follow_ups(user_uuid uuid, days_ahead integer default 7)
returns table (
    id uuid,
    due_date timestamptz,
    note text,
    contact_name text,
    company_name text,
    job_title text
)
language sql
security definer set search_path = public
as $$
    select
        f.id,
        f.due_date,
        f.note,
        c.name as contact_name,
        co.name as company_name,
        j.title as job_title
    from public.follow_ups f
    left join public.contacts c on c.id = f.contact_id
    left join public.applications a on a.id = f.application_id
    left join public.jobs j on j.id = a.job_id
    left join public.companies co on co.id = coalesce(c.company_id, j.company_id)
    where f.is_completed = false
    and f.due_date <= now() + (days_ahead || ' days')::interval
    and (
        (c.user_id = user_uuid)
        or
        (a.user_id = user_uuid)
    )
    order by f.due_date asc;
$$;

-- Function to detect potential ghosting
create or replace function public.get_ghosted_applications(
    user_uuid uuid,
    days_threshold integer default 14
)
returns table (
    application_id uuid,
    job_title text,
    company_name text,
    days_since_activity integer,
    last_activity_at timestamptz
)
language sql
security definer set search_path = public
as $$
    select
        a.id as application_id,
        j.title as job_title,
        c.name as company_name,
        extract(day from now() - coalesce(
            (select max(occurred_at) from public.activities where application_id = a.id),
            a.applied_at,
            a.created_at
        ))::integer as days_since_activity,
        coalesce(
            (select max(occurred_at) from public.activities where application_id = a.id),
            a.applied_at,
            a.created_at
        ) as last_activity_at
    from public.applications a
    join public.jobs j on j.id = a.job_id
    join public.companies c on c.id = j.company_id
    where a.user_id = user_uuid
    and a.stage not in ('offer', 'closed', 'rejected', 'ghosted')
    and coalesce(
        (select max(occurred_at) from public.activities where application_id = a.id),
        a.applied_at,
        a.created_at
    ) < now() - (days_threshold || ' days')::interval
    order by days_since_activity desc;
$$;
