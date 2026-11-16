-- ============================================================
-- Initiatives Tracker: several leads per project, plus stakeholders
-- ============================================================
-- Run after 004_init_hardening.sql. Replaces the single init_projects.lead_person with:
--   init_project_leads         project ↔ person: any number of leads. Every lead gets what the one
--                              lead had (manage the project's tasks, set its stage and summary).
--   init_project_stakeholders  project ↔ person: people involved in the project. Shown on the
--                              board; no extra permissions.
-- Admins set both through init_set_project_people(). Existing leads are carried over.
-- ============================================================

-- ── TABLES ───────────────────────────────────────────────────────────────────
create table public.init_project_leads (
  project_id  uuid not null references public.init_projects(id) on delete cascade,
  person_id   uuid not null references public.init_people(id) on delete cascade,
  added_by    text,
  added_at    timestamptz not null default now(),
  primary key (project_id, person_id)
);
create index init_project_leads_person_idx on public.init_project_leads (person_id);

create table public.init_project_stakeholders (
  project_id  uuid not null references public.init_projects(id) on delete cascade,
  person_id   uuid not null references public.init_people(id) on delete cascade,
  added_by    text,
  added_at    timestamptz not null default now(),
  primary key (project_id, person_id)
);
create index init_project_stakeholders_person_idx on public.init_project_stakeholders (person_id);

alter table public.init_project_leads        enable row level security;
alter table public.init_project_stakeholders enable row level security;
create policy "init read" on public.init_project_leads        for select to authenticated using (public.init_role() is not null);
create policy "init read" on public.init_project_stakeholders for select to authenticated using (public.init_role() is not null);
-- Writes only through init_set_project_people (security definer)
revoke all on public.init_project_leads, public.init_project_stakeholders from anon;
revoke insert, update, delete, truncate on public.init_project_leads, public.init_project_stakeholders from authenticated;

-- Two new kinds in the activity log
alter table public.init_activity drop constraint init_activity_kind_check;
alter table public.init_activity add constraint init_activity_kind_check
  check (kind in ('project_created', 'stage', 'project_edit', 'archived', 'restored',
                  'task_created', 'status', 'note', 'assigned', 'unassigned',
                  'due', 'title', 'blocked_on', 'task_deleted', 'person', 'role', 'signin',
                  'leads', 'stakeholders'));

insert into public.init_project_leads (project_id, person_id, added_by)
select id, lead_person, 'migration: one lead per project' from public.init_projects where lead_person is not null
on conflict do nothing;


-- ── FUNCTIONS THAT READ THE LEAD ─────────────────────────────────────────────
drop view public.init_task_board;
drop view public.init_project_board;
drop view public.init_people_board;

-- Does the signed-in person lead this project?
create or replace function public.init_leads_project(p_project_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.init_project_leads
                 where project_id = p_project_id and person_id = public.init_my_person());
$$;

-- "Lisa, Nick" for emails
create or replace function public.init_lead_names(p_project_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select string_agg(pe.display_name, ', ' order by pe.display_name)
  from public.init_project_leads l join public.init_people pe on pe.id = l.person_id
  where l.project_id = p_project_id;
$$;
create or replace function public.init_stakeholder_names(p_project_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select string_agg(pe.display_name, ', ' order by pe.display_name)
  from public.init_project_stakeholders s join public.init_people pe on pe.id = s.person_id
  where s.project_id = p_project_id;
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
  if new.name is distinct from old.name or new.target_date is distinct from old.target_date
     or new.priority is distinct from old.priority or new.code is distinct from old.code then
    perform public.init_log('project_edit', new.id, null, new.name, null,
      concat_ws(', ',
        case when new.name        is distinct from old.name        then 'name' end,
        case when new.code        is distinct from old.code        then 'code' end,
        case when new.target_date is distinct from old.target_date then 'target date' end,
        case when new.priority    is distinct from old.priority    then 'priority' end));
  end if;
  return null;
end;
$$;


-- Assignment notice: queued when someone adds a person to a task in the app. Not when people add
-- themselves, and never for changes made outside the app (SQL imports, the schedule).
create or replace function public.init_assignees_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s   public.init_settings%rowtype;
  pe  public.init_people%rowtype;
  t   record;
begin
  select * into s from public.init_settings;
  if not (s.email_enabled and s.notify_assigned) or auth.uid() is null then return null; end if;
  select * into pe from public.init_people where id = new.person_id;
  if pe.email is null or not pe.active or pe.user_id is not distinct from auth.uid() then return null; end if;
  select tk.id, tk.title, tk.status, tk.due_date, tk.blocked_on, p.code, p.name as project, p.color,
         public.init_lead_names(p.id) as lead
    into t from public.init_tasks tk join public.init_projects p on p.id = tk.project_id where tk.id = new.task_id;
  insert into public.init_outbox (key, kind, person_id, recipients, subject, payload)
  values ('assigned:' || new.task_id || ':' || new.person_id || ':' || extract(epoch from clock_timestamp())::bigint,
          'assigned', pe.id, array[lower(pe.email)],
          'You''re on a task: ' || t.title,
          jsonb_build_object('name', pe.display_name, 'app_url', s.app_url, 'by', public.init_actor(),
                             'task', to_jsonb(t)))
  on conflict (key) do nothing;
  perform public.init_fire_outbox();
  return null;
end;
$$;

-- The weekly digest for the week starting p_week_start (a Monday). Also what the app's
-- Weekly digest screen shows. Activity counts are for [week start, week start + 7 days).
create or replace function public.init_digest(p_week_start date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s         public.init_settings%rowtype;
  v_start   date := public.init_week_start(coalesce(p_week_start, public.init_today()));
  v_from    timestamptz;
  v_to      timestamptz;
  v_today   date := public.init_today();
  v_asof    date;
  result    jsonb;
begin
  if auth.uid() is not null and public.init_role() is null then
    raise exception 'No access to the Initiatives Tracker' using errcode = '42501';
  end if;
  select * into s from public.init_settings;
  v_from := public.init_day_start(v_start);
  v_to   := public.init_day_start(v_start + 7);
  v_asof := least(v_today, v_start + 6);

  with
  live_projects as (select * from public.init_projects where archived_at is null),
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
             where ac.task_id = t.id and ac.kind in ('status', 'note', 'blocked_on', 'task_created')) as last_at,
           wa.at as moved_at
    from public.init_tasks t join live_projects p on p.id = t.project_id
    left join wk_act wa on wa.task_id = t.id
  ),
  proj as (
    select p.id, p.code, p.name, p.color, p.stage, p.target_date, p.sort_order,
           public.init_lead_names(p.id) as lead,
           count(t.id)::int as total,
           count(t.id) filter (where t.status = 'Done')::int as done,
           count(t.id) filter (where t.moved_at is not null)::int as moved
    from live_projects p left join tasks t on t.project_id = p.id
    group by p.id, p.code, p.name, p.color, p.stage, p.target_date, p.sort_order
  ),
  people as (
    select pe.display_name as name,
           count(*) filter (where t.status in ('Not started', 'In progress', 'Blocked'))::int as open,
           count(*) filter (where t.status = 'Blocked')::int as blocked,
           count(*) filter (where t.status = 'Done' and t.completed_at >= v_from and t.completed_at < v_to)::int as done_week,
           count(*) filter (where t.moved_at is not null)::int as moved
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
    'totals', jsonb_build_object(
      'projects',   (select count(*) from proj where stage <> 'Done'),
      'tasks',      (select count(*) from tasks),
      'done',       (select count(*) from tasks where status = 'Done'),
      'done_week',  (select count(*) from tasks where status = 'Done' and completed_at >= v_from and completed_at < v_to),
      'moved',      (select count(*) from tasks where moved_at is not null),
      'blocked',    (select count(*) from tasks where status = 'Blocked'),
      'overdue',    (select count(*) from tasks where due_date < v_asof and status not in ('Done', 'Parked'))
    ),
    -- Projects with activity this week, most active first, each with up to 5 tasks that moved
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', pr.code, 'name', pr.name, 'color', pr.color, 'stage', pr.stage, 'lead', pr.lead,
               'moved', pr.moved, 'done', pr.done, 'total', pr.total,
               'pct', case when pr.total = 0 then 0 else round(100.0 * pr.done / pr.total)::int end,
               'tasks', (select jsonb_agg(jsonb_build_object('title', x.title, 'status', x.status, 'who', x.who, 'note', x.latest_note))
                         from (select * from tasks t where t.project_id = pr.id and t.moved_at is not null
                               order by t.moved_at desc limit 5) x))
             order by pr.moved desc, pr.sort_order, pr.name)
      from proj pr where pr.moved > 0), '[]'),
    -- Projects with nothing moving this week
    'idle', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'color', color, 'stage', stage, 'lead', lead,
                                          'pct', case when total = 0 then 0 else round(100.0 * done / total)::int end)
                       order by sort_order, name)
      from proj where moved = 0 and stage not in ('Done', 'Parked')), '[]'),
    'blocked', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'project', project_name, 'color', color, 'title', title,
                                          'blocked_on', blocked_on, 'who', who, 'since', status_changed_at::date)
                       order by sort_order, project_name, position)
      from tasks where status = 'Blocked'), '[]'),
    'past_target', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'color', color, 'target_date', target_date,
                                          'open', total - done, 'total', total, 'days_late', v_asof - target_date)
                       order by target_date)
      from proj where target_date < v_asof and stage <> 'Done'), '[]'),
    'quiet', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'project', project_name, 'color', color, 'title', title,
                                          'who', who, 'last_at', last_at::date)
                       order by last_at nulls first)
      from tasks
      where status = 'In progress' and (last_at is null or last_at < public.init_day_start(v_asof - s.stale_days + 1))), '[]'),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'open', open, 'blocked', blocked, 'done_week', done_week,
                                          'moved', moved,
                                          'pct', case when open = 0 then null else round(100.0 * least(moved, open) / open)::int end)
                       order by open desc, name)
      from people), '[]')
  ) into result;
  return result;
