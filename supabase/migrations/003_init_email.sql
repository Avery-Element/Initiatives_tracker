-- ============================================================
-- Initiatives Tracker: weekly digest, reminders, assignment notices
-- ============================================================
-- Run after 002_init_access.sql.
--
-- How sending works (same pattern as Shipping's alerts):
--   1. The database decides what to send and writes it to init_outbox with a unique key,
--      so the same digest or reminder can never be queued twice.
--   2. init_fire_outbox() pokes the init-email Edge Function (pg_net).
--   3. The function claims unsent rows (init_outbox_claim), renders and sends each through
--      Resend, and records the result (init_outbox_result).
--   4. pg_cron runs init_cron_tick() every hour: on the configured day + hour it queues the
--      digest / reminders, and it retries anything that failed.
-- ============================================================

create table public.init_outbox (
  id           bigint generated always as identity primary key,
  key          text not null unique,                     -- 'digest:2026-11-02', 'reminder:<person>:2026-11-02', ...
  kind         text not null check (kind in ('digest', 'reminder', 'assigned', 'test')),
  person_id    uuid references public.init_people(id) on delete set null,
  recipients   text[] not null,
  subject      text not null,
  payload      jsonb not null default '{}',              -- what the Edge Function renders
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  sent_at      timestamptz,
  attempts     integer not null default 0,
  last_error   text
);
create index init_outbox_unsent_idx on public.init_outbox (created_at) where sent_at is null;

alter table public.init_outbox enable row level security;
create policy "init admin read outbox" on public.init_outbox for select to authenticated using (public.init_is_admin());
revoke all on public.init_outbox from anon;


-- ============================================================
-- WHAT GOES IN THE EMAILS
-- ============================================================

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
           (select display_name from public.init_people where id = p.lead_person) as lead,
           count(t.id)::int as total,
           count(t.id) filter (where t.status = 'Done')::int as done,
           count(t.id) filter (where t.moved_at is not null)::int as moved
    from live_projects p left join tasks t on t.project_id = p.id
    group by p.id, p.code, p.name, p.color, p.stage, p.target_date, p.sort_order, p.lead_person
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

-- One person's reminder: their open tasks that are overdue or have gone quiet
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
  )
  select jsonb_build_object(
    'name',     (select display_name from public.init_people where id = p_person_id),
    'app_url',  (select app_url from s),
    'stale_days', (select stale_days from s),
    'open',     (select count(*) from t),
    'tasks', coalesce(jsonb_agg(jsonb_build_object(
               'code', code, 'project', project_name, 'color', color, 'title', title, 'status', status,
               'due_date', due_date, 'overdue', due_date < public.init_today(),
               'blocked_on', blocked_on, 'last_at', last_at::date,
               'days_quiet', public.init_today() - coalesce(last_at, created_at)::date)
             order by (due_date < public.init_today()) desc, sort_order, project_name, position), '[]'))
  from t
  where (due_date < public.init_today())
     or last_at is null
     or last_at < now() - make_interval(days => (select stale_days from s));
$$;


-- ============================================================
-- QUEUEING
-- ============================================================

