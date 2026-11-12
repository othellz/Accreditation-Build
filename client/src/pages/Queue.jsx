import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { useLoad, ErrorNote, Empty, Badge, Progress } from '../ui.jsx';
import { useSession } from '../App.jsx';
import { STATUS_LABEL, fmtDateTime } from '../format.js';

const STATUS_KIND = { uploaded: 'info', in_review: 'warn', published: 'ok' };

export default function Queue() {
  const { event, user } = useSession();
  const { data, error, loading } = useLoad(() => get('/submissions'), []);
  const noZones = event && event.zones.filter((z) => z.status === 'active').length === 0;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Review queue</h1>
          <p className="muted">Assign a zone to each person or remove them, then publish to Accreditors.</p>
        </div>
        {user.role === 'admin' && <Link className="btn btn-primary" to="/upload">Upload submission</Link>}
      </div>
      {noZones && <div className="note note-warn">No zones yet. <Link to="/zones">Define zones</Link> before assigning them.</div>}
      <ErrorNote error={error} />
      {data && data.length === 0 && <Empty>No submissions yet. An Admin uploads company files first.</Empty>}
      {data && data.length > 0 && (
        <div className="queue">
          {data.map((s) => {
            const active = s.total - s.removed;
            return (
              <Link to={`/review/${s.id}`} key={s.id} className="queue-item card">
                <div className="queue-main">
                  <div className="queue-title">
                    <h3>{s.company}</h3>
                    <Badge kind={STATUS_KIND[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                  </div>
                  <div className="muted small">{s.group_name} · {s.team_lead || 'No team lead'} · updated {fmtDateTime(s.updated_at)}</div>
                </div>
                <div className="queue-progress">
                  <div className="small"><b>{s.zoned}</b> of {active} zoned</div>
                  <Progress value={s.zoned} total={active} />
                  <div className="queue-counts small">
                    <span>{s.total} people</span>
                    <span className={s.pending ? 'text-warn' : ''}>{s.pending} pending</span>
                    <span>{s.removed} removed</span>
                    {s.flagged > 0 && <span className="text-info">{s.flagged} flagged</span>}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {loading && !data && <p className="muted">Loading…</p>}
    </div>
  );
}
