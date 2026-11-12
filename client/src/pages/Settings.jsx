import { useEffect, useState } from 'react';
import { post, put, patch, download } from '../api.js';
import { useSession } from '../App.jsx';
import { useToast, ErrorNote, Badge } from '../ui.jsx';
import DaysEditor from './DaysEditor.jsx';

export default function Settings() {
  const { event, reloadEvent } = useSession();
  const toast = useToast();
  const ev = event.event;
  const [error, setError] = useState(null);

  if (!ev) return <CreateEvent onDone={reloadEvent} />;

  return (
    <div className="page">
      <div className="page-head"><div><h1>Event setup</h1><p className="muted">Event name, days, accreditation groups and data settings.</p></div></div>
      <ErrorNote error={error} />
      <EventDetails ev={ev} onSaved={() => { toast('Saved'); reloadEvent(); }} onError={setError} />
      <EventDays days={event.days} onSaved={() => { toast('Event days saved'); reloadEvent(); }} onError={setError} />
      <Groups groups={event.groups} reload={reloadEvent} />
      <section className="card section">
        <h2>Backup and export</h2>
        <p className="muted small">The full list with groups, zones, shirts and attendance.</p>
        <div className="row gap-sm">
          <button className="btn" onClick={() => download('/export/full?format=xlsx')}>Export Excel</button>
          <button className="btn" onClick={() => download('/export/full?format=csv')}>Export CSV</button>
        </div>
      </section>
      <Purge ev={ev} />
    </div>
  );
}

function CreateEvent({ onDone }) {
  const [name, setName] = useState('');
  const [dates, setDates] = useState([]);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try { await post('/event', { name, dates }); onDone(); } catch (err) { setError(err); }
  };
  return (
    <div className="page">
      <form className="card form" onSubmit={submit}>
        <h1>Create the event</h1>
        <label>Event name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <DaysEditor dates={dates} onChange={setDates} />
        <ErrorNote error={error} />
        <button className="btn btn-primary">Create event</button>
      </form>
    </div>
  );
}

function EventDetails({ ev, onSaved, onError }) {
  const [f, setF] = useState({ name: ev.name, zoneLimit: ev.zone_limit, retentionDate: ev.retention_date || '' });
  const submit = async (e) => {
    e.preventDefault();
    try { await put('/event', f); onSaved(); } catch (err) { onError(err); }
  };
  return (
    <form className="card section form" onSubmit={submit}>
      <h2>Event</h2>
      <div className="grid-3">
        <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label>Zone limit<input type="number" min="1" max="99" value={f.zoneLimit} onChange={(e) => setF({ ...f, zoneLimit: e.target.value })} /><span className="hint">Zones 1 to this number</span></label>
        <label>Delete personal data after<input type="date" value={f.retentionDate} onChange={(e) => setF({ ...f, retentionDate: e.target.value })} /><span className="hint">Retention date (NDPA 2023)</span></label>
      </div>
      <div><button className="btn btn-primary">Save</button></div>
    </form>
  );
}

function EventDays({ days, onSaved, onError }) {
  const [dates, setDates] = useState(days.map((d) => d.date));
  useEffect(() => setDates(days.map((d) => d.date)), [days]);
  const save = async () => {
    try { await put('/event/days', { dates }); onSaved(); } catch (err) { onError(err); }
  };
  return (
    <section className="card section">
      <h2>Event days</h2>
      <p className="muted small">Availability columns in uploaded files follow these days. Days with check-ins cannot be removed.</p>
      <DaysEditor dates={dates} onChange={setDates} />
      <button className="btn btn-primary" onClick={save}>Save days</button>
    </section>
  );
}

function Groups({ groups, reload }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const add = async (e) => {
    e.preventDefault();
    try { await post('/groups', { name }); setName(''); toast('Group added'); reload(); } catch (err) { toast(err.message, 'error'); }
  };
  const rename = async (g) => {
    const next = window.prompt('Rename group', g.name);
    if (!next || next === g.name) return;
    try { await patch(`/groups/${g.id}`, { name: next }); reload(); } catch (err) { toast(err.message, 'error'); }
  };
  const toggle = async (g) => {
    try { await patch(`/groups/${g.id}`, { archived: !g.archived }); reload(); } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <section className="card section">
      <h2>Accreditation groups</h2>
      <p className="muted small">Each submission belongs to one group. Archived groups cannot take new uploads.</p>
      <ul className="list">
        {groups.map((g) => (
          <li key={g.id} className="list-row">
            <span className="grow">{g.name} {g.archived ? <Badge kind="muted">Archived</Badge> : null}</span>
            <button className="btn btn-sm btn-ghost" onClick={() => rename(g)}>Rename</button>
            <button className="btn btn-sm btn-ghost" onClick={() => toggle(g)}>{g.archived ? 'Unarchive' : 'Archive'}</button>
          </li>
        ))}
      </ul>
      <form className="row gap-sm" onSubmit={add}>
        <input placeholder="New group, e.g. Media" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn">Add group</button>
      </form>
    </section>
  );
}

function Purge({ ev }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const passed = ev.retention_date && ev.retention_date <= new Date().toISOString().slice(0, 10);
  const purge = async () => {
    try { await post('/event/purge', { confirm }); toast('Personal data deleted'); setConfirm(''); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <section className="card section danger-zone">
      <h2>Delete personal data</h2>
      <p className="muted small">
        After the retention date, replace names, positions, job details and contact numbers, and delete the original files.
        Counts and the audit log stay. {ev.retention_date ? `Retention date: ${ev.retention_date}.` : 'No retention date set.'}
      </p>
      {passed ? (
        <div className="row gap-sm">
          <input placeholder={`Type "${ev.name}" to confirm`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <button className="btn btn-danger" disabled={confirm !== ev.name} onClick={purge}>Delete personal data</button>
        </div>
      ) : <p className="small">Available once the retention date has passed.</p>}
    </section>
  );
}
