import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, del, ApiError } from '../api.js';
import { useSession } from '../App.jsx';
import { useToast, Modal, ErrorNote, Badge } from '../ui.jsx';
import { fmtDate, fmtTime, fmtDateTime } from '../format.js';

const SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

export default function Accredit() {
  const { user, event } = useSession();
  const toast = useToast();
  const days = event?.days || [];
  const [dayId, setDayId] = useState(event?.defaultDayId || days[0]?.id);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [card, setCard] = useState(null);
  const [cardError, setCardError] = useState(null);
  const [counts, setCounts] = useState(null);
  const [walkup, setWalkup] = useState(false);
  const inputRef = useRef(null);
  const seq = useRef(0);
  const readOnly = user.role === 'reviewer';
  const day = days.find((d) => d.id === Number(dayId));

  const loadCounts = useCallback(() => {
    get(`/accredit/counts?dayId=${dayId}`).then(setCounts).catch(() => {});
  }, [dayId]);
  useEffect(() => { if (dayId) loadCounts(); }, [loadCounts, dayId]);

  // Results while typing.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    const mySeq = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await get(`/accredit/search?q=${encodeURIComponent(term)}&dayId=${dayId}`);
        if (mySeq === seq.current) setResults(r.results);
      } catch { /* banner shows connection issues */ }
      finally { if (mySeq === seq.current) setSearching(false); }
    }, 120);
    return () => clearTimeout(t);
  }, [q, dayId]);

  const openCard = useCallback(async (id) => {
    setSelected(id);
    setCardError(null);
    try {
      setCard(await get(`/accredit/people/${id}?dayId=${dayId}`));
    } catch (e) {
      setCard(null);
      setCardError(e);
    }
  }, [dayId]);
  useEffect(() => { if (selected) openCard(selected); }, [dayId]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeCard = () => {
    setSelected(null);
    setCard(null);
    setQ('');
    setResults([]);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const act = async (fn, okMsg) => {
    try {
      const updated = await fn(false).catch(async (e) => {
        if (e instanceof ApiError && e.status === 0) return fn(true); // one safe retry
        throw e;
      });
      if (updated?.id) setCard(updated);
      if (okMsg) toast(okMsg);
      loadCounts();
      setResults((rs) => rs.map((r) => (r.id === updated?.id ? { ...r, attended: !!updated.attendance, shirt: !!updated.shirt } : r)));
    } catch (e) {
      toast(e.message, 'error');
      if (selected) openCard(selected);
    }
  };

  const markShirt = (size) => act(() => post(`/accredit/people/${card.id}/shirt`, { dayId, size }), 'Shirt collected');
  const markAttended = () => act((retry) => post(`/accredit/people/${card.id}/attend`, { dayId, retry }), `${card.name} accredited for ${fmtDate(day.date)}`);
  const undo = (kind) => {
    let reason = '';
    if (user.role === 'admin') {
      reason = window.prompt(`Reason for reversing ${kind === 'attend' ? 'attendance' : 'shirt'} for ${card.name}?`) ?? null;
      if (reason === null) return;
    } else if (!window.confirm(`Undo ${kind === 'attend' ? 'attendance' : 'shirt collected'} for ${card.name}?`)) return;
    act(() => del(`/accredit/people/${card.id}/${kind === 'attend' ? 'attend' : 'shirt'}?dayId=${dayId}`, { reason }), 'Undone');
  };

  return (
    <div className={`accredit ${selected ? 'has-card' : ''}`}>
      <div className="accredit-search">
        <div className="accredit-bar">
          <label className="day-pick">
            <span className="sr-only">Event day</span>
            <select value={dayId || ''} onChange={(e) => setDayId(Number(e.target.value))}>
              {days.map((d, i) => (
                <option key={d.id} value={d.id}>Day {i + 1} · {fmtDate(d.date)}{d.date === event.today ? ' (today)' : ''}{d.closed_at ? ' · closed' : ''}</option>
              ))}
            </select>
          </label>
          {counts && (
            <div className="my-count" title="Accredited on this day">
              {user.role === 'accreditor' && <span><b>{counts.mine}</b> by you</span>}
              <span><b>{counts.total}</b> total</span>
            </div>
          )}
        </div>
        {day && day.date !== event.today && <div className="note note-warn small">Selected day is {fmtDate(day.date)}, not today.</div>}
        {day?.closed_at && <div className="note note-warn small">This day is closed. Check-ins are locked.</div>}
        {readOnly && <div className="note small">Read-only: Reviewers can search but not accredit.</div>}
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          inputMode="search"
          autoComplete="off"
          placeholder="Search name or company"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          aria-label="Search name or company"
        />
        <ul className="results" aria-busy={searching}>
          {results.map((r) => (
            <li key={r.id}>
              <button className={`result ${selected === r.id ? 'active' : ''}`} onClick={() => openCard(r.id)}>
                <span className="result-main">
                  <span className="result-name">{r.name}</span>
                  <span className="result-sub">{r.company}{r.position ? ` · ${r.position}` : ''}</span>
                </span>
                <span className="result-tags">
                  <span className="zone-pill">Z{r.zone_number}</span>
                  {r.attended && <span className="tick" title="Attended this day">✓</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {q.trim().length >= 2 && !searching && results.length === 0 && (
          <div className="empty small">
            No one found for “{q.trim()}”. Check the spelling and company. If still missing, send them to the Reviewer or Admin —
            they may not be submitted, may have been removed, or are not yet published.
          </div>
        )}
        {user.role === 'admin' && (
          <button className="btn btn-ghost btn-sm walkup-btn" onClick={() => setWalkup(true)}>+ Add walk-up</button>
        )}
      </div>

      <div className="accredit-card">
        {selected && (
          <>
            <button className="btn btn-ghost back-btn" onClick={closeCard}>← New search</button>
            <ErrorNote error={cardError} />
            {card && <PersonCard card={card} readOnly={readOnly} onShirt={markShirt} onAttend={markAttended} onUndo={undo} isAdmin={user.role === 'admin'} />}
          </>
        )}
        {!selected && <div className="empty card-placeholder">Search, then tap a name to open the card.</div>}
      </div>

      {walkup && <WalkupModal onClose={() => setWalkup(false)} onDone={(id) => { setWalkup(false); openCard(id); toast('Walk-up added'); }} />}
    </div>
  );
}

function PersonCard({ card, readOnly, onShirt, onAttend, onUndo, isAdmin }) {
  const [size, setSize] = useState(card.shirtSize);
  useEffect(() => setSize(card.shirtSize), [card.id, card.shirtSize]);
  const locked = card.day.closed;
  return (
    <article className="person-card">
      <header>
        <h2>{card.name}</h2>
        <p className="muted">{card.company}{card.position ? ` · ${card.position}` : ''}</p>
        <div className="row gap-sm wrap">
          <Badge>{card.group}</Badge>
          {card.walkup && <Badge kind="warn">Walk-up</Badge>}
          <Badge>{card.workPeriod}</Badge>
        </div>
      </header>

      <div className="big-facts">
        <div className="big-fact zone-fact">
          <div className="big-label">Zone</div>
          <div className="big-value">{card.zone.number}</div>
          <div className="big-sub">{card.zone.name}{card.zone.wristband ? ` · ${card.zone.wristband} wristband` : ''}</div>
        </div>
        <div className="big-fact">
          <div className="big-label">T-shirt</div>
          <div className="big-value">{card.shirtSize || '—'}</div>
          <div className="big-sub">{card.shirt ? 'Collected' : 'Not collected'}</div>
        </div>
      </div>

      {card.zone.access_definition && <p className="access"><b>Access:</b> {card.zone.access_definition}</p>}
      {card.zone.status === 'retired' && <div className="note note-warn">This zone is retired. Ask the Reviewer to rezone.</div>}
      {card.wristbandWarning && <div className="note note-error">{card.wristbandWarning}</div>}
      {card.availableToday === false && <div className="note note-warn">Not marked as available on {fmtDate(card.day.date)}. You can still accredit; it will be logged.</div>}

      <section className="card-actions">
        <div className="action-row">
          {card.shirt ? (
            <div className="done">
              <span className="done-icon">✓</span>
              <span>Shirt collected ({card.shirt.size}) by {card.shirt.by}, {fmtDateTime(card.shirt.at)}</span>
              {!readOnly && (card.shirt.canUndo || isAdmin) && !locked && <button className="btn btn-link" onClick={() => onUndo('shirt')}>{card.shirt.canUndo ? 'Undo' : 'Reverse'}</button>}
            </div>
          ) : !readOnly && (
            <div className="row gap-sm">
              <button className="btn btn-lg btn-secondary grow" disabled={locked} onClick={() => onShirt(size)}>Shirt collected</button>
              <select className="size-select" value={size} onChange={(e) => setSize(e.target.value)} aria-label="Size handed out" title="Size handed out">
                {SIZES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="action-row">
          {card.attendance ? (
            <div className="done done-strong">
              <span className="done-icon">✓</span>
              <span>Attended {fmtDate(card.day.date)} at {fmtTime(card.attendance.at)} by {card.attendance.by}</span>
              {!readOnly && (card.attendance.canUndo || isAdmin) && !locked && <button className="btn btn-link" onClick={() => onUndo('attend')}>{card.attendance.canUndo ? 'Undo' : 'Reverse'}</button>}
            </div>
          ) : !readOnly && (
            <button className="btn btn-lg btn-primary btn-block" disabled={locked} onClick={onAttend}>Mark attended · fit Zone {card.zone.number} wristband</button>
          )}
          {!card.attendance && readOnly && <p className="muted">Not attended on {fmtDate(card.day.date)}.</p>}
        </div>
      </section>
      {card.jobDescription && <p className="muted small">Job: {card.jobDescription}</p>}
    </article>
  );
}

function WalkupModal({ onClose, onDone }) {
  const { event } = useSession();
  const groups = event.groups.filter((g) => !g.archived);
  const zones = event.zones.filter((z) => z.status === 'active');
  const [f, setF] = useState({ name: '', company: '', position: '', groupId: groups[0]?.id, zoneId: '', shirtSize: 'L', reason: '' });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await post('/walkups', f);
      onDone(r.id);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title="Add walk-up" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted small">For someone not on any submission. They are zoned now and visible to Accreditors at once.</p>
        <label>Name<input value={f.name} onChange={set('name')} required /></label>
        <label>Company<input value={f.company} onChange={set('company')} required /></label>
        <label>Position<input value={f.position} onChange={set('position')} /></label>
        <div className="row gap">
          <label className="grow">Group<select value={f.groupId} onChange={set('groupId')}>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          <label>Shirt<select value={f.shirtSize} onChange={set('shirtSize')}>{SIZES.map((s) => <option key={s}>{s}</option>)}</select></label>
        </div>
        <label>Zone<select value={f.zoneId} onChange={set('zoneId')} required>
          <option value="">Choose a zone…</option>
          {zones.map((z) => <option key={z.id} value={z.id} title={z.access_definition}>Zone {z.number} · {z.name}</option>)}
        </select></label>
        <label>Reason<input value={f.reason} onChange={set('reason')} required placeholder="e.g. Replacement for absent crew member" /></label>
        <ErrorNote error={error} />
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary">Add and zone</button></div>
      </form>
    </Modal>
  );
}