-- Queue the digest for the week that just ended (or p_week_start). p_force queues another
-- copy even if this week's was already sent (the "Send digest now" button).
create or replace function public.init_queue_digest(p_week_start date default null, p_force boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s        public.init_settings%rowtype;
  v_week   date := coalesce(p_week_start, public.init_week_start(public.init_today()) - 7);
  v_to     text[];
  v_key    text;
begin
  select * into s from public.init_settings;
  select array_agg(distinct lower(e)) into v_to from unnest(s.digest_recipients) e where btrim(e) <> '';
  if coalesce(array_length(v_to, 1), 0) = 0 then
    raise exception 'Add at least one digest recipient in Admin → Email first';
  end if;
  v_key := 'digest:' || v_week || case when p_force then ':' || extract(epoch from clock_timestamp())::bigint else '' end;
  insert into public.init_outbox (key, kind, recipients, subject, payload)
  values (v_key, 'digest', v_to,
          'Initiatives: week of ' || to_char(v_week, 'Mon FMDD'),
          public.init_digest(v_week))
  on conflict (key) do nothing;
  return case when found then 1 else 0 end;
end;
$$;

-- One reminder per active person with an email and something overdue or quiet.
-- Returns how many were queued.
create or replace function public.init_queue_reminders(p_force boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_week text := public.init_week_start(public.init_today())::text;
  v_n    integer := 0;
  pe     record;
  v_p    jsonb;
begin
  for pe in select id, display_name, email from public.init_people where active and email is not null loop
    v_p := public.init_reminder_payload(pe.id);
    continue when jsonb_array_length(v_p -> 'tasks') = 0;
    insert into public.init_outbox (key, kind, person_id, recipients, subject, payload)
    values ('reminder:' || pe.id || ':' || v_week || case when p_force then ':' || extract(epoch from clock_timestamp())::bigint else '' end,
            'reminder', pe.id, array[lower(pe.email)],
            case when jsonb_array_length(v_p -> 'tasks') = 1 then '1 initiative task needs an update'
                 else jsonb_array_length(v_p -> 'tasks') || ' initiative tasks need an update' end,
            v_p)
    on conflict (key) do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
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
         (select display_name from public.init_people where id = p.lead_person) as lead
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
create trigger init_assignees_notify after insert on public.init_task_assignees
  for each row execute function public.init_assignees_notify();


-- ============================================================
-- SENDING
-- ============================================================

-- Poke the init-email Edge Function. Needs settings.functions_url and the vault secret named
-- in settings.function_key_secret (the same service key Shipping's alerts use).
create or replace function public.init_fire_outbox()
returns text language plpgsql security definer set search_path = public as $$
declare
  s     public.init_settings%rowtype;
  v_key text;
begin
  select * into s from public.init_settings;
  if not s.email_enabled then return 'Email is switched off in Admin → Email'; end if;
  if not exists (select 1 from public.init_outbox where sent_at is null and attempts < 5) then return 'Nothing to send'; end if;
  if s.functions_url is null then
    update public.init_outbox set last_error = 'init_settings.functions_url is not set' where sent_at is null;
    return 'functions_url is not set';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regproc('net.http_post') is null then
    return 'pg_net / vault not available';
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_key using s.function_key_secret;
  if v_key is null then
    update public.init_outbox set last_error = 'vault secret ' || s.function_key_secret || ' is missing' where sent_at is null;
    return 'vault secret missing';
  end if;
  execute $q$select net.http_post(url := $1, headers := $2, body := '{}'::jsonb, timeout_milliseconds := 30000)$q$
    using s.functions_url || '/init-email',
          jsonb_build_object('Authorization', 'Bearer ' || v_key, 'apikey', v_key, 'Content-Type', 'application/json');
  return 'Sending';
end;
$$;

-- Called by the Edge Function (service role only): take up to 50 unsent rows
create or replace function public.init_outbox_claim()
returns table (key text, kind text, recipients text[], subject text, payload jsonb)
language plpgsql security definer set search_path = public as $$
begin
  return query
    with c as (
      update public.init_outbox o set claimed_at = now(), attempts = o.attempts + 1
      where o.id in (select id from public.init_outbox
                     where sent_at is null and attempts < 5
                       and (claimed_at is null or claimed_at < now() - interval '5 minutes')
                     order by created_at limit 50
                     for update skip locked)
      returning o.key, o.kind, o.recipients, o.subject, o.payload
    )
    select * from c;
end;
$$;

create or replace function public.init_outbox_result(p_key text, p_error text)
returns void language sql security definer set search_path = public as $$
  update public.init_outbox set
    sent_at    = case when p_error is null then now() end,
    last_error = p_error,
    claimed_at = null
  where key = p_key;
$$;

-- Hourly (pg_cron): queue the digest / reminders on their day and hour, then send
create or replace function public.init_cron_tick()
returns text language plpgsql security definer set search_path = public as $$
declare
  s       public.init_settings%rowtype;
  v_local timestamp;
  v_dow   integer;
  v_hour  integer;
  v_out   text := '';
begin
  select * into s from public.init_settings;
  if not s.email_enabled then return 'email off'; end if;
  v_local := now() at time zone s.time_zone;
  v_dow := extract(dow from v_local);
  v_hour := extract(hour from v_local);
  perform set_config('init.actor', 'schedule', true);
  if s.digest_enabled and v_dow = s.digest_dow and v_hour >= s.digest_hour
     and coalesce(array_length(s.digest_recipients, 1), 0) > 0 then
    v_out := v_out || 'digest ' || public.init_queue_digest() || '; ';
  end if;
  if s.reminders_enabled and v_dow = s.reminder_dow and v_hour >= s.reminder_hour then
    v_out := v_out || 'reminders ' || public.init_queue_reminders() || '; ';
  end if;
  return v_out || public.init_fire_outbox();
end;
$$;

-- Service-only functions: the app must not call these
revoke execute on function public.init_outbox_claim(), public.init_outbox_result(text, text),
  public.init_cron_tick(), public.init_fire_outbox(), public.init_reminder_payload(uuid)
  from public, anon, authenticated;


-- ── ADMIN BUTTONS ────────────────────────────────────────────────────────────
create or replace function public.init_send_digest_now(p_week_start date default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  perform public.init_require_admin();
  perform public.init_queue_digest(p_week_start, true);
  return public.init_fire_outbox();
end;
$$;

create or replace function public.init_send_reminders_now()
returns text language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  perform public.init_require_admin();
  v_n := public.init_queue_reminders(true);
  if v_n = 0 then return 'Nobody has overdue or quiet tasks, so no reminders were queued'; end if;
  return v_n || ' reminder' || case when v_n = 1 then '' else 's' end || ' queued. ' || public.init_fire_outbox();
end;
$$;

-- Send one test email to the signed-in admin's person email (or p_to)
create or replace function public.init_send_test(p_to text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_to text;
begin
  perform public.init_require_admin();
  v_to := lower(coalesce(nullif(btrim(p_to), ''), (select email from public.init_people where user_id = auth.uid()),
                         auth.jwt() ->> 'email'));
  if v_to is null or v_to like '%@users.elementcontract.com' then
    raise exception 'Enter an address to send the test to';
  end if;
  insert into public.init_outbox (key, kind, recipients, subject, payload)
  values ('test:' || extract(epoch from clock_timestamp())::bigint, 'test', array[v_to],
          'Initiatives Tracker: test email', jsonb_build_object('app_url', (select app_url from public.init_settings)));
  return 'Test queued for ' || v_to || '. ' || public.init_fire_outbox();
end;
$$;

-- Save settings (admins) with validation of the recipient list
create or replace function public.init_update_settings(p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_rec text[];
begin
  perform public.init_require_admin();
  if p_patch ? 'digest_recipients' then
    select array_agg(lower(btrim(x))) into v_rec from jsonb_array_elements_text(p_patch -> 'digest_recipients') x where btrim(x) <> '';
    if exists (select 1 from unnest(coalesce(v_rec, '{}')) e where e !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
      raise exception 'One of the digest recipients isn''t an email address';
    end if;
  end if;
  update public.init_settings set
    stale_days        = coalesce((p_patch ->> 'stale_days')::int, stale_days),
    email_enabled     = coalesce((p_patch ->> 'email_enabled')::boolean, email_enabled),
    digest_enabled    = coalesce((p_patch ->> 'digest_enabled')::boolean, digest_enabled),
    digest_dow        = coalesce((p_patch ->> 'digest_dow')::int, digest_dow),
    digest_hour       = coalesce((p_patch ->> 'digest_hour')::int, digest_hour),
    digest_recipients = case when p_patch ? 'digest_recipients' then coalesce(v_rec, '{}') else digest_recipients end,
    reminders_enabled = coalesce((p_patch ->> 'reminders_enabled')::boolean, reminders_enabled),
    reminder_dow      = coalesce((p_patch ->> 'reminder_dow')::int, reminder_dow),
    reminder_hour     = coalesce((p_patch ->> 'reminder_hour')::int, reminder_hour),
    notify_assigned   = coalesce((p_patch ->> 'notify_assigned')::boolean, notify_assigned),
    app_url           = case when p_patch ? 'app_url' then nullif(btrim(p_patch ->> 'app_url'), '') else app_url end
  where id;
end;
$$;

revoke execute on function public.init_digest(date), public.init_queue_digest(date, boolean),
  public.init_queue_reminders(boolean), public.init_send_digest_now(date), public.init_send_reminders_now(),
  public.init_send_test(text), public.init_update_settings(jsonb)
  from anon;
-- Queueing is for the schedule and the admin buttons, not direct calls
revoke execute on function public.init_queue_digest(date, boolean), public.init_queue_reminders(boolean)
  from public, authenticated;


-- ============================================================
-- SCHEDULE
-- ============================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('init-email-tick', '5 * * * *', 'select public.init_cron_tick()');
  end if;
end $$;
