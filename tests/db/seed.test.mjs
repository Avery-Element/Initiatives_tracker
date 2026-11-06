// Loads the migrations plus supabase/seed/001_lindsay_tracker_oct30.sql into PGlite and checks the result.
//   node tests/db/seed.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { setupSupabaseStubs, makeChecker } from './helpers.mjs';
const ROOT = new URL('../../', import.meta.url);
const { ok, done } = makeChecker();
const db = new PGlite();
await setupSupabaseStubs(db);
await db.exec(`create table public.app_profiles (user_id uuid primary key references auth.users(id), username text, display_name text,
  must_change_password boolean not null default false, disabled boolean not null default false, created_by text,
  created_at timestamptz default now(), updated_at timestamptz default now());`);
for (const f of ['001_init_schema.sql', '002_init_access.sql', '003_init_email.sql', '004_init_hardening.sql'])
  await db.exec(fs.readFileSync(new URL(`supabase/migrations/${f}`, ROOT), 'utf8'));
await db.exec(`insert into auth.users (id, email) values (gen_random_uuid(), 'avery@elementcontract.com'), (gen_random_uuid(), 'matt@elementcontract.com'),
  (gen_random_uuid(), 'bryce@users.elementcontract.com')`);
const seed = fs.readFileSync(new URL('supabase/seed/001_lindsay_tracker_oct30.sql', ROOT), 'utf8');
await db.exec(seed);
await db.exec(seed);   // re-running adds nothing
const q = async (s) => (await db.query(s)).rows;
const c = (await q(`select (select count(*)::int from init_projects) p, (select count(*)::int from init_tasks) t,
  (select count(*)::int from init_people) pe, (select count(*)::int from init_task_assignees) a, (select count(*)::int from init_outbox) o`))[0];
ok(c.p === 6 && c.t === 93, `6 projects, 93 tasks (got ${c.p}, ${c.t})`);
ok(c.pe === 18 && c.a > 100, `18 people, assignments made (got ${c.pe}, ${c.a})`);
ok(c.o === 0, 'no emails queued by the import');
const linked = await q(`select display_name, email from init_people where user_id is not null order by 1`);
ok(linked.map(x => x.display_name).join() === 'Avery,Bryce,Matt Hall', 'links logins that exist', linked);
ok(linked.find(x => x.display_name === 'Bryce').email === null, 'username login gets no reminder email');
const loft = (await q(`select * from init_project_board where code = 'NPI-LOFT'`))[0];
ok(loft.done_count === 6 && loft.task_count === 23 && loft.moved_this_week === 0, 'Loft: 6 of 23 done, no fake "moved this week"', loft);
const tb = (await q(`select count(*) filter (where moved_this_week)::int m from init_task_board`))[0];
ok(tb.m === 0, 'imported tasks are not "updated this week"');
const pb = (await q(`select sum(done_this_week)::int d from init_people_board`))[0];
ok(pb.d === 0, 'imported Done tasks are not "done this week"');
const t = (await q(`select * from init_task_board where project_code = 'NPI-LOFT' and position = 8`))[0];
ok(t.title === 'Add new chair into CET/2020' && t.assignee_names.join() === 'Aiden,Lisa' && t.latest_note?.startsWith('Ready for launch'), 'task 8: title, people, note', t);
const pn = (await q(`select others from init_tasks t join init_projects p on p.id = t.project_id where p.code = 'POA-01' and position = 1`))[0];
ok(pn.others === 'Paul (Vital AI)', 'outside parties land in "also involved"');
done();
