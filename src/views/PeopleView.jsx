// People: workload and how much of it moved this week. Click a card to see that person's tasks.
import { Avatar, Swatch } from "./common.jsx";
import { plural } from "../lib.js";

export default function PeopleView({ data, setPersonFilter, go }) {
  const colors = Object.fromEntries(data.projects.map(p => [p.code, p.color]));
  const people = [...data.people].filter(p => p.open_count + p.done_count > 0 || p.lead_of?.length)
    .sort((a, b) => b.open_count - a.open_count || a.display_name.localeCompare(b.display_name));
  const idle = data.people.filter(p => !people.includes(p));
  const max = Math.max(1, ...people.map(p => p.open_count));

  return (
    <>
      <div className="toolbar"><h2>People</h2></div>
      <div className="legend">
        <span>Big number: share of their open tasks with a status change or note since Monday</span>
        <span><i style={{ background: "var(--s-prog)" }} />In progress</span>
        <span><i style={{ background: "var(--s-block)" }} />Blocked</span>
      </div>
      {people.length === 0 ? <div className="empty">Nobody has tasks yet.</div> : (
        <div className="people">
          {people.map(x => {
            const pct = x.open_count ? Math.round((Math.min(x.moved_this_week, x.open_count) / x.open_count) * 100) : null;
            return (
              <button key={x.id} className="person" onClick={() => { setPersonFilter(x.id); go("projects"); }}
                aria-label={`${x.display_name}: show their tasks`}>
                <div className="ph"><Avatar name={x.display_name} />
                  <div><div className="nm">{x.display_name}</div>
                    <div className="small muted">{plural(x.project_codes.length, "project")}{x.lead_of?.length ? ` · leads ${x.lead_of.length}` : ""}{!x.user_id ? " · no login yet" : ""}</div></div>
                </div>
                <div className="headline">
                  <b className={pct === 0 ? "zero" : ""}>{pct == null ? "—" : `${pct}%`}</b>
                  <span>{pct == null ? "nothing open" : "of open tasks updated this week"}</span>
                </div>
                <div className="kv">
                  <div><b>{x.open_count}</b><span>Open</span></div>
                  <div><b>{x.blocked_count}</b><span>Blocked</span></div>
                  <div><b>{x.done_this_week}</b><span>Done this week</span></div>
                </div>
                <div className="bar" style={{ width: `${(x.open_count / max) * 100}%`, minWidth: 8 }} role="img" aria-label={`Workload: ${x.open_count} open tasks`}>
                  <i className="b-prog" style={{ width: `${x.open_count ? (x.in_progress_count / x.open_count) * 100 : 0}%` }} />
                  <i className="b-block" style={{ width: `${x.open_count ? (x.blocked_count / x.open_count) * 100 : 0}%` }} />
                </div>
                <div className="pchips">{x.project_codes.map(c => <span key={c}><Swatch color={colors[c]} small />{c}</span>)}</div>
              </button>
            );
          })}
        </div>
      )}
      {idle.length > 0 && <p className="small muted" style={{ marginTop: -32, paddingBottom: 40 }}>Not on any task right now: {idle.map(p => p.display_name).join(", ")}</p>}
    </>
  );
}
