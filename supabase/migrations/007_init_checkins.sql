-- ============================================================
-- Initiatives Tracker: weekly check-ins, asks for Matt, a digest note, and a decision-focused digest
-- ============================================================
-- Run after 006_init_department.sql. From the Nov 19 council review:
--   init_checkins       one check-in per project per week from a lead: health (On track / At risk /
--                       Off track), one sentence, and optionally "what I need from Matt". Admins
--                       answer the ask; the answer shows on the project and the leads get an email.
--   init_digest_notes   an optional note an admin (usually Lindsay) writes for a week's digest.
--   init_projects       + purpose ("why we're doing it") and success_measure ("how we'll know it
--                       worked"); leads can edit both.
--   init_tasks          + blocked_on_person: who it's waiting on, when that's someone on the people
--                       list. blocked_on stays for an outside party / department, or as the note.
--   init_digest()       rewritten: asks, headline, data quality, projects by department with health,
--                       candidates to park. Per-person "% moved" is gone (it measured typing, not
--                       progress); workload is counts only.
--   reminders           now a weekly "Your week" email to everyone with open tasks or a check-in
--                       due, not only to people who are behind.
-- ============================================================

-- ── COLUMNS ──────────────────────────────────────────────────────────────────
alter table public.init_projects
  add column if not exists purpose         text,
  add column if not exists success_measure text;

alter table public.init_tasks
  add column if not exists blocked_on_person uuid references public.init_people(id) on delete set null;


-- ── TABLES ───────────────────────────────────────────────────────────────────
create table public.init_checkins (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.init_projects(id) on delete cascade,
  week_start        date not null,                          -- Monday of the week it's for
  health            text not null check (health in ('On track', 'At risk', 'Off track')),
  summary           text not null check (btrim(summary) <> '' and char_length(summary) <= 300),
  ask               text check (char_length(ask) <= 600),   -- "what I need from Matt"
  answer            text check (char_length(answer) <= 1200),
  answered_by       text,                                   -- login email
  answered_by_name  text,                                   -- "Matt Hall", or "Lindsay for Matt Hall"
  answered_at       timestamptz,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_by        text,
  updated_at        timestamptz not null default now(),
  unique (project_id, week_start)
);
create index init_checkins_week_idx on public.init_checkins (week_start);

create table public.init_digest_notes (
  week_start  date primary key,                             -- the digest week it belongs to
  body        text not null check (btrim(body) <> '' and char_length(body) <= 2000),
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table public.init_checkins     enable row level security;
alter table public.init_digest_notes enable row level security;
create policy "init read" on public.init_checkins     for select to authenticated using (public.init_role() is not null);
create policy "init read" on public.init_digest_notes for select to authenticated using (public.init_role() is not null);
-- Writes only through init_save_checkin / init_answer_ask / init_save_digest_note (security definer)
revoke all on public.init_checkins, public.init_digest_notes from anon;
revoke insert, update, delete, truncate on public.init_checkins, public.init_digest_notes from authenticated;

-- New kinds in the activity log and the outbox
alter table public.init_activity drop constraint init_activity_kind_check;
alter table public.init_activity add constraint init_activity_kind_check
  check (kind in ('project_created', 'stage', 'project_edit', 'archived', 'restored',
                  'task_created', 'status', 'note', 'assigned', 'unassigned',
                  'due', 'title', 'blocked_on', 'task_deleted', 'person', 'role', 'signin',
                  'leads', 'stakeholders', 'checkin', 'answer'));
alter table public.init_outbox drop constraint init_outbox_kind_check;
alter table public.init_outbox add constraint init_outbox_kind_check
  check (kind in ('digest', 'reminder', 'assigned', 'test', 'answered'));


-- ── HELPERS ──────────────────────────────────────────────────────────────────
-- Department sort order; keep in step with DEPARTMENTS in src/lib.js
create or replace function public.init_dept_rank(p_department text)
returns integer language sql immutable set search_path = public as $$
  select case p_department when 'Design' then 1 when 'Office' then 2 when 'General' then 3
                           when 'Warehouse/Shipping' then 4 when 'Production' then 5 else 6 end;
$$;

-- Who's waiting on whom, as one line: "Jim — quote for steel"
create or replace function public.init_waiting_on(p_person uuid, p_text text)
returns text language sql stable security definer set search_path = public as $$
  select nullif(concat_ws(' — ', (select display_name from public.init_people where id = p_person), p_text), '');
$$;


-- ── PROJECT TRIGGER: leads may also edit purpose + success measure ────────────
create or replace function public.init_projects_before_write()
returns trigger language plpgsql set search_path = public as $$
declare
  lead_editable constant text[] := array['stage', 'summary', 'priority', 'target_date', 'purpose', 'success_measure',
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
      raise exception 'Project leads can change the stage, summary, purpose, success measure, priority and target date' using errcode = '42501';
    end if;
  end if;
  new.code := upper(btrim(new.code));
  new.purpose := nullif(btrim(new.purpose), '');
  new.success_measure := nullif(btrim(new.success_measure), '');
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


-- ── TASK TRIGGERS: blocked_on_person ─────────────────────────────────────────
create or replace function public.init_tasks_before_write()
returns trigger language plpgsql set search_path = public as $$
declare
  assignee_editable constant text[] := array['status', 'blocked_on', 'blocked_on_person', 'updated_at', 'last_modified_by',
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
  -- Unblocked: clear who/what it was waiting on, unless that was changed in the same edit
  if new.status <> 'Blocked' and tg_op = 'UPDATE' and old.status = 'Blocked'
     and new.blocked_on is not distinct from old.blocked_on
     and new.blocked_on_person is not distinct from old.blocked_on_person then
    new.blocked_on := null;
    new.blocked_on_person := null;
  end if;
  new.last_modified_by := public.init_actor();
  return new;
end;
$$;

create or replace function public.init_tasks_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old text;
  v_new text;
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
    if new.blocked_on is distinct from old.blocked_on or new.blocked_on_person is distinct from old.blocked_on_person then
      v_new := public.init_waiting_on(new.blocked_on_person, new.blocked_on);
      v_old := public.init_waiting_on(old.blocked_on_person, old.blocked_on);
      if v_new is not null then
        perform public.init_log('blocked_on', new.project_id, new.id, new.title, v_old, v_new);
      end if;
    end if;
  end if;
  return null;
end;
$$;


-- ── CHECK-INS ────────────────────────────────────────────────────────────────
-- A lead (or an admin) saves this week's check-in for a project. Saving again replaces it.
-- If the ask changes after it was answered, the old answer no longer applies and is cleared.
create or replace function public.init_save_checkin(p_project_id uuid, p_health text, p_summary text, p_ask text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_week    date := public.init_week_start(public.init_today());
  v_project public.init_projects%rowtype;
  v_old     public.init_checkins%rowtype;
  v_summary text := nullif(btrim(p_summary), '');
  v_ask     text := nullif(btrim(p_ask), '');
  v_id      uuid;
begin
  if not (public.init_is_admin() or (public.init_can_write() and public.init_leads_project(p_project_id))) then
    raise exception 'Only the project''s leads and Initiatives Admins can check in' using errcode = '42501';
  end if;
  select * into v_project from public.init_projects where id = p_project_id;
  if not found or v_project.archived_at is not null then raise exception 'Project not found'; end if;
  if p_health is null or p_health not in ('On track', 'At risk', 'Off track') then
    raise exception 'Pick On track, At risk or Off track';
  end if;
  if v_summary is null then raise exception 'Write one sentence on where it stands'; end if;

  select * into v_old from public.init_checkins where project_id = p_project_id and week_start = v_week;
  if found then
    update public.init_checkins set
      health = p_health, summary = v_summary, ask = v_ask,
      answer           = case when v_ask is distinct from v_old.ask then null else answer end,
      answered_by      = case when v_ask is distinct from v_old.ask then null else answered_by end,
      answered_by_name = case when v_ask is distinct from v_old.ask then null else answered_by_name end,
      answered_at      = case when v_ask is distinct from v_old.ask then null else answered_at end,
      updated_by = public.init_actor(), updated_at = now()
    where id = v_old.id
    returning id into v_id;
  else
    insert into public.init_checkins (project_id, week_start, health, summary, ask, created_by, updated_by)
    values (p_project_id, v_week, p_health, v_summary, v_ask, public.init_actor(), public.init_actor())
    returning id into v_id;
  end if;
  perform public.init_log('checkin', p_project_id, null, v_project.name, v_old.health, p_health);
  return v_id;
end;
$$;

-- An admin answers a check-in's ask (an empty answer takes it back). The answer is signed with
-- the answerer's name, plus "for <first digest recipient>" when someone else answers on their
-- behalf, and the project's leads get an email.
create or replace function public.init_answer_ask(p_checkin_id uuid, p_answer text)
returns text language plpgsql security definer set search_path = public as $$
declare
  s          public.init_settings%rowtype;
  c          public.init_checkins%rowtype;
  p          public.init_projects%rowtype;
  v_answer   text := nullif(btrim(p_answer), '');
  v_me       text;
  v_me_email text;
  v_boss     text;
  v_by       text;
  v_to       text[];
begin
  perform public.init_require_admin();
  select * into s from public.init_settings;
  select * into c from public.init_checkins where id = p_checkin_id;
  if not found then raise exception 'Check-in not found'; end if;
  if c.ask is null then raise exception 'This check-in has no ask to answer'; end if;
  select * into p from public.init_projects where id = c.project_id;

  if v_answer is not null then
    select display_name, lower(email) into v_me, v_me_email from public.init_people where user_id = auth.uid() and active;
    v_me := coalesce(v_me, public.init_login_name(auth.uid()), public.init_actor());
    if not (lower(coalesce(auth.jwt() ->> 'email', '')) = any(s.digest_recipients)
            or coalesce(v_me_email, '') = any(s.digest_recipients))
       and coalesce(array_length(s.digest_recipients, 1), 0) > 0 then
      select coalesce((select display_name from public.init_people where lower(email) = s.digest_recipients[1] limit 1),
                      split_part(s.digest_recipients[1], '@', 1))
        into v_boss;
    end if;
    v_by := case when v_boss is null then v_me else v_me || ' for ' || v_boss end;
  end if;

  update public.init_checkins set
    answer = v_answer,
    answered_by      = case when v_answer is null then null else public.init_actor() end,
    answered_by_name = v_by,
    answered_at      = case when v_answer is null then null else now() end
  where id = c.id;
  perform public.init_log('answer', c.project_id, null, p.name, c.answer, v_answer);

  -- Tell the leads (not whoever answered)
  if v_answer is not null and s.email_enabled then
    select array_agg(distinct lower(pe.email)) into v_to
    from public.init_project_leads l join public.init_people pe on pe.id = l.person_id
    where l.project_id = c.project_id and pe.active and pe.email is not null
      and pe.user_id is distinct from auth.uid();
    if coalesce(array_length(v_to, 1), 0) > 0 then
      insert into public.init_outbox (key, kind, recipients, subject, payload)
      values ('answered:' || c.id || ':' || extract(epoch from clock_timestamp())::bigint, 'answered', v_to,
              v_by || ' answered your ask on ' || p.name,
              jsonb_build_object('app_url', s.app_url, 'project_id', p.id, 'project', p.name, 'color', p.color,
                                 'health', c.health, 'summary', c.summary, 'ask', c.ask, 'answer', v_answer,
                                 'by', v_by, 'week_start', c.week_start))
      on conflict (key) do nothing;
      perform public.init_fire_outbox();
    end if;
  end if;
  return coalesce(v_by, '');
end;
$$;

-- An admin writes (or clears, with an empty body) the note at the top of a week's digest
create or replace function public.init_save_digest_note(p_week_start date, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_week date := public.init_week_start(coalesce(p_week_start, public.init_today()));
  v_body text := nullif(btrim(p_body), '');
begin
  perform public.init_require_admin();
  if v_body is null then
    delete from public.init_digest_notes where week_start = v_week;
  else
    insert into public.init_digest_notes (week_start, body, updated_by) values (v_week, v_body, public.init_actor())
    on conflict (week_start) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = now();
  end if;
end;
$$;


-- ── THE WEEKLY DIGEST ────────────────────────────────────────────────────────
-- For the week starting p_week_start (a Monday); also what the app's Digest screen shows.
-- Order of what it's for: asks for Matt, a three-line headline, how much to trust the data,
-- every project by department with its health, then blocked / late / quiet / candidates to park.
create or replace function public.init_digest(p_week_start date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s       public.init_settings%rowtype;
  v_start date := public.init_week_start(coalesce(p_week_start, public.init_today()));
  v_from  timestamptz;
  v_to    timestamptz;
  v_today date := public.init_today();
  v_asof  date;
  v_heard timestamptz;
  result  jsonb;
begin
  if auth.uid() is not null and public.init_role() is null then
    raise exception 'No access to the Initiatives Tracker' using errcode = '42501';
  end if;
  select * into s from public.init_settings;
  v_from  := public.init_day_start(v_start);
  v_to    := public.init_day_start(v_start + 7);
  v_asof  := least(v_today, v_start + 6);
  v_heard := public.init_day_start(v_asof - 13);          -- "not heard from" = nothing in 14 days

  with
  live_projects as (select * from public.init_projects where archived_at is null and created_at < v_to),
  wk_act as (
    select distinct on (ac.task_id) ac.task_id, ac.at
    from public.init_activity ac
    where ac.at >= v_from and ac.at < v_to and ac.task_id is not null and ac.kind in ('status', 'note', 'blocked_on')
    order by ac.task_id, ac.at desc
  ),
  tasks as (
    select t.*, p.code, p.name as project_name, p.color, p.sort_order,
           coalesce((select array_agg(pe.display_name order by pe.display_name)
                     from public.init_task_assignees ta join public.init_people pe on pe.id = ta.person_id
                     where ta.task_id = t.id), '{}') as who,
           (select max(ac.at) from public.init_activity ac
             where ac.task_id = t.id and ac.at < v_to and ac.kind in ('status', 'note', 'blocked_on', 'task_created')) as last_at,
           (select max(ac.at) from public.init_activity ac
             where ac.task_id = t.id and ac.at < v_to and ac.kind in ('status', 'note', 'blocked_on')) as last_move_at,
           wa.at as moved_at,
           (select display_name from public.init_people where id = t.blocked_on_person) as blocked_on_name,
           t.status in ('Not started', 'In progress', 'Blocked') as is_open
    from public.init_tasks t join live_projects p on p.id = t.project_id
    left join wk_act wa on wa.task_id = t.id
  ),
  -- The check-in that counts for each project: this week's, else the latest before it
  ck as (
    select distinct on (c.project_id) c.*
    from public.init_checkins c where c.week_start <= v_start
    order by c.project_id, c.week_start desc
  ),
  -- Last sign of movement per project before the week ended (task changes, stage, check-ins)
  mv as (
    select ac.project_id, max(ac.at) as last_at
    from public.init_activity ac
    where ac.at < v_to and ac.kind in ('status', 'note', 'blocked_on', 'task_created', 'stage', 'checkin')
    group by ac.project_id
  ),
  proj as (
    select p.id, p.code, p.name, p.color, p.stage, p.priority, p.department, p.target_date, p.sort_order,
           public.init_lead_names(p.id) as lead,
           public.init_dept_rank(p.department) as dept_rank,
           case p.priority when 'Urgent' then 0 when 'High' then 1 else 2 end as prio_rank,
           coalesce(c.total, 0) as total, coalesce(c.done, 0) as done,
           coalesce(c.blocked, 0) as blocked, coalesce(c.moved, 0) as moved,
           ck.id as checkin_id, ck.week_start as checkin_week, ck.summary,
           -- health counts while the check-in is from this week or last
           case when ck.week_start >= v_start - 7 then ck.health end as health,
           (v_asof - (coalesce(mv.last_at, p.created_at) at time zone s.time_zone)::date) as days_quiet,
           p.stage not in ('Done', 'Parked') as active
    from live_projects p
    left join lateral (
      select count(*)::int as total,
             count(*) filter (where t.status = 'Done')::int as done,
             count(*) filter (where t.status = 'Blocked')::int as blocked,
             count(*) filter (where t.moved_at is not null)::int as moved
      from tasks t where t.project_id = p.id
    ) c on true
    left join ck on ck.project_id = p.id
    left join mv on mv.project_id = p.id
  ),
  people as (
    select pe.display_name as name,
           count(*) filter (where t.is_open)::int as open,
           count(*) filter (where t.status = 'Blocked')::int as blocked,
           count(*) filter (where t.status = 'Done' and t.completed_at >= v_from and t.completed_at < v_to)::int as done_week,
           max(t.last_move_at) as last_move,
           max(ta.added_at) as last_added
    from public.init_people pe
    join public.init_task_assignees ta on ta.person_id = pe.id
    join tasks t on t.id = ta.task_id
    where pe.active
    group by pe.id, pe.display_name
  )
  select jsonb_build_object(
    'week_start', v_start,
    'week_end',   v_start + 6,
    'as_of',      v_asof,
    'app_url',    s.app_url,
    'stale_days', s.stale_days,
    'note',       (select body from public.init_digest_notes where week_start = v_start),
    'totals', jsonb_build_object(
      'projects',   (select count(*) from proj where active),
      'tasks',      (select count(*) from tasks),
      'done',       (select count(*) from tasks where status = 'Done'),
      'done_week',  (select count(*) from tasks where status = 'Done' and completed_at >= v_from and completed_at < v_to),
      'moved',      (select count(*) from tasks where moved_at is not null),
      'blocked',    (select count(*) from tasks where status = 'Blocked'),
      'overdue',    (select count(*) from tasks where due_date < v_asof and status not in ('Done', 'Parked'))
    ),
    -- Open asks from each project's current check-in, then asks answered this week
    'asks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'checkin_id', c.id, 'project_id', p.id, 'code', p.code, 'name', p.name, 'color', p.color,
               'department', p.department, 'lead', public.init_lead_names(p.id), 'health', c.health,
               'ask', c.ask, 'week_start', c.week_start, 'days_open', v_asof - c.week_start,
               'answer', c.answer, 'answered_by', c.answered_by_name, 'answered_at', c.answered_at)
             order by (c.answer is not null), c.week_start, p.name)
      from public.init_checkins c join live_projects p on p.id = c.project_id
      where c.ask is not null
        and ((c.answer is null and c.id in (select id from ck))
             or (c.answered_at >= v_from and c.answered_at < v_to))), '[]'),
    'headline', jsonb_build_object(
      'on_track',   (select count(*) from proj where active and health = 'On track'),
      'at_risk',    (select count(*) from proj where active and health = 'At risk'),
      'off_track',  (select count(*) from proj where active and health = 'Off track'),
      'no_checkin', (select count(*) from proj where active and health is null),
      'moving',     coalesce((select jsonb_agg(name order by moved desc, name) from proj where active and moved > 0), '[]'),
      'quiet',      coalesce((select jsonb_agg(name order by dept_rank, name) from proj
                              where active and moved = 0 and checkin_week is distinct from v_start), '[]'),
      'blocked_tasks',    (select count(*) from tasks where status = 'Blocked'),
      'blocked_projects', (select count(distinct project_id) from tasks where status = 'Blocked')
    ),
    -- How much of the picture is current
    'data_quality', jsonb_build_object(
      'checkins_in',       (select count(*) from proj where active and checkin_week = v_start),
      'checkins_expected', (select count(*) from proj where active),
      'missing', coalesce((select jsonb_agg(jsonb_build_object('project_id', id, 'code', code, 'name', name,
                                                               'color', color, 'lead', lead) order by dept_rank, name)
                           from proj where active and checkin_week is distinct from v_start), '[]'),
      'open_tasks',        (select count(*) from tasks where is_open),
      'open_touched',      (select count(*) from tasks where is_open and moved_at is not null),
      'pct_open_touched',  (select case when count(*) = 0 then null
                                        else round(100.0 * count(*) filter (where moved_at is not null) / count(*))::int end
                            from tasks where is_open),
      'not_heard_from', coalesce((select jsonb_agg(name order by name) from people
                                  where open > 0 and coalesce(greatest(last_move, last_added), '-infinity') < v_heard), '[]')
    ),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
               'project_id', id, 'code', code, 'name', name, 'color', color, 'department', department,
               'stage', stage, 'priority', priority, 'lead', lead, 'health', health,
               'checkin_week', checkin_week, 'checkin_current', checkin_week = v_start, 'summary', summary,
               'target_date', target_date,
               'days_late', case when target_date < v_asof and stage <> 'Done' then v_asof - target_date end,
               'done', done, 'total', total, 'blocked', blocked, 'moved', moved)
             order by dept_rank, (stage = 'Done'), prio_rank, sort_order, name)
      from proj), '[]'),
    'blocked', coalesce((
      select jsonb_agg(jsonb_build_object('task_id', id, 'project_id', project_id, 'code', code, 'project', project_name,
                                          'color', color, 'title', title, 'blocked_on', blocked_on,
                                          'blocked_on_person', blocked_on_name,
                                          'waiting_on', nullif(concat_ws(' — ', blocked_on_name, blocked_on), ''),
                                          'who', who, 'since', status_changed_at::date)
                       order by sort_order, project_name, position)
      from tasks where status = 'Blocked'), '[]'),
    'past_target', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', id, 'code', code, 'name', name, 'color', color,
                                          'target_date', target_date, 'open', total - done, 'total', total,
                                          'days_late', v_asof - target_date)
                       order by target_date)
      from proj where target_date < v_asof and stage <> 'Done'), '[]'),
    'quiet', coalesce((
      select jsonb_agg(jsonb_build_object('task_id', id, 'code', code, 'project', project_name, 'color', color,
                                          'title', title, 'who', who, 'last_at', last_at::date)
                       order by last_at nulls first)
      from tasks
      where status = 'In progress' and (last_at is null or last_at < public.init_day_start(v_asof - s.stale_days + 1))), '[]'),
    -- Open projects with no movement for 3+ weeks: candidates to park or close
    'park_candidates', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', id, 'code', code, 'name', name, 'color', color,
                                          'stage', stage, 'lead', lead, 'weeks_quiet', days_quiet / 7)
                       order by days_quiet desc, name)
      from proj where active and days_quiet >= 21), '[]'),
    -- Workload: counts only
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'open', open, 'blocked', blocked, 'done_week', done_week,
                                          'last_update', (last_move at time zone s.time_zone)::date)
                       order by open desc, name)
      from people), '[]')
  ) into result;
  return result;
