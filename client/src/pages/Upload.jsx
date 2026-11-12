import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, post, del, download } from '../api.js';
import { useSession } from '../App.jsx';
import { useToast, ErrorNote, Badge, Empty } from '../ui.jsx';
import { fmtDate } from '../format.js';

const SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const PERIODS = ['Before Event Only', 'Before & During Event'];
const STATUS_KIND = { new: 'info', changed: 'warn', unchanged: 'muted' };

export default function Upload() {
  const { event } = useSession();
  const toast = useToast();
  const groups = event.groups.filter((g) => !g.archived);
  const [groupId, setGroupId] = useState(groups[0]?.id || '');
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [result, setResult] = useState(null);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const fileRef = useRef(null);

  const load = (p) => {
    setPreview(p);
    setMeta({ company: p.company, teamLead: p.teamLead, contactNumber: p.contactNumber });
    setRows(p.rows.map((r) => ({ ...r, decision: r.issues.length ? '' : 'import' })));
  };

  const onFile = async (file) => {
    if (!file) return;
    if (!groupId) return setError(new Error('Pick an accreditation group first'));
    setError(null);
    setResult(null);
    setBusy(true);
    const form = new FormData();
    form.append('groupId', groupId);
    form.append('file', file);
    try {
      load(await api('/uploads', { method: 'POST', form, timeout: 90000 }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const revalidate = async (nextRows = rows, nextMeta = meta) => {
    try {
      const p = await post(`/uploads/${preview.id}/validate`, { company: nextMeta.company, groupId, rows: nextRows });
      const decisions = new Map(nextRows.map((r) => [r.rowNumber, r.decision]));
      setPreview(p);
      setRows(p.rows.map((r) => {
        const prev = decisions.get(r.rowNumber);
        return { ...r, decision: prev === 'skip' || prev === 'accept' ? prev : r.issues.length ? '' : 'import' };
      }));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const edit = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setDecision = (i, decision) => edit(i, { decision });

  const unresolved = rows.filter((r) => r.decision === '' || (r.decision !== 'skip' && r.issues.some((x) => x.blocking))).length;
  const counts = useMemo(() => ({
    import: rows.filter((r) => r.decision !== 'skip').length,
    skip: rows.filter((r) => r.decision === 'skip').length,
    issues: rows.filter((r) => r.issues.length).length,
  }), [rows]);

  const bulkDecide = (decision) => setRows(rows.map((r) => (r.issues.length && !r.issues.some((x) => x.blocking && decision === 'accept') ? { ...r, decision } : r)));

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post(`/uploads/${preview.id}/confirm`, { ...meta, groupId, rows });
      setResult({ ...r, company: meta.company });
      setPreview(null);
      setRows([]);
      toast('Submission saved');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (preview) await del(`/uploads/${preview.id}`).catch(() => {});
    setPreview(null);
    setRows([]);
  };

  const dayCols = event.days.filter((d) => preview?.dayIds?.includes(d.id));
  const shown = rows.map((r, i) => [r, i]).filter(([r]) => !onlyIssues || r.issues.length);

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>Upload submission</h1>
          <p className="muted">One company's Excel file per upload. Re-uploading a company updates its rows and keeps zones, shirts and attendance.</p>
        </div>
        <button className="btn btn-ghost" onClick={() => download('/template')}>Download blank template</button>
      </div>

      {result && (
        <div className="note note-ok">
          <b>{result.company}</b> {result.isReupload ? 'updated' : 'uploaded'}: {result.new} new, {result.changed} changed, {result.unchanged} unchanged
          {result.missing ? `, ${result.missing} flagged as missing from the new file` : ''}{result.skipped ? `, ${result.skipped} skipped` : ''}.
          {' '}<Link to={`/review/${result.submissionId}`}>Open in review →</Link>
        </div>
      )}

      {!preview && (
        <div className="card upload-card">
          <label>Accreditation group
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <div
            className={`dropzone ${drag ? 'drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(e) => onFile(e.target.files[0])} />
            <div className="dropzone-icon" aria-hidden>⇪</div>
            <div><b>{busy ? 'Reading file…' : 'Drop the company Excel file here'}</b></div>
            <div className="muted small">or click to choose · .xlsx in the Flytime template</div>
          </div>
          {event.days.length === 0 && <div className="note note-warn">No event days configured — availability columns will be ignored. <Link to="/settings">Set event days</Link>.</div>}
          <ErrorNote error={error} />
        </div>
      )}

      {preview && (
        <>
          <div className="card preview-head">
            <div className="grid-3">
              <label>Company name
                <input value={meta.company} onChange={(e) => setMeta({ ...meta, company: e.target.value })} onBlur={() => revalidate()} required />
                {!meta.company && <span className="hint text-danger">Required</span>}
              </label>
              <label>Team lead<input value={meta.teamLead} onChange={(e) => setMeta({ ...meta, teamLead: e.target.value })} /></label>
              <label>Contact number<input value={meta.contactNumber} onChange={(e) => setMeta({ ...meta, contactNumber: e.target.value })} /></label>
            </div>
            <div className="row gap wrap small">
              <span>File: <b>{preview.filename}</b></span>
              <span>Group: <b>{groups.find((g) => g.id === Number(groupId))?.name}</b></span>
              <span>{rows.length} rows · {counts.issues} with issues</span>
              {dayCols.length > 0 && <span>Days: {dayCols.map((d) => fmtDate(d.date)).join(', ')}</span>}
            </div>
            {preview.existingSubmission && (
              <div className="note note-info">
                <b>Re-upload:</b> this updates the existing submission ({preview.existingSubmission.people} people, {preview.existingSubmission.status.replace('_', ' ')}).
                Zones, shirts and attendance are kept. {rows.filter((r) => r.status === 'new').length} new, {rows.filter((r) => r.status === 'changed').length} changed.
                {preview.missing.length > 0 && <> {preview.missing.length} not in this file will be flagged (not deleted): {preview.missing.slice(0, 8).map((m) => m.name).join(', ')}{preview.missing.length > 8 ? '…' : ''}.</>}
              </div>
            )}
            {preview.warnings.map((w) => <div className="note note-warn small" key={w}>{w}</div>)}
          </div>

          <div className="filters">
            <label className="check"><input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Only rows with issues</label>
            <button className="btn btn-sm" onClick={() => bulkDecide('accept')}>Accept all flagged as is</button>
            <button className="btn btn-sm" onClick={() => bulkDecide('skip')}>Skip all flagged</button>
            <button className="btn btn-sm btn-ghost" onClick={() => revalidate()}>Re-check fixes</button>
          </div>

          <div className="table-wrap">
            <table className="table preview-table">
              <thead>
                <tr>
                  <th>Row</th><th>Name</th><th>Issues</th><th>Decision</th><th>Position</th><th className="col-job">Job description</th><th>Work period</th><th>Shirt</th>
                  {dayCols.map((d) => <th key={d.id} className="day-col">{fmtDate(d.date).split(' ').slice(1).join(' ')}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map(([r, i]) => {
                  const codes = new Set(r.issues.map((x) => x.code));
                  return (
                    <tr key={r.rowNumber} className={r.decision === 'skip' ? 'row-removed' : r.issues.length ? 'row-issue' : ''}>
                      <td className="muted">{r.rowNumber}</td>
                      <td><input className={codes.has('missing_name') ? 'invalid' : ''} value={r.name} onChange={(e) => edit(i, { name: e.target.value })} onBlur={() => revalidate()} />
                        {r.status && r.status !== 'new' && preview.existingSubmission && <Badge kind={STATUS_KIND[r.status]}>{r.status}</Badge>}
                        {r.status === 'new' && preview.existingSubmission && <Badge kind="info">new</Badge>}
                      </td>
                      <td className="issues">{r.issues.map((x) => <div key={x.code} className={x.blocking ? 'text-danger' : 'text-warn'}>{x.message}</div>)}</td>
                      <td>
                        {r.issues.length === 0 ? (
                          <select value={r.decision === 'skip' ? 'skip' : 'import'} onChange={(e) => setDecision(i, e.target.value)}>
                            <option value="import">Import</option><option value="skip">Skip</option>
                          </select>
                        ) : (
                          <select className={r.decision === '' ? 'invalid' : ''} value={r.decision} onChange={(e) => setDecision(i, e.target.value)}>
                            <option value="">Decide…</option>
                            {!r.issues.some((x) => x.blocking) && <option value="accept">Accept as is</option>}
                            <option value="skip">Skip row</option>
                          </select>
                        )}
                      </td>
                      <td><input value={r.position} onChange={(e) => edit(i, { position: e.target.value })} /></td>
                      <td className="col-job"><input value={r.jobDescription} onChange={(e) => edit(i, { jobDescription: e.target.value })} /></td>
                      <td>
                        <select className={codes.has('work_period') ? 'invalid' : ''} value={PERIODS.includes(r.workPeriod) ? r.workPeriod : ''} onChange={(e) => { const next = rows.map((x, j) => (j === i ? { ...x, workPeriod: e.target.value } : x)); setRows(next); revalidate(next); }}>
                          <option value="">{PERIODS.includes(r.workPeriod) ? '—' : r.workPeriod || '—'}</option>
                          {PERIODS.map((p) => <option key={p}>{p}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className={codes.has('shirt_size') ? 'invalid' : ''} value={SIZES.includes(r.shirtSize) ? r.shirtSize : ''} onChange={(e) => { const next = rows.map((x, j) => (j === i ? { ...x, shirtSize: e.target.value } : x)); setRows(next); revalidate(next); }}>
                          <option value="">{SIZES.includes(r.shirtSize) ? '—' : r.shirtSize || '—'}</option>
                          {SIZES.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </td>
                      {dayCols.map((d) => {
                        const v = r.availability?.[d.id];
                        return <td key={d.id} className="day-col"><span className={`dot ${v === true ? 'yes' : v === false ? 'no' : 'unk'}`} title={v === true ? 'Yes' : v === false ? 'No' : 'Not Yes/No'} /></td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 && <Empty>No rows with issues.</Empty>}
          </div>

          <ErrorNote error={error} />
          {error?.data?.unresolved && <div className="note note-error small">Rows: {error.data.unresolved.map((u) => u.rowNumber).join(', ')}</div>}
          <div className="sticky-foot">
            <span>{counts.import} to import · {counts.skip} skipped{unresolved ? <span className="text-warn"> · {unresolved} need a decision</span> : ''}</span>
            <div className="row gap-sm">
              <button className="btn btn-ghost" onClick={cancel}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || unresolved > 0 || !meta.company} onClick={confirm}>{busy ? 'Saving…' : 'Confirm and save'}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
