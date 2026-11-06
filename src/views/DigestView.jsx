// Weekly digest: the same content Matt gets by email on Monday, for any week.
import { useState, useEffect } from "react";
import { fetchDigest, sendDigestNow } from "../supabase.js";
import { fmtDate, addDays, plural } from "../lib.js";
import { Swatch, StatusPill } from "./common.jsx";

export default function DigestView({ access, perms, onError, notify }) {
  const thisWeek = access.week_start;
  const [week, setWeek] = useState(thisWeek);
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setD(null);
    fetchDigest(week).then(r => { if (!live) return; if (r.error) onError(r.error); else setD(r.data); });
    return () => { live = false; };
  }, [week, onError]);

  const send = async () => {
    setBusy(true);
    const r = await sendDigestNow(week);
    setBusy(false);
    if (r.error) return onError(r.error);
    notify(r.data === "Sending" ? "Digest queued to send" : `Digest queued. ${r.data}`);
  };

  const t = d?.totals || {};
  const who = (names) => (names?.length ? names.join(", ") : "unassigned");

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
      <p className="small muted" style={{ marginBottom: 12 }}>Matt gets last week's digest every Monday morning. Admins change the day and recipients under Admin → Email.</p>

      {!d ? <div className="empty">Loading…</div> : (
        <article className="digest">
          <div className="dhead">
            <span className="from">Week of {fmtDate(d.week_start)} – {fmtDate(d.week_end)}</span>
            <h3>{plural(t.moved, "task")} moved forward, {t.blocked} blocked, {t.done_week} done</h3>
          </div>

          <div className="dsec"><h4>Activity by project</h4>
            {d.activity.length === 0 ? <p className="m">Nothing moved this week.</p> : d.activity.map(p => (
              <div className="dgroup" key={p.code}>
                <div className="gh"><Swatch color={p.color} />{p.name} <span className="m">· {p.moved} updated · now {p.pct}% done · lead {p.lead || "none"}</span></div>
                <ul>
                  {(p.tasks || []).map((x, i) => <li key={i}><StatusPill status={x.status} /> {x.title} <span className="m">· {who(x.who)}</span>
                    {x.note && <div className="m small">“{x.note}”</div>}</li>)}
                  {p.moved > (p.tasks?.length || 0) && <li className="m">and {p.moved - p.tasks.length} more</li>}
                </ul>
              </div>
            ))}
            {d.idle.length > 0 && <p className="m small" style={{ marginTop: 12 }}>No updates: {d.idle.map(p => p.name).join(", ")}</p>}
          </div>

          <div className="dsec"><h4>Blocked</h4>
            {d.blocked.length === 0 ? <p className="m">Nothing blocked.</p> : <ul>
              {d.blocked.map((b, i) => <li key={i}><b>{b.project}</b>: {b.title} <span className="m">· waiting on {b.blocked_on || "not specified"} since {fmtDate(b.since)} · {who(b.who)}</span></li>)}
            </ul>}
          </div>

          {d.past_target.length > 0 && <div className="dsec"><h4>Past target date</h4><ul>
            {d.past_target.map(p => <li key={p.code}><b>{p.name}</b> <span className="m">· target {fmtDate(p.target_date)} · {p.open} of {p.total} tasks open</span></li>)}
          </ul></div>}

          {d.quiet.length > 0 && <div className="dsec"><h4>In progress, no update in {d.stale_days}+ days</h4><ul>
            {d.quiet.slice(0, 12).map((q, i) => <li key={i}>{q.title} <span className="m">· {q.project} · {who(q.who)} · {q.last_at ? `last ${fmtDate(q.last_at)}` : "never updated"}</span></li>)}
            {d.quiet.length > 12 && <li className="m">and {d.quiet.length - 12} more</li>}
          </ul></div>}

          <div className="dsec"><h4>Workload</h4>
            <div className="scroll"><table className="tbl">
              <thead><tr><th>Person</th><th className="n">Open</th><th className="n">Blocked</th><th className="n">Done this week</th><th className="n">Moved this week</th></tr></thead>
              <tbody>{d.people.map(x => <tr key={x.name}><td>{x.name}</td><td className="n">{x.open}</td><td className="n">{x.blocked}</td><td className="n">{x.done_week}</td>
                <td className="n" style={x.pct === 0 ? { color: "var(--warn)" } : undefined}>{x.pct == null ? "—" : `${x.pct}%`}</td></tr>)}</tbody>
            </table></div>
          </div>
        </article>
      )}
    </>
  );
}
