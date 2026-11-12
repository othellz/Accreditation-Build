import { Router } from 'express';
import ExcelJS from 'exceljs';
import { requireRole } from '../auth.js';
import { HttpError, intParam, toCsv, todayISO, SHIRT_SIZES } from '../util.js';
import { VISIBLE_SQL, requireEvent, getDays, getDay, defaultDay } from '../model.js';

/**
 * Daily reconciliation (section 8). Counts always come from attendance records.
 * With `live: false` a closed day returns the totals locked when the Admin closed it.
 */
export function buildReconciliation(db, eventId, dayId, filters = {}, { live = false } = {}) {
  const day = getDay(db, eventId, dayId);
  if (day.closed_at && day.snapshot && !live) {
    const snap = JSON.parse(day.snapshot);
    return applyFilters({ ...snap, closed: { at: day.closed_at, by: day.closed_by } }, filters);
  }

  const rows = db.prepare(`
    SELECT g.id AS group_id, g.name AS group_name, a.company,
      SUM(CASE WHEN ${VISIBLE_SQL} THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM attendance t WHERE t.attendee_id = a.id AND t.day_id = @day) THEN 1 ELSE 0 END) AS accredited_today,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM shirt_collections sc WHERE sc.attendee_id = a.id AND sc.day_id = @day) THEN 1 ELSE 0 END) AS shirts_today,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM attendance t JOIN event_days d ON d.id = t.day_id
            WHERE t.attendee_id = a.id AND d.date <= @date) THEN 1 ELSE 0 END) AS accredited_to_date
    FROM attendees a
    LEFT JOIN submissions s ON s.id = a.submission_id
    JOIN groups g ON g.id = a.group_id
    WHERE a.event_id = @event
    GROUP BY g.id, a.company
    HAVING approved > 0 OR accredited_to_date > 0 OR shirts_today > 0
    ORDER BY g.name, a.company`).all({ day: day.id, date: day.date, event: eventId })
    .map((r) => ({ ...r, not_yet: Math.max(0, r.approved - r.accredited_today) }));

  const perDay = db.prepare(`SELECT d.id, d.date, d.closed_at, COUNT(t.id) AS accredited
    FROM event_days d LEFT JOIN attendance t ON t.day_id = d.id WHERE d.event_id = ? GROUP BY d.id ORDER BY d.date`).all(eventId);
  const unique = db.prepare(`SELECT COUNT(DISTINCT t.attendee_id) AS n FROM attendance t JOIN attendees a ON a.id = t.attendee_id
    WHERE a.event_id = ?`).get(eventId).n;
  const shirtsBySize = db.prepare(`SELECT sc.size, COUNT(*) AS total, SUM(CASE WHEN sc.day_id = ? THEN 1 ELSE 0 END) AS today
    FROM shirt_collections sc JOIN attendees a ON a.id = sc.attendee_id WHERE a.event_id = ? GROUP BY sc.size`).all(day.id, eventId);
  const sizeOrder = (s) => { const i = SHIRT_SIZES.indexOf(s); return i < 0 ? 99 : i; };
  shirtsBySize.sort((a, b) => sizeOrder(a.size) - sizeOrder(b.size));
  const wristbands = db.prepare(`SELECT z.number, z.name, z.wristband, COUNT(t.id) AS issued FROM attendance t
    LEFT JOIN zones z ON z.id = t.zone_id WHERE t.day_id = ? GROUP BY t.zone_id ORDER BY z.number`).all(day.id);
  const exceptions = db.prepare(`SELECT COUNT(*) AS n FROM attendance WHERE day_id = ? AND outside_availability = 1`).get(day.id).n;

  return applyFilters({
    day: { id: day.id, date: day.date },
    generatedAt: new Date().toISOString(),
    rows,
    event: { perDay, uniqueAccredited: unique, shirtsBySize, wristbands, outsideAvailability: exceptions },
    closed: null,
  }, filters);
}

function applyFilters(report, { groupId, company }) {
  let rows = report.rows;
  if (groupId) rows = rows.filter((r) => r.group_id === Number(groupId));
  if (company) rows = rows.filter((r) => r.company.toLowerCase().includes(String(company).toLowerCase()));
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  return {
    ...report,
    rows,
    totals: {
      approved: sum('approved'), accredited_today: sum('accredited_today'), not_yet: sum('not_yet'),
      shirts_today: sum('shirts_today'), accredited_to_date: sum('accredited_to_date'),
    },
  };
}

async function sendTable(res, format, filename, sheets) {
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    for (const s of sheets) {
      const ws = wb.addWorksheet(s.name.slice(0, 31));
      ws.addRow(s.headers).font = { bold: true };
      s.rows.forEach((r) => ws.addRow(r));
      ws.columns.forEach((c, i) => { c.width = Math.min(45, Math.max(10, String(s.headers[i] ?? '').length + 4)); });
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.end(Buffer.from(await wb.xlsx.writeBuffer()));
  } else {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.end('﻿' + toCsv(sheets[0].headers, sheets[0].rows));
  }
}