end;
$$;


-- ── "YOUR WEEK" REMINDER ─────────────────────────────────────────────────────
-- One person's weekly email: all their open tasks (the overdue / quiet ones first, flagged), and,
-- for leads, the projects that still need this week's check-in.
create or replace function public.init_reminder_payload(p_person_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with s as (select * from public.init_settings),
  t as (
    select t.*, p.code, p.name as project_name, p.color, p.sort_order,
           (select max(ac.at) from public.init_activity ac
             where ac.task_id = t.id and ac.kind in ('status', 'note', 'blocked_on', 'task_created')) as last_at
    from public.init_tasks t
    join public.init_projects p on p.id = t.project_id and p.archived_at is null
    join public.init_task_assignees ta on ta.task_id = t.id and ta.person_id = p_person_id
    where t.status in ('Not started', 'In progress', 'Blocked')
  ),
  tt as (
    select t.*,
           coalesce(t.due_date < public.init_today(), false) as overdue,
           public.init_today() - coalesce(t.last_at, t.created_at)::date as days_quiet,
           (coalesce(t.due_date < public.init_today(), false) or t.last_at is null
            or t.last_at < now() - make_interval(days => (select stale_days from s))) as needs_update
    from t
  ),
  due as (
    select p.id, p.code, p.name, p.color, p.sort_order, lc.health as last_health, lc.summary as last_summary,
           lc.week_start as last_week
    from public.init_project_leads l
    join public.init_projects p on p.id = l.project_id and p.archived_at is null and p.stage not in ('Done', 'Parked')
    left join lateral (select * from public.init_checkins c where c.project_id = p.id order by c.week_start desc limit 1) lc on true
    where l.person_id = p_person_id
      and not exists (select 1 from public.init_checkins c
                      where c.project_id = p.id and c.week_start = public.init_week_start(public.init_today()))
  )
  select jsonb_build_object(
    'name',         (select display_name from public.init_people where id = p_person_id),
    'app_url',      (select app_url from s),
    'stale_days',   (select stale_days from s),
    'open',         (select count(*) from tt),
    'needs_update', (select count(*) from tt where needs_update),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
               'task_id', id, 'code', code, 'project', project_name, 'color', color, 'title', title, 'status', status,
               'due_date', due_date, 'overdue', overdue, 'needs_update', needs_update,
               'blocked_on', public.init_waiting_on(blocked_on_person, blocked_on),
               'last_at', last_at::date, 'days_quiet', days_quiet)
             order by needs_update desc, overdue desc, sort_order, project_name, position) from tt), '[]'),
    'checkins_due', coalesce((select jsonb_agg(jsonb_build_object(
               'project_id', id, 'code', code, 'name', name, 'color', color,
               'last_health', last_health, 'last_summary', last_summary, 'last_week', last_week)
             order by sort_order, name) from due), '[]'));
