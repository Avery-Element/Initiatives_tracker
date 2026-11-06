// Sign-in flow copied from the Maintenance Dashboard (same as Stanley and Shipping):
// username-or-email login, no self sign-up, forced password change after a Manager creates or
// resets an account, and a no-access screen. No idle sign-out: this app is used at desks.
/* eslint-disable react-refresh/only-export-components */
import { useState } from "react";
import { supabase, toLoginEmail, loginName, markPasswordChanged } from "./supabase.js";
import { P, DG, SG, LF, Inp, centered, card, btn } from "./ui.jsx";

export const MIN_PASSWORD = 8;

const linkBtn = { background: "none", border: "none", fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer", textAlign: "center" };

export function LoginPage({ onLogin, sessionExpired }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotOk, setForgotOk] = useState(false);

  const submit = async () => {
    if (!email || !password) { setMsg("Username or email and password are required."); return; }
    setBusy(true); setMsg("");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: toLoginEmail(email), password });
      if (error) throw new Error(error.message === "Invalid login credentials" ? "Wrong username/email or password." : error.message);
      onLogin(data.user);
    } catch (err) { setMsg(err.message); }
    finally { setBusy(false); }
  };

  const sendReset = async () => {
    if (!forgotEmail) { setMsg("Enter your email address."); return; }
    if (!forgotEmail.includes("@")) { setMsg("Username accounts can't reset by email. Ask a Manager to reset your password."); return; }
    setBusy(true); setMsg("");
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail, { redirectTo: window.location.origin });
      if (error) { setMsg(error.message); setForgotOk(false); }
      else { setMsg("Reset email sent! Check your inbox."); setForgotOk(true); }
    } finally { setBusy(false); }
  };

  if (showForgot) return (
    <div style={centered}>
      <div style={card}>
        <h1 style={{ margin: "0 0 0.25rem", fontSize: 18, fontWeight: 500 }}>Reset password</h1>
        <p style={{ margin: "0 0 1.5rem", fontSize: 12, color: "var(--color-text-secondary)" }}>
          Enter your email to receive a reset link. If you sign in with a username, ask a Manager to reset your password.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <LF label="Email"><Inp value={forgotEmail} onChange={setForgotEmail} type="email" placeholder="you@company.com" /></LF>
          {msg && <div style={{ fontSize: 12, color: forgotOk ? SG : DG, lineHeight: 1.4 }}>{msg}</div>}
          <button onClick={sendReset} disabled={busy} style={btn(true, { opacity: busy ? 0.7 : 1 })}>{busy ? "Sending…" : "Send reset email"}</button>
          <button onClick={() => { setShowForgot(false); setMsg(""); }} style={{ ...linkBtn, color: P }}>Back to log in</button>
        </div>
      </div>
    </div>
  );

  const notice = (text) => <div style={{ marginBottom: 12, padding: "8px 12px", background: "#fff8e1", border: "1px solid #f0c040", borderRadius: "var(--border-radius-md)", fontSize: 12, color: "#7a5c00" }}>{text}</div>;

  return (
    <div style={centered}>
      <div style={card}>
        {sessionExpired && notice("Your session expired. Please log in again.")}
        <h1 style={{ margin: "0 0 0.25rem", fontSize: 18, fontWeight: 500 }}>Initiatives</h1>
        <p style={{ margin: "0 0 1.5rem", fontSize: 12, color: "var(--color-text-secondary)" }}>Sign in to continue</p>
        <form onSubmit={e => { e.preventDefault(); submit(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <LF label="Username or email"><Inp value={email} onChange={setEmail} placeholder="jsmith or you@company.com" /></LF>
          <LF label="Password"><Inp value={password} onChange={setPassword} type="password" /></LF>
          {msg && <div style={{ fontSize: 12, color: DG, lineHeight: 1.4 }}>{msg}</div>}
          <button type="submit" disabled={busy} style={btn(true, { padding: 8, marginTop: 4, opacity: busy ? 0.7 : 1 })}>{busy ? "Please wait…" : "Log in"}</button>
          <button type="button" onClick={() => { setShowForgot(true); setForgotEmail(email.includes("@") ? email : ""); setMsg(""); }} style={linkBtn}>Forgot password?</button>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textAlign: "center" }}>Need an account? Ask a Stanley Manager.</div>
        </form>
      </div>
    </div>
  );
}

// Used for the emailed reset link, and (forced) after a Manager creates or resets an account
export function SetPasswordForm({ onDone, forced = false, onLogout }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!password || password !== confirm) { setMsg("Passwords do not match."); return; }
    if (password.length < MIN_PASSWORD) { setMsg(`Password must be at least ${MIN_PASSWORD} characters.`); return; }
    setBusy(true); setMsg("");
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) setMsg(error.message);
      else if (forced) { await markPasswordChanged(); onDone(); }
      else { await supabase.auth.signOut(); onDone(); }
    } finally { setBusy(false); }
  };
  return (
    <div style={centered}>
      <div style={card}>
        <h1 style={{ margin: "0 0 0.25rem", fontSize: 18, fontWeight: 500 }}>{forced ? "Choose your password" : "Set new password"}</h1>
        <p style={{ margin: "0 0 1.5rem", fontSize: 12, color: "var(--color-text-secondary)" }}>
          {forced ? "You signed in with a temporary password. Choose a new one to continue." : "Enter and confirm your new password."}
        </p>
        <form onSubmit={e => { e.preventDefault(); submit(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <LF label="New password"><Inp value={password} onChange={setPassword} type="password" /></LF>
          <LF label="Confirm password"><Inp value={confirm} onChange={setConfirm} type="password" /></LF>
          {msg && <div style={{ fontSize: 12, color: DG, lineHeight: 1.4 }}>{msg}</div>}
          <button type="submit" disabled={busy} style={btn(true, { padding: 8, marginTop: 4, opacity: busy ? 0.7 : 1 })}>{busy ? "Please wait…" : "Set password"}</button>
          {forced && onLogout && <button type="button" onClick={onLogout} style={linkBtn}>Log out</button>}
        </form>
      </div>
    </div>
  );
}

// Signed in, but no Initiatives role (or the account is disabled), or the access check failed
export function NoAccessPage({ access, onLogout, onRetry }) {
  const title = access?.error ? "Couldn't check your access" : access?.disabled ? "Account disabled" : "No access to Initiatives";
  const body = access?.error ? "Check your connection and try again."
    : access?.disabled ? "This account has been disabled. Ask a Manager if you think this is a mistake."
    : <>You're signed in as <b>{loginName(access?.email, access?.username)}</b>, but this account doesn't have access to the Initiatives Tracker yet. Ask an Initiatives Admin (Avery, Matt or Lindsay) to give you a role.</>;
  return (
    <div style={centered}>
      <div style={{ ...card, width: 360 }}>
        <h1 style={{ margin: "0 0 0.5rem", fontSize: 18, fontWeight: 500 }}>{title}</h1>
        <p style={{ margin: "0 0 1.5rem", fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{body}</p>
        <div style={{ display: "flex", gap: 8 }}>
          {access?.error && <button onClick={onRetry} style={btn(false, { flex: 1 })}>Try again</button>}
          <button onClick={onLogout} style={btn(true, { flex: 1 })}>Log out</button>
        </div>
      </div>
    </div>
  );
}
