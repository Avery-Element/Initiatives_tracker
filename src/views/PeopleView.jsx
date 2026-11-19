// People: who's carrying what. Open / blocked / overdue counts, what they lead, and when their
// tasks last moved. It's for spotting overload and stuck work, not for scoring people, so
// there's no per-person "% updated" here. Click a card to see that person's tasks.
import { Avatar, Swatch } from "./common.jsx";
import { plural, fmtDate, localDay } from "../lib.js";

export default function PeopleView({ data, setPersonFilter, go }) {
  const colors = Object.fromEntries(data.projects.map(p => [p.code, p.color]));
  const people = [...data.people].filter(p => p.open_count + p.done_count > 0 || p.lead_of?.length || p.stakeholder_of?.length)
    .sort((a, b) => b.open_count - a.open_count || a.display_name.localeCompare(b.display_name));
  const idle = data.people.filter(p => !people.includes(p));
  const max = Math.max(1, ...people.map(p => p.open_count));

  return (
    <>
      <div className="toolbar"><h2>People</h2></div>
      <p className="intro">Who's carrying what. For spotting overload and stuck work, not for scoring people.</p>
      <div className="legend">
        <span>Bar: open tasks</span>
        <span><i style={{ background: "var(--s-prog)" }} />In progress</span>
        <span><i style={{ background: "var(--s-block)" }} />Blocked</span>
      </div>
      {people.length === 0 ? <div className="empty">Nobody has tasks yet.</div> : (
        <div className="people">
          {people.map(x => (
            <button key={x.id} className="person" onClick={() => { setPersonFilter(x.id); go("projects"); }}
              aria-label={`${x.display_name}: show their tasks`}>
              <div className="ph"><Avatar name={x.display_name} />
                <div><div className="nm">{x.display_name}</div>
                  <div className="small muted">{plural(x.project_codes.length, "project")}{x.lead_of?.length ? ` · leads ${x.lead_of.length}` : ""}{x.stakeholder_of?.length ? ` · stakeholder on ${x.stakeholder_of.length}` : ""}{!x.user_id ? " · no login yet" : ""}</div></div>
              </div>
              <div className="headline">
                <b>{x.open_count}</b>
                <span>{x.open_count === 1 ? "open task" : "open tasks"}{x.last_update_at ? ` · last update ${fmtDate(localDay(x.last_update_at))}` : ""}</span>
              </div>
              <div className="kv">
                <div title="Can't move until someone or something else acts"><b>{x.blocked_count}</b><span>Blocked</span></div>
                <div title="Open tasks past their due date"><b>{x.overdue_count}</b><span>Past due</span></div>
                <div><b>{x.done_this_week}</b><span>Done this week</span></div>
              </div>
              <div className="bar" style={{ width: `${(x.open_count / max) * 100}%`, minWidth: 8 }} role="img" aria-label={`Workload: ${x.open_count} open tasks`}>
                <i className="b-prog" style={{ width: `${x.open_count ? (x.in_progress_count / x.open_count) * 100 : 0}%` }} />
                <i className="b-block" style={{ width: `${x.open_count ? (x.blocked_count / x.open_count) * 100 : 0}%` }} />
              </div>
              <div className="pchips">
                {x.project_codes.map(c => <span key={c} title={x.lead_of?.includes(c) ? "Leads this project" : undefined}><Swatch color={colors[c]} small />{c}{x.lead_of?.includes(c) ? " · lead" : ""}</span>)}
              </div>
            </button>
          ))}
        </div>
      )}
      {idle.length > 0 && <p className="small muted" style={{ marginTop: -32, paddingBottom: 40 }}>Not on any task right now: {idle.map(p => p.display_name).join(", ")}</p>}
    </>
  );
}
