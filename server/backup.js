import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';

/** Online backup of the live database to BACKUP_DIR, keeping the newest `keep` files. */
export async function runBackup(db, dir, keep = 14) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `accreditation-${stamp}.db`);
  await backup(db, file);
  const old = fs.readdirSync(dir).filter((f) => /^accreditation-.*\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

/** Back up on start and then every `hours` hours. */
export function scheduleBackups(db, dir, { hours = 24, keep = 14 } = {}) {
  const go = () => runBackup(db, dir, keep)
    .then((f) => console.log(`Backup written: ${f}`))
    .catch((e) => console.error('Backup failed:', e.message));
  setTimeout(go, 5000);
  setInterval(go, hours * 3600e3).unref();
}
