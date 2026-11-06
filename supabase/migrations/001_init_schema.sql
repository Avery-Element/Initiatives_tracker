-- ============================================================
-- Initiatives Tracker: tables, triggers, activity log, views, RLS
-- (runs on the Stanley Supabase project)
-- ============================================================
-- Run in Supabase Dashboard → SQL Editor, then 002_init_access.sql and 003_init_email.sql.
-- Every object is prefixed init_ so nothing collides with Stanley (no prefix), Shipping (ship_),
-- Maintenance (maint_) or Remnant Rack (rem_). Logins come from the shared auth.users +
-- public.app_profiles. This app adds its own role table, like the others do.
--
-- Model
--   init_settings        single row: time zone, email schedule, digest recipients
--   init_user_roles      login → role in this app
--   init_people          who work is assigned to (may or may not have a login yet)
--   init_projects        an initiative: lead, stage, target date, swatch color
--   init_tasks           the steps of a project; what people update
--   init_task_assignees  task ↔ person
--   init_activity        every change worth showing a person: status, notes, assignment, dates
-- ============================================================

-- ── SETTINGS ─────────────────────────────────────────────────────────────────
create table public.init_settings (
  id                  boolean primary key default true check (id),     -- single-row table
  time_zone           text    not null default 'America/Los_Angeles',
  stale_days          integer not null default 7  check (stale_days between 1 and 60),    -- "gone quiet" after this many days
  email_enabled       boolean not null default true,
  digest_enabled      boolean not null default true,
  digest_dow          integer not null default 1  check (digest_dow between 0 and 6),     -- 0 = Sunday … 6 = Saturday
  digest_hour         integer not null default 7  check (digest_hour between 0 and 23),
  digest_recipients   text[]  not null default '{}',
  reminders_enabled   boolean not null default true,
  reminder_dow        integer not null default 4  check (reminder_dow between 0 and 6),
  reminder_hour       integer not null default 9  check (reminder_hour between 0 and 23),
  notify_assigned     boolean not null default true,                   -- email a person when they're added to a task
  app_url             text,                                            -- link in emails, e.g. https://initiatives.example.com
  functions_url       text,                                            -- https://<ref>.supabase.co/functions/v1
  function_key_secret text    not null default 'ship_sync_key',        -- vault secret holding a key the Edge Function accepts
  updated_at          timestamptz not null default now(),
  last_modified_by    text
);
insert into public.init_settings default values;


-- ── ROLES ────────────────────────────────────────────────────────────────────
--   Initiatives Admin  everything
--   Member             update tasks assigned to them; manage tasks on projects they lead
--   View Only          read
create table public.init_user_roles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text,
  role        text not null check (role in ('Initiatives Admin', 'Member', 'View Only')),
  created_at  timestamptz not null default now()
);


-- ── PEOPLE ───────────────────────────────────────────────────────────────────
-- Separate from logins: most people get work assigned before they ever sign in, and
-- username-only logins have no real mailbox. user_id links a person to their login.
create table public.init_people (
  id                uuid primary key default gen_random_uuid(),
  display_name      text not null,
  email             text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),   -- real address for reminders
  user_id           uuid unique references auth.users(id) on delete set null,
  active            boolean not null default true,
  created_by        text,
  last_modified_by  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index init_people_name_idx  on public.init_people (lower(display_name)) where active;
create unique index init_people_email_idx on public.init_people (lower(email)) where email is not null;


