import { openDb } from './db.js';
import { createApp } from './app.js';
import { scheduleBackups } from './backup.js';

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_FILE || 'data/accreditation.db';
const db = openDb(dbFile);
// Expire old sessions on boot.
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

if (process.env.BACKUP_DIR) {
  scheduleBackups(db, process.env.BACKUP_DIR, {
    hours: Number(process.env.BACKUP_HOURS) || 24,
    keep: Number(process.env.BACKUP_KEEP) || 14,
  });
}

const app = createApp(db, { secureCookies: process.env.SECURE_COOKIES === '1' });
const server = app.listen(port, () => console.log(`Accreditation platform on http://localhost:${port} (db: ${dbFile})`));

// Close cleanly on container stop so the database is not left mid-write.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
