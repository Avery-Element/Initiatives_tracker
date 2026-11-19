// Projects: every initiative, grouped by department, with its health from the lead's weekly
// check-in. Click a row to see its purpose, the latest check-in (and any ask for Matt) and its
// tasks; change a task's status right from the list.
import { useState, useMemo, useEffect, useRef } from "react";
import { addTask, updateTask, setAssignees } from "../supabase.js";
import { fmtDate, daysBetween, plural, localDay, DEPARTMENTS, currentHealth } from "../lib.js";
import { Avatars, Swatch, StatusPill, StatusSelect, HealthBadge, AskAnswer, Legend } from "./common.jsx";
import ProjectDialog from "./ProjectDialog.jsx";

const OPEN_KEY = "initiatives-open-projects";
const DEPT_KEY = "initiatives-dept-filter";
const SHUT_KEY = "initiatives-collapsed-depts";
const loadSet = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || "[]")); } catch { return new Set(); } };
const saveSet = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])); } catch { /* storage blocked */ } };
const loadStr = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const saveStr = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

const NO_DEPT = "No department";
const GROUPS = [...DEPARTMENTS.map(d => d.name), NO_DEPT];
const prioRank = (p) => (p.priority === "Urgent" ? 0 : p.priority === "High" ? 1 : 2);
const doneLast = (p) => (p.stage === "Done" ? 1 : 0);
// Earliest date first; no date goes last
const byDate = (a, b) => (a && b ? a.localeCompare(b) : a ? -1 : b ? 1 : 0);
// Within a department: Done last, then the chosen order, then priority
const PROJECT_SORTS = {
  priority: (a, b) => doneLast(a) - doneLast(b) || prioRank(a) - prioRank(b),
  due: (a, b) => doneLast(a) - doneLast(b) || byDate(a.target_date, b.target_date) || prioRank(a) - prioRank(b),
};
const isActive = (p) => p.stage !== "Done" && p.stage !== "Parked";

