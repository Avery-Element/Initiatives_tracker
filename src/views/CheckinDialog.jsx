// A lead's weekly check-in for one project: health, one sentence on where it stands, and
// optionally what they need from Matt. One per project per week; saving again replaces it.
// The database allows the project's leads and admins (init_save_checkin).
import { useState } from "react";
import { saveCheckin } from "../supabase.js";
import { HEALTHS, HEALTH_HELP, slug, fmtDate } from "../lib.js";
import { Dialog, Field, Swatch, HealthBadge } from "./common.jsx";

const SUMMARY_MAX = 200;

export default function CheckinDialog({ project, access, onClose, onSaved, onError }) {
  const last = project.latest_checkin;
  const thisWeek = project.checkin_this_week ? last : null;
  // Carry an unanswered ask over from last time, so it doesn't drop off Matt's list by accident
  const carriedAsk = !thisWeek && last?.ask && !last.answer ? last.ask : "";
  const [health, setHealth] = useState(thisWeek?.health || "");
  const [summary, setSummary] = useState(thisWeek?.summary || "");
  const [ask, setAsk] = useState(thisWeek ? thisWeek.ask || "" : carriedAsk);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const save = async (e) => {
    e.preventDefault();
    if (!health) return setMsg("Pick On track, At risk or Off track.");
    if (!summary.trim()) return setMsg("Write one sentence on where it stands.");
    setBusy(true);
    const r = await saveCheckin(project.id, health, summary.trim(), ask.trim());
    setBusy(false);
    if (r.error) return onError(r.error);
    onSaved(thisWeek ? "Check-in updated" : `Checked in on ${project.name}`);
  };

  return (
    <Dialog onClose={onClose} label={`Weekly check-in: ${project.name}`}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <span className="small muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Swatch small color={project.color} /> Weekly check-in · week of {fmtDate(access.week_start)}
          </span>
          <h3>{project.name}</h3>
        </div>

        {last && !thisWeek && (
          <div className="prev">
            <span>Last check-in (week of {fmtDate(last.week_start)}): <HealthBadge small health={last.health} /></span>
            <span>{last.summary}</span>
            {last.ask && <span>Asked Matt: “{last.ask}”{last.answer ? ` · ${last.answered_by || "Answered"}: ${last.answer}` : " · not answered yet"}</span>}
          </div>
        )}

        <div className="field">
          <span id="ck-health-lbl">How is it going?</span>
          <div className="hbtns" role="group" aria-labelledby="ck-health-lbl">
            {HEALTHS.map(h => (
              <button key={h} type="button" className={`hl-${slug(h)}`} aria-pressed={health === h} onClick={() => setHealth(h)}>
                <b>{h}</b><span>{HEALTH_HELP[h]}</span>
              </button>
            ))}
          </div>
        </div>

        <Field label="Where it stands" hint="one sentence">
          <textarea className="ta" id="ck-summary" rows={2} value={summary} maxLength={SUMMARY_MAX} autoFocus={!!health}
            onChange={e => setSummary(e.target.value)} placeholder="Samples approved; waiting on final pricing from the supplier." />
          <span className="counter">{summary.length}/{SUMMARY_MAX}</span>
        </Field>

        <Field label="What do you need from Matt?" hint="optional: a decision, approval, or a door opened">
          <textarea className="ta" id="ck-ask" rows={2} value={ask} maxLength={600} onChange={e => setAsk(e.target.value)}
            placeholder="Leave blank if nothing" />
        </Field>
        {carriedAsk && ask === carriedAsk && <p className="small muted" style={{ marginTop: -8 }}>Carried over from last week because it hasn't been answered. Clear it if you no longer need it.</p>}
        {thisWeek?.answer && ask.trim() !== (thisWeek.ask || "") && <p className="small muted" style={{ marginTop: -8 }}>Changing the ask clears the answer you already got.</p>}

        {msg && <div className="banner err" style={{ marginTop: 0 }}>{msg}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Saving…" : thisWeek ? "Update check-in" : "Check in"}</button>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
