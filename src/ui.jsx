// Primitives the shared sign-in screens use (same names as Stanley / Shipping / Maintenance src/ui.jsx).
// The rest of this app is styled with classes in index.css.
/* eslint-disable react-refresh/only-export-components */

export const P = "#2F7D2D", DG = "#D63B2F", SG = "#0E8A6C";
export const BDRS = "1px solid var(--line-2)";

export function Inp({ value, onChange, type = "text", disabled = false, style = {}, placeholder, autoFocus, required }) {
  return <input type={type} value={value ?? ""} onChange={e => onChange(e.target.value)} disabled={disabled}
    placeholder={placeholder} autoFocus={autoFocus} required={required} className="inp"
    style={{ width: "100%", fontSize: 14, ...style }} />;
}

export const LF = ({ label, children, hint }) => (
  <div>
    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 3 }}>{label}</div>
    {children}
    {hint && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{hint}</div>}
  </div>
);

export const btn = (primary = false, extra = {}) => ({
  fontSize: 14, padding: "7px 14px", cursor: "pointer", borderRadius: 8, fontWeight: 600,
  border: primary ? "none" : BDRS, background: primary ? "var(--accent)" : "transparent",
  color: primary ? "var(--accent-ink)" : "var(--color-text-primary)", ...extra,
});

export const centered = { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16, fontFamily: "var(--font-sans)", background: "var(--color-background-secondary)" };
export const card = { width: 360, maxWidth: "100%", boxSizing: "border-box", border: "1px solid var(--line)", borderTop: "3px solid var(--brand)", borderRadius: 12, padding: "2rem", background: "var(--color-background-primary)", boxShadow: "var(--shadow)" };