-- ── PROJECTS ─────────────────────────────────────────────────────────────────
-- One vocabulary for project stages and task statuses.
create table public.init_projects (
  id                uuid primary key default gen_random_uuid(),
  code              text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'),   -- short id, e.g. NPI-LOFT
  name              text not null,
  summary           text,
  lead_person       uuid references public.init_people(id) on delete set null,
  stage             text not null default 'Not started'
                    check (stage in ('Not started', 'In progress', 'Blocked', 'Parked', 'Done')),
  priority          text check (priority in ('Low', 'Medium', 'High', 'Urgent')),
  target_date       date,
  color             text not null default '#4C6FFF' check (color ~ '^#[0-9A-Fa-f]{6}$'),   -- swatch
  sort_order        integer not null default 0,
  archived_at       timestamptz,                            -- hidden from the board, kept for history
  stage_changed_at  timestamptz not null default now(),
  created_by        text,
  last_modified_by  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index init_projects_code_idx on public.init_projects (code);


-- ── TASKS ────────────────────────────────────────────────────────────────────
create table public.init_tasks (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.init_projects(id) on delete cascade,
  position           integer not null default 0,           -- order within the project
  title              text not null check (btrim(title) <> ''),
  status             text not null default 'Not started'
                     check (status in ('Not started', 'In progress', 'Blocked', 'Parked', 'Done')),
  due_date           date,
  blocked_on         text,                                  -- who or what it's waiting on
  others             text,                                  -- outside parties: "Riverstone, James"
  latest_note        text,                                  -- newest note, shown on the board
  latest_note_at     timestamptz,
  status_changed_at  timestamptz not null default now(),
  completed_at       timestamptz,
  created_by         text,
  last_modified_by   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index init_tasks_project_idx on public.init_tasks (project_id, position);

create table public.init_task_assignees (
  task_id     uuid not null references public.init_tasks(id) on delete cascade,
  person_id   uuid not null references public.init_people(id) on delete cascade,
  added_at    timestamptz not null default now(),
  added_by    text,
  primary key (task_id, person_id)
);
create index init_task_assignees_person_idx on public.init_task_assignees (person_id);


-- ── ACTIVITY: the timeline people see, and what "moved this week" counts ─────
-- Written only by triggers and init_add_note(), so it can't be skipped or faked from the app.
create table public.init_activity (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor        text,                                       -- email, or 'system'
  actor_user   uuid,
  project_id   uuid references public.init_projects(id) on delete cascade,
  task_id      uuid references public.init_tasks(id) on delete set null,
  kind         text not null check (kind in ('project_created', 'stage', 'project_edit', 'archived', 'restored',
                                             'task_created', 'status', 'note', 'assigned', 'unassigned',
                                             'due', 'title', 'blocked_on', 'task_deleted', 'person', 'role', 'signin')),
  label        text,                                       -- task title / project name at the time
  old_value    text,
  new_value    text
);
create index init_activity_at_idx      on public.init_activity (at desc);
create index init_activity_task_idx    on public.init_activity (task_id, at desc);
create index init_activity_project_idx on public.init_activity (project_id, at desc);


-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

create or replace function public.init_role()
returns text language sql stable security definer set search_path = public as $$
  select r.role from public.init_user_roles r
  left join public.app_profiles p on p.user_id = r.user_id
  where r.user_id = auth.uid() and not coalesce(p.disabled, false);
$$;

create or replace function public.init_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.init_role() = 'Initiatives Admin', false);
$$;

create or replace function public.init_can_write()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.init_role() in ('Initiatives Admin', 'Member'), false);
$$;

-- The person record linked to the signed-in login (null if none)
create or replace function public.init_my_person()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.init_people where user_id = auth.uid() and active;
$$;

create or replace function public.init_require_admin()
returns void language plpgsql stable as $$
begin
  if not public.init_is_admin() then
    raise exception 'Only Initiatives Admins can do that' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.init_actor()
returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', nullif(current_setting('init.actor', true), ''), 'system');
$$;

-- "Today" in Element's time zone, not UTC
create or replace function public.init_today()
returns date language sql stable as $$
  select (now() at time zone (select time_zone from public.init_settings))::date;
$$;

-- Monday of the week containing d
create or replace function public.init_week_start(d date)
returns date language sql immutable as $$
  select d - (extract(isodow from d)::int - 1);
$$;

-- Start of a local date, as a timestamp
create or replace function public.init_day_start(d date)
returns timestamptz language sql stable as $$
  select d::timestamp at time zone (select time_zone from public.init_settings);
$$;

-- Does the signed-in person lead this project?
create or replace function public.init_leads_project(p_project_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.init_projects
                 where id = p_project_id and lead_person is not null and lead_person = public.init_my_person());
$$;

-- Is the signed-in person assigned to this task?
create or replace function public.init_assigned_to(p_task_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.init_task_assignees
                 where task_id = p_task_id and person_id = public.init_my_person());
$$;

-- Display name for a login (app_profiles is otherwise readable only by its owner / Stanley Managers)
create or replace function public.init_login_name(p_user_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(p.display_name, split_part(u.email, '@', 1))
  from auth.users u left join public.app_profiles p on p.user_id = u.id
  where u.id = p_user_id;
$$;

create or replace function public.init_log(p_kind text, p_project uuid, p_task uuid, p_label text,
                                           p_old text default null, p_new text default null)
returns void language sql security definer set search_path = public as $$
  insert into public.init_activity (actor, actor_user, project_id, task_id, kind, label, old_value, new_value)
  values (public.init_actor(), auth.uid(), p_project, p_task, p_kind, p_label, p_old, p_new);
$$;

create or replace function public.init_touch()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, public.init_actor());
  else
    new.updated_at := now();
  end if;
  new.last_modified_by := public.init_actor();
  return new;
