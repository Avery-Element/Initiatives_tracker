// Initiatives Tracker database tests: loads supabase/migrations into an in-memory Postgres
// (PGlite) with Supabase's auth schema stubbed, then checks roles, RLS, the column rules for
// leads and assignees, notes, the activity log, the board views, the digest and the outbox.
//
//   npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { setupSupabaseStubs, makeChecker, asUser } from './helpers.mjs';

const ROOT = new URL('../../', import.meta.url);
const MIGRATIONS = ['001_init_schema.sql', '002_init_access.sql', '003_init_email.sql', '004_init_hardening.sql'];

const { ok, done } = makeChecker();
const db = new PGlite();
await setupSupabaseStubs(db);
// Shared account profiles normally come from Stanley's 001_access_lockdown.sql
await db.exec(`create table public.app_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade, username text unique, display_name text,
  must_change_password boolean not null default false, disabled boolean not null default false,
  created_by text, created_at timestamptz default now(), updated_at timestamptz default now());`);
for (const f of MIGRATIONS) await db.exec(fs.readFileSync(new URL(`supabase/migrations/${f}`, ROOT), 'utf8'));
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

// ── Logins ───────────────────────────────────────────────────
const admin  = { id: '00000000-0000-0000-0000-000000000001', email: 'avery@elementcontract.com' };
const lisa   = { id: '00000000-0000-0000-0000-000000000002', email: 'lisa@elementcontract.com' };
const nick   = { id: '00000000-0000-0000-0000-000000000003', email: 'nick@users.elementcontract.com' };
const viewer = { id: '00000000-0000-0000-0000-000000000004', email: 'matt@elementcontract.com' };
const nobody = { id: '00000000-0000-0000-0000-000000000005', email: 'nobody@elementcontract.com' };
const disabledU = { id: '00000000-0000-0000-0000-000000000006', email: 'gone@elementcontract.com' };
for (const u of [admin, lisa, nick, viewer, nobody, disabledU]) {
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [u.id, u.email]);
  await db.query(`insert into public.app_profiles (user_id, display_name, disabled) values ($1, $2, $3)`,
    [u.id, u.email.split('@')[0], u === disabledU]);
}
await db.query(`insert into public.init_user_roles (user_id, email, role) values ($1, $2, 'Initiatives Admin')`, [admin.id, admin.email]);
await db.query(`insert into public.init_user_roles (user_id, email, role) values ($1, $2, 'Member')`, [disabledU.id, disabledU.email]);

console.log('Access + roles');
let r = await asUser(db, admin, `select public.init_my_access() a`);
ok(r.rows?.[0].a.init_role === 'Initiatives Admin' && r.rows[0].a.week_start, 'init_my_access returns role + week start');
r = await asUser(db, nobody, `select public.init_my_access() a`);
ok(r.rows?.[0].a.init_role === null, 'no role → init_role null');
r = await asUser(db, disabledU, `select public.init_role() r`);
ok(r.rows?.[0].r === null, 'disabled account has no role even with a role row');
for (const [u, role] of [[lisa, 'Member'], [nick, 'Member'], [viewer, 'View Only']]) {
  r = await asUser(db, admin, `select public.init_set_user_role($1, $2)`, [u.id, role]);
  ok(!r.error, `admin assigns ${role} to ${u.email}`, r.error);
}
r = await asUser(db, lisa, `select public.init_set_user_role($1, 'Initiatives Admin')`, [lisa.id]);
ok(r.error?.includes('Only Initiatives Admins'), 'member cannot change roles');
r = await asUser(db, admin, `select public.init_set_user_role($1, 'Member')`, [admin.id]);
ok(r.error?.includes('own admin'), 'admin cannot demote self');
r = await asUser(db, admin, `select public.init_set_user_role($1, 'Boss')`, [lisa.id]);
ok(r.error?.includes('Unknown role'), 'unknown role rejected');
r = await asUser(db, admin, `select count(*)::int n from public.init_list_users()`);
ok(r.rows?.[0].n === 6, 'init_list_users lists every login');
r = await asUser(db, nobody, `select count(*)::int n from public.init_people`);
ok(r.rows?.[0].n === 0, 'no role → RLS hides everything');
r = await asUser(db, admin, `select public.init_log_signin()`);
ok(!r.error && (await one(`select count(*)::int n from init_activity where kind = 'signin'`)).n === 1, 'sign-in logged');

