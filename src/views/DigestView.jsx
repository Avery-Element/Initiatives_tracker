// Weekly digest: what Matt gets by email on Monday, for any week. Same order as the email:
// a note from an admin, asks for Matt, three headline lines, how current the data is, every
// project by department with its health, then blocked / late / candidates to park, and workload.
// Admins write the note and answer asks right here.
import { useState, useEffect, useCallback } from "react";
import { fetchDigest, sendDigestNow, saveDigestNote } from "../supabase.js";
import { fmtDate, addDays, plural } from "../lib.js";
import { Swatch, StatusPill, HealthBadge, AskAnswer } from "./common.jsx";

const names = (list = [], max = 6) => (list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} and ${list.length - max} more`);

export default function DigestView({ access, perms, onError, notify, onChanged, openTask, go, setFocusProject }) {
  const thisWeek = access.week_start;
  const [week, setWeek] = useState(thisWeek);
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [noteEdit, setNoteEdit] = useState(null);   // text while editing the note

  const load = useCallback(async (w, live = { current: true }) => {
    const r = await fetchDigest(w);
    if (!live.current) return;
    if (r.error) onError(r.error); else setD(r.data);
  }, [onError]);
  useEffect(() => {
    const live = { current: true };
    setD(null); setNoteEdit(null);
    load(week, live);
    return () => { live.current = false; };
  }, [week, load]);
  const changed = () => { load(week); onChanged(); };

  const send = async () => {
    setBusy(true);
    const r = await sendDigestNow(week);
    setBusy(false);
    if (r.error) return onError(r.error);
    notify(r.data === "Sending" ? "Digest queued to send" : `Digest queued. ${r.data}`);
  };
  const saveNote = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = await saveDigestNote(week, noteEdit);
    setBusy(false);
    if (r.error) return onError(r.error);
    notify(noteEdit.trim() ? "Note saved" : "Note removed");
    setNoteEdit(null); load(week);
  };
  const showProject = (id) => { setFocusProject(id); go("projects"); };
  const ProjectLink = ({ id, color, name }) => (
    <button type="button" className="linkbtn" style={{ textDecoration: "none", fontWeight: 600, color: "var(--ink)", display: "inline-flex", alignItems: "center", gap: 6 }}
      onClick={() => showProject(id)}><Swatch small color={color} />{name}</button>
  );

  const who = (list) => (list?.length ? list.join(", ") : "unassigned");
  const hl = d?.headline || {}, dq = d?.data_quality || {};
  const openAsks = (d?.asks || []).filter(a => !a.answer).length;
  let lastDept = null;

  return (
    <>
      <div className="toolbar">
        <h2>Weekly digest</h2>
        <div className="weekpick">
          <button className="btn ghost sm" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">←</button>
          <span className="small" style={{ minWidth: 150, textAlign: "center" }}>
            {week === thisWeek ? "This week so far" : week === addDays(thisWeek, -7) ? "Last week" : `Week of ${fmtDate(week)}`}
          </span>
          <button className="btn ghost sm" onClick={() => setWeek(addDays(week, 7))} disabled={week >= thisWeek} aria-label="Next week">→</button>
        </div>
        {perms.isAdmin && <button className="btn" onClick={send} disabled={busy}>{busy ? "Queuing…" : "Email this digest now"}</button>}
      </div>
      <p className="intro">What Matt gets every Monday morning, covering the week before. {perms.isAdmin ? "Admins can add a note for the week and answer asks here." : ""}</p>

      {!d ? <div className="empty">Loading…</div> : (
        <article className="digest">
          <div className="dhead">
            <span className="from">Week of {fmtDate(d.week_start)} – {fmtDate(d.week_end)}</span>
            <h3>{hl.on_track || hl.at_risk || hl.off_track
              ? <><b className={`wn${hl.on_track ? " on" : ""}`}>{hl.on_track}</b> on track, <b className={`wn${hl.at_risk ? " risk" : ""}`}>{hl.at_risk}</b> at risk, <b className={`wn${hl.off_track ? " off" : ""}`}>{hl.off_track}</b> off track{hl.no_checkin ? `, ${hl.no_checkin} without a check-in` : ""}.</>
              : hl.no_checkin ? `No check-ins in the last two weeks from ${plural(hl.no_checkin, "active project")}.` : "No active projects."}</h3>
          </div>

          {(d.note || perms.isAdmin) && (
            <div className="dsec">
              <h4>Note for the week</h4>
              {noteEdit != null ? (
                <form onSubmit={saveNote} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <textarea className="ta" rows={3} value={noteEdit} maxLength={2000} autoFocus onChange={e => setNoteEdit(e.target.value)}
                    aria-label="Note for the week" placeholder="Context for Matt, or what to raise at the Monday meeting" />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn sm" type="submit" disabled={busy}>{noteEdit.trim() ? "Save note" : "Remove note"}</button>
                    <button className="btn ghost sm" type="button" onClick={() => setNoteEdit(null)}>Cancel</button>
                  </div>
                </form>
              ) : d.note ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                  <div className="dnote">{d.note}</div>
                  {perms.isAdmin && <button className="linkbtn small" onClick={() => setNoteEdit(d.note)}>Edit note</button>}
                </div>
              ) : (
                <button className="btn ghost sm" onClick={() => setNoteEdit("")}>Add a note</button>
              )}
            </div>
          )}

          <div className="dsec"><h4>Asks for Matt{openAsks ? ` (${openAsks} open)` : ""}</h4>
            {d.asks.length === 0 ? <p className="m">Nothing asked this week.</p> : d.asks.map(a => (
              <div className="dask" key={a.checkin_id}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <ProjectLink id={a.project_id} color={a.color} name={a.name} />
                  <HealthBadge small health={a.health} />
                  <span className="m small">{a.lead || "no lead"}{!a.answer && a.days_open > 0 ? ` · open ${plural(a.days_open, "day")}` : ""}</span>
                </div>
                <AskAnswer checkin={a} canAnswer={perms.isAdmin} onChanged={changed} onError={onError} notify={notify} />
              </div>
            ))}
          </div>

          <div className="dsec"><h4>This week</h4>
            <div className="hlines">
              <div><b>Moving:</b> {hl.moving.length ? `${plural(hl.moving.length, "project")}: ${names(hl.moving)}` : <span className="m">nothing moved</span>}</div>
              <div><b>Stuck:</b> {hl.blocked_tasks ? `${plural(hl.blocked_tasks, "blocked task")} across ${plural(hl.blocked_projects, "project")} (below)` : <span className="m">nothing blocked</span>}</div>
              <div><b>Quiet:</b> {hl.quiet.length ? `${plural(hl.quiet.length, "project")}: ${names(hl.quiet)}` : <span className="m">none</span>}</div>
            </div>
          </div>
          <div className="dq" title="How much of this picture is current">
            {dq.checkins_in} of {dq.checkins_expected} check-ins in{dq.missing?.length ? ` (missing: ${names(dq.missing.map(m => m.name), 4)})` : ""}
            {dq.pct_open_touched != null && <> · {dq.pct_open_touched}% of open tasks updated</>}
            {dq.not_heard_from?.length > 0 && <> · not heard from in 2 weeks: {names(dq.not_heard_from)}</>}
          </div>

          <div className="dsec"><h4>Projects</h4>
            {d.projects.length === 0 ? <p className="m">No projects.</p> : d.projects.map(p => {
              const dept = p.department || "No department";
              const head = dept !== lastDept ? <div className="ddept">{dept}</div> : null;
              lastDept = dept;
              return (
                <div key={p.project_id}>
                  {head}
                  <div className="dproj">
                    <span>{p.stage === "Done" || p.stage === "Parked" ? <StatusPill status={p.stage} /> : <HealthBadge small health={p.health} />}</span>
                    <span className="nm"><ProjectLink id={p.project_id} color={p.color} name={p.name} />
                      <span className="m small" style={{ fontWeight: 400 }}>· {p.lead || "no lead"} · {p.done} of {plural(p.total, "task")} done
                        {p.days_late ? <> · <span className="late">{plural(p.days_late, "day")} past target</span></> : p.target_date ? ` · target ${fmtDate(p.target_date)}` : ""}</span></span>
                    {p.summary && p.stage !== "Done" && <span className="sub">{p.summary}{p.health && !p.checkin_current ? " (last week)" : ""}</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="dsec"><h4>Blocked</h4>
            {d.blocked.length === 0 ? <p className="m">Nothing blocked.</p> : <ul>
              {d.blocked.map(b => <li key={b.task_id}>
                <button type="button" className="linkbtn" style={{ textDecoration: "none", color: "var(--ink)" }} onClick={() => openTask(b.task_id)}><b>{b.project}</b>: {b.title}</button>
                <span className="m"> · waiting on {b.waiting_on || "not specified"} since {fmtDate(b.since)} · {who(b.who)}</span></li>)}
            </ul>}
          </div>

          {d.past_target.length > 0 && <div className="dsec"><h4>Past target date</h4><ul>
            {d.past_target.map(p => <li key={p.project_id}><b>{p.name}</b> <span className="m">· target {fmtDate(p.target_date)} · {p.open} of {p.total} tasks open</span></li>)}
          </ul></div>}

          {d.park_candidates.length > 0 && <div className="dsec"><h4>Too much on the go?</h4>
            <p className="m small" style={{ marginBottom: 8 }}>No movement in 3+ weeks. Worth deciding whether to park or close these.</p>
            <ul>{d.park_candidates.map(p => <li key={p.project_id}><ProjectLink id={p.project_id} color={p.color} name={p.name} />
              <span className="m"> · {p.lead || "no lead"} · quiet {plural(p.weeks_quiet, "week")}</span></li>)}</ul>
          </div>}

          <div className="dsec"><h4>Workload</h4>
            <div className="scroll"><table className="tbl">
              <thead><tr><th>Person</th><th className="n">Open</th><th className="n">Blocked</th><th className="n">Done this week</th><th className="n">Last update</th></tr></thead>
              <tbody>{d.people.map(x => <tr key={x.name}><td>{x.name}</td><td className="n">{x.open}</td><td className="n">{x.blocked}</td><td className="n">{x.done_week}</td>
                <td className="n muted">{x.last_update ? fmtDate(x.last_update) : "—"}</td></tr>)}</tbody>
            </table></div>
          </div>
        </article>
      )}
    </>
  );
}