end;
$$;


-- ============================================================
-- PEOPLE + SETTINGS TRIGGERS
-- ============================================================
create trigger init_people_touch before insert or update on public.init_people
  for each row execute function public.init_touch();
create trigger init_settings_touch before update on public.init_settings
  for each row execute function public.init_touch();

create or replace function public.init_people_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.init_log('person', null, null, new.display_name, null, 'added');
  elsif new.active is distinct from old.active then
    perform public.init_log('person', null, null, new.display_name, null, case when new.active then 'reactivated' else 'deactivated' end);
  elsif new.user_id is distinct from old.user_id then
    perform public.init_log('person', null, null, new.display_name, public.init_login_name(old.user_id), public.init_login_name(new.user_id));
  end if;
  return null;
end;
$$;
create trigger init_people_after_write after insert or update on public.init_people
  for each row execute function public.init_people_after_write();


-- ============================================================
-- PROJECT TRIGGERS
-- ============================================================
-- Admins change anything. A Member who leads the project may change its stage, summary,
-- priority and target date. Nobody else edits projects directly.
create or replace function public.init_projects_before_write()
returns trigger language plpgsql as $$
declare
  lead_editable constant text[] := array['stage', 'summary', 'priority', 'target_date',
                                         'updated_at', 'last_modified_by', 'stage_changed_at'];
begin
  if current_user in ('authenticated', 'anon') and not public.init_is_admin() then
    if tg_op = 'INSERT' then
      raise exception 'Only Initiatives Admins can create projects' using errcode = '42501';
    end if;
    if not (public.init_can_write() and public.init_leads_project(old.id)) then
      raise exception 'Only Initiatives Admins and the project lead can edit a project' using errcode = '42501';
    end if;
    if (to_jsonb(new) - lead_editable) is distinct from (to_jsonb(old) - lead_editable) then
      raise exception 'Project leads can change the stage, summary, priority and target date' using errcode = '42501';
    end if;
  end if;
  new.code := upper(btrim(new.code));
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, public.init_actor());
  else
    new.updated_at := now();
    if new.stage is distinct from old.stage then new.stage_changed_at := now(); end if;
  end if;
  new.last_modified_by := public.init_actor();
  return new;
end;
$$;

create or replace function public.init_projects_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.init_log('project_created', new.id, null, new.name, null, new.stage);
    return null;
  end if;
  if new.stage is distinct from old.stage then
    perform public.init_log('stage', new.id, null, new.name, old.stage, new.stage);
  end if;
  if new.archived_at is distinct from old.archived_at then
    perform public.init_log(case when new.archived_at is null then 'restored' else 'archived' end, new.id, null, new.name);
  end if;
  if new.name is distinct from old.name or new.lead_person is distinct from old.lead_person
     or new.target_date is distinct from old.target_date or new.priority is distinct from old.priority
     or new.code is distinct from old.code then
    perform public.init_log('project_edit', new.id, null, new.name, null,
      concat_ws(', ',
        case when new.name        is distinct from old.name        then 'name' end,
        case when new.code        is distinct from old.code        then 'code' end,
        case when new.lead_person is distinct from old.lead_person then 'lead' end,
        case when new.target_date is distinct from old.target_date then 'target date' end,
        case when new.priority    is distinct from old.priority    then 'priority' end));
  end if;
  return null;
end;
$$;

create trigger init_projects_before_write before insert or update on public.init_projects
  for each row execute function public.init_projects_before_write();
create trigger init_projects_after_write after insert or update on public.init_projects
  for each row execute function public.init_projects_after_write();


-- ============================================================
-- TASK TRIGGERS
-- ============================================================
-- Admins and the project lead change anything on the project's tasks.
-- People assigned to a task change its status and "blocked on" (notes go through init_add_note).
create or replace function public.init_tasks_before_write()
returns trigger language plpgsql as $$
declare
  assignee_editable constant text[] := array['status', 'blocked_on', 'updated_at', 'last_modified_by',
                                             'status_changed_at', 'completed_at'];
