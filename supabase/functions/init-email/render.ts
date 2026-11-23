// Turns an init_outbox row (kind + payload from the database) into an email: HTML for mail
// apps that show it, plain text for the rest. No imports, so tests can run it under Node.
//
// Email HTML is old-fashioned on purpose: tables and inline styles, because Outlook and Gmail
// ignore <style> blocks and modern CSS.

type Json = Record<string, any>;
export type Rendered = { html: string; text: string };

const GREEN = '#2F7D2D', BRAND = '#66BD64', HEADER = '#DDEFDB', INK = '#152018', INK2 = '#465449', LINE = '#DCE3DA';
const STATUS: Record<string, [string, string]> = {
  'Done': ['#0A6F57', '#D8F3EA'], 'In progress': ['#3354C4', '#E3E9FD'], 'Blocked': ['#B8291F', '#FDE4E1'],
  'Parked': ['#525D75', '#E6E9F0'], 'Not started': ['#465449', '#EBEFEA'],
};

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
// The database sends a project's leads as "Lisa, Nick"
const leadWord = (lead?: string | null) => (lead && lead.includes(', ') ? 'leads' : 'lead');

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
  `<tr><td style="padding:22px 28px 6px;font:700 15px/1.4 Arial,sans-serif;color:${INK}">${esc(t)}</td></tr>`;
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

// Links into the app: #project/<id>, #task/<id>, #checkin/<projectId>
const link = (base: string | null | undefined, hash: string) =>
  (base ? `${String(base).replace(/#.*$/, '').replace(/\/$/, '')}/#${hash}` : null);