$$;

-- One "Your week" email per active person with an email and open tasks or a check-in due.
-- Returns how many were queued.
create or replace function public.init_queue_reminders(p_force boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_week text := public.init_week_start(public.init_today())::text;
  v_n    integer := 0;
  pe     record;
  v_p    jsonb;
  v_need integer;
begin
  for pe in select id, display_name, email from public.init_people where active and email is not null loop
    v_p := public.init_reminder_payload(pe.id);
    continue when jsonb_array_length(v_p -> 'tasks') = 0 and jsonb_array_length(v_p -> 'checkins_due') = 0;
    v_need := (v_p ->> 'needs_update')::int + jsonb_array_length(v_p -> 'checkins_due');
    insert into public.init_outbox (key, kind, person_id, recipients, subject, payload)
    values ('reminder:' || pe.id || ':' || v_week || case when p_force then ':' || extract(epoch from clock_timestamp())::bigint else '' end,
            'reminder', pe.id, array[lower(pe.email)],
            'Your initiatives this week' || case when v_need = 0 then '' else ' · ' || v_need || ' to update' end,
            v_p)
    on conflict (key) do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end;
$$;

create or replace function public.init_send_reminders_now()
returns text language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  perform public.init_require_admin();
  v_n := public.init_queue_reminders(true);
  if v_n = 0 then return 'Nobody has open tasks or a check-in due, so no emails were queued'; end if;
  return v_n || ' "Your week" email' || case when v_n = 1 then '' else 's' end || ' queued. ' || public.init_fire_outbox();
end;
$$;


-- ── VIEWS ────────────────────────────────────────────────────────────────────
-- Rebuilt for the new columns. Keep any extra grants (e.g. an outside reporting role) the live
-- views carry: note them before the drop and put them back after.
create temp table init_view_grants as
select table_name::text, grantee::text, privilege_type::text
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('init_task_board', 'init_project_board', 'init_people_board')
  and grantee not in ('anon', 'authenticated', 'service_role', 'PUBLIC', 'postgres', 'supabase_admin')
  and grantee <> current_user;

drop view public.init_task_board;
drop view public.init_project_board;
drop view public.init_people_board;

-- Every task with its project, assignees, who it's waiting on, and whether it moved this week
create view public.init_task_board
with (security_invoker = true) as
with wk as (select public.init_today() as today, public.init_week_start(public.init_today()) as week_start)
select
  t.*,
  p.code                                         as project_code,
  p.name                                         as project_name,
  p.color                                        as project_color,
  p.department                                   as project_department,
  p.archived_at is not null                      as project_archived,
  coalesce(a.person_ids,   '{}')                 as assignee_ids,
  coalesce(a.person_names, '{}')                 as assignee_names,
  bp.display_name                                as blocked_on_person_name,
  (t.due_date is not null and t.status not in ('Done', 'Parked') and t.due_date < wk.today) as overdue,
  act.last_at                                    as last_activity_at,
  coalesce(act.moved_at >= public.init_day_start(wk.week_start), false) as moved_this_week,
  wk.today
from public.init_tasks t
join public.init_projects p on p.id = t.project_id
cross join wk
left join public.init_people bp on bp.id = t.blocked_on_person
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

-- One row per project: leads, stakeholders, counts, weekly activity, and the latest check-in.
-- latest_checkin is null until a lead checks in. weeks_quiet counts whole weeks since the last
-- task change, stage change or check-in.
create view public.init_project_board
with (security_invoker = true) as
with wk as (select public.init_today() as today, public.init_week_start(public.init_today()) as week_start)
select
  p.*,
  array_to_string(ld.names, ', ')  as lead_name,
  coalesce(ld.ids, '{}')      as lead_ids,
  coalesce(ld.names, '{}')    as lead_names,
  coalesce(sh.ids, '{}')      as stakeholder_ids,
  coalesce(sh.names, '{}')    as stakeholder_names,
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
  coalesce(tm.team, '{}')     as team_names,
  case when lc.id is null then null else jsonb_build_object(
    'id', lc.id, 'week_start', lc.week_start, 'health', lc.health, 'summary', lc.summary, 'ask', lc.ask,
    'answer', lc.answer, 'answered_by', lc.answered_by_name, 'answered_at', lc.answered_at,
    'updated_by', lc.updated_by, 'updated_at', lc.updated_at, 'age_days', wk.today - lc.week_start) end as latest_checkin,
  coalesce(lc.week_start = wk.week_start, false) as checkin_this_week,
  ((wk.today - (coalesce(mv.last_at, p.created_at) at time zone (select time_zone from public.init_settings))::date) / 7) as weeks_quiet
from public.init_projects p
cross join wk
left join lateral (
  select array_agg(pe.id order by pe.display_name) as ids, array_agg(pe.display_name order by pe.display_name) as names
  from public.init_project_leads l join public.init_people pe on pe.id = l.person_id
  where l.project_id = p.id
) ld on true
left join lateral (
  select array_agg(pe.id order by pe.display_name) as ids, array_agg(pe.display_name order by pe.display_name) as names
  from public.init_project_stakeholders s join public.init_people pe on pe.id = s.person_id
  where s.project_id = p.id
) sh on true
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
  select max(ac.at) as last_at
  from public.init_activity ac
  where ac.project_id = p.id and ac.kind in ('status', 'note', 'blocked_on', 'task_created', 'stage', 'checkin')
) mv on true
left join lateral (
  select * from public.init_checkins ci where ci.project_id = p.id order by ci.week_start desc limit 1
) lc on true
left join lateral (
  select array_agg(distinct pe.display_name) as team
  from public.init_tasks t join public.init_task_assignees ta on ta.task_id = t.id
  join public.init_people pe on pe.id = ta.person_id
  where t.project_id = p.id
) tm on true;

