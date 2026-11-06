// Admin: people and logins, email settings and outbox, activity log, archived projects.
import { useState, useEffect, useCallback } from "react";
import { listLogins, setUserRole, savePerson, fetchAllPeople, fetchSettings, saveSettings, sendRemindersNow, sendTest,
         fetchOutbox, fetchActivity, saveProject } from "../supabase.js";
import { DAYS, HOURS, fmtWhen, fmtDate } from "../lib.js";
import { Field, Swatch } from "./common.jsx";

const ROLES = ["Initiatives Admin", "Member", "View Only"];
const SUB = [["people", "People + logins"], ["email", "Email"], ["activity", "Activity log"], ["archived", "Archived projects"]];

export default function AdminView(props) {
  const [sub, setSub] = useState("people");
  return (
    <>
      <div className="toolbar"><h2>Admin</h2></div>
      <div className="subtabs">
        {SUB.map(([id, label]) => <button key={id} className="chip" aria-pressed={sub === id} onClick={() => setSub(id)}>{label}</button>)}
      </div>
      {sub === "people" && <PeopleAdmin {...props} />}
      {sub === "email" && <EmailAdmin {...props} />}
      {sub === "activity" && <ActivityLog {...props} />}
      {sub === "archived" && <Archived {...props} />}
    </>
  );
}

// ── People + logins ─────────────────────────────────────────────
function PeopleAdmin({ data, access, onChanged, onError, notify }) {
  const [logins, setLogins] = useState(null);
  const [people, setPeople] = useState([]);
  const [adding, setAdding] = useState({ display_name: "", email: "" });
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    const [l, p] = await Promise.all([listLogins(), fetchAllPeople()]);
    if (l.error) return onError(l.error);
    if (p.error) return onError(p.error);
    setLogins(l.data); setPeople(p.data);
  }, [onError]);
  useEffect(() => { load(); }, [load, data]);

  const loginById = Object.fromEntries((logins || []).map(l => [l.user_id, l]));
  const linked = new Set(people.filter(p => p.user_id).map(p => p.user_id));

  const update = async (p, fields, msg) => {
    const r = await savePerson(p.id, fields);
    if (r.error) return onError(r.error.includes("init_people_email_idx") ? "Another person already has that email." : r.error);
    notify(msg); load(); onChanged();
  };
  const changeRole = async (userId, role) => {
    const r = await setUserRole(userId, role || null);
    if (r.error) return onError(r.error);
    notify(role ? `Role set to ${role}` : "Access removed"); load();
  };
  const add = async (e) => {
    e.preventDefault();
    if (!adding.display_name.trim()) return;
    const r = await savePerson(null, { display_name: adding.display_name.trim(), email: adding.email.trim() || null });
    if (r.error) return onError(r.error.includes("init_people_name_idx") ? "Someone with that name is already on the list." : r.error);
    setAdding({ display_name: "", email: "" }); notify("Person added"); load(); onChanged();
  };

  if (!logins) return <div className="empty">Loading…</div>;
  const shown = people.filter(p => showInactive || p.active);
  const rolesWithoutPerson = logins.filter(l => l.role && !linked.has(l.user_id));

  return (
    <>
      <div className="card">
        <h3>People</h3>
        <p className="muted">Everyone work can be assigned to. The email is where reminders go, so use a real mailbox. Link a person to their
          login so they can update their own tasks, then give that login a role. New logins are created by a Stanley Manager in Stanley → Users.</p>
        <div className="scroll"><table className="tbl">
          <thead><tr><th>Name</th><th>Email for reminders</th><th>Login</th><th>Role</th><th>Active</th></tr></thead>
          <tbody>
            {shown.map(p => {
              const login = p.user_id ? loginById[p.user_id] : null;
              return (
                <tr key={p.id} style={p.active ? undefined : { opacity: .55 }}>
                  <td><EditText value={p.display_name} label="Name" onSave={v => v && update(p, { display_name: v }, "Name saved")} /></td>
                  <td><EditText value={p.email || ""} label="Email" placeholder="name@elementcontract.com" onSave={v => update(p, { email: v || null }, "Email saved")} /></td>
                  <td>
                    <select className="sel" aria-label={`Login for ${p.display_name}`} value={p.user_id || ""}
                      onChange={e => update(p, { user_id: e.target.value || null }, e.target.value ? "Login linked" : "Login unlinked")}>
                      <option value="">No login</option>
                      {logins.filter(l => l.user_id === p.user_id || !linked.has(l.user_id)).map(l =>
                        <option key={l.user_id} value={l.user_id}>{l.display_name} ({l.username || l.email})</option>)}
                    </select>
                  </td>
                  <td>{login
                    ? <select className="sel" aria-label={`Role for ${p.display_name}`} value={login.role || ""} disabled={login.user_id === access.user_id}
                        onChange={e => changeRole(login.user_id, e.target.value)}>
                        <option value="">No access</option>{ROLES.map(r => <option key={r}>{r}</option>)}
                      </select>
                    : <span className="small muted">Needs a login</span>}</td>
                  <td><input type="checkbox" checked={p.active} aria-label={`${p.display_name} active`}
                    onChange={e => update(p, { active: e.target.checked }, e.target.checked ? "Reactivated" : "Deactivated")} /></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        <form className="addrow" style={{ padding: "12px 0 0" }} onSubmit={add}>
          <input className="inp" type="text" id="add-person-name" placeholder="Name" value={adding.display_name} onChange={e => setAdding({ ...adding, display_name: e.target.value })} aria-label="New person's name" />
          <input className="inp" type="email" id="add-person-email" placeholder="Email for reminders" value={adding.email} onChange={e => setAdding({ ...adding, email: e.target.value })} aria-label="New person's email" />
          <button className="btn" type="submit" disabled={!adding.display_name.trim()}>Add person</button>
          <label className="small muted" style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> Show inactive</label>
        </form>
      </div>

      {rolesWithoutPerson.length > 0 && (
        <div className="card">
          <h3>Logins with a role but no person</h3>
          <p className="muted">These logins can sign in but have no tasks of their own. Link each to a person above, or remove the role.</p>
          <table className="tbl"><tbody>{rolesWithoutPerson.map(l => (
            <tr key={l.user_id}><td>{l.display_name} <span className="small muted">({l.username || l.email})</span></td>
              <td><select className="sel" aria-label={`Role for ${l.display_name}`} value={l.role} disabled={l.user_id === access.user_id} onChange={e => changeRole(l.user_id, e.target.value)}>
                <option value="">No access</option>{ROLES.map(r => <option key={r}>{r}</option>)}</select></td></tr>))}
          </tbody></table>
        </div>
      )}
    </>
  );
}

// Inline text that saves on blur / Enter
function EditText({ value, onSave, label, placeholder }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() !== (value || "")) onSave(v.trim()); };
  return <input className="inp w100" value={v} placeholder={placeholder} aria-label={label} onChange={e => setV(e.target.value)}
    onBlur={commit} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setV(value); }} />;
}