export default function ProjectsView({ data, access, perms, onChanged, onError, notify, openTask, personFilter, setPersonFilter,
                                       openCheckin, focusProject, setFocusProject }) {
  const [open, setOpen] = useState(() => loadSet(OPEN_KEY));
  const [shut, setShut] = useState(() => loadSet(SHUT_KEY));        // collapsed department groups
  const [dept, setDeptRaw] = useState(() => loadStr(DEPT_KEY));     // "" = all departments
  const [filter, setFilterRaw] = useState("all");                   // all | attention | mine
  const [attnClosed, setAttnClosed] = useState(() => new Set());    // cards collapsed while "Needs attention" opens them all
  const [editing, setEditing] = useState(null);                     // project, or {} for new
  const [sort, setSort] = useState("priority");                     // priority | due
  const today = access.today;
  const setFilter = (f) => { setFilterRaw(f); setAttnClosed(new Set()); };
  const setDept = (d) => { setDeptRaw(d); saveStr(DEPT_KEY, d); };

  const toggle = (id) => setOpen(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); saveSet(OPEN_KEY, s); return s; });
  const toggleAttn = (id) => setAttnClosed(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const toggleGroup = (g) => setShut(prev => { const s = new Set(prev); s.has(g) ? s.delete(g) : s.add(g); saveSet(SHUT_KEY, s); return s; });

  // A link to a project (from an email or the digest): show all, open its group and card, scroll to it
  const focusRef = useRef(null);
  useEffect(() => {
    if (!focusProject) return;
    const p = data.projects.find(x => x.id === focusProject);
    if (p) {
      setFilter("all"); setPersonFilter(""); setDept("");
      setShut(prev => { const s = new Set(prev); s.delete(p.department || NO_DEPT); saveSet(SHUT_KEY, s); return s; });
      setOpen(prev => { const s = new Set(prev); s.add(p.id); saveSet(OPEN_KEY, s); return s; });
      focusRef.current = p.id;
    }
    setFocusProject(null);
  }, [focusProject]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focusRef.current) return;
    const el = document.getElementById(`p-${focusRef.current}`);
    if (!el) return;   // its group opens on the next render
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    focusRef.current = null;
  });

  const tasksByProject = useMemo(() => {
    const m = new Map();
    for (const t of data.tasks) { if (!m.has(t.project_id)) m.set(t.project_id, []); m.get(t.project_id).push(t); }
    return m;
  }, [data.tasks]);

  const live = data.projects.filter(p => !p.archived_at);
  const personId = filter === "mine" ? perms.myPerson : personFilter || null;
  const matchTask = (t) =>
    (!personId || t.assignee_ids.includes(personId)) &&
    (filter !== "attention" || t.status === "Blocked" || t.overdue);
  const projects = live.filter(p => !dept || (p.department || NO_DEPT) === dept).filter(p => {
    if (filter === "all" && !personId) return true;
    if (personId && (p.lead_ids.includes(personId) || p.stakeholder_ids.includes(personId)) && filter !== "attention") return true;
    if (filter === "attention" && !personId && (p.past_target || (isActive(p) && currentHealth(p) === "Off track"))) return true;
    return (tasksByProject.get(p.id) || []).some(matchTask);
  }).sort(PROJECT_SORTS[sort]);
  const groups = GROUPS.map(g => ({ name: g, items: projects.filter(p => (p.department || NO_DEPT) === g) })).filter(g => g.items.length);

  // Leads: this week's check-ins still to do
  const due = perms.myPerson ? live.filter(p => isActive(p) && p.lead_ids.includes(perms.myPerson) && !p.checkin_this_week) : [];

  const setStatus = async (t, status) => {
    const r = await updateTask(t.id, { status });
    if (r.error) return onError(r.error);
    notify(`${t.title}: ${status}`);
    onChanged();
  };

  const deptCount = (d) => live.filter(p => (p.department || NO_DEPT) === d).length;
  const renderRow = (p) => {
    const attnOpen = filter === "attention" && !personId;  // starts expanded, but each card can still be collapsed
    return (
      <ProjectRow key={p.id} p={p} tasks={tasksByProject.get(p.id) || []} open={attnOpen ? !attnClosed.has(p.id) : open.has(p.id)}
        onToggle={() => (attnOpen ? toggleAttn(p.id) : toggle(p.id))} byDue={sort === "due"} matchTask={personId || filter === "attention" ? matchTask : null}
        personName={personId ? (filter === "mine" ? "you" : data.assignable.find(x => x.id === personId)?.display_name) : null}
        today={today} perms={perms} people={data.assignable} onStatus={setStatus} openTask={openTask}
        onEdit={() => setEditing(p)} onCheckin={() => openCheckin(p.id)} onChanged={onChanged} onError={onError} notify={notify} />
    );
  };

  return (
    <>
      <div className="toolbar">
        <h2>Projects</h2>
        <button className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>
        <button className="chip" aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}
          title="Blocked or overdue tasks, projects past their target date, and projects marked Off track">Needs attention</button>
        {perms.myPerson && <button className="chip" aria-pressed={filter === "mine"} onClick={() => { setFilter("mine"); setPersonFilter(""); }}>My tasks</button>}
        <select className="sel" aria-label="Filter by person" value={filter === "mine" ? "" : personFilter}
          onChange={e => { setPersonFilter(e.target.value); if (filter === "mine") setFilter("all"); }}>
          <option value="">Everyone</option>
          {data.assignable.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </select>
        <select className="sel" aria-label="Sort projects" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="priority">Sort: Priority</option>
          <option value="due">Sort: Target date</option>
        </select>
        {perms.isAdmin && <button className="btn" onClick={() => setEditing({})}>New project</button>}
      </div>
      <p className="intro">Every internal initiative, grouped by department. Health comes from each lead's weekly check-in; open a project for its tasks.</p>

      <div className="deptbar" role="group" aria-label="Department">
        <button className="chip" aria-pressed={!dept} onClick={() => setDept("")}>All departments</button>
        {DEPARTMENTS.filter(d => deptCount(d.name)).map(d => (
          <button key={d.name} className="chip" aria-pressed={dept === d.name} onClick={() => setDept(dept === d.name ? "" : d.name)}>
            <Swatch small color={d.color} />{d.name} <span className="muted">{deptCount(d.name)}</span>
          </button>
        ))}
        {deptCount(NO_DEPT) > 0 && <button className="chip" aria-pressed={dept === NO_DEPT} onClick={() => setDept(dept === NO_DEPT ? "" : NO_DEPT)}>{NO_DEPT} <span className="muted">{deptCount(NO_DEPT)}</span></button>}
      </div>

      {due.length > 0 && (
        <div className="duebar" role="status">
          <b>Check-in due:</b>
          {due.map(p => <button key={p.id} className="btn ghost sm" onClick={() => openCheckin(p.id)}><Swatch small color={p.color} /> {p.name}</button>)}
          <span className="small muted">One per project each week: health, one sentence, anything you need from Matt.</span>
        </div>
      )}
      <Legend />

      {projects.length === 0 ? (
        <div className="empty">
          {data.projects.length === 0
            ? (perms.isAdmin ? <>No projects yet. Use <b>New project</b> to add the first one.</> : "No projects yet.")
            : "Nothing matches this filter."}
        </div>
      ) : (
        <div className="plist">
          {groups.map(g => {
            const isOpen = !shut.has(g.name);
            const act = g.items.filter(isActive);
            const tally = (h) => act.filter(p => currentHealth(p) === h).length;
            return (
              <section key={g.name} className={`dgrp${isOpen ? " open" : ""}`} aria-label={g.name}>
                <button className="dgrp-h" aria-expanded={isOpen} onClick={() => toggleGroup(g.name)}>
                  <span className="chev" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 14 14"><path d="M5 2l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  {g.name !== NO_DEPT && <Swatch small color={DEPARTMENTS.find(d => d.name === g.name)?.color} />}
                  <h3>{g.name}</h3>
                  <span className="n">{plural(g.items.length, "project")}</span>
                  <span className="tally" aria-label={`${tally("On track")} on track, ${tally("At risk")} at risk, ${tally("Off track")} off track`}>
                    <span><i style={{ background: "var(--s-done)" }} />{tally("On track")}</span>
                    <span><i style={{ background: "var(--s-park)" }} />{tally("At risk")}</span>
                    <span><i style={{ background: "var(--s-block)" }} />{tally("Off track")}</span>
                  </span>
                </button>
                {isOpen && g.items.map(renderRow)}
              </section>
            );
          })}
        </div>
      )}
      {editing && <ProjectDialog project={editing.id ? editing : null} people={data.assignable} perms={perms}
        onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); notify(msg); onChanged(); }} onError={onError} />}
    </>
  );
}