const a = (url: string | null, label: string) => url ? `<a href="${esc(url)}" style="color:${GREEN};text-decoration:none">${label}</a>` : label;
const HEALTH: Record<string, [string, string]> = {
  'On track': ['#0A6F57', '#D8F3EA'], 'At risk': ['#8A5300', '#FCEFD6'], 'Off track': ['#B8291F', '#FDE4E1'],
};
const healthPill = (h?: string | null) => {
  const [fg, bg] = (h && HEALTH[h]) || ['#465449', '#EBEFEA'];
  return `<span style="display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;color:${fg};background:${bg};white-space:nowrap">${esc(h || 'No check-in')}</span>`;
};
const s_ = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "A, B, C and 4 more"
const names = (list: string[] = [], max = 5) =>
  list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`;

// ── Weekly digest ─────────────────────────────────────────────────────────────
// Order: note, asks for Matt, the three-line headline, how current the data is, projects by
// department with health, then blocked / past target / candidates to park, and workload counts.
export function renderDigest(p: Json): Rendered {
  const hl = p.headline || {}, dq = p.data_quality || {};
  const range = `${fmtDate(p.week_start)} – ${fmtDate(p.week_end)}`;
  const title = `${hl.on_track ?? 0} on track · ${hl.at_risk ?? 0} at risk · ${hl.off_track ?? 0} off track`;
  const text: string[] = [`Element Initiatives: week of ${range}`, title, ''];
  let body = '';

  if (p.note) {
    body += `<tr><td style="padding:18px 28px 4px"><div style="background:#F2F5F1;border-left:4px solid ${BRAND};border-radius:6px;padding:12px 14px;font:14px/1.5 Arial,sans-serif;color:${INK};white-space:pre-wrap">${esc(p.note)}</div></td></tr>`;
    text.push('NOTE', p.note, '');
  }

  // Asks for Matt
  const asks: Json[] = p.asks || [];
  const open = asks.filter(x => !x.answer);
  body += h2(open.length ? `Asks for you (${open.length})` : 'Asks for you');
  text.push('ASKS FOR YOU');
  if (!asks.length) { body += row(muted('Nothing asked of you this week.')); text.push('Nothing asked of you this week.'); }
  for (const x of asks) {
    const url = link(p.app_url, `project/${x.project_id}`);   // admins answer on the project
    const status = x.answer
      ? muted(`Answered by ${esc(x.answered_by || 'an admin')}: `) + esc(x.answer)
      : `${muted(x.days_open > 0 ? `open ${x.days_open} days · ` : '')}${a(url, 'Answer in the tracker')}`;
    body += row(`<div style="padding:6px 0;border-bottom:1px solid ${LINE}">${swatch(x.color)}<b>${esc(x.name)}</b> ${muted(`· ${leadWord(x.lead)} ${esc(x.lead || 'none')}`)}<br>
      <span style="padding-left:16px;display:inline-block">“${esc(x.ask)}”</span><br>
      <span style="padding-left:16px">${status}</span></div>`);
    text.push(`- ${x.name} (${x.lead || 'no lead'}): "${x.ask}"`,
      x.answer ? `    Answered by ${x.answered_by}: ${x.answer}` : `    Answer: ${url ?? 'in the tracker'}`);
  }

  // Headline
  body += h2('This week');
  const moving: string[] = hl.moving || [], quiet: string[] = hl.quiet || [];
  const lines: [string, string][] = [
    ['Moving', moving.length ? `${s_(moving.length, 'project')}: ${names(moving)}` : 'nothing moved'],
    ['Stuck', hl.blocked_tasks ? `${s_(hl.blocked_tasks, 'blocked task')} across ${s_(hl.blocked_projects, 'project')} (below)` : 'nothing blocked'],
    ['Quiet', quiet.length ? `${s_(quiet.length, 'project')}: ${names(quiet)}` : 'none'],
  ];
  for (const [k, v] of lines) body += row(`<b>${k}:</b> ${esc(v)}`);
  text.push('', 'THIS WEEK', ...lines.map(([k, v]) => `${k}: ${v}`));

  // How current the picture is
  const missing: Json[] = dq.missing || [], notHeard: string[] = dq.not_heard_from || [];
  const dqParts = [
    `${dq.checkins_in ?? 0} of ${dq.checkins_expected ?? 0} check-ins in${missing.length ? ` (missing: ${names(missing.map(m => m.name), 4)})` : ''}`,
    dq.pct_open_touched == null ? null : `${dq.pct_open_touched}% of open tasks updated`,
    notHeard.length ? `not heard from in 2 weeks: ${names(notHeard, 6)}` : null,
  ].filter(Boolean) as string[];
  body += row(`<div style="padding-top:8px;font-size:13px;color:${INK2}">${esc(dqParts.join(' · '))}</div>`);
  text.push(dqParts.join(' · '));

  // Projects by department
  const projects: Json[] = p.projects || [];
  if (projects.length) {
    body += h2('Projects');
    text.push('', 'PROJECTS');
    let dept: string | undefined;
    for (const x of projects) {
      const d = x.department || 'No department';
      if (d !== dept) {
        dept = d;
        body += row(`<div style="padding-top:10px;font:600 13px Arial,sans-serif;color:${INK2}">${esc(d)}</div>`);
        text.push(`${d}:`);
      }
      const when = x.days_late ? `<span style="color:#B8291F">${x.days_late} days past target</span>`
        : x.target_date ? muted(`target ${fmtDate(x.target_date)}`) : '';
      const stale = x.health && !x.checkin_current ? muted(' (last week)') : '';
      const showSummary = x.summary && x.stage !== 'Done';
      body += row(`<div style="padding:5px 0;border-bottom:1px solid ${LINE}">${x.stage === 'Done' || x.stage === 'Parked' ? pill(x.stage) : healthPill(x.health)}${stale}
        ${swatch(x.color)}${a(link(p.app_url, `project/${x.project_id}`), `<b style="color:${INK}">${esc(x.name)}</b>`)}
        ${muted(`· ${esc(x.lead || 'no lead')} · ${x.done} of ${x.total} tasks done`)}${when ? ' · ' + when : ''}
        ${showSummary ? `<div style="padding-left:2px;color:${INK2};font-size:13px">${esc(x.summary)}</div>` : ''}</div>`);
      text.push(`  [${x.stage === 'Done' || x.stage === 'Parked' ? x.stage : x.health || 'No check-in'}] ${x.name} (${x.lead || 'no lead'})${
        x.days_late ? `, ${x.days_late} days late` : ''}${showSummary ? ` — ${x.summary}` : ''}`);
    }
  }

  if (p.blocked?.length) {
    body += h2('Blocked');
    text.push('', 'BLOCKED');
    for (const b of p.blocked) {
      const on = b.waiting_on || b.blocked_on || 'not specified';
      body += row(`${swatch(b.color)}${a(link(p.app_url, `task/${b.task_id}`), esc(b.title))} ${muted(`· ${esc(b.project)} · ${esc(who(b.who))}`)}<br>
        <span style="padding-left:16px;color:#B8291F">Waiting on ${esc(on)}</span> ${muted(`since ${fmtDate(b.since)}`)}`);
      text.push(`- ${b.project}: ${b.title} — waiting on ${on} since ${fmtDate(b.since)}`);
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
  if (p.park_candidates?.length) {
    body += h2('Too much on the go?');
    body += row(muted('No movement in 3+ weeks. Worth deciding whether to park or close these.'));
    text.push('', 'TOO MUCH ON THE GO? (no movement in 3+ weeks)');
    for (const x of p.park_candidates) {
      body += row(`${swatch(x.color)}<b>${esc(x.name)}</b> ${muted(`· ${esc(x.lead || 'no lead')} · quiet ${x.weeks_quiet} weeks`)}`);
      text.push(`- ${x.name} (${x.lead || 'no lead'}): quiet ${x.weeks_quiet} weeks`);
    }
  }
  if (p.people?.length) {
    body += h2('Workload');
    text.push('', 'WORKLOAD (open · blocked · done this week)');
    const th = (v: string, right = false) => `<td style="padding:6px 8px;font:600 12px Arial,sans-serif;color:${INK2};border-bottom:1px solid ${LINE};text-align:${right ? 'right' : 'left'}">${v}</td>`;
    const td = (v: string, right = false, color = INK) => `<td style="padding:6px 8px;font:14px Arial,sans-serif;color:${color};border-bottom:1px solid ${LINE};text-align:${right ? 'right' : 'left'}">${v}</td>`;
    body += `<tr><td style="padding:4px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>${th('Person')}${th('Open', true)}${th('Blocked', true)}${th('Done this week', true)}${th('Last update', true)}</tr>
      ${p.people.map((x: Json) => `<tr>${td(esc(x.name))}${td(String(x.open), true)}${td(String(x.blocked), true, x.blocked ? '#B8291F' : INK)}${
        td(String(x.done_week), true)}${td(x.last_update ? fmtDate(x.last_update) : '—', true, INK2)}</tr>`).join('')}
    </table></td></tr>`;
    for (const x of p.people) text.push(`- ${x.name}: ${x.open} open · ${x.blocked} blocked · ${x.done_week} done`);
  }
  body += button(p.app_url, 'Open the tracker');
  if (p.app_url) text.push('', `Open the tracker: ${p.app_url}`);
  return {
    html: frame(`Week of ${range}`, title, body, 'Sent every week from the Element Initiatives Tracker. Admins change who gets it under Admin → Email.'),
    text: text.join('\n'),
  };
}

// ── "Your week": one person's weekly email ───────────────────────────────────
// Every open task (the overdue / quiet ones first), and for leads, the check-ins still due.
export function renderReminder(p: Json): Rendered {
  const tasks: Json[] = p.tasks || [], due: Json[] = p.checkins_due || [];
  const need = tasks.filter(t => t.needs_update), rest = tasks.filter(t => !t.needs_update);
  const first = String(p.name || '').split(' ')[0] || 'there';
  const sub = [tasks.length ? s_(tasks.length, 'open task') : '', due.length ? `${s_(due.length, 'check-in')} due` : '']
    .filter(Boolean).join(' · ');
  const asks = [need.length ? `${need.length === 1 ? 'one task needs' : `${need.length} tasks need`} an update` : '',
                due.length ? `${due.length === 1 ? 'one project needs its' : `${due.length} projects need their`} weekly check-in` : '']
    .filter(Boolean).join(', and ');
  const intro = asks ? `here's your week. ${asks[0].toUpperCase()}${asks.slice(1)}.` : `here's your week. Everything is up to date, thanks!`;
  let body = row(`<div style="padding-top:16px">Hi ${esc(first)}, ${esc(intro)}</div>`);
  const text = [`Hi ${first},`, '', intro, ''];

  if (due.length) {
    body += h2('Check-in due');
    body += row(muted('You lead these. One check-in each: on track, at risk or off track, one sentence, and anything you need from Matt.'));
    text.push('CHECK-IN DUE');
    for (const c of due) {
      const url = link(p.app_url, `checkin/${c.project_id}`);
      const last = c.last_health ? `<br><span style="padding-left:16px">${muted('Last time: ')}${healthPill(c.last_health)} ${muted(esc(c.last_summary || ''))}</span>` : '';
      body += row(`<div style="padding:6px 0;border-bottom:1px solid ${LINE}">${swatch(c.color)}<b>${esc(c.name)}</b> &nbsp;${a(url, 'Check in →')}${last}</div>`);
      text.push(`- ${c.name}${url ? `: ${url}` : ''}`);
    }
  }
  const taskRow = (t: Json) => {
    const why = t.overdue ? `<span style="color:#B8291F;font-weight:600">due ${fmtDate(t.due_date)}</span>`
      : t.needs_update ? muted(t.last_at ? `no update in ${t.days_quiet} days` : 'never updated')
      : t.due_date ? muted(`due ${fmtDate(t.due_date)}`) : '';
    return row(`<div style="padding:6px 0;border-bottom:1px solid ${LINE}">${swatch(t.color)}${a(link(p.app_url, `task/${t.task_id}`), `<b style="color:${INK}">${esc(t.title)}</b>`)}<br>
      <span style="padding-left:16px">${pill(t.status)} ${muted(esc(t.project))}${why ? ' · ' + why : ''}${t.blocked_on ? muted(` · waiting on ${esc(t.blocked_on)}`) : ''}</span></div>`);
  };
  const taskText = (t: Json) => `- ${t.title} (${t.project}) — ${t.status}${
    t.overdue ? ', due ' + fmtDate(t.due_date) : t.needs_update ? (t.last_at ? `, no update in ${t.days_quiet} days` : ', never updated') : ''}`;
  if (need.length) {
    body += h2('Needs an update');
    body += row(muted('A status change or a quick note is enough.'));
    text.push('', 'NEEDS AN UPDATE');
    for (const t of need) { body += taskRow(t); text.push(taskText(t)); }
  }
  if (rest.length) {
    body += h2(need.length ? 'The rest of your tasks' : 'Your tasks');
    text.push('', need.length ? 'THE REST OF YOUR TASKS' : 'YOUR TASKS');
    for (const t of rest) { body += taskRow(t); text.push(taskText(t)); }
  }
  body += button(p.app_url, 'Open the tracker');
  if (p.app_url) text.push('', `Open the tracker: ${p.app_url}`);
  return {
    html: frame('Your initiatives this week', sub, body,
      `Sent weekly to everyone with open initiative tasks or a check-in due. A task needs an update when it's past due or hasn't changed in ${p.stale_days} days.`),
    text: text.join('\n'),
  };
}

// ── An ask was answered ───────────────────────────────────────────────────────
export function renderAnswered(p: Json): Rendered {
  const url = link(p.app_url, `project/${p.project_id}`);
  let body = row(`<div style="padding-top:16px">${swatch(p.color)}<b>${esc(p.project)}</b> ${muted(`· check-in for the week of ${fmtDate(p.week_start)}`)}</div>`);
  body += row(`<div style="padding-top:10px">${muted('You asked:')}<br>“${esc(p.ask)}”</div>`);
  body += row(`<div style="padding-top:10px">${muted(`${esc(p.by)} answered:`)}<br><b>${esc(p.answer)}</b></div>`);
  body += button(url, 'Open the project');
  const text = [`${p.by} answered your ask on ${p.project}.`, '', `You asked: "${p.ask}"`, `Answer: ${p.answer}`, url ? `\n${url}` : ''];
  return { html: frame(`${p.by} answered your ask`, p.project || '', body, 'Element Initiatives Tracker'), text: text.join('\n') };
}

// ── "You're on a task" ────────────────────────────────────────────────────────
export function renderAssigned(p: Json): Rendered {
  const t = p.task || {};
  const first = String(p.name || '').split(' ')[0] || 'there';
  let body = row(`<div style="padding-top:16px">Hi ${esc(first)}, ${esc(p.by || 'an admin')} added you to a task.</div>`);
  body += row(`<div style="padding:10px 0">${swatch(t.color)}<b>${esc(t.title)}</b><br>
    <span style="padding-left:16px">${pill(t.status || 'Not started')} ${muted(esc(t.project))}${t.due_date ? muted(` · due ${fmtDate(t.due_date)}`) : ''}${t.lead ? muted(` · ${leadWord(t.lead)} ${esc(t.lead)}`) : ''}</span></div>`);
  body += button(t.id ? link(p.app_url, `task/${t.id}`) : p.app_url, 'Open the task');
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
    case 'answered': return renderAnswered(payload);
    case 'test': return renderTest(payload);
    default: throw new Error(`Unknown email kind: ${kind}`);
  }
}
