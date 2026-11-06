// Task details: status, what it's blocked on, notes and the full history.
// People on the task can change the status and add notes. The project lead and admins can
// also edit the title, due date, assignees and "also involved", or delete the task.
import { useState, useEffect, useCallback } from "react";
import { updateTask, deleteTask, setAssignees, addNote, fetchTaskActivity } from "../supabase.js";
import { fmtDate, fmtWhen } from "../lib.js";
import { Panel, Field, Swatch, StatusSelect } from "./common.jsx";

const describe = (a) => {
  switch (a.kind) {
    case "task_created": return "created the task";
    case "status": return <>changed status: {a.old_value} → <b>{a.new_value}</b></>;
    case "note": return "added a note";
    case "assigned": return <>added <b>{a.new_value}</b></>;
    case "unassigned": return <>removed <b>{a.old_value}</b></>;
    case "due": return a.new_value ? <>set due date to <b>{fmtDate(a.new_value)}</b></> : "cleared the due date";
    case "title": return <>renamed it from “{a.old_value}”</>;
    case "blocked_on": return <>marked it waiting on <b>{a.new_value}</b></>;
    default: return a.kind;
  }
};
const actorName = (a) => (a.actor === "system" || a.actor === "schedule" ? "System" : String(a.actor || "").split("@")[0]);

