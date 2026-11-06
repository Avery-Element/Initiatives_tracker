# Initiatives Tracker: build plan

**Goal:** give Matt Hall one place to see who is working on which initiative, where each initiative
stands, each person's workload, and how much each person moved forward this week. The 12–14 people
doing the work update their own tasks in a couple of clicks.

**Scope:** internal initiatives only (12–24 at a time, each with a list of tasks). Not standing
responsibilities, not customer orders.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Database | Element's existing Supabase project, tables prefixed `init_` | Same logins as Stanley, Shipping, Maintenance and Remnant Rack. Nothing existing is touched. |
| Front end | Vite + React, Cloudflare Worker hosting | Same stack and deploy as the other Element apps |
| Look | "Bright" prototype: pale green header with an Element green rule, shaded summary tiles, one swatch color per project | Approved Nov 6 |
| Email | Resend, from a verified domain | Shipping already uses Resend, and the Google service account route would need domain-wide delegation |
| Admins | Avery, Matt, Lindsay | |

## People vs. logins

Most people on the current tracker don't have a login yet, and username-only accounts (Bryce,
Josh C, …) have no real mailbox. So the tracker keeps its own **people** list. Each person has a
name, a real email for reminders, and an optional link to a login. Tasks are assigned to people.
When a person gets a login, an admin links it and that person can then update their own tasks.

Outside parties (Riverstone, Vital AI, James, Project Coordinators) are free text on the task
("Also involved"), not people.

## Data model

```
init_settings        one row: time zone, email schedule, digest recipients, app URL
init_user_roles      login → role (Initiatives Admin / Member / View Only)
init_people          name, email, optional login link, active
init_projects        code, name, summary, lead (person), stage, priority, target date, color
init_tasks           project, position, title, status, due date, blocked on, latest note, also involved
init_task_assignees  task ↔ person (many-to-many)
init_activity        every status change, note, assignment, date change, project stage change
init_outbox          emails waiting to send (digest, reminders, assignment notices)
```

Stages and statuses share one vocabulary: **Not started · In progress · Blocked · Parked · Done**.
A project's progress bar is the share of its tasks that are Done. Its stage is set by hand.

**"Moved this week"** for a person means the distinct tasks assigned to them that had a status
change or a note this week (Monday to today, Pacific). The People screen shows it as a percentage
of their open tasks. This is what the old spreadsheets couldn't do: `init_activity` is written by
database triggers, so every change is captured without anyone filling in a log.

## Permissions

| Role | Can |
|---|---|
| Initiatives Admin | everything: projects, tasks, people, roles, settings, send emails now |
| Member | read everything. On tasks assigned to them: change status, set "blocked on", add notes. On projects they lead: add, edit, reorder and assign tasks; set the project stage. |
| View Only | read |

Enforced in the database (RLS plus triggers that limit which columns each role may change), so
the rules hold no matter what calls the API.

## Screens

1. **Projects:** summary tiles, then one row per project (swatch, name, stage, lead, team, "N
   updated this week", progress bar, target date). Click a row to expand it into its tasks. Change
   a task's status from its dropdown. Filters: All / Needs attention / My tasks / person.
2. **Task panel:** opens from a task. Status, blocked on, due date, assignees, also involved,
   and the activity timeline, with a box to add a note.
3. **People:** one card per person: % of open tasks moved this week, open / blocked / done,
   workload bar, the projects they're on.
4. **Weekly digest:** the email Matt gets on Monday, rendered live for any week.
5. **Admin:** projects (new, edit, archive), people and logins, roles, email settings with "Send
   digest now" and "Send reminders now", outbox status, and the activity log.

## Email

- **Weekly digest:** Monday 7 AM to the digest recipients (Matt by default). Covers the week that
  just ended: activity by project, what's blocked and on whom, projects past their target, work
  that's gone quiet, and workload by person.
- **Reminders:** Thursday 9 AM, one email per person, listing only their tasks that are overdue or
  have had no update in 7 days. Nobody with nothing stale gets an email.
- **Assignment notice:** when someone is added to a task (can be switched off).

The database decides what to send and queues it in `init_outbox`. The `init-email` Edge Function
sends the queue through Resend and records each result. `pg_cron` runs the check hourly, using
the same pattern as Shipping's alerts.

## Phases

1. Database: schema, roles, RLS, activity, views, RPCs, PGlite tests ← *this build*
2. App: all five screens ← *this build*
3. Email: outbox, schedule, Edge Function ← *this build*
4. Go live: apply migrations, load starting data, create missing logins, deploy to Cloudflare,
   verify the Resend domain, first digest to Matt
5. Later: Google Sheet export, per-person "my week" email, subtasks if people ask for them