// ── People ───────────────────────────────────────────────────
console.log('\nPeople');
r = await asUser(db, lisa, `insert into public.init_people (display_name) values ('Sneaky')`);
ok(r.error, 'member cannot add people');
const addPerson = async (name, email, userId) =>
  (await asUser(db, admin, `insert into public.init_people (display_name, email, user_id) values ($1, $2, $3) returning id`, [name, email, userId])).rows?.[0]?.id;
const pLisa = await addPerson('Lisa', 'lisa@elementcontract.com', lisa.id);
const pNick = await addPerson('Nick', 'nick.real@elementcontract.com', nick.id);
const pOuri = await addPerson('Ouri', 'ouri@elementcontract.com', null);
const pAvery = await addPerson('Avery', 'avery@elementcontract.com', admin.id);
ok(pLisa && pNick && pOuri && pAvery, 'admin adds people (with and without logins)');
r = await asUser(db, admin, `insert into public.init_people (display_name) values ('lisa')`);
ok(r.error?.toLowerCase().includes('unique'), 'duplicate active name (case-insensitive) rejected');
r = await asUser(db, admin, `insert into public.init_people (display_name, email) values ('Bad', 'not-an-email')`);
ok(r.error, 'bad email rejected');
r = await asUser(db, lisa, `select public.init_my_access() a`);
ok(r.rows?.[0].a.person_id === pLisa, 'my_access returns the linked person');
r = await asUser(db, viewer, `select count(*)::int n from public.init_assignable_people()`);
ok(r.rows?.[0].n === 4, 'anyone with a role can list assignable people');

// ── Projects ─────────────────────────────────────────────────
console.log('\nProjects');
r = await asUser(db, lisa, `insert into public.init_projects (code, name) values ('NOPE', 'Nope')`);
ok(r.error, 'member cannot create projects');
r = await asUser(db, admin, `insert into public.init_projects (code, name, lead_person, stage, target_date, color)
  values ('npi-loft', 'Loft Chair launch', $1, 'In progress', public.init_today() - 3, '#F0644E') returning id, code`, [pLisa]);
ok(!r.error && r.rows[0].code === 'NPI-LOFT', 'admin creates project; code upper-cased', r.error);
const loft = r.rows[0].id;
r = await asUser(db, admin, `insert into public.init_projects (code, name, lead_person) values ('WMS-01', 'Warehouse tool', $1) returning id`, [pNick]);
const wms = r.rows[0].id;
r = await asUser(db, admin, `insert into public.init_projects (code, name) values ('bad code!', 'x')`);
ok(r.error, 'invalid code rejected');
r = await asUser(db, lisa, `update public.init_projects set stage = 'Blocked', summary = 'Waiting on Riverstone' where id = $1`, [loft]);
ok(!r.error, 'lead changes stage + summary', r.error);
r = await asUser(db, lisa, `update public.init_projects set name = 'Renamed' where id = $1`, [loft]);
ok(r.error?.includes('Project leads can change'), 'lead cannot rename the project');
r = await asUser(db, nick, `update public.init_projects set stage = 'Done' where id = $1`, [loft]);
ok(r.error || r.affected === 0, 'non-lead member cannot change another project');
let a = await one(`select * from init_activity where kind = 'stage' and project_id = $1`, [loft]);
ok(a?.old_value === 'In progress' && a.new_value === 'Blocked' && a.actor === lisa.email, 'stage change logged with actor');

// ── Tasks ────────────────────────────────────────────────────
console.log('\nTasks');
r = await asUser(db, nick, `insert into public.init_tasks (project_id, title) values ($1, 'Not my project')`, [loft]);
ok(r.error?.includes('project lead can add'), 'non-lead member cannot add tasks');
const addTask = async (user, title, extra = {}) => {
  const res = await asUser(db, user, `insert into public.init_tasks (project_id, title, due_date, status) values ($1, $2, $3, coalesce($4, 'Not started')) returning id, position`,
    [extra.project ?? loft, title, extra.due ?? null, extra.status ?? null]);
  return res;
};
r = await addTask(lisa, 'Get renderings from James', { due: '2026-09-30' });
ok(!r.error && r.rows[0].position === 1, 'lead adds task; position assigned', r.error);
const tRender = r.rows[0].id;
r = await addTask(lisa, 'Add new chair into CET/2020');
ok(r.rows?.[0].position === 2, 'next task gets the next position');
const tCet = r.rows[0].id;
r = await addTask(admin, 'Establish stocking levels', { status: 'Done' });
const tStock = r.rows[0].id;
ok((await one(`select completed_at from init_tasks where id = $1`, [tStock])).completed_at, 'task created Done gets completed_at');
r = await asUser(db, viewer, `insert into public.init_tasks (project_id, title) values ($1, 'x')`, [loft]);
ok(r.error, 'View Only cannot add tasks');

