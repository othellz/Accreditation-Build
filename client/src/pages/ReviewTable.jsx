import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, download } from '../api.js';
import { useSession } from '../App.jsx';
import { useLoad, useToast, ErrorNote, Badge, Progress } from '../ui.jsx';
import { STATUS_LABEL, fmtDate, fmtDateTime, plural } from '../format.js';

const STATUS_KIND = { pending: 'warn', zoned: 'ok', removed: 'muted' };
const FLAG_LABEL = { new: 'New in latest file', changed: 'Changed in latest file', missing: 'Not in latest file' };

export default function ReviewTable() {
  const { id } = useParams();
  const { event } = useSession();
  const toast = useToast();
  const { data, error, reload } = useLoad(() => get(`/submissions/${id}`), [id]);
  const [selected, setSelected] = useState(new Set());
  const [filters, setFilters] = useState({ q: '', position: '', period: '', status: '' });
  const [bulkZone, setBulkZone] = useState('');
  const [busy, setBusy] = useState(false);

  const zones = event.zones;
  const activeZones = zones.filter((z) => z.status === 'active');
  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);

  const attendees = data?.attendees || [];
  const positions = useMemo(() => [...new Set(attendees.map((a) => a.position).filter(Boolean))].sort(), [attendees]);
  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return attendees.filter((a) => {
      if (q && !`${a.name} ${a.position} ${a.job_description}`.toLowerCase().includes(q)) return false;
      if (filters.position && a.position !== filters.position) return false;
      if (filters.period && a.work_period !== filters.period) return false;
      if (filters.status === 'flagged') return !!a.import_flag || a.also_in.length > 0 || a.same_name > 0 || a.import_issues.length > 0;
      if (filters.status && a.status !== filters.status) return false;
      return true;
    });
  }, [attendees, filters]);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;

  const { submission: s, counts } = data;
  const active = counts.total - counts.removed;
  const allVisibleSelected = visible.length > 0 && visible.every((a) => selected.has(a.id));
  const toggleAll = () => {
    const next = new Set(selected);
    if (allVisibleSelected) visible.forEach((a) => next.delete(a.id));
    else visible.forEach((a) => next.add(a.id));
    setSelected(next);
  };
  const toggle = (aid) => {
    const next = new Set(selected);
    next.has(aid) ? next.delete(aid) : next.add(aid);
    setSelected(next);
  };

  const run = async (ids, action, extra = {}, msg) => {
    setBusy(true);
    try {
      const r = await post('/attendees/bulk', { ids: [...ids], action, ...extra });
      toast(msg ? msg(r.changed) : `${plural(r.changed, 'person', 'people')} updated`);
      await reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const bulk = (action) => {
    if (selected.size === 0) return;
    if (action === 'zone' && !bulkZone) return toast('Pick a zone first', 'error');
    if (action === 'remove' && !window.confirm(`Remove ${plural(selected.size, 'person', 'people')}? They are hidden from Accreditors and can be restored.`)) return;
    run(selected, action, action === 'zone' ? { zoneId: Number(bulkZone) } : {}).then(() => setSelected(new Set()));
  };

  const publish = async () => {
    setBusy(true);
    try {
      await post(`/submissions/${id}/publish`);
      toast(`${s.company} published to Accreditors`);
      await reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const days = event.days;
  return (
    <div className="page page-wide">
      <div className="crumbs"><Link to="/review">← Review queue</Link></div>
      <div className="page-head">
        <div>
          <h1>{s.company} <Badge kind={s.status === 'published' ? 'ok' : s.status === 'in_review' ? 'warn' : 'info'}>{STATUS_LABEL[s.status]}</Badge></h1>
          <p className="muted">{s.group_name} · Team lead: {s.team_lead || '—'} · {s.contact_number || 'no number'}</p>
        </div>
        <div className="publish-box">
          <div className="small"><b>{counts.zoned} of {active} zoned</b> · {counts.removed} removed</div>
          <Progress value={counts.zoned} total={active} />
          {s.status === 'published' ? (
            <div className="small text-ok">
              Published {fmtDateTime(s.published_at)}. Changes apply to Accreditors immediately.
              {counts.pending > 0 && <span className="text-warn"> {counts.pending} new {counts.pending === 1 ? 'person is' : 'people are'} pending and not visible yet.</span>}
            </div>
          ) : (
            <>
              <button className="btn btn-primary" disabled={counts.pending > 0 || busy || counts.total === 0} onClick={publish}>Publish</button>
              {counts.pending > 0 && <div className="small text-warn">{plural(counts.pending, 'person', 'people')} still pending</div>}
            </>
          )}
        </div>
      </div>

      <div className="filters">
        <input type="search" placeholder="Search name, position, job…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        <select value={filters.position} onChange={(e) => setFilters({ ...filters, position: e.target.value })} aria-label="Position">
          <option value="">All positions</option>
          {positions.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={filters.period} onChange={(e) => setFilters({ ...filters, period: e.target.value })} aria-label="Work period">
          <option value="">All work periods</option>
          <option>Before Event Only</option>
          <option>Before &amp; During Event</option>
        </select>
        <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Status">
          <option value="">All statuses</option>
          <option value="pending">Pending ({counts.pending})</option>
          <option value="zoned">Zoned ({counts.zoned})</option>
          <option value="removed">Removed ({counts.removed})</option>
          <option value="flagged">Flagged / possible duplicates</option>
        </select>
        <span className="muted small">{visible.length} shown</span>
      </div>

      <div className={`bulk-bar ${selected.size ? 'on' : ''}`}>
        <span><b>{selected.size}</b> selected</span>
        <select value={bulkZone} onChange={(e) => setBulkZone(e.target.value)} aria-label="Zone for selected">
          <option value="">Zone…</option>
          {activeZones.map((z) => <option key={z.id} value={z.id} title={z.access_definition}>Zone {z.number} · {z.name}</option>)}
        </select>
        <button className="btn btn-sm btn-primary" disabled={!selected.size || busy} onClick={() => bulk('zone')}>Assign zone</button>
        <button className="btn btn-sm btn-danger" disabled={!selected.size || busy} onClick={() => bulk('remove')}>Remove</button>
        <button className="btn btn-sm" disabled={!selected.size || busy} onClick={() => bulk('restore')}>Restore</button>
        <button className="btn btn-sm btn-ghost" disabled={!selected.size || busy} onClick={() => bulk('clear_flag')}>Clear flags</button>
        {selected.size > 0 && <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>Clear selection</button>}
      </div>

      <div className="table-wrap">
        <table className="table review-table">
          <thead>
            <tr>
              <th><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select all shown" /></th>
              <th>Name</th>
              <th>Position</th>
              <th className="col-job">Job description</th>
              <th>Work period</th>
              <th>Shirt</th>
              <th title="Availability per event day">Days</th>
              <th>Zone</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => {
              const zone = zoneById.get(a.zone_id);
              return (
                <tr key={a.id} className={a.removed ? 'row-removed' : selected.has(a.id) ? 'row-selected' : ''}>
                  <td><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} aria-label={`Select ${a.name}`} /></td>
                  <td>
                    <div className="cell-name">{a.name}</div>
                    <div className="flags">
                      {a.import_flag && <Badge kind={a.import_flag === 'missing' ? 'error' : 'info'}>{FLAG_LABEL[a.import_flag]}</Badge>}
                      {a.also_in.length > 0 && <Badge kind="warn" title="Same name submitted by another company. Keep one and remove the other.">Also in {a.also_in.join(', ')}</Badge>}
                      {a.same_name > 0 && <Badge kind="warn" title="Same name twice in this company; use position to tell apart">Same name ×{a.same_name + 1}</Badge>}
                      {a.import_issues.length > 0 && <Badge kind="muted" title={a.import_issues.join('\n')}>Accepted with issues</Badge>}
                    </div>
                  </td>
                  <td>{a.position}</td>
                  <td className="col-job">{a.job_description}</td>
                  <td className="nowrap">{a.work_period}</td>
                  <td>{a.shirt_size}</td>
                  <td>
                    <div className="avail">
                      {days.map((d) => {
                        const v = a.availability[d.id];
                        return <span key={d.id} className={`dot ${v === true ? 'yes' : v === false ? 'no' : 'unk'}`} title={`${fmtDate(d.date)}: ${v === true ? 'Yes' : v === false ? 'No' : 'Unknown'}`} />;
                      })}
                    </div>
                  </td>
                  <td>
                    <select
                      className="zone-select"
                      value={a.zone_id || ''}
                      disabled={a.removed || busy}
                      title={zone ? `${zone.name}: ${zone.access_definition}` : 'Assign a zone'}
                      onChange={(e) => e.target.value && run([a.id], 'zone', { zoneId: Number(e.target.value) }, () => `${a.name} → Zone ${zoneById.get(Number(e.target.value))?.number}`)}
                      aria-label={`Zone for ${a.name}`}
                    >
                      <option value="">—</option>
                      {zones.filter((z) => z.status === 'active' || z.id === a.zone_id).map((z) => (
                        <option key={z.id} value={z.id} title={z.access_definition} disabled={z.status !== 'active'}>
                          {z.number} · {z.name}{z.status !== 'active' ? ' (retired)' : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td><Badge kind={STATUS_KIND[a.status]}>{STATUS_LABEL[a.status]}</Badge></td>
                  <td>
                    {a.removed
                      ? <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run([a.id], 'restore', {}, () => `${a.name} restored`)}>Restore</button>
                      : <button className="btn btn-sm btn-ghost text-danger" disabled={busy} onClick={() => run([a.id], 'remove', {}, () => `${a.name} removed`)}>Remove</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.files.length > 0 && (
        <section className="section">
          <h2>Uploaded files</h2>
          <ul className="file-list">
            {data.files.map((f) => (
              <li key={f.id}>
                <button className="btn btn-link" onClick={() => download(`/submissions/${id}/files/${f.id}`)}>{f.filename}</button>
                <span className="muted small"> · {fmtDateTime(f.uploaded_at)} by {f.uploaded_by}
                  {f.summary && ` · ${f.summary.new} new, ${f.summary.changed} changed, ${f.summary.missing} missing`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
