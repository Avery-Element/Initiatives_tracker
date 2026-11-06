// Projects: one row per initiative with stage, team, weekly activity and a progress bar.
// Click a row to see its tasks; change a task's status right from the list.
import { useState, useMemo } from "react";
import { addTask, updateTask, setAssignees } from "../supabase.js";
import { fmtDate, daysBetween, plural, localDay } from "../lib.js";
import { Avatars, Swatch, StatusPill, StatusSelect, Bar, Legend } from "./common.jsx";
import ProjectDialog from "./ProjectDialog.jsx";

const OPEN_KEY = "initiatives-open-projects";
const loadOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")); } catch { return new Set(); } };
const saveOpen = (s) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...s])); } catch { /* storage blocked */ } };

export default function ProjectsView({ data, access, perms, onChanged, onError, notify, openTask, personFilter, setPersonFilter }) {
  const [open, setOpen] = useState(loadOpen);
  const [filter, setFilter] = useState("all");            // all | attention | mine
  const [editing, setEditing] = useState(null);           // project, or {} for new
  const today = access.today;

  const toggle = (id) => setOpen(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); saveOpen(s); return s; });

  const tasksByProject = useMemo(() => {
    const m = new Map();
    for (const t of data.tasks) { if (!m.has(t.project_id)) m.set(t.project_id, []); m.get(t.project_id).push(t); }
    return m;
  }, [data.tasks]);

  const personId = filter === "mine" ? perms.myPerson : personFilter || null;
  const matchTask = (t) =>
    (!personId || t.assignee_ids.includes(personId)) &&
    (filter !== "attention" || t.status === "Blocked" || t.overdue);
  const projects = data.projects.filter(p => !p.archived_at).filter(p => {
    if (filter === "all" && !personId) return true;
    if (personId && p.lead_person === personId && filter !== "attention") return true;
    if (filter === "attention" && !personId && p.past_target) return true;
    return (tasksByProject.get(p.id) || []).some(matchTask);
  });

  const setStatus = async (t, status) => {
    const r = await updateTask(t.id, { status });
    if (r.error) return onError(r.error);
    notify(`${t.title}: ${status}`);
    onChanged();
  };

  return (
    <>
      <div className="toolbar">
        <h2>Projects</h2>
        <button className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>
        <button className="chip" aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>Needs attention</button>
        {perms.myPerson && <button className="chip" aria-pressed={filter === "mine"} onClick={() => { setFilter("mine"); setPersonFilter(""); }}>My tasks</button>}
        <select className="sel" aria-label="Filter by person" value={filter === "mine" ? "" : personFilter}
          onChange={e => { setPersonFilter(e.target.value); if (filter === "mine") setFilter("all"); }}>
          <option value="">Everyone</option>
          {data.assignable.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </select>
        {perms.isAdmin && <button className="btn" onClick={() => setEditing({})}>New project</button>}
      </div>
      <Legend />

      {projects.length === 0 ? (
        <div className="empty">
          {data.projects.length === 0
            ? (perms.isAdmin ? <>No projects yet. Use <b>New project</b> to add the first one.</> : "No projects yet.")
            : "Nothing matches this filter."}
        </div>
      ) : (
        <div className="plist">
          {projects.map(p => (
            <ProjectRow key={p.id} p={p} tasks={tasksByProject.get(p.id) || []} open={open.has(p.id) || !!personId || filter === "attention"}
              onToggle={() => toggle(p.id)} matchTask={personId || filter === "attention" ? matchTask : null}
              today={today} perms={perms} people={data.assignable} onStatus={setStatus} openTask={openTask}
              onEdit={() => setEditing(p)} onChanged={onChanged} onError={onError} notify={notify} />
          ))}
        </div>
      )}
      {editing && <ProjectDialog project={editing.id ? editing : null} people={data.assignable} perms={perms}
        onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); notify(msg); onChanged(); }} onError={onError} />}
    </>
  );
}

function ProjectRow({ p, tasks, open, onToggle, matchTask, today, perms, people, onStatus, openTask, onEdit, onChanged, onError, notify }) {
  const shown = matchTask ? tasks.filter(matchTask) : tasks;
  const canManage = perms.leads(p.id);
  const due = p.target_date
    ? (p.past_target
        ? <><span className="late">{plural(-p.days_to_target, "day")} past target</span><span>Target {fmtDate(p.target_date)}</span></>
        : <><span>Target {fmtDate(p.target_date)}</span><span>{p.stage === "Done" ? "Done" : `${plural(p.days_to_target, "day")} left`}</span></>)
    : <span>No target date</span>;

  return (
    <article className={`proj${open ? " open" : ""}`} style={{ "--pc": p.color }}>
      <button className="phead" aria-expanded={open} aria-controls={`b-${p.id}`} onClick={onToggle}>
        <div className="ptitle">
          <div className="row1">
            <Swatch color={p.color} />
            <span className="pname">{p.name}</span>
            <StatusPill status={p.stage} />
            {p.priority && (p.priority === "High" || p.priority === "Urgent") &&
              <span className={`prio${p.priority === "Urgent" ? " urgent" : ""}`}>{p.priority} priority</span>}
          </div>
          <div className="meta">
            <span>Lead: <b>{p.lead_name || "none"}</b></span>
            <Avatars names={p.team_names || []} />
            <span className={`wk${p.moved_this_week ? "" : " zero"}`}>
              {p.moved_this_week ? `${p.moved_this_week} updated this week` : p.task_count ? "No updates this week" : "No tasks yet"}
            </span>
          </div>
        </div>
        <div className="prog">
          <Bar done={p.done_count} inProgress={p.in_progress_count} blocked={p.blocked_count} total={p.task_count} />
          <div className="lbl"><span><b>{p.pct_done}%</b> · {p.done_count} of {p.task_count} done</span><span>{p.blocked_count ? `${p.blocked_count} blocked` : ""}</span></div>
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
            {perms.canEditProject(p) && <span className="actions"><button className="btn ghost sm" onClick={onEdit}>Edit project</button></span>}
          </div>
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
  return (
    <tr className={`click${mine ? " mine" : ""}`} onClick={() => openTask(t.id)} tabIndex={0}
      onKeyDown={e => { if (e.key === "Enter") openTask(t.id); }}>
      <td className="c-num">{n}</td>
      <td>
        <div className="tname">{t.title}</div>
        {t.status === "Blocked" && t.blocked_on && <div className="tblock">Waiting on: {t.blocked_on}</div>}
        {t.latest_note && <div className="tnote">
          {t.latest_note_at && <><span className="nd">{noteDays === 0 ? "Today" : fmtDate(noteDay)}</span> · </>}{t.latest_note}</div>}
        {t.others && <div className="tothers">Also involved: {t.others}</div>}
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
