// Demo data for a dry run: users for each role, the Flytime Fest event, sample zones
// and two company submissions waiting for review. Only runs on an empty database.
import { openDb, tx } from './db.js';
import { hashPassword } from './auth.js';
import { createEvent } from './routes/admin.js';
import { buildTemplate } from './template.js';
import { parseWorkbook, validateRows, commitImport } from './importer.js';
import { samplePeople, SAMPLE_DAYS } from './sampleData.js';
import { getDays } from './model.js';

const dbFile = process.env.DB_FILE || 'data/accreditation.db';
const db = openDb(dbFile);
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.error(`${dbFile} already has data. Delete it first to reseed.`);
  process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD || 'password123';
const users = [
  ['admin@example.com', 'Ada Admin', 'admin'],
  ['reviewer@example.com', 'Rita Reviewer', 'reviewer'],
  ['gate1@example.com', 'Gate One', 'accreditor'],
  ['gate2@example.com', 'Gate Two', 'accreditor'],
];

const zones = [
  [1, 'General', 'GEN', 'Arena floor, food court and public toilets', 'White'],
  [2, 'Production', 'PRD', 'Arena floor, production yard and loading bay', 'Blue'],
  [3, 'Backstage', 'BKS', 'Backstage and artist village', 'Red'],
  [4, 'VIP', 'VIP', 'VIP lounge and VIP bar', 'Gold'],
  [5, 'All access', 'AAA', 'Every area, including stage and control room', 'Black'],
];

const ids = tx(db, () => {
  const out = {};
  for (const [email, name, role] of users) {
    const info = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)').run(email, name, role, hashPassword(PASSWORD));
    out[role] = out[role] || Number(info.lastInsertRowid);
  }
  out.event = createEvent(db, out.admin, 'Flytime Fest 2026', SAMPLE_DAYS);
  const ins = db.prepare('INSERT INTO zones (event_id, number, name, code, access_definition, wristband) VALUES (?,?,?,?,?,?)');
  for (const z of zones) ins.run(out.event, ...z);
  return out;
});

const days = getDays(db, ids.event);
const groups = db.prepare('SELECT * FROM groups WHERE event_id = ?').all(ids.event);
const samples = samplePeople();
for (const [i, s] of samples.entries()) {
  const buf = await buildTemplate({ ...s, days: SAMPLE_DAYS, rows: s.people.length + 5 });
  const parsed = await parseWorkbook(buf, days);
  const rows = validateRows(db, ids.event, parsed.company, parsed.rows);
  tx(db, () => commitImport(db, {
    eventId: ids.event, groupId: groups[i % groups.length].id, company: parsed.company, teamLead: parsed.teamLead,
    contactNumber: parsed.contactNumber, rows, dayIds: parsed.dayIds, filename: s.file, content: buf, userId: ids.admin,
  }));
}

console.log(`Seeded ${dbFile}`);
console.log(`Sign in with any of these (password: ${PASSWORD}):`);
for (const [email, , role] of users) console.log(`  ${role.padEnd(10)} ${email}`);
