import { useState } from 'react';
import { get } from '../api.js';
import { useLoad, ErrorNote } from '../ui.jsx';
import { fmtDateTime } from '../format.js';

const FILTERS = [
  ['', 'Everything'], ['submission', 'Uploads and publishing'], ['attendee', 'Zones, removals, restores'],
  ['attendance', 'Check-ins and reversals'], ['shirt', 'Shirts'], ['zone', 'Zone definitions'], ['user', 'Users'], ['day', 'Day close / reopen'],
];

function describe(row) {
  const d = row.details || {};
  const who = d.name ? `${d.name}${d.company ? ` (${d.company})` : ''}` : d.company || d.email || '';
  const extra = [];
  if (d.toZone) extra.push(`→ Zone ${d.toZone}`);
  if (d.zone) extra.push(`Zone ${d.zone}`);
  if (d.day) extra.push(d.day);
  if (d.size) extra.push(`size ${d.size}`);
  if (d.reason) extra.push(`reason: ${d.reason}`);
  if (d.new !== undefined) extra.push(`${d.new} new, ${d.changed} changed, ${d.missing} missing`);
  if (d.role) extra.push(d.role);
  return [who, ...extra].filter(Boolean).join(' · ');
}

export default function Audit() {
  const [action, setAction] = useState('');
  const [pages, setPages] = useState([]);
  const { data, error } = useLoad(() => get(`/audit?limit=200&action=${action}`), [action]);
  const rows = [...(data || []), ...pages.flat()];
  const more = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setPages([...pages, await get(`/audit?limit=200&action=${action}&before=${last.id}`)]);
  };
  return (
    <div className="page page-wide">
      <div className="page-head"><div><h1>Audit log</h1><p className="muted">Every upload, zone change, removal, restore, check-in and reversal, with user and time. Entries cannot be changed.</p></div></div>
      <div className="filters">
        <select value={action} onChange={(e) => { setAction(e.target.value); setPages([]); }} aria-label="Filter">
          {FILTERS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <ErrorNote error={error} />
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{fmtDateTime(r.at)}</td>
                <td>{r.user_name || r.user_email || 'system'}</td>
                <td><code>{r.action}</code></td>
                <td>{describe(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && rows.length % 200 === 0 && <button className="btn" onClick={more}>Load older</button>}
    </div>
  );
}
