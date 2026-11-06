// New / edit project. Admins edit everything; a project's lead can change its stage,
// summary, priority and target date (the database enforces the same split).
import { useState } from "react";
import { saveProject } from "../supabase.js";
import { STATUSES, PRIORITIES, SWATCHES } from "../lib.js";
import { Dialog, Field } from "./common.jsx";

export default function ProjectDialog({ project, people, perms, onClose, onSaved, onError }) {
  const isNew = !project;
  const admin = perms.isAdmin;
  const [f, setF] = useState(() => ({
    code: project?.code || "", name: project?.name || "", summary: project?.summary || "",
    lead_person: project?.lead_person || "", stage: project?.stage || "Not started",
    priority: project?.priority || "", target_date: project?.target_date || "",
    color: project?.color || SWATCHES[Math.floor(Math.random() * SWATCHES.length)],
  }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target ? e.target.value : e }));

  const save = async (e) => {
    e.preventDefault();
    setMsg("");
    if (admin && (!f.name.trim() || !/^[A-Za-z0-9][A-Za-z0-9-]{1,15}$/.test(f.code.trim()))) {
      setMsg("Give the project a name and a short code: 2–16 letters, numbers or dashes, like NPI-LOFT.");
      return;
    }
    const lead = { stage: f.stage, summary: f.summary.trim() || null, priority: f.priority || null, target_date: f.target_date || null };
    const fields = admin ? { ...lead, code: f.code.trim().toUpperCase(), name: f.name.trim(), lead_person: f.lead_person || null, color: f.color } : lead;
    setBusy(true);
    const r = await saveProject(project?.id, fields);
    setBusy(false);
    if (r.error) return setMsg(r.error.includes("init_projects_code_idx") ? `Another project already uses the code ${fields.code}.` : r.error);
    onSaved(isNew ? `Created ${fields.name}` : "Project saved");
  };

  const archive = async () => {
    const r = await saveProject(project.id, { archived_at: project.archived_at ? null : new Date().toISOString() });
    if (r.error) return onError(r.error);
    onSaved(project.archived_at ? `Restored ${project.name}` : `Archived ${project.name}`);
  };

  return (
    <Dialog onClose={onClose} label={isNew ? "New project" : `Edit ${project.name}`}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h3>{isNew ? "New project" : project.name}</h3>
        {admin && (
          <div className="grid2">
            <Field label="Name"><input className="inp w100" id="pj-name" value={f.name} onChange={set("name")} autoFocus={isNew} /></Field>
            <Field label="Code" hint="short, e.g. NPI-LOFT"><input className="inp w100" id="pj-code" value={f.code} onChange={set("code")} maxLength={16} /></Field>
          </div>
        )}
        <Field label="Summary" hint="one or two sentences">
          <textarea className="ta" id="pj-summary" rows={2} value={f.summary} onChange={set("summary")} />
        </Field>
        <div className="grid2">
          {admin && (
            <Field label="Lead">
              <select className="sel w100" id="pj-lead" value={f.lead_person} onChange={set("lead_person")}>
                <option value="">No lead</option>
                {people.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Stage">
            <select className="sel w100" id="pj-stage" value={f.stage} onChange={set("stage")}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select>
          </Field>
          <Field label="Priority">
            <select className="sel w100" id="pj-priority" value={f.priority} onChange={set("priority")}>
              <option value="">None</option>{PRIORITIES.map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Target date"><input className="inp w100" type="date" id="pj-target" value={f.target_date} onChange={set("target_date")} /></Field>
        </div>
        {admin && (
          <Field label="Color">
            <div className="swatches">
              {SWATCHES.map(c => <button type="button" key={c} style={{ "--pc": c }} aria-label={`Color ${c}`} aria-pressed={f.color === c}
                onClick={() => setF(x => ({ ...x, color: c }))} />)}
            </div>
          </Field>
        )}
        {msg && <div className="banner err" style={{ marginTop: 0 }}>{msg}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Saving…" : isNew ? "Create project" : "Save"}</button>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
          {admin && !isNew && (confirmArchive
            ? <span className="confirm" style={{ marginLeft: "auto" }}>{project.archived_at ? "Restore it to the board?" : "Hide it from the board? History is kept."}
                <button type="button" className="btn danger sm" onClick={archive}>{project.archived_at ? "Restore" : "Archive"}</button>
                <button type="button" className="btn ghost sm" onClick={() => setConfirmArchive(false)}>No</button></span>
            : <button type="button" className="btn danger" style={{ marginLeft: "auto" }} onClick={() => setConfirmArchive(true)}>
                {project.archived_at ? "Restore project" : "Archive project"}</button>)}
        </div>
      </form>
    </Dialog>
  );
}
