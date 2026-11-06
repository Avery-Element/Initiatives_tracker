// Turns an init_outbox row (kind + payload from the database) into an email: HTML for mail
// apps that show it, plain text for the rest. No imports, so tests can run it under Node.
//
// Email HTML is old-fashioned on purpose: tables and inline styles, because Outlook and Gmail
// ignore <style> blocks and modern CSS.

type Json = Record<string, any>;
export type Rendered = { html: string; text: string };

const GREEN = '#2F7D2D', BRAND = '#66BD64', HEADER = '#DDEFDB', INK = '#152018', INK2 = '#465449', LINE = '#DCE3DA';
const STATUS: Record<string, [string, string]> = {
  'Done': ['#0E8A6C', '#D8F3EA'], 'In progress': ['#3A5FD9', '#E3E9FD'], 'Blocked': ['#D63B2F', '#FDE4E1'],
  'Parked': ['#B87400', '#FCEFD6'], 'Not started': ['#465449', '#EBEFEA'],
};

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// "Nov 2" from YYYY-MM-DD, without time-zone shifts
export const fmtDate = (iso?: string | null) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const swatch = (color?: string) =>
  `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${esc(color || BRAND)};margin-right:6px;vertical-align:middle"></span>`;
const pill = (status: string) => {
  const [fg, bg] = STATUS[status] || STATUS['Not started'];
  return `<span style="display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;color:${fg};background:${bg};white-space:nowrap">${esc(status)}</span>`;
};
const who = (names?: string[]) => (names && names.length ? names.join(', ') : 'unassigned');
const h2 = (t: string) =>
  `<tr><td style="padding:22px 28px 6px;font:600 12px/1.4 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${INK2}">${esc(t)}</td></tr>`;
const row = (inner: string) => `<tr><td style="padding:4px 28px;font:14px/1.5 Arial,sans-serif;color:${INK}">${inner}</td></tr>`;
const muted = (t: string) => `<span style="color:${INK2}">${t}</span>`;
const button = (url: string | null | undefined, label: string) => url
  ? `<tr><td style="padding:22px 28px 6px"><a href="${esc(url)}" style="display:inline-block;background:${GREEN};color:#fff;text-decoration:none;font:600 14px Arial,sans-serif;padding:10px 18px;border-radius:8px">${esc(label)}</a></td></tr>`
  : '';