// ── Email ───────────────────────────────────────────────────────
function EmailAdmin({ onError, notify }) {
  const [s, setS] = useState(null);
  const [recip, setRecip] = useState("");
  const [outbox, setOutbox] = useState([]);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([fetchSettings(), fetchOutbox()]);
    if (a.error) return onError(a.error);
    setS(a.data); setRecip((a.data.digest_recipients || []).join(", ")); setOutbox(b.data || []);
  }, [onError]);
  useEffect(() => { load(); }, [load]);

  const save = async (patch, msg = "Saved") => {
    const r = await saveSettings(patch);
    if (r.error) return onError(r.error);
    notify(msg); load();
  };
  const run = async (fn, arg) => {
    setBusy(true); const r = await fn(arg); setBusy(false);
    if (r.error) return onError(r.error);
    notify(r.data); setTimeout(load, 4000);
  };

  if (!s) return <div className="empty">Loading…</div>;
  const Toggle = ({ k, label }) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
      <input type="checkbox" checked={s[k]} onChange={e => save({ [k]: e.target.checked })} />{label}</label>
  );
  const When = ({ dow, hour }) => (
    <div style={{ display: "flex", gap: 8 }}>
      <select className="sel" value={s[dow]} onChange={e => save({ [dow]: Number(e.target.value) })} aria-label="Day">{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
      <select className="sel" value={s[hour]} onChange={e => save({ [hour]: Number(e.target.value) })} aria-label="Hour">{HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}</select>
    </div>
  );

  return (
    <>
      <div className="card">
        <h3>Schedule</h3>
        <p className="muted">Times are Pacific. Email is sent through Resend from the address set in the init-email function's secrets.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Toggle k="email_enabled" label="Send email (turning this off pauses everything below)" />
          <div className="grid2">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Toggle k="digest_enabled" label="Weekly digest" />
              <When dow="digest_dow" hour="digest_hour" />
              <Field label="Digest goes to" hint="comma-separated">
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="inp w100" id="digest-recipients" value={recip} onChange={e => setRecip(e.target.value)} placeholder="matt@elementcontract.com" />
                  <button className="btn sm" onClick={() => save({ digest_recipients: recip.split(/[,;\s]+/).filter(Boolean) }, "Recipients saved")}>Save</button>
                </div>
              </Field>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Toggle k="reminders_enabled" label="Reminders to people with stale tasks" />
              <When dow="reminder_dow" hour="reminder_hour" />
              <Field label="A task is stale after" hint="days without a status change or note">
                <select className="sel" value={s.stale_days} onChange={e => save({ stale_days: Number(e.target.value) })}>
                  {[3, 5, 7, 10, 14, 21].map(n => <option key={n} value={n}>{n} days</option>)}</select>
              </Field>
            </div>
          </div>
          <Toggle k="notify_assigned" label="Email people when they're added to a task" />
          <Field label="Link in emails" hint="the tracker's web address">
            <EditText value={s.app_url || ""} label="App URL" placeholder="https://initiatives.yourdomain.com" onSave={v => save({ app_url: v }, "Link saved")} />
          </Field>
        </div>
      </div>

      <div className="card">
        <h3>Send now</h3>
        <p className="muted">Reminders only go to people with something overdue or stale. Each send shows up in the outbox below within a minute.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" disabled={busy} onClick={() => run(sendRemindersNow)}>Send reminders now</button>
          <input className="inp" type="email" id="test-to" placeholder="Test address (default: yours)" value={testTo} onChange={e => setTestTo(e.target.value)} aria-label="Test email address" />
          <button className="btn ghost" disabled={busy} onClick={() => run(sendTest, testTo)}>Send a test</button>
          <span className="small muted">The digest has its own button on the Weekly digest tab.</span>
        </div>
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}><h3>Outbox</h3><button className="linkbtn" onClick={load}>Refresh</button></div>
        {outbox.length === 0 ? <p className="small muted">Nothing sent yet.</p> : (
          <div className="scroll"><table className="tbl">
            <thead><tr><th>Queued</th><th>Kind</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
            <tbody>{outbox.map(o => (
              <tr key={o.id}>
                <td className="small">{fmtWhen(o.created_at)}</td><td className="small">{o.kind}</td>
                <td className="small">{o.recipients.join(", ")}</td><td className="small">{o.subject}</td>
                <td className="small">{o.sent_at ? <span style={{ color: "var(--s-done)" }}>Sent {fmtWhen(o.sent_at)}</span>
                  : o.last_error ? <span style={{ color: "var(--s-block)" }} title={o.last_error}>Failed ({o.attempts}): {o.last_error.slice(0, 80)}</span>
                  : "Waiting"}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

// ── Activity log ────────────────────────────────────────────────
const KIND_LABEL = { project_created: "created project", stage: "changed stage", project_edit: "edited project", archived: "archived", restored: "restored",
  task_created: "added task", status: "changed status", note: "added a note", assigned: "assigned", unassigned: "unassigned", due: "changed due date",
  title: "renamed task", blocked_on: "marked waiting on", task_deleted: "deleted task", person: "updated person", role: "changed role", signin: "signed in" };

function ActivityLog({ data, onError }) {
  const [project, setProject] = useState("");
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    fetchActivity({ projectId: project || null }).then(r => { if (!live) return; if (r.error) onError(r.error); else setRows(r.data); });
    return () => { live = false; };
  }, [project, onError]);
  const pname = Object.fromEntries(data.projects.map(p => [p.id, p]));
  return (
    <div className="card">
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <h3 style={{ marginRight: "auto" }}>Activity log</h3>
        <select className="sel" value={project} onChange={e => setProject(e.target.value)} aria-label="Filter by project">
          <option value="">All projects</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      {!rows ? <p className="small muted">Loading…</p> : (
        <div className="scroll"><table className="tbl">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Project</th><th>Item</th><th>Change</th></tr></thead>
          <tbody>{rows.map(a => (
            <tr key={a.id}>
              <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtWhen(a.at)}</td>
              <td className="small">{String(a.actor || "").split("@")[0]}</td>
              <td className="small">{KIND_LABEL[a.kind] || a.kind}</td>
              <td className="small">{a.project_id && pname[a.project_id] ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Swatch small color={pname[a.project_id].color} />{pname[a.project_id].code}</span> : ""}</td>
              <td className="small">{a.label}</td>
              <td className="small">{a.kind === "due" ? `${fmtDate(a.old_value) || "none"} → ${fmtDate(a.new_value) || "none"}`
                : a.old_value || a.new_value ? [a.old_value, a.new_value].filter(Boolean).join(" → ").slice(0, 140) : ""}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
}

// ── Archived ────────────────────────────────────────────────────
function Archived({ data, onChanged, onError, notify }) {
  const list = data.projects.filter(p => p.archived_at);
  const restore = async (p) => {
    const r = await saveProject(p.id, { archived_at: null });
    if (r.error) return onError(r.error);
    notify(`Restored ${p.name}`); onChanged();
  };
  return (
    <div className="card">
      <h3>Archived projects</h3>
      {list.length === 0 ? <p className="small muted">None. Archive a project from its Edit project dialog.</p> : (
        <table className="tbl"><tbody>{list.map(p => (
          <tr key={p.id}><td><span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><Swatch color={p.color} />{p.name}</span></td>
            <td className="small muted">{p.done_count} of {p.task_count} done · archived {fmtWhen(p.archived_at)}</td>
            <td style={{ textAlign: "right" }}><button className="btn ghost sm" onClick={() => restore(p)}>Restore</button></td></tr>))}
        </tbody></table>
      )}
    </div>
  );
}
