import { useState } from 'react';
import { get, post, download } from '../api.js';
import { useSession } from '../App.jsx';
import { useLoad, useToast, ErrorNote, Stat, Empty } from '../ui.jsx';
import { fmtDate, fmtDateTime } from '../format.js';

export default function Reconcile() {
  const { event, user, reloadEvent } = useSession();
  const toast = useToast();
  const [dayId, setDayId] = useState(event.defaultDayId);
  const [groupId, setGroupId] = useState('');
  const [company, setCompany] = useState('');
  const qs = `dayId=${dayId}&groupId=${groupId}&company=${encodeURIComponent(company)}`;
  const { data, error, reload } = useLoad(() => get(`/reconcile?${qs}`), [qs]);
  const day = event.days.find((d) => d.id === Number(dayId));

  const closeDay = async () => {
    if (!window.confirm(`Close ${fmtDate(day.date)}? Totals are locked and check-ins for this day stop.`)) return;
    try { await post(`/event/days/${dayId}/close`); toast('Day closed'); await reloadEvent(); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const reopenDay = async () => {
    const reason = window.prompt('Reason for reopening this day?');
    if (!reason) return;
    try { await post(`/event/days/${dayId}/reopen`, { reason }); toast('Day reopened'); await reloadEvent(); reload(); } catch (e) { toast(e.message, 'error'); }
  };

  // Group rows by accreditation group.
  const grouped = {};
  for (const r of data?.rows || []) (grouped[r.group_name] ||= []).push(r);

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>Reconciliation</h1>
          <p className="muted">Accreditations per company for the day against the approved list. Counts come from check-in records only.</p>
        </div>
        <div className="row gap-sm wrap">
          <button className="btn" onClick={() => download(`/reconcile/export?${qs}&format=csv`)}>Export CSV</button>
          <button className="btn" onClick={() => download(`/reconcile/export?${qs}&format=xlsx`)}>Export Excel</button>
          {user.role === 'admin' && day && !day.closed_at && <button className="btn btn-primary" onClick={closeDay}>Close day</button>}
          {user.role === 'admin' && day?.closed_at && <button className="btn" onClick={reopenDay}>Reopen day</button>}
        </div>
      </div>

      <div className="filters">
        <select value={dayId} onChange={(e) => setDayId(Number(e.target.value))} aria-label="Day">
          {event.days.map((d, i) => <option key={d.id} value={d.id}>Day {i + 1} · {fmtDate(d.date)}{d.closed_at ? ' · closed' : ''}</option>)}
        </select>
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-label="Group">
          <option value="">All groups</option>
          {event.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <input type="search" placeholder="Filter company" value={company} onChange={(e) => setCompany(e.target.value)} />
      </div>
      <ErrorNote error={error} />
      {data?.closed && <div className="note note-info">Closed {fmtDateTime(data.closed.at)}. These are the locked totals for the day.</div>}

      {data && (
        <>
          <div className="stats">
            <Stat label="Approved" value={data.totals.approved} />
            <Stat label="Accredited today" value={data.totals.accredited_today} />
            <Stat label="Not yet accredited" value={data.totals.not_yet} />
            <Stat label="Shirts issued today" value={data.totals.shirts_today} />
            <Stat label="Accredited to date" value={data.totals.accredited_to_date} />
          </div>

          {data.rows.length === 0 ? <Empty>No approved people yet for these filters.</Empty> : (
            <div className="table-wrap">
              <table className="table num-table">
                <thead>
                  <tr><th>Company</th><th>Approved</th><th>Accredited today</th><th>Not yet</th><th>Shirts today</th><th>To date</th></tr>
                </thead>
                {Object.entries(grouped).map(([g, rows]) => (
                  <tbody key={g}>
                    <tr className="group-row"><th colSpan={6}>{g}</th></tr>
                    {rows.map((r) => {
                      const gap = r.approved ? r.not_yet / r.approved : 0;
                      return (
                        <tr key={g + r.company}>
                          <td>{r.company}</td>
                          <td>{r.approved}</td>
                          <td><b>{r.accredited_today}</b></td>
                          <td className={gap > 0.5 && r.approved >= 5 ? 'text-warn' : ''}>{r.not_yet}</td>
                          <td>{r.shirts_today}</td>
                          <td>{r.accredited_to_date}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
                <tfoot>
                  <tr><th>Total</th><th>{data.totals.approved}</th><th>{data.totals.accredited_today}</th><th>{data.totals.not_yet}</th><th>{data.totals.shirts_today}</th><th>{data.totals.accredited_to_date}</th></tr>
                </tfoot>
              </table>
            </div>
          )}

          <h2 className="section-title">Event totals</h2>
          <div className="grid-3">
            <div className="card">
              <h3>Accredited per day</h3>
              <table className="table compact num-table">
                <tbody>
                  {data.event.perDay.map((d) => <tr key={d.id}><td>{fmtDate(d.date)}{d.closed_at ? ' 🔒' : ''}</td><td>{d.accredited}</td></tr>)}
                </tbody>
                <tfoot><tr><th>Unique people</th><th>{data.event.uniqueAccredited}</th></tr></tfoot>
              </table>
            </div>
            <div className="card">
              <h3>Shirts by size</h3>
              {data.event.shirtsBySize.length === 0 ? <p className="muted small">None issued yet.</p> : (
                <table className="table compact num-table">
                  <thead><tr><th>Size</th><th>Today</th><th>Total</th></tr></thead>
                  <tbody>{data.event.shirtsBySize.map((s) => <tr key={s.size}><td>{s.size}</td><td>{s.today}</td><td>{s.total}</td></tr>)}</tbody>
                </table>
              )}
            </div>
            <div className="card">
              <h3>Wristbands issued ({fmtDate(data.day.date)})</h3>
              {data.event.wristbands.length === 0 ? <p className="muted small">None issued on this day.</p> : (
                <table className="table compact num-table">
                  <tbody>{data.event.wristbands.map((w) => <tr key={w.number ?? 'x'}><td>Zone {w.number} · {w.name}{w.wristband ? ` (${w.wristband})` : ''}</td><td>{w.issued}</td></tr>)}</tbody>
                </table>
              )}
              {data.event.outsideAvailability > 0 && <p className="small text-warn">{data.event.outsideAvailability} accredited on a day they had not marked as available.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
