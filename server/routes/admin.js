import { Router } from 'express';
import { requireRole, randomToken, hashPassword, verifyPassword, createSession, destroySession, requireAuth } from '../auth.js';
import { tx } from '../db.js';
import { HttpError, ROLES, audit, cleanText, intParam, nowISO, todayISO } from '../util.js';
import { getEvent, requireEvent, getDays, defaultDay, getDay } from '../model.js';
import { buildReconciliation } from './reports.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDates(dates) {
  if (!Array.isArray(dates) || dates.length === 0) throw new HttpError(400, 'Add at least one event day');
  const clean = [...new Set(dates.map((d) => String(d).trim()))].sort();
  for (const d of clean) {
    if (!DATE_RE.test(d) || Number.isNaN(Date.parse(d))) throw new HttpError(400, `Invalid date: ${d}`);
  }
  return clean;
}

export function authRoutes(db, { secureCookies }) {
  const r = Router();

  r.get('/auth/state', (req, res) => {
    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const ev = getEvent(db);
    res.json({ needsSetup: userCount === 0, setupTokenRequired: userCount === 0 && !!process.env.SETUP_TOKEN, user: req.user || null, hasEvent: !!ev, today: todayISO() });
  });

  // First run: create the first Admin and the event.
  r.post('/auth/setup', (req, res) => {
    const { email, name, password, eventName, dates, setupToken } = req.body || {};
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) throw new HttpError(409, 'Setup is already done');
    // On a public server, SETUP_TOKEN stops a stranger from claiming the first Admin account.
    if (process.env.SETUP_TOKEN && setupToken !== process.env.SETUP_TOKEN) throw new HttpError(403, 'Setup code is not right');
    if (!email || !password || password.length < 8) throw new HttpError(400, 'Email and a password of at least 8 characters are required');
    const user = tx(db, () => {
      const info = db.prepare(`INSERT INTO users (email, name, role, password_hash) VALUES (?,?, 'admin', ?)`)
        .run(cleanText(email).toLowerCase(), cleanText(name), hashPassword(password));
      const id = Number(info.lastInsertRowid);
      if (eventName) createEvent(db, id, cleanText(eventName), dates || []);
      audit(db, id, 'setup.completed', 'user', id, { email });
      return id;
    });
    createSession(db, res, user, secureCookies);
    res.json({ ok: true });
  });

  // Slow down password guessing: 10 failed attempts per IP+email per 15 minutes.
  const failures = new Map();
  const WINDOW = 15 * 60e3;
  r.post('/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const key = `${req.ip}|${cleanText(email).toLowerCase()}`;
    const now = Date.now();
    const f = failures.get(key);
    if (f && now - f.first < WINDOW && f.count >= 10) {
      throw new HttpError(429, 'Too many failed sign-ins. Wait 15 minutes and try again.');
    }
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanText(email).toLowerCase());
    if (!u || !u.active || !verifyPassword(String(password || ''), u.password_hash)) {
      if (!f || now - f.first >= WINDOW) failures.set(key, { first: now, count: 1 });
      else f.count++;
      if (failures.size > 10000) failures.clear();
      throw new HttpError(401, 'Email or password is not right');
    }
    failures.delete(key);
    createSession(db, res, u.id, secureCookies);
    audit(db, u.id, 'auth.login', 'user', u.id);
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  });

  r.post('/auth/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  r.get('/invite/:token', (req, res) => {
    const u = db.prepare('SELECT email, name, role FROM users WHERE invite_token = ? AND active = 1').get(req.params.token);
    if (!u) throw new HttpError(404, 'This invite link is not valid or was already used');
    res.json(u);
  });

  r.post('/invite/:token', (req, res) => {
    const { password, name } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE invite_token = ? AND active = 1').get(req.params.token);
    if (!u) throw new HttpError(404, 'This invite link is not valid or was already used');
    if (!password || password.length < 8) throw new HttpError(400, 'Choose a password of at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ?, invite_token = NULL, name = COALESCE(NULLIF(?, \'\'), name) WHERE id = ?')
      .run(hashPassword(password), cleanText(name), u.id);
    audit(db, u.id, 'user.invite_accepted', 'user', u.id);
    createSession(db, res, u.id, secureCookies);
    res.json({ ok: true });
  });

  return r;
}

export function createEvent(db, userId, name, dates) {
  const info = db.prepare('INSERT INTO events (name) VALUES (?)').run(name);
  const eventId = Number(info.lastInsertRowid);
  const ins = db.prepare('INSERT INTO event_days (event_id, date) VALUES (?,?)');
  for (const d of dates.length ? validDates(dates) : []) ins.run(eventId, d);
  const g = db.prepare('INSERT INTO groups (event_id, name) VALUES (?,?)');
  g.run(eventId, 'Staff');
  g.run(eventId, 'Partners & Sponsors');
  audit(db, userId, 'event.created', 'event', eventId, { name, dates });
  return eventId;
}

