import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { useSession } from '../App.jsx';
import { useLoad, ErrorNote, Stat, Progress } from '../ui.jsx';
import { fmtDate } from '../format.js';
import Settings from './Settings.jsx';

export default function Overview() {
  const { event } = useSession();
  if (!event?.event) return <Settings />;
  return <OverviewInner />;
}

function OverviewInner() {
  const { event } = useSession();
  const { data, error } = useLoad(() => get('/overview'), []);
  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const s = data.submissions;
  const totalSubs = (s.uploaded || 0) + (s.in_review || 0) + (s.published || 0);
  const steps = [
    { done: event.days.length > 0 && event.groups.length > 0, label: 'Event days and groups', to: '/settings' },
    { done: (data.users.reviewer || 0) + (data.users.accreditor || 0) > 0, label: 'Invite Reviewer and Accreditors', to: '/users' },
    { done: data.activeZones > 0, label: 'Zones defined', to: '/zones' },
    { done: totalSubs > 0, label: 'Company files uploaded', to: '/upload' },
    { done: (s.published || 0) > 0 && !s.uploaded && !s.in_review, label: 'All submissions published', to: '/review' },
  ];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">{data.event.name} · {event.days.length} days{event.days.length ? `, ${fmtDate(event.days[0].date)} – ${fmtDate(event.days[event.days.length - 1].date)}` : ''}</p>
        </div>
        <Link to="/upload" className="btn btn-primary">Upload submission</Link>
      </div>
      {data.retentionPassed && <div className="note note-warn">The retention date has passed. <Link to="/settings">Delete personal data</Link>.</div>}

      <div className="stats">
        <Stat label={data.day ? `Accredited ${data.day.date === data.today ? 'today' : fmtDate(data.day.date)}` : 'Accredited today'} value={data.todayCount} sub={`of ${data.people.approved} approved`} />
        <Stat label="Approved" value={data.people.approved} sub="zoned, published, not removed" />
        <Stat label="Pending review" value={data.people.pending} />
        <Stat label="Removed" value={data.people.removed} />
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Submissions</h2>
          <div className="sub-status">
            <div><b>{s.uploaded || 0}</b><span>Uploaded</span></div>
            <div><b>{s.in_review || 0}</b><span>In review</span></div>
            <div><b>{s.published || 0}</b><span>Published</span></div>
          </div>
          <Progress value={s.published || 0} total={totalSubs} />
          <p className="small muted">{s.published || 0} of {totalSubs} published · <Link to="/review">Open review queue</Link></p>
        </section>
        <section className="card">
          <h2>Getting ready</h2>
          <ul className="checklist">
            {steps.map((st) => <li key={st.label} className={st.done ? 'done' : ''}><span aria-hidden>{st.done ? '✓' : '○'}</span> <Link to={st.to}>{st.label}</Link></li>)}
          </ul>
        </section>
      </div>

      <section className="card section">
        <h2>Event days</h2>
        <div className="table-wrap">
          <table className="table num-table">
            <thead><tr><th>Day</th><th>Date</th><th>Accredited</th><th>Approved</th><th>Status</th></tr></thead>
            <tbody>
              {data.perDay.map((d, i) => (
                <tr key={d.id} className={d.id === data.day?.id ? 'row-selected' : ''}>
                  <td>Day {i + 1}</td><td>{fmtDate(d.date)}</td><td><b>{d.accredited}</b></td><td>{data.people.approved}</td>
                  <td>{d.closed_at ? 'Closed' : d.date === data.today ? 'Today' : d.date < data.today ? 'Open' : 'Upcoming'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Link to="/reconcile">Open reconciliation →</Link>
      </section>
    </div>
  );
}
