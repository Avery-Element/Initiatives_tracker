// Small shared pieces: avatars, swatches, status pill + select, progress bar, panel, dialog.
/* eslint-disable react-refresh/only-export-components */
import { useEffect } from "react";
import { STATUSES, slug, hue, initials } from "../lib.js";

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
export const StatusPill = ({ status }) => <span className={`pill st-${slug(status)}`}>{status}</span>;

export function StatusSelect({ value, onChange, disabled, label, id }) {
  return (
    <select id={id} className={`status st-${slug(value)}`} value={value} disabled={disabled}
      aria-label={label} onClick={e => e.stopPropagation()} onChange={e => onChange(e.target.value)}>
      {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
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

export const Legend = () => (
  <div className="legend">
    <span><i style={{ background: "var(--s-done)" }} />Done</span>
    <span><i style={{ background: "var(--s-prog)" }} />In progress</span>
    <span><i style={{ background: "var(--s-block)" }} />Blocked</span>
    <span><i style={{ background: "var(--sunk)", outline: "1px solid var(--line-2)" }} />Not started or parked</span>
  </div>
);

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
