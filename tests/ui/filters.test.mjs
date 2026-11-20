// Projects screen filter rules in src/lib.js (pure functions, no browser).
//   npm run test:ui
import { startFilter, filterBoard } from '../../src/lib.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } };
const ids = (ps) => ps.map(p => p.id).sort().join(',');

console.log('startFilter');
ok(startFilter({ saved: '', isMember: true, hasPerson: true }) === 'mine', 'Member with a person starts on Mine');
ok(startFilter({ saved: '', isMember: true, hasPerson: false }) === 'all', 'Member without a person starts on All');
ok(startFilter({ saved: '', isMember: false, hasPerson: true }) === 'all', 'Admin / View Only starts on All');
ok(startFilter({ saved: 'all', isMember: true, hasPerson: true }) === 'all', 'saved All wins over the Member default');
ok(startFilter({ saved: 'attention', isMember: true, hasPerson: true }) === 'attention', 'saved Needs attention is kept');
ok(startFilter({ saved: 'mine', isMember: false, hasPerson: true }) === 'mine', 'Admin who saved Mine gets Mine');
ok(startFilter({ saved: 'mine', isMember: true, hasPerson: false }) === 'all', 'saved Mine without a person falls back to All');
ok(startFilter({ saved: 'junk', isMember: true, hasPerson: true }) === 'mine', 'unknown saved value is ignored');
ok(startFilter({ saved: 'mine', isMember: true, hasPerson: true, personPicked: true }) === 'all', 'a person picked on People overrides saved Mine');

console.log('filterBoard');
const ME = 'me', OTHER = 'other';
const proj = (id, extra = {}) => ({ id, lead_ids: [], stakeholder_ids: [], stage: 'In progress', ...extra });
const projects = [
  proj('led', { lead_ids: [ME] }),
  proj('stake', { stakeholder_ids: [ME] }),
  proj('task'),
  proj('none'),
  proj('late', { past_target: true }),
];
const tasks = [
  { id: 't1', project_id: 'task', assignee_ids: [ME], status: 'In progress' },
  { id: 't2', project_id: 'task', assignee_ids: [OTHER], status: 'Blocked' },
  { id: 't3', project_id: 'led', assignee_ids: [OTHER], status: 'In progress' },
  { id: 't4', project_id: 'none', assignee_ids: [OTHER], status: 'In progress', overdue: true },
];
const tasksByProject = new Map();
for (const t of tasks) { if (!tasksByProject.has(t.project_id)) tasksByProject.set(t.project_id, []); tasksByProject.get(t.project_id).push(t); }

const mine = filterBoard({ projects, tasksByProject, filter: 'mine', personId: ME });
ok(ids(mine.projects) === 'led,stake,task', 'Mine = led + stakeholder + has-a-task projects');
ok(tasks.filter(mine.matchTask).map(t => t.id).join(',') === 't1', 'Mine lists only my own tasks');

const empty = filterBoard({ projects, tasksByProject, filter: 'mine', personId: 'nobody' });
ok(empty.projects.length === 0, 'Mine is empty for an uninvolved person');

const all = filterBoard({ projects, tasksByProject, filter: 'all', personId: null });
ok(all.projects.length === projects.length, 'All shows every project');
ok(tasks.every(all.matchTask), 'All matches every task');

const attn = filterBoard({ projects, tasksByProject, filter: 'attention', personId: null });
ok(ids(attn.projects) === 'late,none,task', 'Needs attention = past target + blocked/overdue tasks');

const other = filterBoard({ projects, tasksByProject, filter: 'all', personId: OTHER });
ok(ids(other.projects) === 'led,none,task', 'a person picked from the dropdown shows their work');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
