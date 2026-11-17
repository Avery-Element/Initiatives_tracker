// New / edit project. Admins edit everything, including who leads it and who the stakeholders
// are; a project's leads can change its stage, summary, priority and target date (the database
// enforces the same split).
import { useState, useRef, useLayoutEffect, useCallback } from "react";
import { saveProject, setProjectPeople } from "../supabase.js";
import { STATUSES, PRIORITIES, SWATCHES } from "../lib.js";
import { Dialog, Field } from "./common.jsx";

// A select-style button that opens a checkbox list, for picking any number of people.
// `exclude` hides people already picked elsewhere. The list is position: fixed so the
// dialog's scrolling doesn't clip it; it opens upward when there's no room below.
function PeopleSelect({ id, label, hint, people, value, onChange, exclude = [], placeholder = "Nobody" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const pop = useRef(null);
  const shown = people.filter(p => !exclude.includes(p.id));
  const names = people.filter(p => value.includes(p.id)).map(p => p.display_name);
  const summary = names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  const toggle = (pid) => onChange(value.includes(pid) ? value.filter(x => x !== pid) : [...value, pid]);

  const place = useCallback(() => {
    if (!btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 220 && above > below;
    setPos({ left: r.left, width: r.width, maxHeight: Math.min(300, up ? above : below),
             ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onDown = (e) => { if (!btn.current?.contains(e.target) && !pop.current?.contains(e.target)) setOpen(false); };
    // Capture phase, so Escape closes the list without also closing the dialog
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return (
    <div className="field">
      <span id={`${id}-lbl`}>{label}{hint && <> <span className="hint">{hint}</span></>}</span>
      <button type="button" ref={btn} id={id} className="sel w100 msel-btn" disabled={!shown.length}
        aria-haspopup="true" aria-expanded={open} aria-controls={`${id}-list`} aria-labelledby={`${id}-lbl ${id}`}
        onClick={() => setOpen(o => !o)}>
        <span className={`v${names.length ? "" : " ph"}`} title={names.join(", ")}>
          {shown.length ? summary || placeholder : "Everyone is already a lead"}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && pos && (
        <div ref={pop} id={`${id}-list`} className="msel-pop" role="group" aria-label={label} style={pos}>
          <div className="msel-opts">
            {shown.map(p => (
              <label key={p.id}>
                <input type="checkbox" checked={value.includes(p.id)} onChange={() => toggle(p.id)} />
                {p.display_name}
              </label>
            ))}
          </div>
          <div className="msel-foot">
            <span>{value.length} selected</span>
            {value.length > 0 && <button type="button" onClick={() => onChange([])}>Clear</button>}
            <button type="button" onClick={() => { setOpen(false); btn.current?.focus(); }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// The database needs a short unique code per project (shown on People and Admin). New projects
// get one made from the name's leading words ("Loft Chair launch" -> "LOFT-CHAIR"), max 13 chars
// so a "-2".."-99" suffix still fits the 16-char limit if the code is already taken.
function codeFromName(name) {
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) || [];
  let code = "";
  for (const w of words) {
    const next = code ? `${code}-${w}` : w;
    if (next.length > 13) { if (!code) code = w.slice(0, 13); break; }
    code = next;
  }
  return code.length >= 2 ? code : `PROJ${code}`;
}

export default function ProjectDialog({ project, people, perms, onClose, onSaved, onError }) {
  const isNew = !project;
  const admin = perms.isAdmin;
  const [f, setF] = useState(() => ({
    name: project?.name || "", summary: project?.summary || "",
    leads: project?.lead_ids || [], stakeholders: project?.stakeholder_ids || [], stage: project?.stage || "Not started",
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
    if (admin && !f.name.trim()) {
      setMsg("Give the project a name.");
      return;
    }
    const lead = { stage: f.stage, summary: f.summary.trim() || null, priority: f.priority || null, target_date: f.target_date || null };
    const fields = admin ? { ...lead, name: f.name.trim(), color: f.color } : lead;
    setBusy(true);
    let r;
    if (isNew) {
      // Try the name's code, then CODE-2, CODE-3… if another project already has it
      const base = codeFromName(fields.name);
      for (let n = 1; n < 100; n++) {
        r = await saveProject(undefined, { ...fields, code: n === 1 ? base : `${base}-${n}` });
        if (!r.error?.includes("init_projects_code_idx")) break;
      }
    } else {
      r = await saveProject(project.id, fields);
    }
    if (r.error) { setBusy(false); return setMsg(r.error); }
    if (admin) {
      const p = await setProjectPeople(r.data.id, f.leads, f.stakeholders.filter(id => !f.leads.includes(id)));
      if (p.error) { setBusy(false); return setMsg(`Saved the project, but not its leads and stakeholders: ${p.error}`); }
    }
    setBusy(false);
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
          <Field label="Name"><input className="inp w100" id="pj-name" value={f.name} onChange={set("name")} autoFocus={isNew} /></Field>
        )}
        <Field label="Summary" hint="one or two sentences">
          <textarea className="ta" id="pj-summary" rows={2} value={f.summary} onChange={set("summary")} />
        </Field>
        {admin && (
          <div className="grid2">
            <PeopleSelect id="pj-leads" label="Leads" people={people} value={f.leads} placeholder="No lead"
              onChange={leads => setF(x => ({ ...x, leads, stakeholders: x.stakeholders.filter(id => !leads.includes(id)) }))} />
            <PeopleSelect id="pj-stakeholders" label="Stakeholders" people={people} value={f.stakeholders} exclude={f.leads}
              placeholder="None" onChange={stakeholders => setF(x => ({ ...x, stakeholders }))} />
          </div>
        )}
        <div className="grid2">
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
