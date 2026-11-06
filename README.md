# Initiatives Tracker

Where Element's internal initiatives stand: who is on what, each project's stage and progress,
each person's workload, and how much moved forward this week. Matt gets a weekly digest by email;
people with stale tasks get a reminder.

Runs on the same Supabase project as Stanley, Shipping, Maintenance and Remnant Rack, and shares
their logins. Same stack: Vite + React (plain JS), one `src/supabase.js` module, Cloudflare Worker
hosting. Design: Element green header, shaded summary tiles, a swatch color per project
(`src/index.css`). The plan and the reasoning behind it are in [docs/PLAN.md](docs/PLAN.md).

## Roles

| Role | Can |
|---|---|
| Initiatives Admin | everything: projects, tasks, people, roles, email settings, send now |
| Member | update status / "waiting on" / notes on tasks assigned to them; on projects they **lead**, add, edit, assign and delete tasks and set the stage |
| View Only | read |

The database enforces all of this (RLS + triggers that limit which columns each role may change).

## People vs. logins

Work is assigned to **people** (`init_people`), not logins, because most people get tasks before
they have a login, and username logins have no mailbox. Each person has a real email for reminders
and, optionally, a linked login. To let someone update their own tasks:

1. A Stanley Manager creates their login (Stanley → Users), if they don't have one.
2. An Initiatives Admin opens **Admin → People + logins**, picks the login next to the person, and
   gives it a role (usually Member).

## Status vocabulary

**Not started · In progress · Blocked · Parked · Done**, used for both tasks and project stages.
A project's bar is the share of its tasks that are Done; its stage is set by hand. "Moved this
week" means a status change, a note, or a "waiting on" since Monday (Pacific), taken from
`init_activity`, which database triggers write on every change.

## Email

| Email | When | To |
|---|---|---|
| Weekly digest | Mondays 7 AM (configurable) | digest recipients (Matt) |
| Reminder | Thursdays 9 AM (configurable) | each person with an overdue task or one with no update in 7 days |
| You're on a task | when someone adds a person to a task in the app | that person |

The database queues mail in `init_outbox` and `init_fire_outbox()` pokes the `init-email` Edge
Function, which sends through **Resend** and records each result. `pg_cron` job `init-email-tick`
runs hourly. Admins see the outbox and its errors under **Admin → Email**.

## Setup

### Database (done on Nov 6, 2026; for a fresh project run these in order)

1. `supabase/migrations/001_init_schema.sql`: tables, triggers, activity log, views, RLS
2. `supabase/migrations/002_init_access.sql`: access + action RPCs
3. `supabase/migrations/003_init_email.sql`: outbox, digest, reminders, schedule
4. `supabase/migrations/004_init_hardening.sql`: function permissions, search_path
5. Optional: `supabase/seed/001_lindsay_tracker_oct30.sql` loads the six projects from Lindsay's
   tracker (already loaded on the live project).

The live project was migrated in steps (`init_001` … `init_005` in Supabase's migration list);
two small follow-ups were folded back into 001 and 003, so running 001–004 fresh gives the
same result.

### Email (to turn it on)

1. In Resend, add and verify the sending domain (the DNS records Resend gives you).
2. Supabase → Edge Functions → Secrets: `RESEND_API_KEY` (if Shipping hasn't set it already) and
   `INIT_EMAIL_FROM`, e.g. `Element Initiatives <initiatives@yourdomain.com>`. Optional:
   `INIT_REPLY_TO`.
3. In the app: Admin → Email → set **Link in emails** to the app's URL, tick **Send email**, then
   **Send a test**. Check the outbox row says Sent.

The function is deployed. To redeploy after changes:
`npx supabase functions deploy init-email --project-ref rxibmtzsnlwxhapktkzt`

### App

```
cp .env.example .env.local     # fill in the publishable key (same as the other apps)
npm install
npm run dev
```

Deploy (Cloudflare Worker, like the other apps): `npm run deploy`. In Cloudflare, set
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as **build** variables. Add the app's URL to
Supabase → Auth → URL Configuration so password-reset links work.

## Tests

```
npm test                 # database (PGlite) + email rendering
node tests/db/seed.test.mjs
```

`tests/db/initiatives.test.mjs` loads the migrations into an in-memory Postgres with Supabase's auth
stubbed and checks roles, RLS, the lead / assignee column rules, notes, activity, the board views,
the digest, reminders, the outbox and function permissions.

## Layout

```
supabase/migrations/          SQL, run in order
supabase/seed/                starting data
supabase/functions/init-email Edge Function (index.ts) + email templates (render.ts)
src/supabase.js               every database call
src/auth.jsx                  sign-in screens (same behaviour as the other Element apps)
src/App.jsx                   shell, summary tiles, tabs, permission helpers
src/views/                    Projects, task panel, People, Weekly digest, Admin
tests/                        database + email tests
```
