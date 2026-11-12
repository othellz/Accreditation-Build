import { Router } from 'express';
import { requireRole } from '../auth.js';
import { tx } from '../db.js';
import { HttpError, audit, intParam, nowISO, todayISO, isoToLocalDate, normalizeShirtSize } from '../util.js';
import { VISIBLE_SQL, requireEvent, getDays, getDay, defaultDay } from '../model.js';

/**
 * On-site accreditation. Every query here filters with VISIBLE_SQL on the server, so removed,
 * unzoned or unpublished people never reach an Accreditor's device.
 */
export function accreditRoutes(db) {
  const r = Router();
  const canSearch = requireRole('accreditor', 'reviewer');
  const canAct = requireRole('accreditor');

  function resolveDay(ev, raw) {
    if (raw) return getDay(db, ev.id, intParam(raw, 'day'));
    const d = defaultDay(getDays(db, ev.id));
    if (!d) throw new HttpError(409, 'No event days are configured');
    return getDay(db, ev.id, d.id);
  }

  function loadVisible(ev, id) {
    const a = db.prepare(`SELECT a.*, g.name AS group_name FROM attendees a
      LEFT JOIN submissions s ON s.id = a.submission_id JOIN groups g ON g.id = a.group_id
      WHERE a.id = ? AND a.event_id = ? AND ${VISIBLE_SQL}`).get(id, ev.id);
    if (!a) throw new HttpError(404, 'Not found. They may not be submitted, may have been removed, or are not yet published. Send them to the Reviewer or Admin.');
    return a;
  }

  function card(ev, a, day, user) {
    const zone = db.prepare('SELECT id, number, name, code, access_definition, wristband, status FROM zones WHERE id = ?').get(a.zone_id);
    const shirt = db.prepare(`SELECT sc.*, u.name AS by_name, u.email AS by_email, d.date AS day_date FROM shirt_collections sc
      JOIN users u ON u.id = sc.by_user JOIN event_days d ON d.id = sc.day_id WHERE sc.attendee_id = ?`).get(a.id);
    const att = db.prepare(`SELECT at.*, u.name AS by_name, u.email AS by_email FROM attendance at
      JOIN users u ON u.id = at.by_user WHERE at.attendee_id = ? AND at.day_id = ?`).get(a.id, day.id);
    const avail = db.prepare('SELECT available FROM availability WHERE attendee_id = ? AND day_id = ?').get(a.id, day.id);
    // Last wristband issued: if the zone changed since, the gate must swap it.
    const lastIssued = db.prepare(`SELECT at.zone_id, z.number AS zone_number, d.date FROM attendance at
      JOIN event_days d ON d.id = at.day_id LEFT JOIN zones z ON z.id = at.zone_id
      WHERE at.attendee_id = ? ORDER BY d.date DESC LIMIT 1`).get(a.id);
    const today = todayISO();
    const canUndo = (rec) => !!rec && !day.closed_at && (user.role === 'admin' || (rec.by_user === user.id && isoToLocalDate(rec.at) === today));
    return {
      id: a.id,
      name: a.name,
      company: a.company,
      group: a.group_name,
      position: a.position,
      jobDescription: a.job_description,
      workPeriod: a.work_period,
      shirtSize: a.shirt_size,
      walkup: !!a.walkup_reason,
      zone,
      day: { id: day.id, date: day.date, closed: !!day.closed_at, isToday: day.date === today },
      availableToday: avail ? !!avail.available : null,
      shirt: shirt ? { at: shirt.at, by: shirt.by_name || shirt.by_email, size: shirt.size, dayDate: shirt.day_date, canUndo: canUndo(shirt) } : null,
      attendance: att ? { at: att.at, by: att.by_name || att.by_email, canUndo: canUndo(att) } : null,
      wristbandWarning: lastIssued && lastIssued.zone_id !== a.zone_id
        ? `Zone changed since the wristband was issued on ${lastIssued.date} (was Zone ${lastIssued.zone_number ?? '?'}). Swap the wristband.`
        : null,
    };
  }

  // Results while typing (F13). Every word must match name, company or position.
  r.get('/accredit/search', canSearch, (req, res) => {
    const ev = requireEvent(db);
    const day = resolveDay(ev, req.query.dayId);
    const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return res.json({ results: [], day });
    const conds = words.map(() => `(lower(a.name) LIKE ? OR lower(a.company) LIKE ? OR lower(a.position) LIKE ?)`).join(' AND ');
    const params = words.flatMap((w) => { const p = `%${w.replace(/[%_]/g, '')}%`; return [p, p, p]; });
    const rows = db.prepare(`SELECT a.id, a.name, a.company, a.position, a.shirt_size, z.number AS zone_number, z.name AS zone_name,
        (SELECT 1 FROM attendance t WHERE t.attendee_id = a.id AND t.day_id = ?) AS attended,
        (SELECT 1 FROM shirt_collections sc WHERE sc.attendee_id = a.id) AS shirt
      FROM attendees a LEFT JOIN submissions s ON s.id = a.submission_id JOIN zones z ON z.id = a.zone_id
      WHERE a.event_id = ? AND ${VISIBLE_SQL} AND ${conds}
      ORDER BY (lower(a.name) LIKE ?) DESC, a.name LIMIT 40`).all(day.id, ev.id, ...params, `${words[0]}%`);
    res.json({ results: rows.map((x) => ({ ...x, attended: !!x.attended, shirt: !!x.shirt })), day: { id: day.id, date: day.date } });
  });

  r.get('/accredit/people/:id', canSearch, (req, res) => {
    const ev = requireEvent(db);
    const day = resolveDay(ev, req.query.dayId);
    res.json(card(ev, loadVisible(ev, intParam(req.params.id)), day, req.user));
  });

  function openDay(ev, raw) {
    const day = resolveDay(ev, raw);
    if (day.closed_at) throw new HttpError(409, `${day.date} is closed. An Admin must reopen the day to change it.`);
    return day;
  }

  // One-time shirt flag (F15).
  r.post('/accredit/people/:id/shirt', canAct, (req, res) => {
    const ev = requireEvent(db);
    const day = openDay(ev, req.body?.dayId);
    const a = loadVisible(ev, intParam(req.params.id));
    const size = req.body?.size ? normalizeShirtSize(req.body.size) : a.shirt_size;
    if (!size) throw new HttpError(400, 'Unknown shirt size');
    const info = db.prepare(`INSERT INTO shirt_collections (attendee_id, day_id, size, at, by_user) VALUES (?,?,?,?,?)
      ON CONFLICT (attendee_id) DO NOTHING`).run(a.id, day.id, size, nowISO(), req.user.id);
    if (!info.changes) {
      const ex = db.prepare(`SELECT sc.at, u.name, u.email FROM shirt_collections sc JOIN users u ON u.id = sc.by_user WHERE attendee_id = ?`).get(a.id);
      throw new HttpError(409, `Shirt already collected — given by ${ex.name || ex.email}`, { at: ex.at, by: ex.name || ex.email });
    }
    audit(db, req.user.id, 'shirt.collected', 'attendee', a.id, { name: a.name, company: a.company, size, submittedSize: a.shirt_size, day: day.date });
    res.json(card(ev, a, day, req.user));
  });

  // Mark attended once per person per day (F16). The unique key makes concurrent taps safe.
  r.post('/accredit/people/:id/attend', canAct, (req, res) => {
    const ev = requireEvent(db);
    const day = openDay(ev, req.body?.dayId);
    const a = loadVisible(ev, intParam(req.params.id));
    const avail = db.prepare('SELECT available FROM availability WHERE attendee_id = ? AND day_id = ?').get(a.id, day.id);
    const outside = avail ? !avail.available : !a.walkup_reason;
    const info = db.prepare(`INSERT INTO attendance (attendee_id, day_id, zone_id, outside_availability, at, by_user) VALUES (?,?,?,?,?,?)
      ON CONFLICT (attendee_id, day_id) DO NOTHING`).run(a.id, day.id, a.zone_id, outside ? 1 : 0, nowISO(), req.user.id);
    if (!info.changes) {
      const ex = db.prepare(`SELECT t.at, t.by_user, u.name, u.email FROM attendance t JOIN users u ON u.id = t.by_user
        WHERE attendee_id = ? AND day_id = ?`).get(a.id, day.id);
      // A retry of our own request (weak connection) is not an error.
      if (ex.by_user === req.user.id && req.body?.retry) return res.json(card(ev, a, day, req.user));
      throw new HttpError(409, `Already marked attended today by ${ex.name || ex.email}`, { at: ex.at, by: ex.name || ex.email });
    }
    const zone = db.prepare('SELECT number FROM zones WHERE id = ?').get(a.zone_id);
    audit(db, req.user.id, 'attendance.marked', 'attendee', a.id, { name: a.name, company: a.company, day: day.date, zone: zone?.number });
    if (outside) audit(db, req.user.id, 'attendance.outside_availability', 'attendee', a.id, { name: a.name, day: day.date });
    res.json(card(ev, a, day, req.user));
  });

  // Undo: same Accreditor on the same day; afterwards only an Admin can reverse (F17).
  function undo(kind) {
    return (req, res) => {
      const ev = requireEvent(db);
      const day = openDay(ev, req.query.dayId || req.body?.dayId);
      const id = intParam(req.params.id);
      const a = db.prepare('SELECT * FROM attendees WHERE id = ? AND event_id = ?').get(id, ev.id);
      if (!a) throw new HttpError(404, 'Person not found');
      const rec = kind === 'attend'
        ? db.prepare('SELECT * FROM attendance WHERE attendee_id = ? AND day_id = ?').get(id, day.id)
        : db.prepare('SELECT * FROM shirt_collections WHERE attendee_id = ?').get(id);
      if (!rec) throw new HttpError(404, 'Nothing to undo');
      const isAdmin = req.user.role === 'admin';
      if (!isAdmin) {
        if (rec.by_user !== req.user.id) throw new HttpError(403, 'Only the Accreditor who did this can undo it. Ask an Admin.');
        if (isoToLocalDate(rec.at) !== todayISO()) throw new HttpError(403, 'Undo is only possible on the same day. Ask an Admin to reverse it.');
      }
      const reason = String(req.body?.reason || '').trim();
      tx(db, () => {
        if (kind === 'attend') db.prepare('DELETE FROM attendance WHERE id = ?').run(rec.id);
        else db.prepare('DELETE FROM shirt_collections WHERE attendee_id = ?').run(id);
        const action = `${kind === 'attend' ? 'attendance' : 'shirt'}.${isAdmin && rec.by_user !== req.user.id ? 'reversed' : 'undone'}`;
        audit(db, req.user.id, action, 'attendee', id, { name: a.name, company: a.company, day: day.date, original: { at: rec.at, by: rec.by_user }, reason: reason || undefined });
      });
      try {
        res.json(card(ev, loadVisible(ev, id), day, req.user));
      } catch {
        res.json({ ok: true });
      }
    };
  }
  r.delete('/accredit/people/:id/attend', canAct, undo('attend'));
  r.delete('/accredit/people/:id/shirt', canAct, undo('shirt'));

  // Counts for today shown to the Accreditor (own and total).
  r.get('/accredit/counts', canSearch, (req, res) => {
    const ev = requireEvent(db);
    const day = req.user.role === 'accreditor' ? resolveDay(ev, null) : resolveDay(ev, req.query.dayId);
    const total = db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE day_id = ?').get(day.id).n;
    const mine = db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE day_id = ? AND by_user = ?').get(day.id, req.user.id).n;
    const shirts = db.prepare('SELECT COUNT(*) AS n FROM shirt_collections WHERE day_id = ? AND by_user = ?').get(day.id, req.user.id).n;
    res.json({ day: { id: day.id, date: day.date }, total, mine, myShirts: shirts });
  });

  return r;
}