r = await asUser(db, lisa, `select public.init_set_assignees($1, $2::uuid[])`, [tRender, [pNick, pLisa]]);
ok(!r.error, 'lead assigns people', r.error);
r = await asUser(db, lisa, `select public.init_set_assignees($1, $2::uuid[])`, [tCet, [pNick]]);
r = await asUser(db, nick, `select public.init_set_assignees($1, $2::uuid[])`, [tCet, [pNick, pOuri]]);
ok(r.error?.includes('assign people'), 'assignee cannot change assignees');
ok((await one(`select count(*)::int n from init_outbox where kind = 'assigned'`)).n === 2,
   'assignment notices queued for Nick on both tasks, none for Lisa assigning herself');
r = await asUser(db, admin, `insert into public.init_task_assignees (task_id, person_id) values ($1, $2)`, [tStock, pOuri]);
ok((await one(`select count(*)::int n from init_outbox where kind = 'assigned'`)).n === 3, 'admin assigning a person without a login still emails them');

r = await asUser(db, nick, `update public.init_tasks set status = 'In progress' where id = $1`, [tRender]);
ok(!r.error, 'assignee changes status', r.error);
r = await asUser(db, nick, `update public.init_tasks set status = 'Blocked', blocked_on = 'Updated models from suppliers' where id = $1`, [tRender]);
ok(!r.error, 'assignee marks blocked with a reason', r.error);
r = await asUser(db, nick, `update public.init_tasks set title = 'Hijacked' where id = $1`, [tRender]);
ok(r.error?.includes('status and what'), 'assignee cannot rename the task');
r = await asUser(db, nick, `update public.init_tasks set due_date = '2027-01-01' where id = $1`, [tRender]);
ok(r.error, 'assignee cannot move the due date');
r = await asUser(db, admin, `insert into public.init_tasks (project_id, title) values ($1, 'Unassigned task') returning id`, [loft]);
const tFree = r.rows[0].id;
r = await asUser(db, nick, `update public.init_tasks set status = 'Done' where id = $1`, [tFree]);
ok(r.error?.includes('assigned to you'), 'member cannot update a task they are not on');
r = await asUser(db, viewer, `update public.init_tasks set status = 'Done' where id = $1`, [tRender]);
ok(r.error || r.affected === 0, 'View Only cannot update tasks');
r = await asUser(db, lisa, `update public.init_tasks set due_date = '2026-10-15', title = 'Get renderings (final)' where id = $1`, [tRender]);
ok(!r.error, 'lead edits title and due date', r.error);
r = await asUser(db, nick, `update public.init_tasks set status = 'In progress' where id = $1`, [tRender]);
let t = await one(`select status, blocked_on from init_tasks where id = $1`, [tRender]);
ok(t.status === 'In progress' && t.blocked_on === null, 'unblocking clears "blocked on"');
r = await asUser(db, nick, `update public.init_tasks set status = 'Blocked', blocked_on = 'Riverstone' where id = $1`, [tRender]);

// Notes
r = await asUser(db, nick, `select public.init_add_note($1, '  Sent final notes to James  ')`, [tRender]);
ok(!r.error, 'assignee adds a note', r.error);
t = await one(`select latest_note, latest_note_at from init_tasks where id = $1`, [tRender]);
ok(t.latest_note === 'Sent final notes to James' && t.latest_note_at, 'note trimmed and shown on the task');
r = await asUser(db, nick, `select public.init_add_note($1, 'nope')`, [tFree]);
ok(r.error?.includes('Only people on this task'), 'member cannot note a task they are not on');
r = await asUser(db, viewer, `select public.init_add_note($1, 'nope')`, [tRender]);
ok(r.error, 'View Only cannot add notes');
r = await asUser(db, nick, `select public.init_add_note($1, '   ')`, [tRender]);
ok(r.error?.includes('Write a note'), 'empty note rejected');
r = await asUser(db, admin, `insert into public.init_activity (kind) values ('note')`);
ok(r.error, 'activity cannot be written directly');

