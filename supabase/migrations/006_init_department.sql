-- 006: each project belongs to a department (Design, Office, General, Warehouse/Shipping,
-- Production). The app sets the project's color from its department; existing projects keep
-- their color and have no department until an admin picks one. Only admins can change it
-- (the project trigger already limits leads to stage, summary, priority and target date).

alter table public.init_projects
  add column if not exists department text
  check (department in ('Design', 'Office', 'General', 'Warehouse/Shipping', 'Production'));

-- init_project_board selects p.*, so it has to be rebuilt to pick up the new column.
drop view public.init_project_board;

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

revoke all on public.init_project_board from anon;

-- The live project also grants read access to an outside reporting role; dropping the view
-- removed that grant, so put it back where the role exists.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'vitalai_reader') then
    grant select on public.init_project_board to vitalai_reader;
  end if;
end $$;
