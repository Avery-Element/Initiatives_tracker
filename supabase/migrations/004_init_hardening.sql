-- ============================================================
-- Initiatives Tracker: function permissions + search_path hardening
-- ============================================================
-- Run after 003_init_email.sql. Fixes what Supabase's security advisor flagged:
--   1. Every new function is executable by PUBLIC by default, so "revoke ... from anon" alone
--      didn't stop anonymous callers. Lock everything down, then grant back only what the app
--      (authenticated) needs: the RPCs it calls, plus the helpers RLS policies and views use.
--   2. Pin search_path on the plain (non-SECURITY DEFINER) helpers.
-- ============================================================

-- 1. Nobody but the owner by default (init_ functions only; other apps' functions are untouched)
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'init\_%' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- What the app calls
grant execute on function
  public.init_my_access(), public.init_log_signin(), public.init_list_users(),
  public.init_set_user_role(uuid, text), public.init_add_note(uuid, text),
  public.init_set_assignees(uuid, uuid[]), public.init_reorder_tasks(uuid, uuid[]),
  public.init_assignable_people(), public.init_digest(date),
  public.init_send_digest_now(date), public.init_send_reminders_now(), public.init_send_test(text),
  public.init_update_settings(jsonb)
  to authenticated;

-- What RLS policies, views and table triggers evaluate as the signed-in user
grant execute on function
  public.init_role(), public.init_is_admin(), public.init_can_write(), public.init_my_person(),
  public.init_require_admin(), public.init_actor(), public.init_today(), public.init_week_start(date),
  public.init_day_start(date), public.init_leads_project(uuid), public.init_assigned_to(uuid),
  public.init_login_name(uuid)
  to authenticated;

-- The Edge Function (service role) claims and records outbox rows
grant execute on function public.init_outbox_claim(), public.init_outbox_result(text, text) to service_role;

-- Not granted to anyone: init_log (would let a caller write fake history), the queue / fire / cron
-- functions, init_reminder_payload, and the trigger functions (triggers don't need EXECUTE).

-- init_digest already refuses signed-in callers without a role; anon can no longer call it at all.

-- 2. search_path on the plain helpers
alter function public.init_actor()                   set search_path = public;
alter function public.init_today()                   set search_path = public;
alter function public.init_week_start(date)          set search_path = public;
alter function public.init_day_start(date)           set search_path = public;
alter function public.init_require_admin()           set search_path = public;
alter function public.init_touch()                   set search_path = public;
alter function public.init_projects_before_write()   set search_path = public;
alter function public.init_tasks_before_write()      set search_path = public;
alter function public.init_assignees_before_write()  set search_path = public;