// Activity
const kinds = (await db.query(`select kind from init_activity where task_id = $1 order by id`, [tRender])).rows.map(x => x.kind);
ok(['task_created', 'assigned', 'status', 'blocked_on', 'due', 'title', 'note'].every(k => kinds.includes(k)), 'activity records create, assign, status, blocked on, due, title, note', kinds);

// Reorder
r = await asUser(db, lisa, `select public.init_reorder_tasks($1, $2::uuid[])`, [loft, [tCet, tRender, tStock, tFree]]);
ok(!r.error && (await one(`select position from init_tasks where id = $1`, [tCet])).position === 1, 'lead reorders tasks', r.error);
r = await asUser(db, nick, `select public.init_reorder_tasks($1, $2::uuid[])`, [loft, [tRender, tCet]]);
ok(r.error, 'non-lead cannot reorder');

// ── Views ────────────────────────────────────────────────────
console.log('\nBoards');
let b = (await asUser(db, viewer, `select * from public.init_project_board where id = $1`, [loft])).rows[0];
ok(b.task_count === 4 && b.done_count === 1 && b.blocked_count === 1 && b.pct_done === 25, 'project board counts and % done', b);
ok(b.moved_this_week === 1 && b.past_target === true && b.lead_name === 'Lisa', 'project board: moved this week, past target, lead');
let tb = (await asUser(db, viewer, `select * from public.init_task_board where id = $1`, [tRender])).rows[0];
ok(tb.assignee_names.join() === 'Lisa,Nick' && tb.overdue && tb.moved_this_week && tb.project_code === 'NPI-LOFT', 'task board: assignees, overdue, moved', tb);
let pb = (await asUser(db, viewer, `select * from public.init_people_board where display_name = 'Nick'`)).rows[0];
ok(pb.open_count === 2 && pb.blocked_count === 1 && pb.moved_this_week === 1 && pb.overdue_count === 1, 'people board: Nick open / blocked / moved / overdue', pb);
pb = (await asUser(db, viewer, `select * from public.init_people_board where display_name = 'Lisa'`)).rows[0];
ok(pb.lead_of.join() === 'NPI-LOFT' && pb.role === 'Member', 'people board: lead_of + role');

// ── Digest + email ───────────────────────────────────────────
console.log('\nDigest + email');
r = await asUser(db, viewer, `select public.init_digest() d`);
let d = r.rows?.[0].d;
ok(d && d.activity[0].code === 'NPI-LOFT' && d.activity[0].moved === 1, 'digest: activity by project', d?.activity);
ok(d.blocked.length === 1 && d.blocked[0].blocked_on === 'Riverstone', 'digest: blocked with reason');
ok(d.past_target.length === 1 && d.idle.some(p => p.code === 'WMS-01'), 'digest: past target + idle projects');
ok(d.people.find(p => p.name === 'Nick')?.pct === 50, 'digest: Nick moved 1 of 2 open = 50%');
r = await asUser(db, nobody, `select public.init_digest() d`);
ok(r.error, 'no role → no digest');

r = await asUser(db, admin, `select public.init_send_digest_now()`);
ok(r.error?.includes('digest recipient'), 'digest needs recipients');
r = await asUser(db, admin, `select public.init_update_settings('{"digest_recipients": ["Matt@ElementContract.com", " "], "app_url": "https://initiatives.example.com"}')`);
ok(!r.error && (await one(`select digest_recipients from init_settings`)).digest_recipients.join() === 'matt@elementcontract.com', 'settings: recipients cleaned', r.error);
r = await asUser(db, admin, `select public.init_update_settings('{"digest_recipients": ["nope"]}')`);
ok(r.error?.includes("isn't an email"), 'settings: bad recipient rejected');
r = await asUser(db, lisa, `select public.init_update_settings('{"stale_days": 3}')`);
ok(r.error, 'member cannot change settings');
r = await asUser(db, lisa, `select public.init_queue_digest()`);
ok(r.error, 'queueing is not callable from the app');
r = await asUser(db, admin, `select public.init_send_digest_now() m`);
ok(!r.error, 'admin sends digest now', r.error);
await db.query(`select public.init_queue_digest()`);
await db.query(`select public.init_queue_digest()`);
ok((await one(`select count(*)::int n from init_outbox where kind = 'digest'`)).n === 2, 'scheduled digest queues once per week (plus the forced one)');

