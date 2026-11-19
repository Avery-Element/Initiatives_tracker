// Email rendering tests for supabase/functions/init-email/render.ts (pure functions, no network).
//   npm run test:email
// Set WRITE_SAMPLES=1 to also write tests/functions/samples/*.html for a visual check.
import fs from 'node:fs';
import { render, esc, fmtDate } from '../../supabase/functions/init-email/render.ts';

let pass = 0, fail = 0;
const ok = (c: unknown, msg: string) => { if (c) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } };

const APP = 'https://initiatives.example.com';
const digest = {
  week_start: '2026-10-26', week_end: '2026-11-01', as_of: '2026-11-01', app_url: APP, stale_days: 7,
  note: 'Raise the Loft date at Monday\'s meeting <please>.',
  totals: { projects: 6, tasks: 93, done: 20, done_week: 3, moved: 19, blocked: 7, overdue: 11 },
  asks: [
    { checkin_id: 'c1', project_id: 'p-loft', code: 'NPI-LOFT', name: 'Loft Chair launch', color: '#F0644E', lead: 'Lisa, Nick',
      health: 'Off track', ask: 'Approve paying James for a rush', week_start: '2026-10-26', days_open: 3, answer: null },
    { checkin_id: 'c2', project_id: 'p-wms', code: 'WMS-01', name: 'Warehouse management tool', color: '#C2457E', lead: 'Mat P.',
      health: 'At risk', ask: 'Pick a vendor', week_start: '2026-10-19', days_open: 10, answer: 'Go with Vital AI', answered_by: 'Lindsay for Matt Hall' },
  ],
  headline: { on_track: 3, at_risk: 1, off_track: 1, no_checkin: 1, moving: ['Loft Chair launch', 'Kono Chair launch'],
              quiet: ['Production order automation'], blocked_tasks: 7, blocked_projects: 2 },
  data_quality: { checkins_in: 4, checkins_expected: 6, missing: [{ name: 'Kono Chair launch' }, { name: 'Production order automation' }],
                  open_tasks: 70, open_touched: 43, pct_open_touched: 61, not_heard_from: ['Josh'] },
  projects: [
    { project_id: 'p-loft', code: 'NPI-LOFT', name: 'Loft Chair launch', color: '#F0644E', department: 'Design', stage: 'In progress',
      lead: 'Lisa', health: 'Off track', checkin_current: true, summary: 'Renderings two weeks late', target_date: '2026-10-23', days_late: 9, done: 6, total: 23 },
    { project_id: 'p-kono', code: 'NPI-KONO', name: 'Kono Chair launch', color: '#F2A93B', department: 'Design', stage: 'In progress',
      lead: 'Lisa', health: 'On track', checkin_current: false, summary: 'Samples in', target_date: '2026-12-01', days_late: null, done: 2, total: 9 },
    { project_id: 'p-poa', code: 'POA-01', name: 'Production order automation', color: '#7A4FD0', department: 'Production', stage: 'In progress',
      lead: 'Nick', health: null, checkin_current: false, summary: null, target_date: null, days_late: null, done: 0, total: 3 },
  ],
  blocked: [{ task_id: 't-r', code: 'NPI-KONO', project: 'Kono Chair launch', color: '#F2A93B', title: 'Get renderings from James',
              blocked_on: 'Updated models', blocked_on_person: 'Lisa', waiting_on: 'Lisa — Updated models', who: ['Nick'], since: '2026-10-29' }],
  past_target: [{ code: 'NPI-LOFT', name: 'Loft Chair launch', color: '#F0644E', target_date: '2026-10-23', open: 17, total: 23, days_late: 9 }],
  quiet: [],
  park_candidates: [{ project_id: 'p-poa', code: 'POA-01', name: 'Production order automation', color: '#7A4FD0', stage: 'In progress', lead: 'Nick', weeks_quiet: 4 }],
  people: [{ name: 'Lisa', open: 30, blocked: 5, done_week: 2, last_update: '2026-10-31' }, { name: 'Josh', open: 9, blocked: 0, done_week: 0, last_update: null }],
};

console.log('Digest');
let r = render('digest', digest);
ok(r.html.includes('Week of Oct 26 – Nov 1') && r.html.includes('3 on track · 1 at risk · 1 off track'), 'title, week range and health tally');
ok(r.html.includes('Raise the Loft date') && r.html.includes('&lt;please&gt;'), 'admin note at the top, escaped');
ok(r.html.indexOf('Raise the Loft') < r.html.indexOf('Asks for you (1)') && r.html.indexOf('Asks for you') < r.html.indexOf('This week'), 'note, then asks, then headline');
ok(r.html.includes('Approve paying James for a rush') && r.html.includes(`href="${APP}/#project/p-loft"`) && r.html.includes("open 3 days"), 'open ask links to answer it');
ok(r.html.includes('Answered by Lindsay for Matt Hall: </span>Go with Vital AI'), 'answered ask shows who answered');
ok(r.html.includes('leads Lisa, Nick'), 'several leads');
ok(r.html.includes('2 projects: Loft Chair launch, Kono Chair launch') && r.html.includes('7 blocked tasks across 2 projects'), 'three-line headline');
ok(r.html.includes('4 of 6 check-ins in (missing: Kono Chair launch, Production order automation)') && r.html.includes('61% of open tasks updated') && r.html.includes('not heard from in 2 weeks: Josh'), 'data-quality line');
ok(r.html.indexOf('>Design<') < r.html.indexOf('>Production<') && r.html.includes('Off track') && r.html.includes('No check-in'), 'projects grouped by department with health');
ok(r.html.includes('(last week)') && r.html.includes('9 days past target') && r.html.includes('6 of 23 tasks done'), 'stale health flagged, lateness, task count');
ok(r.html.includes(`href="${APP}/#project/p-loft"`), 'project names link to the project');
ok(r.html.includes('Waiting on Lisa — Updated models') && r.html.includes(`#task/t-r`), 'blocked shows who it is waiting on and links the task');
ok(r.html.includes('Too much on the go?') && r.html.includes('quiet 4 weeks'), 'candidates to park');
ok(r.html.includes('Last update') && r.html.includes('Oct 31') && !r.html.includes('%</td>') && !r.html.includes('Moved this week'), 'workload is counts only');
ok(r.text.includes('ASKS FOR YOU') && r.text.includes('Lisa: 30 open') && r.text.includes('[Off track] Loft Chair launch'), 'plain-text version');
let empty = render('digest', { ...digest, note: null, asks: [], projects: [], blocked: [], past_target: [], park_candidates: [], people: [], app_url: null,
  headline: { moving: [], quiet: [] }, data_quality: {} });
