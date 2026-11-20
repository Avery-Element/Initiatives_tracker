// Initiatives Tracker shell: sign-in routing (same flow as the other Element apps), header,
// summary tiles, tabs, live data, the permission helpers every screen uses, and deep links from
// emails: #task/<id> opens a task, #checkin/<projectId> opens a check-in, #project/<id> shows a project.
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase, loginName, fetchMyAccess, logSignIn, fetchProjects, fetchTasks, fetchPeople,
         fetchAssignable, subscribeToChanges } from "./supabase.js";
import { LoginPage, SetPasswordForm, NoAccessPage } from "./auth.jsx";
import { fmtDate, plural, currentHealth } from "./lib.js";
import ProjectsView from "./views/ProjectsView.jsx";
import PeopleView from "./views/PeopleView.jsx";
import DigestView from "./views/DigestView.jsx";
import AdminView from "./views/AdminView.jsx";
import TaskPanel from "./views/TaskPanel.jsx";
import CheckinDialog from "./views/CheckinDialog.jsx";

const TABS = [
  { id: "projects", label: "Projects" },
  { id: "people", label: "People" },
  { id: "digest", label: "Weekly digest" },
  { id: "admin", label: "Admin", admin: true },
];
// "#digest" → { tab: "digest" }; "#task/<id>" → { tab: "projects", kind: "task", id }
const parseHash = () => {
  const h = decodeURIComponent(location.hash.slice(1));
  const m = h.match(/^(task|checkin|project)\/([\w-]+)$/);
  if (m) return { tab: "projects", kind: m[1], id: m[2] };
  return { tab: TABS.some(t => t.id === h) ? h : "projects" };
};
const loadingScreen = <div className="loading">Loading…</div>;

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [access, setAccess] = useState(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [tab, setTab] = useState(() => parseHash().tab);
  const [deepLink, setDeepLink] = useState(() => (parseHash().kind ? parseHash() : null));
  const [checkinFor, setCheckinFor] = useState(null);     // project id
  const [focusProject, setFocusProject] = useState(null); // project id to open and scroll to
  const [data, setData] = useState(null);           // { projects, tasks, people, assignable }
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [openTaskId, setOpenTaskId] = useState(null);
  const [personFilter, setPersonFilter] = useState("");
  const userRef = useRef(null);
  const intentionalLogoutRef = useRef(false);
  const reloadGenRef = useRef(0);
  const toastTimer = useRef(null);

  const role = access?.init_role || null;
  const isAdmin = role === "Initiatives Admin";
  const canWrite = isAdmin || role === "Member";
  const myPerson = access?.person_id || null;

  // ── auth ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) { userRef.current = session.user; setUser(session.user); }
      setAuthChecked(true);
    }).catch(err => { console.error("getSession error:", err); setAuthChecked(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(event => {
      if (event === "SIGNED_OUT") {
        if (userRef.current && !intentionalLogoutRef.current) setSessionExpired(true);
        intentionalLogoutRef.current = false;
        userRef.current = null;
        setUser(null); setAccess(null); setData(null); setPasswordRecovery(false);
      }
      if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let live = true;
    fetchMyAccess().then(a => { if (live) setAccess(a || { error: true }); });
    return () => { live = false; };
  }, [userId]);
  const retryAccess = async () => { setAccess(null); setAccess((await fetchMyAccess()) || { error: true }); };
  const handleLogout = async () => { intentionalLogoutRef.current = true; await supabase.auth.signOut(); };

  useEffect(() => {
    const onHash = () => { const h = parseHash(); setTab(h.tab); if (h.kind) setDeepLink(h); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (id) => { location.hash = id; setTab(id); };

  // ── data ──
  const reload = useCallback(async () => {
    const gen = ++reloadGenRef.current;
    const [projects, tasks, people, assignable] = await Promise.all([fetchProjects(), fetchTasks(), fetchPeople(), fetchAssignable()]);
    if (gen !== reloadGenRef.current) return;   // a newer reload already landed
    const err = projects.error || tasks.error || people.error || assignable.error;
    if (err) { setError("Couldn't load the tracker. Check your connection and try again."); return; }
    setData({ projects: projects.data, tasks: tasks.data, people: people.data, assignable: assignable.data || [] });
  }, []);

  const ready = !!role && !access?.disabled && !access?.must_change_password;
  useEffect(() => {
    if (!ready) return;
    logSignIn();
    reload();
    return subscribeToChanges(reload);
  }, [ready, reload]);

  const notify = useCallback((msg) => {
    setToast(msg); clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  // Permission helpers: mirror the database rules so the UI only offers what will work.
  // The database enforces them regardless.
  const perms = useMemo(() => {
    const leadOf = new Set((data?.projects || []).filter(p => myPerson && p.lead_ids?.includes(myPerson)).map(p => p.id));
    const leads = (projectId) => isAdmin || (canWrite && leadOf.has(projectId));
    return {
      isAdmin, canWrite, myPerson, leads,
      canUpdateTask: (t) => leads(t.project_id) || (canWrite && !!myPerson && t.assignee_ids?.includes(myPerson)),
      canEditProject: (p) => leads(p.id),
    };
  }, [data, myPerson, isAdmin, canWrite]);

  // Deep links wait for the data, then open what they point at and tidy the address bar
  useEffect(() => {
    if (!deepLink || !data) return;
    const { kind, id } = deepLink;
    if (kind === "task") setOpenTaskId(id);
    else if (kind === "checkin" && perms.leads(id)) setCheckinFor(id);
    else setFocusProject(id);
    setDeepLink(null);
    history.replaceState(null, "", "#projects");
  }, [deepLink, data, perms]);

  // ── routing ──
  if (!authChecked) return loadingScreen;
  if (passwordRecovery) return <SetPasswordForm onDone={() => { setPasswordRecovery(false); setUser(null); }} />;
  if (!user) return <LoginPage sessionExpired={sessionExpired}
    onLogin={u => { setSessionExpired(false); userRef.current = u; setUser(u); }} />;
  if (!access) return loadingScreen;
  if (access.error || access.disabled || !role) return <NoAccessPage access={access} onLogout={handleLogout} onRetry={retryAccess} />;
  if (access.must_change_password) return <SetPasswordForm forced onLogout={handleLogout}
    onDone={() => setAccess(a => ({ ...a, must_change_password: false }))} />;
  if (!data) return error ? <div className="loading">{error}</div> : loadingScreen;

  const live = data.projects.filter(p => !p.archived_at);
  const liveIds = new Set(live.map(p => p.id));
  const tasks = data.tasks.filter(t => liveIds.has(t.project_id));
  const active = live.filter(p => p.stage !== "Done" && p.stage !== "Parked");
  const health = (h) => active.filter(p => currentHealth(p) === h).length;
  const blocked = tasks.filter(t => t.status === "Blocked").length;
  const overdue = tasks.filter(t => t.overdue).length;
  const moved = tasks.filter(t => t.moved_this_week).length;
  const checkedIn = active.filter(p => p.checkin_this_week).length;
  const openTask = openTaskId && data.tasks.find(t => t.id === openTaskId);
  const checkinProject = checkinFor && live.find(p => p.id === checkinFor);
  const viewProps = { data, access, perms, onChanged: reload, onError: setError, notify, openTask: setOpenTaskId,
                      personFilter, setPersonFilter, go, openCheckin: setCheckinFor, focusProject, setFocusProject };

  return (
    <>
      <header className="top">
        <div className="wrap">
          <div className="brand"><span className="brand-mark" role="img" aria-label="Element" /><b>Element</b><span>Initiatives</span></div>
          <nav className="tabs" role="tablist" aria-label="Views">
            {TABS.filter(t => !t.admin || isAdmin).map(t =>
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)}>{t.label}</button>)}
          </nav>
          <div className="me">
            <span title={loginName(access.email, access.username)}><b>{access.person_name || access.display_name}</b> · {role}</span>
            <button className="linkbtn" onClick={handleLogout}>Log out</button>
          </div>
        </div>
      </header>

      <main className="wrap">
        {error && <div className="banner err" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss">✕</button></div>}
        {canWrite && !myPerson && (
          <div className="banner info"><span>Your login isn't linked to a person yet, so no tasks show as yours. Ask an Initiatives Admin to link it under Admin → People.</span></div>
        )}

        <section className="summary" aria-label="Summary">
          <div className="stat c1" title="Projects that aren't Done or Parked"><span className="k">Active projects</span><span className="v">{active.length}</span>
            <span className="d">{plural(live.filter(p => p.past_target).length, "past target date", "past target date")}</span></div>
          <div className="stat c2" title="From each lead's latest check-in (this week or last)"><span className="k">On track</span><span className="v">{health("On track")} <small>of {active.length}</small></span>
            <span className="d">{health("At risk")} at risk · {health("Off track")} off track</span></div>
          <div className="stat c3" title="Blocked tasks, plus open tasks past their due date"><span className="k">Needs attention</span><span className="v">{blocked + overdue}</span>
            <span className="d">{blocked} blocked · {overdue} past due</span></div>
          <div className="stat c4" title="Active projects whose lead has checked in since Monday"><span className="k">Check-ins this week</span><span className="v">{checkedIn} <small>of {active.length}</small></span>
            <span className="d">Since {fmtDate(access.week_start)} · {plural(moved, "task")} updated</span></div>
        </section>

        {tab === "projects" && <ProjectsView {...viewProps} />}
        {tab === "people" && <PeopleView {...viewProps} />}
        {tab === "digest" && <DigestView {...viewProps} />}
        {tab === "admin" && isAdmin && <AdminView {...viewProps} />}
      </main>

      {openTask && <TaskPanel task={openTask} {...viewProps} onClose={() => setOpenTaskId(null)} />}
      {checkinProject && <CheckinDialog project={checkinProject} access={access} onClose={() => setCheckinFor(null)} onError={setError}
        onSaved={(msg) => { setCheckinFor(null); notify(msg); reload(); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
