import { HttpError, todayISO } from './util.js';

/**
 * Key rule: a person is visible to Accreditors only when not removed, zoned, and in a published
 * submission (walk-ups added on site have no submission and are visible once zoned).
 * Use with `attendees a LEFT JOIN submissions s ON s.id = a.submission_id`.
 */
export const VISIBLE_SQL = `(a.removed = 0 AND a.zone_id IS NOT NULL AND
  ((a.submission_id IS NULL AND a.walkup_reason IS NOT NULL) OR s.status = 'published'))`;

export function getEvent(db) {
  return db.prepare('SELECT * FROM events ORDER BY id LIMIT 1').get() || null;
}

export function requireEvent(db) {
  const ev = getEvent(db);
  if (!ev) throw new HttpError(409, 'No event is set up yet. An Admin must create the event first.');
  return ev;
}

export function getDays(db, eventId) {
  return db.prepare('SELECT id, date, closed_at, closed_by FROM event_days WHERE event_id = ? ORDER BY date').all(eventId);
}

export function getDay(db, eventId, dayId) {
  const day = db.prepare('SELECT * FROM event_days WHERE id = ? AND event_id = ?').get(dayId, eventId);
  if (!day) throw new HttpError(404, 'Event day not found');
  return day;
}

/** The event day matching today's date, else the next upcoming day, else the last day. */
export function defaultDay(days) {
  if (!days.length) return null;
  const today = todayISO();
  return days.find((d) => d.date === today) || days.find((d) => d.date > today) || days[days.length - 1];
}

export function reviewStatus(a) {
  if (a.removed) return 'removed';
  if (a.zone_id) return 'zoned';
  return 'pending';
}

export function submissionCounts(db, submissionId) {
  return db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN removed = 0 AND zone_id IS NOT NULL THEN 1 ELSE 0 END) AS zoned,
      SUM(CASE WHEN removed = 1 THEN 1 ELSE 0 END) AS removed,
      SUM(CASE WHEN removed = 0 AND zone_id IS NULL THEN 1 ELSE 0 END) AS pending
    FROM attendees WHERE submission_id = ?`).get(submissionId);
}

export function isVisible(db, attendeeId) {
  return !!db.prepare(`SELECT 1 FROM attendees a LEFT JOIN submissions s ON s.id = a.submission_id
    WHERE a.id = ? AND ${VISIBLE_SQL}`).get(attendeeId);
}
