import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('accreditor','reviewer','admin')),
  password_hash TEXT,
  invite_token TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- One active event at a time (v1). Settings live on the event.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  zone_limit INTEGER NOT NULL DEFAULT 10,
  retention_date TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS event_days (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  date TEXT NOT NULL,              -- YYYY-MM-DD
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  snapshot TEXT,                   -- JSON reconciliation locked at close
  UNIQUE (event_id, date)
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, name)
);

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  access_definition TEXT NOT NULL DEFAULT '',
  wristband TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  UNIQUE (event_id, number)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  company TEXT NOT NULL,
  company_key TEXT NOT NULL,
  team_lead TEXT NOT NULL DEFAULT '',
  contact_number TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','in_review','published')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT,
  published_by INTEGER REFERENCES users(id),
  UNIQUE (event_id, company_key)
);

-- Every uploaded original file is kept for reference.
CREATE TABLE IF NOT EXISTS submission_files (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  filename TEXT NOT NULL,
  content BLOB NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  summary TEXT
);

-- Upload previews waiting for the Admin to confirm.
CREATE TABLE IF NOT EXISTS pending_uploads (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  filename TEXT NOT NULL,
  content BLOB NOT NULL,
  parsed TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS attendees (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  submission_id INTEGER REFERENCES submissions(id),   -- NULL for walk-ups
  group_id INTEGER NOT NULL REFERENCES groups(id),
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  job_description TEXT NOT NULL DEFAULT '',
  work_period TEXT NOT NULL DEFAULT '',
  shirt_size TEXT NOT NULL DEFAULT '',
  zone_id INTEGER REFERENCES zones(id),
  removed INTEGER NOT NULL DEFAULT 0,
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  import_flag TEXT,           -- new | changed | missing (latest re-upload result)
  import_issues TEXT,         -- JSON array of issue strings accepted at import
  walkup_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_att_sub ON attendees(submission_id);
CREATE INDEX IF NOT EXISTS idx_att_event_name ON attendees(event_id, name_key);
CREATE INDEX IF NOT EXISTS idx_att_company ON attendees(event_id, company);

CREATE TABLE IF NOT EXISTS availability (
  attendee_id INTEGER NOT NULL REFERENCES attendees(id) ON DELETE CASCADE,
  day_id INTEGER NOT NULL REFERENCES event_days(id) ON DELETE CASCADE,
  available INTEGER NOT NULL,
  PRIMARY KEY (attendee_id, day_id)
);

-- One-time shirt flag: the primary key makes a second issue impossible.
CREATE TABLE IF NOT EXISTS shirt_collections (
  attendee_id INTEGER PRIMARY KEY REFERENCES attendees(id),
  day_id INTEGER NOT NULL REFERENCES event_days(id),
  size TEXT NOT NULL,
  at TEXT NOT NULL,
  by_user INTEGER NOT NULL REFERENCES users(id)
);

-- One attendance record per person per day.
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  attendee_id INTEGER NOT NULL REFERENCES attendees(id),
  day_id INTEGER NOT NULL REFERENCES event_days(id),
  zone_id INTEGER REFERENCES zones(id),       -- wristband zone issued
  outside_availability INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  by_user INTEGER NOT NULL REFERENCES users(id),
  UNIQUE (attendee_id, day_id)
);
CREATE INDEX IF NOT EXISTS idx_attendance_day ON attendance(day_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- The audit log is append-only.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction (node:sqlite has no helper). */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
