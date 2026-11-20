-- Initiatives Tracker 008: "ready to close" projects don't need a weekly check-in.
-- A project is ready to close when it is open (not Done or Parked) and every one of its tasks is
-- Done (it has at least one). The Projects screen already stops asking for its check-in; this
-- brings the "Your week" email and the digest's check-in counts into line.
-- Changes from 007: init_digest (data_quality: checkins_in / checkins_expected / missing) and
-- init_reminder_payload (checkins_due). Everything else in both functions is unchanged.

create or replace function public.init_ready_to_close(p_project_id uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from public.init_tasks where project_id = p_project_id)
     and not exists (select 1 from public.init_tasks where project_id = p_project_id and status <> 'Done');
$$;
-- Only called from inside the digest and reminder functions (which run as the owner)
revoke execute on function public.init_ready_to_close(uuid) from public, anon, authenticated;

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
           p.stage not in ('Done', 'Parked') as active,
           -- expects a check-in: open and not ready to close (every task Done)
           p.stage not in ('Done', 'Parked') and not public.init_ready_to_close(p.id) as expects_checkin
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
      'checkins_in',       (select count(*) from proj where expects_checkin and checkin_week = v_start),
      'checkins_expected', (select count(*) from proj where expects_checkin),
      'missing', coalesce((select jsonb_agg(jsonb_build_object('project_id', id, 'code', code, 'name', name,
                                                               'color', color, 'lead', lead) order by dept_rank, name)
                           from proj where expects_checkin and checkin_week is distinct from v_start), '[]'),
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
      and not public.init_ready_to_close(p.id)
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