-- One row per active person: workload, and when their tasks last moved
create view public.init_people_board
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
  lu.last_at                  as last_update_at,
  coalesce(s.projects, '{}')  as project_codes,
  coalesce((select array_agg(pr.code order by pr.code) from public.init_project_leads l
            join public.init_projects pr on pr.id = l.project_id and pr.archived_at is null
            where l.person_id = pe.id), '{}') as lead_of,
  coalesce((select array_agg(pr.code order by pr.code) from public.init_project_stakeholders sh
            join public.init_projects pr on pr.id = sh.project_id and pr.archived_at is null
            where sh.person_id = pe.id), '{}') as stakeholder_of
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
         array_agg(distinct pr.code) as projects
  from public.init_task_assignees ta
  join public.init_tasks t on t.id = ta.task_id
  join public.init_projects pr on pr.id = t.project_id and pr.archived_at is null
  where ta.person_id = pe.id
) s on true
left join lateral (
  select max(ac.at) as last_at
  from public.init_task_assignees ta
  join public.init_activity ac on ac.task_id = ta.task_id and ac.kind in ('status', 'note', 'blocked_on')
  where ta.person_id = pe.id
) lu on true
where pe.active;

revoke all on public.init_task_board, public.init_project_board, public.init_people_board from anon;

do $$
declare g record;
begin
  for g in select * from init_view_grants loop
    if exists (select 1 from pg_roles where rolname = g.grantee) then
      execute format('grant %s on public.%I to %I', g.privilege_type, g.table_name, g.grantee);
    end if;
  end loop;
end $$;
drop table init_view_grants;


-- ── FUNCTION PERMISSIONS (same rules as 004) ─────────────────────────────────
revoke execute on function public.init_dept_rank(text), public.init_waiting_on(uuid, text),
  public.init_save_checkin(uuid, text, text, text), public.init_answer_ask(uuid, text),
  public.init_save_digest_note(date, text)
  from public, anon, authenticated;
grant execute on function public.init_save_checkin(uuid, text, text, text), public.init_answer_ask(uuid, text),
  public.init_save_digest_note(date, text)
  to authenticated;


-- ── REALTIME ─────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.init_checkins;
  end if;
end $$;
