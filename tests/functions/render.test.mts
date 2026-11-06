// Email rendering tests for supabase/functions/init-email/render.ts (pure functions, no network).
//   npm run test:email
// Set WRITE_SAMPLES=1 to also write tests/functions/samples/*.html for a visual check.
import fs from 'node:fs';
import { render, esc, fmtDate } from '../../supabase/functions/init-email/render.ts';

let pass = 0, fail = 0;
const ok = (c: unknown, msg: string) => { if (c) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } };

const digest = {
  week_start: '2026-10-26', week_end: '2026-11-01', as_of: '2026-11-01', app_url: 'https://initiatives.example.com', stale_days: 7,
  totals: { projects: 6, tasks: 93, done: 20, done_week: 3, moved: 19, blocked: 7, overdue: 11 },
  activity: [
    { code: 'NPI-LOFT', name: 'Loft Chair launch', color: '#F0644E', stage: 'In progress', lead: 'Lisa', moved: 7, done: 6, total: 23, pct: 26,
      tasks: [{ title: 'Add new chair into CET/2020', status: 'In progress', who: ['Aiden', 'Lisa'], note: 'Ready for launch. Graphics could be improved <but OK>' },
              { title: 'Design and obtain demo tags', status: 'Done', who: [], note: null }] },
  ],
  idle: [{ code: 'WMS-01', name: 'Warehouse management tool', color: '#C2457E', stage: 'In progress', lead: 'Mat P.', pct: 20 }],
  blocked: [{ code: 'NPI-KONO', project: 'Kono Chair launch', color: '#F2A93B', title: 'Get renderings from James', blocked_on: 'Updated models from suppliers', who: ['Lisa'], since: '2026-10-29' }],
  past_target: [{ code: 'POA-01', name: 'Production order automation', color: '#7A4FD0', target_date: '2026-10-23', open: 3, total: 3, days_late: 9 }],
  quiet: [{ code: 'NPI-LOFT', project: 'Loft Chair launch', color: '#F0644E', title: 'Establish stocking levels', who: ['Ouri', 'Mat P.', 'Matt H.'], last_at: null }],
  people: [{ name: 'Lisa', open: 30, blocked: 5, done_week: 2, moved: 17, pct: 57 }, { name: 'Josh', open: 9, blocked: 0, done_week: 0, moved: 0, pct: 0 },
           { name: 'Paul', open: 0, blocked: 0, done_week: 0, moved: 0, pct: null }],
};

console.log('Digest');
let r = render('digest', digest);
ok(r.html.includes('Week of Oct 26 – Nov 1') && r.html.includes('19 tasks moved forward, 7 blocked'), 'title and week range');
ok(r.html.includes('Loft Chair launch') && r.html.includes('#F0644E'), 'project with its swatch color');
ok(r.html.includes('&lt;but OK&gt;') && !r.html.includes('<but OK>'), 'notes are HTML-escaped');
ok(r.html.includes('and 5 more'), 'shows "and N more" when more tasks moved than listed');
ok(r.html.includes('Waiting on Updated models from suppliers') && r.html.includes('since Oct 29'), 'blocked with reason and date');
ok(r.html.includes('9 days ago') && r.html.includes('3 of 3 tasks open'), 'past target');
ok(r.html.includes('never updated'), 'quiet task never updated');
ok(r.html.includes('>57%<') && r.html.includes('>—<'), 'workload percentages, dash for nobody-open');
ok(r.html.includes('href="https://initiatives.example.com"'), 'button links to the app');
ok(r.text.includes('BLOCKED') && r.text.includes('Lisa: 30 open'), 'plain-text version');
let empty = render('digest', { ...digest, activity: [], idle: [], blocked: [], past_target: [], quiet: [], people: [], app_url: null });
ok(empty.html.includes('Nothing moved this week.') && !empty.html.includes('Open the tracker'), 'quiet week renders; no button without app_url');

console.log('\nReminder');
r = render('reminder', { name: 'Ouri Ben', app_url: 'https://initiatives.example.com', stale_days: 7, tasks: [
  { code: 'NPI-LOFT', project: 'Loft Chair launch', color: '#F0644E', title: 'Law labels', status: 'In progress', due_date: null, overdue: false, blocked_on: null, last_at: '2026-10-20', days_quiet: 12 },
  { code: 'NPI-KONO', project: 'Kono Chair launch', color: '#F2A93B', title: 'Sample swatches', status: 'Blocked', due_date: '2026-10-15', overdue: true, blocked_on: 'Supplier', last_at: null, days_quiet: 20 },
] });
ok(r.html.includes('Hi Ouri,') && r.html.includes('2 of your initiative tasks need'), 'greets by first name, counts tasks');
ok(r.html.includes('no update in 12 days') && r.html.includes('due Oct 15') && r.html.includes('waiting on Supplier'), 'says why each task is listed');
ok(r.text.includes('Update your tasks: https://initiatives.example.com'), 'plain text has the link');

console.log('\nAssigned + test');
r = render('assigned', { name: 'Nick', by: 'lisa@elementcontract.com', app_url: null,
  task: { title: 'Educate Upholstery Dept', status: 'Not started', project: 'Loft Chair launch', color: '#F0644E', due_date: '2026-11-20', lead: 'Lisa' } });
ok(r.html.includes('lisa@elementcontract.com added you') && r.html.includes('due Nov 20'), 'assignment notice');
ok(render('test', {}).text.includes('working'), 'test email');
let threw = false; try { render('nope', {}); } catch { threw = true; }
ok(threw, 'unknown kind throws (recorded as an error on the outbox row)');
ok(esc(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;' && fmtDate('2026-01-05') === 'Jan 5', 'helpers');

if (process.env.WRITE_SAMPLES) {
  const dir = new URL('./samples/', import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(new URL('digest.html', dir), render('digest', digest).html);
  fs.writeFileSync(new URL('reminder.html', dir), render('reminder', { name: 'Ouri', app_url: 'https://x', stale_days: 7, tasks: [] }).html);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