ok(empty.html.includes('Nothing asked of you this week.') && empty.html.includes('nothing moved') && !empty.html.includes('Open the tracker'), 'quiet week renders; no button without app_url');

console.log('\nYour week');
const week = { name: 'Ouri Ben', app_url: APP, stale_days: 7, open: 3, needs_update: 2, tasks: [
  { task_id: 't1', code: 'NPI-LOFT', project: 'Loft Chair launch', color: '#F0644E', title: 'Law labels', status: 'In progress', due_date: null, overdue: false, needs_update: true, blocked_on: null, last_at: '2026-10-20', days_quiet: 12 },
  { task_id: 't2', code: 'NPI-KONO', project: 'Kono Chair launch', color: '#F2A93B', title: 'Sample swatches', status: 'Blocked', due_date: '2026-10-15', overdue: true, needs_update: true, blocked_on: 'Supplier', last_at: null, days_quiet: 20 },
  { task_id: 't3', code: 'NPI-KONO', project: 'Kono Chair launch', color: '#F2A93B', title: 'Price list', status: 'In progress', due_date: '2026-12-01', overdue: false, needs_update: false, blocked_on: null, last_at: '2026-11-17', days_quiet: 1 },
], checkins_due: [{ project_id: 'p-loft', code: 'NPI-LOFT', name: 'Loft Chair launch', color: '#F0644E', last_health: 'At risk', last_summary: 'Renderings late' }] };
r = render('reminder', week);
ok(r.html.includes('Hi Ouri,') && r.html.includes('2 tasks need an update, and one project needs its weekly check-in'), 'greets by first name, says what is needed');
ok(r.html.includes('Your initiatives this week') && r.html.includes('3 open tasks · 1 check-in due'), 'title is not a reprimand');
ok(r.html.indexOf('Check-in due') < r.html.indexOf('Needs an update') && r.html.includes(`#checkin/p-loft`) && r.html.includes('Renderings late'), 'check-ins due first, with last time’s health');
ok(r.html.includes('no update in 12 days') && r.html.includes('due Oct 15') && r.html.includes('waiting on Supplier'), 'says why each task needs an update');
ok(r.html.includes('The rest of your tasks') && r.html.includes('Price list') && r.html.includes(`#task/t3`), 'lists tasks that are not behind, linked');
ok(r.text.includes('CHECK-IN DUE') && r.text.includes(`Open the tracker: ${APP}`), 'plain text');
r = render('reminder', { ...week, tasks: [week.tasks[2]], checkins_due: [], needs_update: 0 });
ok(r.html.includes('Everything is up to date') && r.html.includes('Your tasks'), 'nothing behind: a friendly note');

console.log('\nAnswered');
r = render('answered', { app_url: APP, project_id: 'p-loft', project: 'Loft Chair launch', color: '#F0644E', week_start: '2026-11-16',
  ask: 'Approve a rush', answer: 'Approved, up to $2k', by: 'Lindsay for Matt Hall' });
ok(r.html.includes('Lindsay for Matt Hall answered your ask') && r.html.includes('Approved, up to $2k') && r.html.includes(`#project/p-loft`), 'answer notice');

console.log('\nAssigned + test');
r = render('assigned', { name: 'Nick', by: 'lisa@elementcontract.com', app_url: APP,
  task: { id: 't9', title: 'Educate Upholstery Dept', status: 'Not started', project: 'Loft Chair launch', color: '#F0644E', due_date: '2026-11-20', lead: 'Lisa' } });
ok(r.html.includes('lisa@elementcontract.com added you') && r.html.includes('due Nov 20') && r.html.includes('#task/t9'), 'assignment notice links to the task');
ok(render('test', {}).text.includes('working'), 'test email');
let threw = false; try { render('nope', {}); } catch { threw = true; }
ok(threw, 'unknown kind throws (recorded as an error on the outbox row)');
ok(esc(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;' && fmtDate('2026-01-05') === 'Jan 5', 'helpers');

if (process.env.WRITE_SAMPLES) {
  const dir = new URL('./samples/', import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(new URL('digest.html', dir), render('digest', digest).html);
  fs.writeFileSync(new URL('reminder.html', dir), render('reminder', week).html);
  fs.writeFileSync(new URL('answered.html', dir), render('answered', { app_url: APP, project_id: 'p', project: 'Loft Chair launch', color: '#F0644E',
    week_start: '2026-11-16', ask: 'Approve a rush', answer: 'Approved', by: 'Lindsay for Matt Hall' }).html);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