begin
  if current_user in ('authenticated', 'anon') and not public.init_is_admin() then
    if not public.init_can_write() then
      raise exception 'Your role can''t change tasks' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' then
      if not public.init_leads_project(new.project_id) then
        raise exception 'Only Initiatives Admins and the project lead can add tasks' using errcode = '42501';
      end if;
    elsif not public.init_leads_project(old.project_id) then
      if not public.init_assigned_to(old.id) then
        raise exception 'You can only update tasks assigned to you' using errcode = '42501';
      end if;
      if (to_jsonb(new) - assignee_editable) is distinct from (to_jsonb(old) - assignee_editable) then
        raise exception 'You can change the status and what it''s blocked on. Ask the project lead to change the rest.' using errcode = '42501';
      end if;
    elsif new.project_id is distinct from old.project_id and not public.init_leads_project(new.project_id) then
      raise exception 'You can only move tasks between projects you lead' using errcode = '42501';
    end if;
  end if;

  new.title := btrim(new.title);
  new.blocked_on := nullif(btrim(new.blocked_on), '');
  new.others := nullif(btrim(new.others), '');
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, public.init_actor());
    new.status_changed_at := now();
    if new.status = 'Done' then new.completed_at := coalesce(new.completed_at, now()); end if;
    if new.position = 0 then
      select coalesce(max(position), 0) + 1 into new.position from public.init_tasks where project_id = new.project_id;
    end if;
  else
    new.updated_at := now();
    if new.status is distinct from old.status then
      new.status_changed_at := now();
      new.completed_at := case when new.status = 'Done' then now() end;
    end if;
  end if;
  if new.status <> 'Blocked' and tg_op = 'UPDATE' and old.status = 'Blocked' and new.blocked_on is not distinct from old.blocked_on then
    new.blocked_on := null;   -- unblocked: clear the reason unless it was changed in the same edit
  end if;
  new.last_modified_by := public.init_actor();
  return new;
end;
$$;

create or replace function public.init_tasks_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.init_log('task_created', new.project_id, new.id, new.title, null, new.status);
  elsif tg_op = 'DELETE' then
    perform public.init_log('task_deleted', old.project_id, null, old.title);
  else
    if new.status is distinct from old.status then
      perform public.init_log('status', new.project_id, new.id, new.title, old.status, new.status);
    end if;
    if new.due_date is distinct from old.due_date then
      perform public.init_log('due', new.project_id, new.id, new.title, old.due_date::text, new.due_date::text);
    end if;
    if new.title is distinct from old.title then
      perform public.init_log('title', new.project_id, new.id, new.title, old.title, new.title);
    end if;
    if new.blocked_on is distinct from old.blocked_on and new.blocked_on is not null then
      perform public.init_log('blocked_on', new.project_id, new.id, new.title, old.blocked_on, new.blocked_on);
    end if;
  end if;
  return null;
end;
$$;

create trigger init_tasks_before_write before insert or update on public.init_tasks
  for each row execute function public.init_tasks_before_write();
create trigger init_tasks_after_write after insert or update or delete on public.init_tasks
  for each row execute function public.init_tasks_after_write();

-- Assignments: admins and the project lead
create or replace function public.init_assignees_before_write()
returns trigger language plpgsql as $$
declare
  v_project uuid;
begin
  select project_id into v_project from public.init_tasks where id = coalesce(new.task_id, old.task_id);
  if tg_op = 'DELETE' and v_project is null then return old; end if;   -- the task itself is being deleted
  if current_user in ('authenticated', 'anon') and not public.init_is_admin()
     and not (public.init_can_write() and public.init_leads_project(v_project)) then
    raise exception 'Only Initiatives Admins and the project lead can assign people' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then new.added_by := coalesce(new.added_by, public.init_actor()); return new; end if;
  return old;
end;
$$;

create or replace function public.init_assignees_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t public.init_tasks%rowtype;
  v_name text;
begin
  select * into t from public.init_tasks where id = coalesce(new.task_id, old.task_id);
  if not found then return null; end if;   -- task is being deleted
  select display_name into v_name from public.init_people where id = coalesce(new.person_id, old.person_id);
  if tg_op = 'INSERT' then
    perform public.init_log('assigned', t.project_id, t.id, t.title, null, v_name);
  else
    perform public.init_log('unassigned', t.project_id, t.id, t.title, v_name, null);
  end if;
  return null;
end;
$$;

create trigger init_assignees_before_write before insert or delete on public.init_task_assignees
  for each row execute function public.init_assignees_before_write();
create trigger init_assignees_after_write after insert or delete on public.init_task_assignees
  for each row execute function public.init_assignees_after_write();


-- ============================================================
-- VIEWS
-- ============================================================