export default function TaskPanel({ task, data, perms, onClose, onChanged, onError, notify }) {
  const project = data.projects.find(p => p.id === task.project_id);
  const canUpdate = perms.canUpdateTask(task);
  const canManage = perms.leads(task.project_id);
  const [activity, setActivity] = useState(null);
  const [note, setNote] = useState("");
  const [blockedOn, setBlockedOn] = useState(task.blocked_on || "");
  const [edit, setEdit] = useState(null);       // { title, due_date, others, assignees } while editing
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadActivity = useCallback(async () => {
    const r = await fetchTaskActivity(task.id);
    if (!r.error) setActivity(r.data);
  }, [task.id]);
  useEffect(() => { loadActivity(); }, [loadActivity, task.updated_at, task.latest_note_at]);
  useEffect(() => { setBlockedOn(task.blocked_on || ""); }, [task.blocked_on]);

  const act = async (fn, okMsg) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r?.error) { onError(r.error); return false; }
    if (okMsg) notify(okMsg);
    onChanged(); loadActivity();
    return true;
  };

  const setStatus = (status) => act(() => updateTask(task.id, status === "Blocked" ? { status, blocked_on: blockedOn.trim() || null } : { status }), `Status: ${status}`);
  const saveBlocked = () => act(() => updateTask(task.id, { blocked_on: blockedOn.trim() || null }), "Saved");
  const postNote = async (e) => {
    e.preventDefault();
    if (!note.trim()) return;
    if (await act(() => addNote(task.id, note), "Note added")) setNote("");
  };
  const saveEdit = async (e) => {
    e.preventDefault();
    if (!edit.title.trim()) return onError("A task needs a title.");
    const ok = await act(async () => {
      const r = await updateTask(task.id, { title: edit.title.trim(), due_date: edit.due_date || null, others: edit.others.trim() || null });
      if (r.error) return r;
      return setAssignees(task.id, edit.assignees);
    }, "Task saved");
    if (ok) setEdit(null);
  };
  const remove = async () => {
    const r = await deleteTask(task.id);
    if (r.error) return onError(r.error);
    notify("Task deleted"); onChanged(); onClose();
  };

  return (
    <Panel onClose={onClose} label={task.title}>
      <div className="panelhead">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="small muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Swatch color={task.project_color} small /> {task.project_name}{project?.lead_name ? ` · lead ${project.lead_name}` : ""}
          </span>
          <h3>{task.title}</h3>
        </div>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>

      {!edit ? (
        <>
          <div className="grid2">
            <Field label="Status">
              <StatusSelect id="tp-status" value={task.status} disabled={!canUpdate || busy} label="Status" onChange={setStatus} />
            </Field>
            <Field label="Due"><span className={task.overdue ? "late" : ""}>{task.due_date ? fmtDate(task.due_date) : "No due date"}</span></Field>
            <Field label="People on it"><span>{task.assignee_names.join(", ") || "Unassigned"}</span></Field>
            <Field label="Also involved"><span>{task.others || "—"}</span></Field>
          </div>
          {(task.status === "Blocked" || canUpdate) && (
            <Field label="Waiting on" hint={task.status === "Blocked" ? "" : "fill this in when you mark it Blocked"}>
              {canUpdate
                ? <div style={{ display: "flex", gap: 8 }}>
                    <input className="inp w100" id="tp-blocked" value={blockedOn} onChange={e => setBlockedOn(e.target.value)} placeholder="Who or what is this waiting on?" />
                    {blockedOn !== (task.blocked_on || "") && <button className="btn sm" onClick={saveBlocked} disabled={busy}>Save</button>}
                  </div>
                : <span>{task.blocked_on || "—"}</span>}
            </Field>
          )}
          {!canUpdate && perms.canWrite && <p className="small muted">Only people on this task, the project lead and admins can update it.</p>}
          {canManage && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn ghost sm" onClick={() => setEdit({ title: task.title, due_date: task.due_date || "", others: task.others || "", assignees: [...task.assignee_ids] })}>Edit task</button>
              {confirmDelete
                ? <span className="confirm">Delete this task and its history?
                    <button className="btn danger sm" onClick={remove}>Delete</button>
                    <button className="btn ghost sm" onClick={() => setConfirmDelete(false)}>Keep</button></span>
                : <button className="btn danger sm" onClick={() => setConfirmDelete(true)}>Delete</button>}
            </div>
          )}
        </>
      ) : (
        <form onSubmit={saveEdit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Title"><input className="inp w100" id="tp-title" value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} /></Field>
          <div className="grid2">
            <Field label="Due date"><input className="inp w100" type="date" id="tp-due" value={edit.due_date} onChange={e => setEdit({ ...edit, due_date: e.target.value })} /></Field>
            <Field label="Also involved" hint="outside parties"><input className="inp w100" id="tp-others" value={edit.others} onChange={e => setEdit({ ...edit, others: e.target.value })} placeholder="Riverstone, James" /></Field>
          </div>
          <Field label="People on it">
            <div className="checks">
              {data.assignable.map(p => {
                const on = edit.assignees.includes(p.id);
                return (
                  <label key={p.id} className={on ? "on" : ""}>
                    <input type="checkbox" checked={on} onChange={() => setEdit({ ...edit, assignees: on ? edit.assignees.filter(x => x !== p.id) : [...edit.assignees, p.id] })} />
                    {p.display_name}
                  </label>
                );
              })}
            </div>
          </Field>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            <button className="btn ghost" type="button" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </form>
      )}

      {canUpdate && (
        <form onSubmit={postNote} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Field label="Add a note" hint="what changed, what's next">
            <textarea className="ta" id="tp-note" rows={3} value={note} onChange={e => setNote(e.target.value)} maxLength={2000} />
          </Field>
          <div><button className="btn" type="submit" disabled={busy || !note.trim()}>Add note</button></div>
        </form>
      )}

      <div>
        <div className="field" style={{ marginBottom: 8 }}><span>History</span></div>
        {!activity ? <p className="small muted">Loading…</p> : activity.length === 0 ? <p className="small muted">No history yet.</p> : (
          <div className="timeline">
            {activity.map(a => (
              <div key={a.id} className="tl">
                <span className="when">{fmtWhen(a.at)}</span>
                <div style={{ minWidth: 0 }}>
                  <b>{actorName(a)}</b> {describe(a)}
                  {a.kind === "note" && <div className="note">{a.new_value}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