export function reportRoutes(db) {
  const r = Router();
  const reviewer = requireRole('reviewer');
  const admin = requireRole();

  function pickDay(ev, raw) {
    if (raw) return intParam(raw, 'day');
    const d = defaultDay(getDays(db, ev.id));
    if (!d) throw new HttpError(409, 'No event days are configured');
    return d.id;
  }

  r.get('/reconcile', reviewer, (req, res) => {
    const ev = requireEvent(db);
    const report = buildReconciliation(db, ev.id, pickDay(ev, req.query.dayId), {
      groupId: req.query.groupId, company: req.query.company,
    });
    res.json(report);
  });

  r.get('/reconcile/export', reviewer, async (req, res) => {
    const ev = requireEvent(db);
    const rep = buildReconciliation(db, ev.id, pickDay(ev, req.query.dayId), { groupId: req.query.groupId, company: req.query.company });
    const headers = ['Group', 'Company', 'Approved', 'Accredited today', 'Not yet accredited', 'Shirts issued today', 'Accredited to date'];
    const rows = rep.rows.map((x) => [x.group_name, x.company, x.approved, x.accredited_today, x.not_yet, x.shirts_today, x.accredited_to_date]);
    const t = rep.totals;
    rows.push(['', 'TOTAL', t.approved, t.accredited_today, t.not_yet, t.shirts_today, t.accredited_to_date]);
    const sheets = [{ name: `Day ${rep.day.date}`, headers, rows }];
    sheets.push({ name: 'Per day', headers: ['Date', 'Accredited'], rows: rep.event.perDay.map((d) => [d.date, d.accredited]).concat([['Unique people (event)', rep.event.uniqueAccredited]]) });
    sheets.push({ name: 'Shirts by size', headers: ['Size', 'Issued today', 'Issued total'], rows: rep.event.shirtsBySize.map((s) => [s.size, s.today, s.total]) });
    sheets.push({ name: 'Wristbands', headers: ['Zone', 'Name', 'Wristband', 'Issued today'], rows: rep.event.wristbands.map((w) => [w.number, w.name, w.wristband, w.issued]) });
    await sendTable(res, req.query.format, `reconciliation-${rep.day.date}`, sheets);
  });

  // Backup and export: the full list with zones and attendance at any time.
  r.get('/export/full', admin, async (req, res) => {
    const ev = requireEvent(db);
    const days = getDays(db, ev.id);
    const people = db.prepare(`SELECT a.*, g.name AS group_name, s.status AS submission_status, z.number AS zone_number, z.name AS zone_name,
        sc.at AS shirt_at, sc.size AS shirt_given, su.email AS shirt_by
      FROM attendees a JOIN groups g ON g.id = a.group_id LEFT JOIN submissions s ON s.id = a.submission_id
      LEFT JOIN zones z ON z.id = a.zone_id LEFT JOIN shirt_collections sc ON sc.attendee_id = a.id LEFT JOIN users su ON su.id = sc.by_user
      WHERE a.event_id = ? ORDER BY g.name, a.company, a.name`).all(ev.id);
    const att = db.prepare('SELECT attendee_id, day_id, at FROM attendance t JOIN attendees a ON a.id = t.attendee_id WHERE a.event_id = ?').all(ev.id);
    const map = new Map(att.map((x) => [`${x.attendee_id}:${x.day_id}`, x.at]));
    const headers = ['Group', 'Company', 'Name', 'Position', 'Job description', 'Work period', 'Shirt size', 'Zone', 'Zone name',
      'Review status', 'Submission status', 'Walk-up reason', 'Shirt collected at', 'Shirt size given', 'Shirt given by',
      ...days.map((d) => `Attended ${d.date}`)];
    const rows = people.map((p) => [p.group_name, p.company, p.name, p.position, p.job_description, p.work_period, p.shirt_size,
      p.zone_number ?? '', p.zone_name ?? '', p.removed ? 'Removed' : p.zone_id ? 'Zoned' : 'Pending', p.submission_status ?? 'walk-up',
      p.walkup_reason ?? '', p.shirt_at ?? '', p.shirt_given ?? '', p.shirt_by ?? '',
      ...days.map((d) => map.get(`${p.id}:${d.id}`) ?? '')]);
    await sendTable(res, req.query.format, `full-export-${todayISO()}`, [{ name: 'Attendees', headers, rows }]);
  });

  // Admin overview: event days, submissions by status, approved vs accredited, today's count.
  r.get('/overview', admin, (_req, res) => {
    const ev = requireEvent(db);
    const days = getDays(db, ev.id);
    const day = defaultDay(days);
    const subs = db.prepare(`SELECT status, COUNT(*) AS n FROM submissions WHERE event_id = ? GROUP BY status`).all(ev.id);
    const people = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ${VISIBLE_SQL} THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN a.removed = 0 AND a.zone_id IS NULL THEN 1 ELSE 0 END) AS pending,
        SUM(a.removed) AS removed
      FROM attendees a LEFT JOIN submissions s ON s.id = a.submission_id WHERE a.event_id = ?`).get(ev.id);
    const perDay = db.prepare(`SELECT d.id, d.date, d.closed_at, COUNT(t.id) AS accredited FROM event_days d
      LEFT JOIN attendance t ON t.day_id = d.id WHERE d.event_id = ? GROUP BY d.id ORDER BY d.date`).all(ev.id);
    const zones = db.prepare(`SELECT COUNT(*) AS n FROM zones WHERE event_id = ? AND status = 'active'`).get(ev.id).n;
    const users = db.prepare(`SELECT role, COUNT(*) AS n FROM users WHERE active = 1 GROUP BY role`).all();
    res.json({
      event: ev,
      today: todayISO(),
      day,
      submissions: Object.fromEntries(subs.map((s) => [s.status, s.n])),
      people: { total: people.total || 0, approved: people.approved || 0, pending: people.pending || 0, removed: people.removed || 0 },
      perDay,
      todayCount: day ? perDay.find((d) => d.id === day.id)?.accredited ?? 0 : 0,
      activeZones: zones,
      users: Object.fromEntries(users.map((u) => [u.role, u.n])),
      retentionPassed: !!ev.retention_date && ev.retention_date <= todayISO(),
    });
  });

  return r;
}
