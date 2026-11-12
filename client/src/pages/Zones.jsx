import { useState } from 'react';
import { post, patch, del } from '../api.js';
import { useSession } from '../App.jsx';
import { useToast, Modal, ErrorNote, Badge, Empty } from '../ui.jsx';

export default function Zones() {
  const { event, reloadEvent } = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const zones = event.zones;
  const limit = event.event.zone_limit;
  const nextNumber = Array.from({ length: limit }, (_, i) => i + 1).find((n) => !zones.some((z) => z.number === n));

  const setStatus = async (z, status) => {
    try {
      await patch(`/zones/${z.id}`, { status });
      toast(status === 'retired' ? `Zone ${z.number} retired` : `Zone ${z.number} active again`);
      reloadEvent();
    } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async (z) => {
    if (!window.confirm(`Delete Zone ${z.number}?`)) return;
    try {
      await del(`/zones/${z.id}`);
      toast('Zone deleted');
      reloadEvent();
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Zones</h1>
          <p className="muted">Each zone is one level of access and matches one wristband. Define zones before assigning them. {zones.length} of {limit} used.</p>
        </div>
        <button className="btn btn-primary" disabled={!nextNumber} onClick={() => setEditing({ number: nextNumber, name: '', code: '', accessDefinition: '', wristband: '' })}>Add zone</button>
      </div>
      {zones.length === 0 && <Empty>No zones yet. Add Zone 1 to start; zone names and access definitions are yours to write.</Empty>}
      <div className="zone-grid">
        {zones.map((z) => (
          <div key={z.id} className={`card zone-card ${z.status === 'retired' ? 'retired' : ''}`}>
            <div className="zone-card-head">
              <div className="zone-number">{z.number}</div>
              <div className="grow">
                <h3>{z.name} {z.code && <span className="muted small">({z.code})</span>}</h3>
                <div className="small muted">{z.wristband ? `${z.wristband} wristband` : 'No wristband set'}</div>
              </div>
              {z.status === 'retired' && <Badge kind="muted">Retired</Badge>}
            </div>
            <p className="zone-def">{z.access_definition || <span className="muted">No access definition yet.</span>}</p>
            <div className="row gap-sm wrap">
              <button className="btn btn-sm" onClick={() => setEditing({ ...z, accessDefinition: z.access_definition })}>Edit</button>
              {z.status === 'active'
                ? <button className="btn btn-sm btn-ghost" onClick={() => setStatus(z, 'retired')}>Retire</button>
                : <button className="btn btn-sm btn-ghost" onClick={() => setStatus(z, 'active')}>Reactivate</button>}
              <button className="btn btn-sm btn-ghost text-danger" onClick={() => remove(z)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {editing && <ZoneForm zone={editing} limit={limit} taken={zones.map((z) => z.number)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reloadEvent(); toast('Zone saved'); }} />}
    </div>
  );
}

function ZoneForm({ zone, limit, taken, onClose, onSaved }) {
  const [f, setF] = useState(zone);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    try {
      if (zone.id) await patch(`/zones/${zone.id}`, f);
      else await post('/zones', f);
      onSaved();
    } catch (err) { setError(err); }
  };
  return (
    <Modal title={zone.id ? `Edit Zone ${zone.number}` : 'Add zone'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="row gap">
          <label>Number
            <select value={f.number} onChange={set('number')} disabled={!!zone.id}>
              {Array.from({ length: limit }, (_, i) => i + 1).filter((n) => n === zone.number || !taken.includes(n)).map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
          <label className="grow">Name<input value={f.name} onChange={set('name')} required placeholder="e.g. Backstage" /></label>
          <label>Code<input value={f.code} onChange={set('code')} maxLength={8} placeholder="BKS" /></label>
        </div>
        <label>Access definition<textarea rows={3} value={f.accessDefinition} onChange={set('accessDefinition')} placeholder="Plain-language list of the places this zone can enter" /></label>
        <label>Wristband<input value={f.wristband} onChange={set('wristband')} placeholder="Colour or type, e.g. Red" /></label>
        {zone.id && <p className="muted small">Changes update this zone everywhere. Existing assignments stay.</p>}
        <ErrorNote error={error} />
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save zone</button></div>
      </form>
    </Modal>
  );
}
