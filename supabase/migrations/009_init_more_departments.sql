-- Initiatives Tracker 009: three more departments — Accounting, Operations, Upholstery.
-- Widens the check on init_projects.department (from 006) and adds them to the sort order
-- in init_dept_rank (from 007), after Production. Keep both in step with DEPARTMENTS in src/lib.js.

-- The check was declared inline in 006, so look up its generated name rather than guess it.
do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.init_projects'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%department%'
  loop
    execute format('alter table public.init_projects drop constraint %I', c);
  end loop;
end $$;

alter table public.init_projects
  add constraint init_projects_department_check
  check (department in ('Design', 'Office', 'General', 'Warehouse/Shipping', 'Production',
                        'Accounting', 'Operations', 'Upholstery'));

create or replace function public.init_dept_rank(p_department text)
returns integer language sql immutable set search_path = public as $$
  select case p_department when 'Design' then 1 when 'Office' then 2 when 'General' then 3
                           when 'Warehouse/Shipping' then 4 when 'Production' then 5
                           when 'Accounting' then 6 when 'Operations' then 7 when 'Upholstery' then 8
                           else 9 end;
$$;

-- create or replace keeps the grants from 007, but restate them so this file stands alone.
revoke execute on function public.init_dept_rank(text) from public, anon, authenticated;