end;
$$;

alter table public.init_projects drop column lead_person;


-- ── SET LEADS + STAKEHOLDERS (Initiatives Admin) ─────────────────────────────
-- Replaces both lists. Someone listed as a lead isn't also kept as a stakeholder.
-- Logs a 'leads' / 'stakeholders' activity row with the names before and after.
create or replace function public.init_set_project_people(p_project_id uuid, p_lead_ids uuid[], p_stakeholder_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
  v_name     text;
  v_leads    uuid[] := array(select distinct x from unnest(coalesce(p_lead_ids, '{}')) x);
  v_stake    uuid[];
  v_lbefore  text;
  v_sbefore  text;
  v_lafter   text;
  v_safter   text;
begin
  perform public.init_require_admin();
  select name into v_name from public.init_projects where id = p_project_id;
  if not found then raise exception 'Project not found'; end if;
  v_stake := array(select distinct x from unnest(coalesce(p_stakeholder_ids, '{}')) x where x <> all(v_leads));

  v_lbefore := public.init_lead_names(p_project_id);
  v_sbefore := public.init_stakeholder_names(p_project_id);

  delete from public.init_project_leads where project_id = p_project_id and person_id <> all(v_leads);
  insert into public.init_project_leads (project_id, person_id, added_by)
  select p_project_id, x, public.init_actor() from unnest(v_leads) x on conflict do nothing;

  delete from public.init_project_stakeholders where project_id = p_project_id and person_id <> all(v_stake);
  insert into public.init_project_stakeholders (project_id, person_id, added_by)
  select p_project_id, x, public.init_actor() from unnest(v_stake) x on conflict do nothing;

  v_lafter := public.init_lead_names(p_project_id);
  v_safter := public.init_stakeholder_names(p_project_id);
  if v_lbefore is distinct from v_lafter then
    perform public.init_log('leads', p_project_id, null, v_name, v_lbefore, v_lafter);
  end if;
  if v_sbefore is distinct from v_safter then
    perform public.init_log('stakeholders', p_project_id, null, v_name, v_sbefore, v_safter);
  end if;
end;
$$;


-- ── VIEWS (as in 001, with lead lists in place of lead_person) ────────────────

-- Every task with its project, assignees, and whether it moved this week
create or replace view public.init_task_board
with (security_invoker = true) as
with wk as (select public.init_today() as today, public.init_week_start(public.init_today()) as week_start)
select
  t.*,
  p.code                                         as project_code,
  p.name                                         as project_name,
  p.color                                        as project_color,
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

-- One row per project for the board: leads, stakeholders, counts, progress, weekly activity.
-- lead_name is the leads joined with ", " (what the board and emails print).
create or replace view public.init_project_board
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
  coalesce(tm.team, '{}')     as team_names
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
where pe.active;

revoke all on public.init_task_board, public.init_project_board, public.init_people_board from anon;


-- ── FUNCTION PERMISSIONS (same rules as 004) ─────────────────────────────────
revoke execute on function public.init_lead_names(uuid), public.init_stakeholder_names(uuid),
  public.init_set_project_people(uuid, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.init_set_project_people(uuid, uuid[], uuid[]) to authenticated;


-- ── REALTIME ─────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.init_project_leads, public.init_project_stakeholders;
  end if;
end $$;
