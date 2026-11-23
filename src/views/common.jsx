// Small shared pieces: avatars, swatches, status pill + select, health badge, ask + answer,
// progress bar, panel, dialog.
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from "react";
import { STATUSES, STATUS_HELP, HEALTH_HELP, slug, hue, initials } from "../lib.js";
import { answerAsk } from "../supabase.js";

export const Avatar = ({ name }) => (
  <span className="av" style={{ "--h": hue(name) }} title={name}>{initials(name)}</span>
);
export const Avatars = ({ names = [], max = 5 }) => (
  <span className="avs">
    {names.slice(0, max).map(n => <Avatar key={n} name={n} />)}
    {names.length > max && <span className="av more" title={names.slice(max).join(", ")}>+{names.length - max}</span>}
  </span>
);
export const Swatch = ({ color, small }) => <span className={small ? "sw" : "swatch"} style={{ "--pc": color }} aria-hidden="true" />;
export const StatusPill = ({ status }) => <span className={`pill st-${slug(status)}`} title={STATUS_HELP[status]}>{status}</span>;

// On track / At risk / Off track from the latest check-in; grey "No check-in" when there isn't a recent one
export const HealthBadge = ({ health, small }) => (
  <span className={`pill hl-${slug(health || "none")}${small ? " sm" : ""}`} title={HEALTH_HELP[health || "No check-in"]}>{health || "No check-in"}</span>
);

export function StatusSelect({ value, onChange, disabled, label, id }) {
  return (
    <select id={id} className={`status st-${slug(value)}`} value={value} disabled={disabled}
      aria-label={label} onClick={e => e.stopPropagation()} onChange={e => onChange(e.target.value)}>
      {STATUSES.map(s => <option key={s} value={s} title={STATUS_HELP[s]}>{s}</option>)}
    </select>
  );
}

// Segmented progress bar: done / in progress / blocked out of total
export function Bar({ done = 0, inProgress = 0, blocked = 0, total = 0, label }) {
  const w = (n) => (total ? (n / total) * 100 : 0) + "%";
  return (
    <div className="bar" role="img" aria-label={label || `${done} done, ${inProgress} in progress, ${blocked} blocked of ${total}`}>
      <i className="b-done" style={{ width: w(done) }} /><i className="b-prog" style={{ width: w(inProgress) }} /><i className="b-block" style={{ width: w(blocked) }} />
    </div>
  );
}

// Health legend for the Projects screen
export const Legend = () => (
  <div className="legend">
    <span title={HEALTH_HELP["On track"]}><i style={{ background: "var(--s-done)" }} />On track</span>
    <span title={HEALTH_HELP["At risk"]}><i style={{ background: "var(--s-risk)" }} />At risk</span>
    <span title={HEALTH_HELP["Off track"]}><i style={{ background: "var(--s-block)" }} />Off track</span>
    <span title={HEALTH_HELP["No check-in"]}><i style={{ background: "var(--sunk)", outline: "1px solid var(--line-2)" }} />No check-in in 2 weeks</span>
    <span className="legend-note">Health comes from each lead's weekly check-in.</span>
  </div>
);

// A check-in's "what I need from Matt", with its answer. Admins answer (or change the answer)
// in place; everyone else sees whether it's still waiting.
export function AskAnswer({ checkin, canAnswer, onChanged, onError, notify }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!checkin?.ask) return null;
  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = await answerAsk(checkin.checkin_id || checkin.id, text);
    setBusy(false);
    if (r.error) return onError(r.error);
    notify(text.trim() ? "Answer sent to the project's leads" : "Answer removed");
    setEditing(false); setText(""); onChanged();
  };
  const answer = checkin.answer;
  const by = checkin.answered_by || checkin.answered_by_name;
  return (
    <div className="ask">
      <div className="ask-q"><span className="ask-k">Ask for Matt</span> “{checkin.ask}”</div>
      {answer && !editing && (
        <div className="ask-a"><span className="ask-k">{by || "Answer"}</span> {answer}
          {canAnswer && <button type="button" className="linkbtn" onClick={() => { setText(answer); setEditing(true); }}>Change</button>}
        </div>
      )}
      {!answer && !editing && (canAnswer
        ? <button type="button" className="btn sm" onClick={() => setEditing(true)}>Answer</button>
        : <div className="small muted">Waiting for an answer.</div>)}
      {editing && (
        <form className="ask-form" onSubmit={send}>
          <textarea className="ta" rows={2} value={text} onChange={e => setText(e.target.value)} maxLength={1200} autoFocus
            aria-label={`Answer to: ${checkin.ask}`} placeholder="Your answer goes to the project's leads by email" />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" type="submit" disabled={busy || (!text.trim() && !answer)}>{busy ? "Sending…" : text.trim() ? "Send answer" : "Remove answer"}</button>
            <button className="btn ghost sm" type="button" onClick={() => { setEditing(false); setText(""); }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

function useEscape(onClose) {
  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

// Slides in from the right (task details)
export function Panel({ onClose, children, label }) {
  useEscape(onClose);
  return (
    <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="panel" role="dialog" aria-modal="true" aria-label={label}>{children}</aside>
    </div>
  );
}

// Centered dialog (project form, confirmations)
export function Dialog({ onClose, children, label }) {
  useEscape(onClose);
  return (
    <div className="scrim center" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}

export const Field = ({ label, hint, children }) => (
  <label className="field"><span>{label}{hint && <> <span className="hint">{hint}</span></>}</span>{children}</label>
);
