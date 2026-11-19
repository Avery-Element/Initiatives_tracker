// Shared constants and small helpers for the Initiatives Tracker screens.

export const STATUSES = ['Not started', 'In progress', 'Blocked', 'Parked', 'Done'];
export const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
// class suffix for a status: 'In progress' → 'in_progress'
export const slug = (s) => String(s || 'Not started').toLowerCase().replace(/\s+/g, '_');

// Departments, in sort order. A project's color comes from its department.
// The names must match the check on init_projects.department (migration 006).
export const DEPARTMENTS = [
  { name: 'Design', color: '#D9488F' },              // pink
  { name: 'Office', color: '#3B7DD8' },              // blue
  { name: 'General', color: '#7A4FD0' },             // purple
  { name: 'Warehouse/Shipping', color: '#E8B21E' },  // yellow
  { name: 'Production', color: '#2F9E5B' },          // green
];
export const deptColor = (name) => DEPARTMENTS.find(d => d.name === name)?.color;

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'UTC' }) }));

export const TZ = 'America/Los_Angeles';   // keep in step with init_settings.time_zone

// "Nov 2" from YYYY-MM-DD without time-zone shifts
export const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
// "Nov 2, 3:40 PM" in Element's time zone
export const fmtWhen = (ts) => ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '';
// YYYY-MM-DD of a timestamp in Element's time zone
export const localDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
export const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

export const hue = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
export const initials = (name) => String(name).replace(/\(.*\)/, '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;

// What each status means (tooltips, legend)
export const STATUS_HELP = {
  'Not started': "Work hasn't begun yet",
  'In progress': 'Someone is actively working on it',
  'Blocked': "Can't move until someone or something else acts",
  'Parked': 'Paused on purpose; will pick back up later',
  'Done': 'Finished',
};

// Weekly check-in health, set by a project's lead
export const HEALTHS = ['On track', 'At risk', 'Off track'];
export const HEALTH_HELP = {
  'On track': 'Moving as planned',
  'At risk': 'Could slip without attention',
  'Off track': 'Will miss its target without a change',
  'No check-in': 'No check-in from a lead in the last two weeks',
};
// A project's current health: its latest check-in, if it's from this week or last
export const currentHealth = (p) => (p.latest_checkin && p.latest_checkin.age_days <= 13 ? p.latest_checkin.health : null);
