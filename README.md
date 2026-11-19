# Initiatives Tracker

Where Element's internal initiatives stand: who is on what, each project's health from its lead's
weekly check-in, what the leads need from Matt, and each person's workload. Matt gets a weekly digest
by email; everyone with open tasks gets a "Your week" email.

Runs on the same Supabase project as Stanley, Shipping, Maintenance and Remnant Rack, and shares
their logins. Same stack: Vite + React (plain JS), one `src/supabase.js` module, Cloudflare Worker
hosting. Design: Element green header, shaded summary tiles, a swatch color per project
(`src/index.css`). The plan and the reasoning behind it are in [docs/PLAN.md](docs/PLAN.md).

## Roles

| Role | Can |
|---|---|
| Initiatives Admin | everything: projects, tasks, people, roles, email settings, send now; **answer asks** for Matt and write the **digest note** |
| Member | update status / "waiting on" / notes on tasks assigned to them; on projects they **lead** (a project can have several leads), do the **weekly check-in**, add, edit, assign and delete tasks, and set the stage, summary, purpose and success measure |
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

**Not started · In progress · Blocked · Parked · Done**, used for both tasks and project stages
(Blocked = can't move until someone or something else acts; Parked = paused on purpose). A
project's stage is set by hand. "Moved this week" means a status change, a note, or a "waiting on"
since Monday (Pacific), taken from `init_activity`, which database triggers write on every change.

## Weekly check-ins and health

Each week a project's lead checks in once: **On track · At risk · Off track**, one sentence on
where it stands, and optionally **what they need from Matt**. Saving again that week replaces it.
A project's health on the board is its latest check-in from this week or last; older than that it
shows "No check-in". Admins (Matt, or Lindsay for Matt) answer asks on the project or the Digest
screen; the answer is signed ("Matt Hall", or "Lindsay for Matt Hall" when someone other than the
first digest recipient answers) and emailed to the project's leads. There is deliberately no
per-person "% updated" score: it measured typing, not progress.

Projects are grouped and filtered by **department** on the Projects screen and in the digest.
"Waiting on" can name a person from the people list, an outside party, or both.

## Email

| Email | When | To |
|---|---|---|
| Weekly digest | Mondays 7 AM (configurable) | digest recipients (Matt). Order: admin note, asks for Matt, three headline lines (moving / stuck / quiet), how many check-ins are in, projects by department with health, blocked, past target, candidates to park (no movement 3+ weeks), workload counts |
| Your week | Thursdays 9 AM (configurable) | everyone with open tasks or a check-in due: overdue / quiet tasks flagged first, then the rest; leads see which projects still need this week's check-in |
| Answered | when an admin answers an ask | the project's leads |
| You're on a task | when someone adds a person to a task in the app | that person |

Links in emails open the app at the right place: `#task/<id>`, `#checkin/<projectId>` (leads),
`#project/<id>`.

The database queues mail in `init_outbox` and `init_fire_outbox()` pokes the `init-email` Edge
Function, which sends through **Resend** and records each result. `pg_cron` job `init-email-tick`
runs hourly. Admins see the outbox and its errors under **Admin → Email**.

## Setup

### Database (done on Nov 6, 2026; for a fresh project run these in order)

1. `supabase/migrations/001_init_schema.sql`: tables, triggers, activity log, views, RLS
2. `supabase/migrations/002_init_access.sql`: access + action RPCs
3. `supabase/migrations/003_init_email.sql`: outbox, digest, reminders, schedule
4. `supabase/migrations/004_init_hardening.sql`: function permissions, search_path
5. `supabase/migrations/005_init_project_people.sql`: several leads per project, plus stakeholders
   (replaces `init_projects.lead_person`; existing leads carry over)
6. `supabase/migrations/006_init_department.sql`: a department per project (sets its color in the app)
7. `supabase/migrations/007_init_checkins.sql`: weekly check-ins, asks + answers, digest note,
   purpose / success measure, "waiting on" a person, the rewritten digest and "Your week" email
8. Optional: `supabase/seed/001_lindsay_tracker_oct30.sql` loads the six projects from Lindsay's
   tracker (already loaded on the live project).

The live project was migrated in steps (`init_001` … `init_005` in Supabase's migration list);
two small follow-ups were folded back into 001 and 003, so running 001–004 fresh gives the
same result.

`005` was applied to the live project on Nov 16, 2026 as `init_006_project_people`.
`006` was applied on Nov 17, 2026 as `init_007_department`.

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
