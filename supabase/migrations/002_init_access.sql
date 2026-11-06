-- ============================================================
-- Initiatives Tracker: access, user management and action RPCs
-- ============================================================
-- Run after 001_init_schema.sql. The app calls these with supabase.rpc(...).
-- SECURITY DEFINER functions check the caller's role themselves. SECURITY INVOKER ones
-- (init_set_assignees, init_reorder_tasks) run as the caller, so RLS and the table
-- triggers decide what's allowed.
-- ============================================================


-- ── ACCESS ───────────────────────────────────────────────────────────────────
create or replace function public.init_my_access()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'user_id',              u.id,
    'email',                u.email,
    'username',             p.username,
    'display_name',         coalesce(p.display_name, split_part(u.email, '@', 1)),
    'must_change_password', coalesce(p.must_change_password, false),
    'disabled',             coalesce(p.disabled, false),
    'init_role',            public.init_role(),
    'person_id',            pe.id,
    'person_name',          pe.display_name,
    'today',                public.init_today(),
    'week_start',           public.init_week_start(public.init_today())
  )
  from auth.users u
  left join public.app_profiles p on p.user_id = u.id
  left join public.init_people pe on pe.user_id = u.id and pe.active
  where u.id = auth.uid();
$$;

create or replace function public.init_log_signin()
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.init_role() is null then return; end if;
  perform public.init_log('signin', null, null, public.init_login_name(auth.uid()));
end;
$$;


-- ── LOGINS + ROLES (Initiatives Admin) ───────────────────────────────────────
-- Every login, its role here, and the person it's linked to. Logins themselves are created,
-- disabled and reset by Stanley Managers through Stanley's admin-users function.
create or replace function public.init_list_users()
returns table (user_id uuid, email text, username text, display_name text, role text,
               disabled boolean, last_sign_in_at timestamptz, person_id uuid, person_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.init_require_admin();
  return query
    select u.id, u.email::text, p.username, coalesce(p.display_name, split_part(u.email, '@', 1)),
           r.role, coalesce(p.disabled, false), u.last_sign_in_at, pe.id, pe.display_name
    from auth.users u
    left join public.app_profiles p    on p.user_id = u.id
    left join public.init_user_roles r on r.user_id = u.id
    left join public.init_people pe    on pe.user_id = u.id
    order by coalesce(p.display_name, u.email::text);
end;
$$;

-- role null → remove access
create or replace function public.init_set_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_old text;
begin
  perform public.init_require_admin();
  if p_user_id = auth.uid() and p_role is distinct from 'Initiatives Admin' then
    raise exception 'You cannot remove your own admin access';
  end if;
  if p_role is not null and p_role not in ('Initiatives Admin', 'Member', 'View Only') then
    raise exception 'Unknown role %', p_role;
  end if;
  select role into v_old from public.init_user_roles where user_id = p_user_id;
  if p_role is null then
    delete from public.init_user_roles where user_id = p_user_id;
  else
    insert into public.init_user_roles (user_id, email, role)
    select u.id, u.email, p_role from auth.users u where u.id = p_user_id
    on conflict (user_id) do update set role = excluded.role, email = excluded.email;
    if not found then raise exception 'Login not found'; end if;
  end if;
  perform public.init_log('role', null, null, public.init_login_name(p_user_id), v_old, p_role);
end;
$$;


-- ── TASK ACTIONS ─────────────────────────────────────────────────────────────

-- Add a note to a task: Admins, the project lead, and people assigned to the task
create or replace function public.init_add_note(p_task_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare
  t      public.init_tasks%rowtype;
  v_body text := btrim(coalesce(p_body, ''));
begin
  if v_body = '' then raise exception 'Write a note first'; end if;
  if length(v_body) > 2000 then raise exception 'Keep notes under 2,000 characters'; end if;
  select * into t from public.init_tasks where id = p_task_id;
  if not found then raise exception 'Task not found'; end if;
  if not (public.init_is_admin()
          or (public.init_can_write() and (public.init_leads_project(t.project_id) or public.init_assigned_to(t.id)))) then
    raise exception 'Only people on this task, its project lead and admins can add notes' using errcode = '42501';
  end if;
  update public.init_tasks set latest_note = v_body, latest_note_at = now(), updated_at = now(),
         last_modified_by = public.init_actor()
   where id = p_task_id;
  perform public.init_log('note', t.project_id, t.id, t.title, null, v_body);
end;
$$;

-- Replace a task's assignees in one go (runs as the caller: the assignee triggers check permission)
create or replace function public.init_set_assignees(p_task_id uuid, p_person_ids uuid[])
returns void language plpgsql security invoker set search_path = public as $$
begin
  delete from public.init_task_assignees
   where task_id = p_task_id and person_id <> all(coalesce(p_person_ids, '{}'));
  insert into public.init_task_assignees (task_id, person_id)
  select p_task_id, x from unnest(coalesce(p_person_ids, '{}')) x
  on conflict do nothing;
end;
$$;

-- Put a project's tasks in this order (runs as the caller)
create or replace function public.init_reorder_tasks(p_project_id uuid, p_task_ids uuid[])
returns void language plpgsql security invoker set search_path = public as $$
begin
  update public.init_tasks t set position = o.ord
    from unnest(p_task_ids) with ordinality as o(id, ord)
   where t.id = o.id and t.project_id = p_project_id and t.position is distinct from o.ord;
end;
$$;

-- People work can be assigned to (active people), for pickers
create or replace function public.init_assignable_people()
returns table (id uuid, display_name text, email text, has_login boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.init_role() is null then
    raise exception 'No access to the Initiatives Tracker' using errcode = '42501';
  end if;
  return query
    select pe.id, pe.display_name, pe.email, pe.user_id is not null
    from public.init_people pe where pe.active order by pe.display_name;
end;
$$;

-- Lock down: nothing here for anonymous visitors
revoke execute on function public.init_my_access(), public.init_log_signin(), public.init_list_users(),
  public.init_set_user_role(uuid, text), public.init_add_note(uuid, text), public.init_set_assignees(uuid, uuid[]),
  public.init_reorder_tasks(uuid, uuid[]), public.init_assignable_people()
  from anon;