function ProjectRow({ p, tasks, open, onToggle, byDue, matchTask, personName, today, perms, people, onStatus, openTask, onEdit, onCheckin, onChanged, onError, notify }) {
  // Overdue tasks first (earliest due date on top). Sorted by target date, the rest follow by due
  // date too (no date last); otherwise they keep their list order.
  const shown = (matchTask ? tasks.filter(matchTask) : tasks).slice().sort((a, b) =>
    (b.overdue - a.overdue) || (byDue || (a.overdue && b.overdue) ? byDate(a.due_date, b.due_date) : 0));
  const canManage = perms.leads(p.id);
  const iLead = !!perms.myPerson && p.lead_ids.includes(perms.myPerson);
  const ck = p.latest_checkin;
  const health = currentHealth(p);
  const active = isActive(p);
  const openAsk = ck?.ask && !ck.answer && ck.age_days <= 13;
  const due = p.target_date
    ? (p.past_target
        ? <><span className="late">{plural(-p.days_to_target, "day")} past target</span><span>Target {fmtDate(p.target_date)}</span></>
        : <><span>Target {fmtDate(p.target_date)}</span><span>{p.stage === "Done" ? "Done" : `${plural(p.days_to_target, "day")} left`}</span></>)
    : <span>No target date</span>;

  return (
    <article id={`p-${p.id}`} className={`proj${open ? " open" : ""}`} style={{ "--pc": p.color }}>
      <button className="phead" aria-expanded={open} aria-controls={`b-${p.id}`} onClick={onToggle}>
        <div className="ptitle">
          <div className="row1">
            <Swatch color={p.color} />
            <span className="pname">{p.name}</span>
            {!active && <StatusPill status={p.stage} />}
            {p.priority && (p.priority === "High" || p.priority === "Urgent") &&
              <span className={`prio${p.priority === "Urgent" ? " urgent" : ""}`}>{p.priority} priority</span>}
            {openAsk && <span className="tag" title={ck.ask}>Ask for Matt</span>}
            {iLead && active && !p.checkin_this_week && <span className="tag warn">Check-in due</span>}
          </div>
          <div className="meta">
            <span>{p.lead_names.length > 1 ? "Leads" : "Lead"}: <b>{p.lead_name || "none"}</b></span>
            {p.stakeholder_names.length > 0 &&
              <span title={p.stakeholder_names.join(", ")}>Stakeholders: <b>{p.stakeholder_names.length > 3
                ? `${p.stakeholder_names.slice(0, 3).join(", ")} +${p.stakeholder_names.length - 3}` : p.stakeholder_names.join(", ")}</b></span>}
            <Avatars names={p.team_names || []} />
            {personName && <span className="wk"><b>{plural(shown.length, "task")}</b> for {personName}</span>}
            <span className={`wk${p.moved_this_week || !active ? "" : " zero"}`}>
              {p.moved_this_week ? `${p.moved_this_week} updated this week` : p.task_count ? "No task updates this week" : "No tasks yet"}
            </span>
          </div>
        </div>
        <div className="prog hlth">
          {active && <span><HealthBadge health={health} /></span>}
          {active && health && <span className="sumline" title={ck.summary}>{ck.summary}</span>}
          {active && ck && !health && <span className="old">Last check-in {fmtDate(ck.week_start)}</span>}
          <span className="lbl">{p.done_count} of {plural(p.task_count, "task")} done{p.blocked_count ? ` · ${p.blocked_count} blocked` : ""}</span>
        </div>
        <div className="due">{due}</div>
        <span className="chev" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M5 2l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
      </button>

      {open && (
        <div className="pbody" id={`b-${p.id}`}>
          <div className="psum">
            <span>{p.summary || <span className="muted">No summary.</span>}</span>
            <span className="actions">
              {canManage && active && <button className="btn sm" onClick={onCheckin}>{p.checkin_this_week ? "Update check-in" : "Weekly check-in"}</button>}
              {perms.canEditProject(p) && <button className="btn ghost sm" onClick={onEdit}>Edit project</button>}
            </span>
          </div>
          {(p.purpose || p.success_measure) && (
            <div className="pinfo">
              {p.purpose && <div><b>Why we're doing it</b><span>{p.purpose}</span></div>}
              {p.success_measure && <div><b>How we'll know it worked</b><span>{p.success_measure}</span></div>}
            </div>
          )}
          {ck && (
            <div className="ckblock">
              <div className="ckh"><HealthBadge small health={ck.health} />
                <span>Check-in, week of {fmtDate(ck.week_start)}{ck.updated_by ? ` · ${String(ck.updated_by).split("@")[0]}` : ""}</span></div>
              <div>{ck.summary}</div>
              <AskAnswer checkin={ck} canAnswer={perms.isAdmin} onChanged={onChanged} onError={onError} notify={notify} />
            </div>
          )}
          <div className="scroll">
            <table className="tasks">
              <thead><tr><th>#</th><th>Task</th><th>Status</th><th>Who</th><th>Due</th></tr></thead>
              <tbody>
                {shown.map((t) => <TaskRow key={t.id} t={t} n={tasks.indexOf(t) + 1} today={today} perms={perms} onStatus={onStatus} openTask={openTask} />)}
                {shown.length === 0 && <tr><td /><td colSpan={4} className="tnote">{tasks.length ? "No tasks match this filter." : "No tasks yet."}</td></tr>}
              </tbody>
            </table>
          </div>
          {canManage && <AddTask project={p} people={people} onChanged={onChanged} onError={onError} notify={notify} />}
        </div>
      )}
    </article>
  );
}

function TaskRow({ t, n, today, perms, onStatus, openTask }) {
  const mine = perms.myPerson && t.assignee_ids.includes(perms.myPerson);
  const noteDay = t.latest_note_at ? localDay(t.latest_note_at) : null;
  const noteDays = noteDay ? daysBetween(noteDay, today) : null;
  const waiting = [t.blocked_on_person_name, t.blocked_on].filter(Boolean).join(" — ");
  return (
    <tr className={`click${mine ? " mine" : ""}`} onClick={() => openTask(t.id)} tabIndex={0}
      onKeyDown={e => { if (e.key === "Enter") openTask(t.id); }}>
      <td className="c-num">{n}</td>
      <td>
        <div className="tname">{t.title}</div>
        {t.status === "Blocked" && waiting && <div className="tblock">Waiting on: {waiting}</div>}
        {t.latest_note && <div className="tnote">
          {t.latest_note_at && <><span className="nd">{noteDays === 0 ? "Today" : fmtDate(noteDay)}</span> · </>}{t.latest_note}</div>}
        {t.others && <div className="tothers">Outside parties: {t.others}</div>}
      </td>
      <td className="c-status">
        <StatusSelect value={t.status} disabled={!perms.canUpdateTask(t)} label={`Status for ${t.title}`}
          onChange={s => onStatus(t, s)} />
      </td>
      <td className="c-who">
        <span className="who">{t.assignee_names.length ? t.assignee_names.join(", ") : "Unassigned"}</span>
        {t.due_date && <span className={`mdue tdue${t.overdue ? " late" : ""}`}> · Due {fmtDate(t.due_date)}</span>}
      </td>
      <td className="c-due"><span className={`tdue${t.overdue ? " late" : ""}`}>{t.due_date ? fmtDate(t.due_date) : "—"}</span></td>
    </tr>
  );
}

function AddTask({ project, people, onChanged, onError, notify }) {
  const [title, setTitle] = useState("");
  const [who, setWho] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const r = await addTask({ project_id: project.id, title: title.trim(), due_date: due || null });
    if (!r.error && who) { const a = await setAssignees(r.data.id, [who]); if (a.error) onError(a.error); }
    setBusy(false);
    if (r.error) return onError(r.error);
    setTitle(""); setDue(""); notify(`Added to ${project.name}`); onChanged();
  };
  return (
    <form className="addrow" onSubmit={submit}>
      <input className="inp" type="text" id={`add-title-${project.id}`} value={title} onChange={e => setTitle(e.target.value)} placeholder="New task" aria-label="New task" />
      <select className="sel" id={`add-who-${project.id}`} value={who} onChange={e => setWho(e.target.value)} aria-label="Assign to">
        <option value="">Assign to…</option>
        {people.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
      </select>
      <input className="inp" type="date" id={`add-due-${project.id}`} value={due} onChange={e => setDue(e.target.value)} aria-label="Due date" />
      <button className="btn" type="submit" disabled={busy || !title.trim()}>Add task</button>
    </form>
  );
}
