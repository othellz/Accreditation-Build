import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_FILE || 'data/accreditation.db';
const db = openDb(dbFile);
// Expire old sessions on boot.
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

const app = createApp(db, { secureCookies: process.env.SECURE_COOKIES === '1' });
app.listen(port, () => console.log(`Accreditation platform on http://localhost:${port} (db: ${dbFile})`));