function frame(title: string, subtitle: string, body: string, footer: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F2F5F1">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F5F1;padding:24px 0"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border:1px solid ${LINE};border-radius:12px;overflow:hidden">
<tr><td style="background:${HEADER};border-bottom:3px solid ${BRAND};padding:18px 28px">
  <div style="font:700 18px Arial,sans-serif;color:#14361A">Element <span style="font-weight:500;color:#2F5E34">Initiatives</span></div>
  <div style="font:600 20px/1.3 Arial,sans-serif;color:${INK};margin-top:10px">${esc(title)}</div>
  ${subtitle ? `<div style="font:14px Arial,sans-serif;color:${INK2};margin-top:4px">${esc(subtitle)}</div>` : ''}
</td></tr>
${body}
<tr><td style="padding:22px 28px 24px;font:12px/1.5 Arial,sans-serif;color:${INK2};border-top:1px solid ${LINE}">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

// ── Weekly digest ─────────────────────────────────────────────────────────────
export function renderDigest(p: Json): Rendered {
  const t = p.totals || {};
  const range = `${fmtDate(p.week_start)} – ${fmtDate(p.week_end)}`;
  const title = `${t.moved ?? 0} task${t.moved === 1 ? '' : 's'} moved forward, ${t.blocked ?? 0} blocked`;
  const tiles = [
    ['Moved this week', t.moved ?? 0, GREEN], ['Done this week', t.done_week ?? 0, '#0E8A6C'],
    ['Blocked', t.blocked ?? 0, '#D63B2F'], ['Past due', t.overdue ?? 0, '#B87400'],
  ];
  let body = `<tr><td style="padding:18px 28px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${
    tiles.map(([k, v, c]) => `<td width="25%" style="padding:0 4px"><div style="border:1px solid ${LINE};border-radius:10px;padding:10px 12px">
      <div style="font:600 11px Arial,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:${INK2}">${k}</div>
      <div style="font:700 24px Arial,sans-serif;color:${c}">${v}</div></div></td>`).join('')
  }</tr></table></td></tr>`;
  const text: string[] = [`Element Initiatives: week of ${range}`, title, ''];

  body += h2('Activity by project');
  text.push('ACTIVITY BY PROJECT');
  if (!p.activity?.length) { body += row(muted('Nothing moved this week.')); text.push('Nothing moved this week.'); }
  for (const pr of p.activity || []) {
    body += row(`${swatch(pr.color)}<b>${esc(pr.name)}</b> ${muted(`· ${pr.moved} updated · now ${pr.pct}% done · lead ${esc(pr.lead || 'none')}`)}`);
    text.push(`- ${pr.name}: ${pr.moved} updated, now ${pr.pct}% done`);
    for (const tk of pr.tasks || []) {
      body += row(`<div style="padding-left:16px">${pill(tk.status)} ${esc(tk.title)} ${muted('· ' + esc(who(tk.who)))}${
        tk.note ? `<div style="color:${INK2};font-size:13px;padding-left:2px">“${esc(tk.note)}”</div>` : ''}</div>`);
      text.push(`    ${tk.status}: ${tk.title} (${who(tk.who)})${tk.note ? ` — "${tk.note}"` : ''}`);
    }
    if (pr.moved > (pr.tasks?.length || 0)) {
      body += row(`<div style="padding-left:16px">${muted(`and ${pr.moved - pr.tasks.length} more`)}</div>`);
    }
  }
  if (p.idle?.length) {
    body += row(`<div style="padding-top:6px">${muted('No updates this week: ' + p.idle.map((x: Json) => `${swatch(x.color)}${esc(x.name)}`).join(' &nbsp; '))}</div>`);
    text.push(`No updates this week: ${p.idle.map((x: Json) => x.name).join(', ')}`);
  }

  if (p.blocked?.length) {
    body += h2('Blocked');
    text.push('', 'BLOCKED');
    for (const b of p.blocked) {
      body += row(`${swatch(b.color)}${esc(b.title)} ${muted(`· ${esc(b.project)} · ${esc(who(b.who))}`)}<br>
        <span style="padding-left:16px;color:#D63B2F">Waiting on ${esc(b.blocked_on || 'not specified')}</span> ${muted(`since ${fmtDate(b.since)}`)}`);
      text.push(`- ${b.project}: ${b.title} — waiting on ${b.blocked_on || 'not specified'} since ${fmtDate(b.since)}`);
    }
  }
  if (p.past_target?.length) {
    body += h2('Past target date');
    text.push('', 'PAST TARGET DATE');
    for (const x of p.past_target) {
      body += row(`${swatch(x.color)}<b>${esc(x.name)}</b> ${muted(`· target ${fmtDate(x.target_date)} (${x.days_late} days ago) · ${x.open} of ${x.total} tasks open`)}`);
      text.push(`- ${x.name}: target ${fmtDate(x.target_date)}, ${x.open} of ${x.total} open`);
    }
  }
  if (p.quiet?.length) {
    body += h2(`In progress, no update in ${p.stale_days}+ days`);
    text.push('', `IN PROGRESS, NO UPDATE IN ${p.stale_days}+ DAYS`);
    for (const q of p.quiet.slice(0, 10)) {
      body += row(`${swatch(q.color)}${esc(q.title)} ${muted(`· ${esc(q.project)} · ${esc(who(q.who))} · ${q.last_at ? 'last ' + fmtDate(q.last_at) : 'never updated'}`)}`);
      text.push(`- ${q.title} (${q.project}, ${who(q.who)})`);
    }
    if (p.quiet.length > 10) { body += row(muted(`and ${p.quiet.length - 10} more`)); text.push(`and ${p.quiet.length - 10} more`); }
  }
  if (p.people?.length) {
    body += h2('Workload');
    text.push('', 'WORKLOAD (open · blocked · % of open tasks updated this week)');
    const th = (s: string, right = false) => `<td style="padding:6px 8px;font:600 12px Arial,sans-serif;color:${INK2};border-bottom:1px solid ${LINE};text-align:${right ? 'right' : 'left'}">${s}</td>`;
    const td = (s: string, right = false, color = INK) => `<td style="padding:6px 8px;font:14px Arial,sans-serif;color:${color};border-bottom:1px solid ${LINE};text-align:${right ? 'right' : 'left'}">${s}</td>`;
    body += `<tr><td style="padding:4px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>${th('Person')}${th('Open', true)}${th('Blocked', true)}${th('Moved this week', true)}</tr>
      ${p.people.map((x: Json) => `<tr>${td(esc(x.name))}${td(String(x.open), true)}${td(String(x.blocked), true, x.blocked ? '#D63B2F' : INK)}${
        td(x.pct == null ? '—' : x.pct + '%', true, x.pct === 0 ? '#A86200' : INK)}</tr>`).join('')}
    </table></td></tr>`;
    for (const x of p.people) text.push(`- ${x.name}: ${x.open} open · ${x.blocked} blocked · ${x.pct == null ? '—' : x.pct + '%'}`);
  }
  body += button(p.app_url, 'Open the tracker');
  if (p.app_url) text.push('', `Open the tracker: ${p.app_url}`);
  return {
    html: frame(`Week of ${range}`, title, body, 'Sent every week from the Element Initiatives Tracker. Admins change who gets it under Admin → Email.'),
    text: text.join('\n'),
  };
}

// ── Reminder to one person ────────────────────────────────────────────────────
export function renderReminder(p: Json): Rendered {
  const n = p.tasks?.length || 0;
  const first = String(p.name || '').split(' ')[0] || 'there';
  let body = row(`<div style="padding-top:16px">Hi ${esc(first)}, ${n === 1 ? 'one of your initiative tasks needs' : `${n} of your initiative tasks need`} an update. A status change or a quick note is enough.</div>`);
  const text = [`Hi ${first},`, '', `${n} of your initiative tasks need an update. A status change or a quick note is enough.`, ''];
  for (const t of p.tasks || []) {
    const why = t.overdue ? `<span style="color:#D63B2F;font-weight:600">due ${fmtDate(t.due_date)}</span>`
      : muted(t.last_at ? `no update in ${t.days_quiet} days` : 'never updated');
    body += row(`<div style="padding:6px 0;border-bottom:1px solid ${LINE}">${swatch(t.color)}<b>${esc(t.title)}</b><br>
      <span style="padding-left:16px">${pill(t.status)} ${muted(esc(t.project))} · ${why}${t.blocked_on ? muted(` · waiting on ${esc(t.blocked_on)}`) : ''}</span></div>`);
    text.push(`- ${t.title} (${t.project}) — ${t.status}, ${t.overdue ? 'due ' + fmtDate(t.due_date) : t.last_at ? `no update in ${t.days_quiet} days` : 'never updated'}`);
  }
  body += button(p.app_url, 'Update my tasks');
  if (p.app_url) text.push('', `Update your tasks: ${p.app_url}`);
  return {
    html: frame('Your tasks need an update', `${n} task${n === 1 ? '' : 's'}`, body,
      `Reminders go out weekly for tasks that are past due or haven't been updated in ${p.stale_days} days.`),
    text: text.join('\n'),
  };
}

// ── "You're on a task" ────────────────────────────────────────────────────────
export function renderAssigned(p: Json): Rendered {
  const t = p.task || {};
  const first = String(p.name || '').split(' ')[0] || 'there';
  let body = row(`<div style="padding-top:16px">Hi ${esc(first)}, ${esc(p.by || 'an admin')} added you to a task.</div>`);
  body += row(`<div style="padding:10px 0">${swatch(t.color)}<b>${esc(t.title)}</b><br>
    <span style="padding-left:16px">${pill(t.status || 'Not started')} ${muted(esc(t.project))}${t.due_date ? muted(` · due ${fmtDate(t.due_date)}`) : ''}${t.lead ? muted(` · lead ${esc(t.lead)}`) : ''}</span></div>`);
  body += button(p.app_url, 'Open the task');
  const text = [`Hi ${first},`, '', `${p.by || 'An admin'} added you to "${t.title}" (${t.project}).`,
    t.due_date ? `Due ${fmtDate(t.due_date)}.` : '', p.app_url ? `Open it: ${p.app_url}` : ''].filter(Boolean);
  return { html: frame("You're on a task", t.project || '', body, 'Element Initiatives Tracker'), text: text.join('\n') };
}

export function renderTest(p: Json): Rendered {
  const body = row(`<div style="padding:16px 0">Email from the Initiatives Tracker is working. Digests and reminders will arrive from this address.</div>`) +
    button(p.app_url, 'Open the tracker');
  return { html: frame('Test email', '', body, 'Element Initiatives Tracker'),
           text: 'Email from the Initiatives Tracker is working.' + (p.app_url ? `\n${p.app_url}` : '') };
}

export function render(kind: string, payload: Json): Rendered {
  switch (kind) {
    case 'digest': return renderDigest(payload);
    case 'reminder': return renderReminder(payload);
    case 'assigned': return renderAssigned(payload);
    case 'test': return renderTest(payload);
    default: throw new Error(`Unknown email kind: ${kind}`);
  }
}