export function eventRoutes(db) {
  const r = Router();
  const admin = requireRole();

  // Shared event context for every signed-in role.
  r.get('/event', requireAuth, (req, res) => {
    const ev = getEvent(db);
    if (!ev) return res.json({ event: null, days: [], groups: [], zones: [] });
    const days = getDays(db, ev.id);
    const groups = db.prepare('SELECT id, name, archived FROM groups WHERE event_id = ? ORDER BY id').all(ev.id);
    const zones = db.prepare('SELECT * FROM zones WHERE event_id = ? ORDER BY number').all(ev.id);
    res.json({ event: ev, days, groups, zones, defaultDayId: defaultDay(days)?.id ?? null, today: todayISO() });
  });

  r.post('/event', admin, (req, res) => {
    if (getEvent(db)) throw new HttpError(409, 'An event already exists');
    const { name, dates } = req.body || {};
    if (!cleanText(name)) throw new HttpError(400, 'Event name is required');
    const id = tx(db, () => createEvent(db, req.user.id, cleanText(name), dates || []));
    res.json({ id });
  });

  r.put('/event', admin, (req, res) => {
    const ev = requireEvent(db);
    const { name, zoneLimit, retentionDate } = req.body || {};
    const limit = zoneLimit === undefined ? ev.zone_limit : Number(zoneLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 99) throw new HttpError(400, 'Zone limit must be 1–99');
    if (retentionDate && !DATE_RE.test(retentionDate)) throw new HttpError(400, 'Retention date must be a date');
    db.prepare('UPDATE events SET name = ?, zone_limit = ?, retention_date = ? WHERE id = ?')
      .run(cleanText(name) || ev.name, limit, retentionDate || null, ev.id);
    audit(db, req.user.id, 'event.updated', 'event', ev.id, { name, zoneLimit: limit, retentionDate });
    res.json({ ok: true });
  });

  // Replace the set of event days. Days that already hold records cannot be dropped.
  r.put('/event/days', admin, (req, res) => {
    const ev = requireEvent(db);
    const dates = validDates(req.body?.dates);
    tx(db, () => {
      const current = getDays(db, ev.id);
      for (const d of current) {
        if (dates.includes(d.date)) continue;
        const used = db.prepare(`SELECT
            (SELECT COUNT(*) FROM attendance WHERE day_id = ?) + (SELECT COUNT(*) FROM shirt_collections WHERE day_id = ?) AS n`)
          .get(d.id, d.id).n;
        if (used) throw new HttpError(409, `${d.date} already has check-ins and cannot be removed`);
        db.prepare('DELETE FROM availability WHERE day_id = ?').run(d.id);
        db.prepare('DELETE FROM event_days WHERE id = ?').run(d.id);
      }
      const ins = db.prepare('INSERT OR IGNORE INTO event_days (event_id, date) VALUES (?,?)');
      for (const d of dates) ins.run(ev.id, d);
      audit(db, req.user.id, 'event.days_updated', 'event', ev.id, { dates });
    });
    res.json({ days: getDays(db, ev.id) });
  });

  // Close a day: lock its totals as the daily record.
  r.post('/event/days/:id/close', admin, (req, res) => {
    const ev = requireEvent(db);
    const day = getDay(db, ev.id, intParam(req.params.id));
    if (day.closed_at) throw new HttpError(409, 'This day is already closed');
    const snapshot = buildReconciliation(db, ev.id, day.id, {}, { live: true });
    db.prepare('UPDATE event_days SET closed_at = ?, closed_by = ?, snapshot = ? WHERE id = ?')
      .run(nowISO(), req.user.id, JSON.stringify(snapshot), day.id);
    audit(db, req.user.id, 'day.closed', 'event_day', day.id, { date: day.date, totals: snapshot.totals });
    res.json({ ok: true });
  });

  r.post('/event/days/:id/reopen', admin, (req, res) => {
    const ev = requireEvent(db);
    const day = getDay(db, ev.id, intParam(req.params.id));
    if (!day.closed_at) throw new HttpError(409, 'This day is not closed');
    const reason = cleanText(req.body?.reason);
    if (!reason) throw new HttpError(400, 'Give a reason for reopening the day');
    db.prepare('UPDATE event_days SET closed_at = NULL, closed_by = NULL, snapshot = NULL WHERE id = ?').run(day.id);
    audit(db, req.user.id, 'day.reopened', 'event_day', day.id, { date: day.date, reason });
    res.json({ ok: true });
  });

  // Accreditation groups (F2).
  r.post('/groups', admin, (req, res) => {
    const ev = requireEvent(db);
    const name = cleanText(req.body?.name);
    if (!name) throw new HttpError(400, 'Group name is required');
    try {
      const info = db.prepare('INSERT INTO groups (event_id, name) VALUES (?,?)').run(ev.id, name);
      audit(db, req.user.id, 'group.created', 'group', Number(info.lastInsertRowid), { name });
      res.json({ id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A group with this name exists');
      throw e;
    }
  });

  r.patch('/groups/:id', admin, (req, res) => {
    const ev = requireEvent(db);
    const id = intParam(req.params.id);
    const g = db.prepare('SELECT * FROM groups WHERE id = ? AND event_id = ?').get(id, ev.id);
    if (!g) throw new HttpError(404, 'Group not found');
    const name = req.body?.name !== undefined ? cleanText(req.body.name) : g.name;
    const archived = req.body?.archived !== undefined ? (req.body.archived ? 1 : 0) : g.archived;
    if (!name) throw new HttpError(400, 'Group name is required');
    try {
      db.prepare('UPDATE groups SET name = ?, archived = ? WHERE id = ?').run(name, archived, id);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A group with this name exists');
      throw e;
    }
    audit(db, req.user.id, 'group.updated', 'group', id, { from: { name: g.name, archived: g.archived }, to: { name, archived } });
    res.json({ ok: true });
  });

  // Users and roles (F3). Invites are links the Admin shares; there is no mail server in v1.
  r.get('/users', admin, (_req, res) => {
    res.json(db.prepare(`SELECT id, email, name, role, active, created_at,
      CASE WHEN password_hash IS NULL THEN invite_token END AS invite_token FROM users ORDER BY role, email`).all());
  });

  r.post('/users', admin, (req, res) => {
    const email = cleanText(req.body?.email).toLowerCase();
    const role = req.body?.role;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Pick a role');
    const token = randomToken();
    try {
      const info = db.prepare('INSERT INTO users (email, name, role, invite_token) VALUES (?,?,?,?)')
        .run(email, cleanText(req.body?.name), role, token);
      audit(db, req.user.id, 'user.invited', 'user', Number(info.lastInsertRowid), { email, role });
      res.json({ id: Number(info.lastInsertRowid), inviteToken: token });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'This email already has an account');
      throw e;
    }
  });

  r.patch('/users/:id', admin, (req, res) => {
    const id = intParam(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'User not found');
    const role = req.body?.role ?? u.role;
    const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : u.active;
    const name = req.body?.name !== undefined ? cleanText(req.body.name) : u.name;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Pick a role');
    if (id === req.user.id && (role !== 'admin' || !active)) throw new HttpError(400, 'You cannot remove your own Admin access');
    db.prepare('UPDATE users SET role = ?, active = ?, name = ? WHERE id = ?').run(role, active, name, id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(db, req.user.id, 'user.updated', 'user', id, { from: { role: u.role, active: u.active }, to: { role, active } });
    res.json({ ok: true });
  });

  r.post('/users/:id/reset', admin, (req, res) => {
    const id = intParam(req.params.id);
    const token = randomToken();
    const info = db.prepare('UPDATE users SET invite_token = ?, password_hash = NULL WHERE id = ?').run(token, id);
    if (!info.changes) throw new HttpError(404, 'User not found');
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(db, req.user.id, 'user.reset', 'user', id);
    res.json({ inviteToken: token });
  });

  // Audit trail (F21).
  r.get('/audit', admin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const params = [before];
    let where = 'l.id < ?';
    if (req.query.action) { where += ' AND l.action LIKE ?'; params.push(`${req.query.action}%`); }
    if (req.query.entity && req.query.entityId) {
      where += ' AND l.entity = ? AND l.entity_id = ?';
      params.push(String(req.query.entity), Number(req.query.entityId));
    }
    const rows = db.prepare(`SELECT l.*, u.email AS user_email, u.name AS user_name FROM audit_log l
      LEFT JOIN users u ON u.id = l.user_id WHERE ${where} ORDER BY l.id DESC LIMIT ?`).all(...params, limit);
    res.json(rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })));
  });

  // Data protection: wipe personal data once the retention date has passed.
  r.post('/event/purge', admin, (req, res) => {
    const ev = requireEvent(db);
    if (req.body?.confirm !== ev.name) throw new HttpError(400, 'Type the event name to confirm');
    if (!ev.retention_date || ev.retention_date > todayISO()) {
      throw new HttpError(409, 'Set a retention date that has passed before deleting personal data');
    }
    tx(db, () => {
      db.prepare(`UPDATE attendees SET name = 'Deleted person ' || id, name_key = '', position = '', job_description = ''
        WHERE event_id = ?`).run(ev.id);
      db.prepare(`UPDATE submissions SET team_lead = '', contact_number = '' WHERE event_id = ?`).run(ev.id);
      db.prepare(`DELETE FROM submission_files WHERE submission_id IN (SELECT id FROM submissions WHERE event_id = ?)`).run(ev.id);
      db.prepare('DELETE FROM pending_uploads WHERE event_id = ?').run(ev.id);
      audit(db, req.user.id, 'event.personal_data_purged', 'event', ev.id);
    });
    res.json({ ok: true });
  });

  return r;
}