-- Every task with its project, assignees, and whether it moved this week
create or replace view public.init_task_board
with (security_invoker = true) as
with wk as (select public.init_today() as today, public.init_week_start(public.init_today()) as week_start)
select
  t.*,
  p.code                                         as project_code,
  p.name                                         as project_name,
  p.color                                        as project_color,
  p.lead_person                                  as project_lead,
  p.archived_at is not null                      as project_archived,
  coalesce(a.person_ids,   '{}')                 as assignee_ids,
  coalesce(a.person_names, '{}')                 as assignee_names,
  (t.due_date is not null and t.status not in ('Done', 'Parked') and t.due_date < wk.today) as overdue,
  act.last_at                                    as last_activity_at,
  coalesce(act.moved_at >= public.init_day_start(wk.week_start), false) as moved_this_week,
  wk.today
from public.init_tasks t
join public.init_projects p on p.id = t.project_id
cross join wk
left join lateral (
  select array_agg(pe.id order by pe.display_name) as person_ids,
         array_agg(pe.display_name order by pe.display_name) as person_names
  from public.init_task_assignees ta join public.init_people pe on pe.id = ta.person_id
  where ta.task_id = t.id
) a on true
left join lateral (
  -- last_at: any sign of life (incl. creation). moved_at: a status change, note or "waiting on" only.
  select max(ac.at) as last_at,
         max(ac.at) filter (where ac.kind in ('status', 'note', 'blocked_on')) as moved_at
  from public.init_activity ac
  where ac.task_id = t.id and ac.kind in ('status', 'note', 'blocked_on', 'task_created')
) act on true;

-- One row per project for the board: counts, progress, weekly activity
create or replace view public.init_project_board
with (security_invoker = true) as
with wk as (select public.init_today() as today, public.init_week_start(public.init_today()) as week_start)
select
  p.*,
  lp.display_name                                                              as lead_name,
  coalesce(c.total, 0)        as task_count,
  coalesce(c.done, 0)         as done_count,
  coalesce(c.in_progress, 0)  as in_progress_count,
  coalesce(c.blocked, 0)      as blocked_count,
  coalesce(c.parked, 0)       as parked_count,
  coalesce(c.not_started, 0)  as not_started_count,
  coalesce(c.overdue, 0)      as overdue_count,
  case when coalesce(c.total, 0) = 0 then 0 else round(100.0 * c.done / c.total)::int end as pct_done,
  coalesce(m.moved, 0)        as moved_this_week,
  m.last_at                   as last_activity_at,
  (p.target_date is not null and p.stage <> 'Done' and p.target_date < wk.today) as past_target,
  (p.target_date - wk.today)  as days_to_target,
  coalesce(tm.team, '{}')     as team_names
from public.init_projects p
cross join wk
left join public.init_people lp on lp.id = p.lead_person
left join lateral (
  select count(*)::int as total,
         count(*) filter (where status = 'Done')::int         as done,
         count(*) filter (where status = 'In progress')::int  as in_progress,
         count(*) filter (where status = 'Blocked')::int      as blocked,
         count(*) filter (where status = 'Parked')::int       as parked,
         count(*) filter (where status = 'Not started')::int  as not_started,
         count(*) filter (where due_date < wk.today and status not in ('Done', 'Parked'))::int as overdue
  from public.init_tasks where project_id = p.id
) c on true
left join lateral (
  select count(distinct ac.task_id) filter (where ac.at >= public.init_day_start(wk.week_start)
                                              and ac.kind in ('status', 'note', 'blocked_on'))::int as moved,
         max(ac.at) as last_at
  from public.init_activity ac where ac.project_id = p.id and ac.task_id is not null
) m on true
left join lateral (
  select array_agg(distinct pe.display_name) as team
  from public.init_tasks t join public.init_task_assignees ta on ta.task_id = t.id
  join public.init_people pe on pe.id = ta.person_id
  where t.project_id = p.id
) tm on true;

-- One row per active person: workload and weekly movement
create or replace view public.init_people_board
with (security_invoker = true) as
with wk as (select public.init_today() as today, public.init_week_start(public.init_today()) as week_start)
select
  pe.id, pe.display_name, pe.email, pe.user_id, pe.active,
  public.init_login_name(pe.user_id) as login_name,
  (select r.role from public.init_user_roles r where r.user_id = pe.user_id) as role,
  coalesce(s.open, 0)         as open_count,
  coalesce(s.in_progress, 0)  as in_progress_count,
  coalesce(s.blocked, 0)      as blocked_count,
  coalesce(s.not_started, 0)  as not_started_count,
  coalesce(s.done, 0)         as done_count,
  coalesce(s.overdue, 0)      as overdue_count,
  coalesce(s.done_this_week, 0) as done_this_week,
  coalesce(s.moved, 0)        as moved_this_week,
  coalesce(s.projects, '{}')  as project_codes,
  coalesce(s.lead_of, '{}')   as lead_of
