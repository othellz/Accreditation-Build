import { useState } from 'react';
import { get, post, patch } from '../api.js';
import { useSession } from '../App.jsx';
import { useLoad, useToast, Modal, ErrorNote, Badge } from '../ui.jsx';
import { ROLE_LABEL } from '../format.js';

const inviteUrl = (token) => `${location.origin}/invite/${token}`;

export default function Users() {
  const { user: me } = useSession();
  const toast = useToast();
  const { data, error, reload } = useLoad(() => get('/users'), []);
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState(null);

  const update = async (u, body, msg) => {
    try { await patch(`/users/${u.id}`, body); toast(msg); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const reset = async (u) => {
    if (!window.confirm(`Reset sign-in for ${u.email}? They will need a new link to set a password.`)) return;
    try { const r = await post(`/users/${u.id}/reset`); setLink({ email: u.email, url: inviteUrl(r.inviteToken) }); reload(); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="muted">Each person has one role. Accreditors work the gate, Reviewers zone and publish, Admins do everything.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Invite user</button>
      </div>
      <ErrorNote error={error} />
      {data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'row-removed'}>
                  <td>{u.name || '—'}</td>
                  <td>{u.email}</td>
                  <td>
                    <select value={u.role} disabled={u.id === me.id} onChange={(e) => update(u, { role: e.target.value }, 'Role updated')} aria-label={`Role for ${u.email}`}>
                      {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td>
                    {!u.active ? <Badge kind="muted">Deactivated</Badge> : u.invite_token ? (
                      <button className="btn btn-link" onClick={() => setLink({ email: u.email, url: inviteUrl(u.invite_token) })}>Invite pending · show link</button>
                    ) : <Badge kind="ok">Active</Badge>}
                  </td>
                  <td className="row gap-sm">
                    {u.id !== me.id && (u.active
                      ? <button className="btn btn-sm btn-ghost" onClick={() => update(u, { active: false }, 'Deactivated')}>Deactivate</button>
                      : <button className="btn btn-sm btn-ghost" onClick={() => update(u, { active: true }, 'Reactivated')}>Reactivate</button>)}
                    {u.id !== me.id && u.active && <button className="btn btn-sm btn-ghost" onClick={() => reset(u)}>Reset password</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <InviteForm onClose={() => setAdding(false)} onDone={(email, token) => { setAdding(false); setLink({ email, url: inviteUrl(token) }); reload(); }} />}
      {link && (
        <Modal title="Invite link" onClose={() => setLink(null)}>
          <p>Send this link to <b>{link.email}</b>. They open it to set their password. It works once.</p>
          <div className="copy-row">
            <input readOnly value={link.url} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(link.url); toast('Link copied'); }}>Copy</button>
          </div>
          <div className="modal-foot"><button className="btn btn-primary" onClick={() => setLink(null)}>Done</button></div>
        </Modal>
      )}
    </div>
  );
}

function InviteForm({ onClose, onDone }) {
  const [f, setF] = useState({ email: '', name: '', role: 'accreditor' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try { const r = await post('/users', f); onDone(f.email, r.inviteToken); } catch (err) { setError(err); }
  };
  return (
    <Modal title="Invite user" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
        <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Role
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <ErrorNote error={error} />
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary">Create invite</button></div>
      </form>
    </Modal>
  );
}