// Reminders: make Ouri's task quiet; Nick's blocked task moved today so only his overdue one counts
await db.query(`update init_activity set at = now() - interval '10 days' where task_id = $1`, [tStock]);
await db.query(`update init_tasks set status = 'In progress' where id = $1`, [tStock]);   // superuser: no trigger checks
await db.query(`update init_activity set at = now() - interval '10 days' where task_id = $1`, [tStock]);
const n = (await one(`select public.init_queue_reminders() n`)).n;
const rem = (await db.query(`select o.recipients, o.payload from init_outbox o where kind = 'reminder' order by recipients`)).rows;
ok(n === 3 && rem.length === 3, 'reminders queued for Lisa + Nick (overdue renderings) and Ouri (quiet)', rem.map(x => x.recipients));
ok(rem.find(x => x.recipients[0] === 'ouri@elementcontract.com')?.payload.tasks[0].days_quiet >= 10, 'reminder payload has days quiet');
ok((await one(`select public.init_queue_reminders() n`)).n === 0, 'reminders queue once per person per week');
r = await asUser(db, admin, `select public.init_send_reminders_now() m`);
ok(!r.error && r.rows[0].m.includes('queued'), 'admin sends reminders now', r.error);

// Outbox plumbing (as the Edge Function's service role would)
r = await asUser(db, admin, `select * from public.init_outbox_claim()`);
ok(r.error, 'app cannot claim outbox rows');
const claimed = (await db.query(`select * from public.init_outbox_claim()`)).rows;
ok(claimed.length > 0 && claimed.every(c => c.recipients.length && c.subject && c.payload), 'claim returns rendered-ready rows');
ok((await db.query(`select * from public.init_outbox_claim()`)).rows.length === 0, 'claimed rows are not handed out twice');
await db.query(`select public.init_outbox_result($1, null)`, [claimed[0].key]);
await db.query(`select public.init_outbox_result($1, 'Resend 422: bad from')`, [claimed[1].key]);
const sent = await one(`select count(*) filter (where sent_at is not null)::int s, count(*) filter (where last_error is not null)::int e from init_outbox`);
ok(sent.s === 1 && sent.e >= 1, 'results recorded: sent + error');
r = await asUser(db, admin, `select count(*)::int n from init_outbox`);
ok(r.rows?.[0].n > 0, 'admins can read the outbox');
r = await asUser(db, lisa, `select count(*)::int n from init_outbox`);
ok(r.rows?.[0].n === 0, 'members cannot read the outbox');
ok((await one(`select public.init_cron_tick() m`)).m.includes('functions_url'), 'cron tick runs; reports missing functions_url');

// ── Function permissions (004) ─────────────────────────────────
console.log('\nFunction permissions');
r = await asUser(db, null, `select public.init_digest() d`);
ok(r.error?.includes('permission denied'), 'anon cannot call init_digest', r.error);
r = await asUser(db, null, `select public.init_my_access() a`);
ok(r.error?.includes('permission denied'), 'anon cannot call init_my_access');
r = await asUser(db, lisa, `select public.init_log('note', null, null, 'fake', null, 'fake history')`);
ok(r.error?.includes('permission denied'), 'signed-in users cannot write activity directly', r.error);
r = await asUser(db, admin, `select public.init_fire_outbox()`);
ok(r.error?.includes('permission denied'), 'app cannot poke the sender directly');
r = await asUser(db, lisa, `update public.init_tasks set status = 'Done' where id = $1`, [tCet]);
ok(!r.error, 'triggers still run for a lead after the lockdown', r.error);

// ── Deleting ─────────────────────────────────────────────────
console.log('\nDeleting');
r = await asUser(db, nick, `delete from public.init_tasks where id = $1`, [tRender]);
ok(r.affected === 0, 'assignee cannot delete a task');
r = await asUser(db, lisa, `delete from public.init_tasks where id = $1`, [tRender]);
ok(!r.error && r.affected === 1, 'lead deletes a task that has assignees', r.error);
ok((await one(`select count(*)::int n from init_activity where kind = 'task_deleted'`)).n === 1, 'deletion logged');
r = await asUser(db, admin, `update public.init_projects set archived_at = now() where id = $1`, [wms]);
ok(!r.error && (await one(`select count(*)::int n from init_activity where kind = 'archived'`)).n === 1, 'admin archives a project');

done();