from public.init_people pe
cross join wk
left join lateral (
  select count(*) filter (where t.status in ('Not started', 'In progress', 'Blocked'))::int as open,
         count(*) filter (where t.status = 'In progress')::int as in_progress,
         count(*) filter (where t.status = 'Blocked')::int     as blocked,
         count(*) filter (where t.status = 'Not started')::int as not_started,
         count(*) filter (where t.status = 'Done')::int        as done,
         count(*) filter (where t.due_date < wk.today and t.status not in ('Done', 'Parked'))::int as overdue,
         count(*) filter (where t.status = 'Done' and t.completed_at >= public.init_day_start(wk.week_start))::int as done_this_week,
         count(*) filter (where exists (select 1 from public.init_activity ac
                                        where ac.task_id = t.id and ac.kind in ('status', 'note', 'blocked_on')
                                          and ac.at >= public.init_day_start(wk.week_start)))::int as moved,
         array_agg(distinct pr.code) as projects,
         (select array_agg(code order by code) from public.init_projects where lead_person = pe.id and archived_at is null) as lead_of
  from public.init_task_assignees ta
  join public.init_tasks t on t.id = ta.task_id
  join public.init_projects pr on pr.id = t.project_id and pr.archived_at is null
  where ta.person_id = pe.id
) s on true
where pe.active;


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.init_settings        enable row level security;
alter table public.init_user_roles      enable row level security;
alter table public.init_people          enable row level security;
alter table public.init_projects        enable row level security;
alter table public.init_tasks           enable row level security;
alter table public.init_task_assignees  enable row level security;
alter table public.init_activity        enable row level security;

-- Anyone with a role reads everything
create policy "init read" on public.init_settings       for select to authenticated using (public.init_role() is not null);
create policy "init read" on public.init_user_roles     for select to authenticated using (public.init_role() is not null);
create policy "init read" on public.init_people         for select to authenticated using (public.init_role() is not null);
create policy "init read" on public.init_projects       for select to authenticated using (public.init_role() is not null);
create policy "init read" on public.init_tasks          for select to authenticated using (public.init_role() is not null);
create policy "init read" on public.init_task_assignees for select to authenticated using (public.init_role() is not null);
create policy "init read" on public.init_activity       for select to authenticated using (public.init_role() is not null);

-- Admins: people, settings
create policy "init admin people" on public.init_people for all to authenticated
  using (public.init_is_admin()) with check (public.init_is_admin());
create policy "init admin settings" on public.init_settings for update to authenticated
  using (public.init_is_admin()) with check (public.init_is_admin());

-- Projects: admins create / archive; leads update (the trigger narrows the columns)
create policy "init add projects" on public.init_projects for insert to authenticated with check (public.init_is_admin());
create policy "init edit projects" on public.init_projects for update to authenticated
  using (public.init_is_admin() or public.init_leads_project(id))
  with check (public.init_is_admin() or public.init_leads_project(id));
create policy "init delete projects" on public.init_projects for delete to authenticated using (public.init_is_admin());

-- Tasks: writers; the trigger decides what each person may do
create policy "init add tasks" on public.init_tasks for insert to authenticated with check (public.init_can_write());
create policy "init edit tasks" on public.init_tasks for update to authenticated
  using (public.init_can_write()) with check (public.init_can_write());
create policy "init delete tasks" on public.init_tasks for delete to authenticated
  using (public.init_is_admin() or public.init_leads_project(project_id));

create policy "init assign" on public.init_task_assignees for insert to authenticated with check (public.init_can_write());
create policy "init unassign" on public.init_task_assignees for delete to authenticated using (public.init_can_write());

-- Roles change only through init_set_user_role; activity only through triggers / init_add_note.

revoke all on public.init_settings, public.init_user_roles, public.init_people, public.init_projects,
              public.init_tasks, public.init_task_assignees, public.init_activity,
              public.init_task_board, public.init_project_board, public.init_people_board
  from anon;


-- ============================================================
-- REALTIME (live updates)
-- ============================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.init_projects, public.init_tasks,
      public.init_task_assignees, public.init_people;
  end if;
end $$;
