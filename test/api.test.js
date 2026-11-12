import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { buildTemplate } from '../server/template.js';
import { samplePeople, SAMPLE_DAYS } from '../server/sampleData.js';
import { normalizePhone, normalizeShirtSize, normalizeWorkPeriod } from '../server/util.js';

let server, base, db;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, { form } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b ?? {}); }
  patch(u, b) { return this.req('PATCH', u, b); }
  put(u, b) { return this.req('PUT', u, b); }
  del(u, b) { return this.req('DELETE', u, b); }
  async upload(buffer, filename, groupId) {
    const form = new FormData();
    form.append('groupId', String(groupId));
    form.append('file', new Blob([buffer]), filename);
    return this.req('POST', '/api/uploads', undefined, { form });
  }
}

const admin = new Client();
const reviewer = new Client();
const acc1 = new Client();
const acc2 = new Client();
let ctx;

async function invite(client, email, role) {
  const r = await admin.post('/api/users', { email, role, name: email.split('@')[0] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = await client.post(`/api/invite/${r.data.inviteToken}`, { password: 'password123' });
  assert.equal(a.status, 200);
}

before(async () => {
  db = openDb(':memory:');
  server = createApp(db, { serveClient: false }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('normalisers', () => {
  assert.equal(normalizePhone('0803 123 4567'), '+2348031234567');
  assert.equal(normalizePhone('+234 812 555 0199'), '+2348125550199');
  assert.equal(normalizeShirtSize('2xl'), 'XXL');
  assert.equal(normalizeShirtSize('XXXXL'), null);
  assert.equal(normalizeWorkPeriod('before and during event'), 'Before & During Event');
  assert.equal(normalizeWorkPeriod('BEFORE EVENT ONLY'), 'Before Event Only');
});

test('setup, users and roles', async () => {
  const s = await admin.post('/api/auth/setup', { email: 'lead@example.com', name: 'Lead', password: 'password123', eventName: 'Flytime Fest 2026', dates: SAMPLE_DAYS });
  assert.equal(s.status, 200);
  assert.equal((await admin.post('/api/auth/setup', { email: 'x@example.com', password: 'password123' })).status, 409);
  await invite(reviewer, 'rev@example.com', 'reviewer');
  await invite(acc1, 'acc1@example.com', 'accreditor');
  await invite(acc2, 'acc2@example.com', 'accreditor');
  const ev = await admin.get('/api/event');
  assert.equal(ev.data.days.length, 6);
  assert.deepEqual(ev.data.groups.map((g) => g.name), ['Staff', 'Partners & Sponsors']);
  ctx = ev.data;
  // Server-side role checks.
  assert.equal((await acc1.get('/api/users')).status, 403);
  assert.equal((await reviewer.post('/api/groups', { name: 'Media' })).status, 403);
  assert.equal((await acc1.post('/api/zones', { number: 1, name: 'X' })).status, 403);
  assert.equal((await admin.post('/api/groups', { name: 'Media' })).status, 200);
});

test('reviewer defines zones', async () => {
  for (let n = 1; n <= 3; n++) {
    const r = await reviewer.post('/api/zones', { number: n, name: `Zone ${n}`, code: `Z${n}`, accessDefinition: n === 3 ? 'Backstage and artist village' : 'General', wristband: ['Red', 'Blue', 'Gold'][n - 1] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.equal((await reviewer.post('/api/zones', { number: 11, name: 'Too high' })).status, 400);
  ctx = (await admin.get('/api/event')).data;
});

let subA, subB;
test('upload with preview, row errors and confirm', async () => {
  const [a, b] = samplePeople();
  const people = [...a.people, { name: '', position: 'Ghost', job: 'x', period: 'Before Event Only', size: 'M' },
    { name: 'Odd Size', position: 'Runner', job: 'x', period: 'Sometimes', size: 'XXXXL' }, { ...a.people[0] }];
  const buf = await buildTemplate({ ...a, people, days: SAMPLE_DAYS, rows: people.length });
  const staff = ctx.groups.find((g) => g.name === 'Staff').id;
  const p = await admin.upload(buf, a.file, staff);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.company, 'Stagecraft Productions');
  assert.equal(p.data.contactNumber, '+2348031234567');
  assert.equal(p.data.rows.length, people.length);
  const codes = (r) => r.issues.map((i) => i.code);
  assert.ok(codes(p.data.rows.find((r) => r.position === 'Ghost')).includes('missing_name'));
  const odd = p.data.rows.find((r) => r.name === 'Odd Size');
  assert.ok(codes(odd).includes('shirt_size') && codes(odd).includes('work_period'));
  assert.ok(codes(p.data.rows[0]).includes('duplicate'));

  // Unresolved rows block confirmation.
  const blocked = await admin.post(`/api/uploads/${p.data.id}/confirm`, { company: p.data.company, rows: p.data.rows.map((r) => ({ ...r, decision: 'import' })) });
  assert.equal(blocked.status, 422);

  const rows = p.data.rows.map((r) => {
    if (r.position === 'Ghost') return { ...r, decision: 'skip' };
    if (r.name === 'Odd Size') return { ...r, shirtSize: 'L', workPeriod: 'Before Event Only', decision: 'import' }; // fixed in preview
    if (r.issues.length) return { ...r, decision: 'accept' };
    return { ...r, decision: 'import' };
  });
  const ok = await admin.post(`/api/uploads/${p.data.id}/confirm`, { company: p.data.company, teamLead: p.data.teamLead, contactNumber: p.data.contactNumber, rows });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.new, people.length - 1);
  assert.equal(ok.data.skipped, 1);
  subA = ok.data.submissionId;

  const partners = ctx.groups.find((g) => g.name === 'Partners & Sponsors').id;
  const pb = await admin.upload(await buildTemplate({ ...b, days: SAMPLE_DAYS }), b.file, partners);
  const okb = await admin.post(`/api/uploads/${pb.data.id}/confirm`, { rows: pb.data.rows.map((r) => ({ ...r, decision: r.issues.length ? 'accept' : 'import' })) });
  assert.equal(okb.status, 200, JSON.stringify(okb.data));
  subB = okb.data.submissionId;

  const q = await reviewer.get('/api/submissions');
  assert.equal(q.data.length, 2);
  assert.ok(q.data.every((s) => s.status === 'uploaded'));
});

test('publishing is blocked while anyone is Pending; bulk zone and remove', async () => {
  const s = await reviewer.get(`/api/submissions/${subA}`);
  const ids = s.data.attendees.map((a) => a.id);
  const blocked = await reviewer.post(`/api/submissions/${subA}/publish`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.pending, ids.length);

  const zone1 = ctx.zones.find((z) => z.number === 1).id;
  const r1 = await reviewer.post('/api/attendees/bulk', { ids: ids.slice(0, -1), action: 'zone', zoneId: zone1 });
  assert.equal(r1.data.changed, ids.length - 1);
  const still = await reviewer.post(`/api/submissions/${subA}/publish`);
  assert.equal(still.status, 409);
  assert.equal(still.data.pending, 1);
  await reviewer.post('/api/attendees/bulk', { ids: ids.slice(-1), action: 'remove' });
  const pub = await reviewer.post(`/api/submissions/${subA}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.data));

  const sb = await reviewer.get(`/api/submissions/${subB}`);
  await reviewer.post('/api/attendees/bulk', { ids: sb.data.attendees.map((a) => a.id), action: 'zone', zoneId: ctx.zones[1].id });
  assert.equal((await reviewer.post(`/api/submissions/${subB}/publish`)).status, 200);
});

test('removed people never reach accreditors', async () => {
  const s = await reviewer.get(`/api/submissions/${subA}`);
  const removed = s.data.attendees.find((a) => a.removed);
  const res = await acc1.get(`/api/accredit/search?q=${encodeURIComponent(removed.name)}`);
  assert.ok(!res.data.results.some((r) => r.id === removed.id));
  assert.equal((await acc1.get(`/api/accredit/people/${removed.id}`)).status, 404);
  // Restore brings them back once zoned; the restore is logged.
  await reviewer.post('/api/attendees/bulk', { ids: [removed.id], action: 'restore' });
  await reviewer.post('/api/attendees/bulk', { ids: [removed.id], action: 'zone', zoneId: ctx.zones[0].id });
  assert.equal((await acc1.get(`/api/accredit/people/${removed.id}`)).status, 200);
});

test('check-in: shirt once, attendance once per day, concurrency, undo', async () => {
  const s = await reviewer.get(`/api/submissions/${subA}`);
  const person = s.data.attendees.find((a) => !a.removed && a.availability[ctx.days[1].id] && a.availability[ctx.days[2].id]);
  const day2 = ctx.days[1].id, day3 = ctx.days[2].id;

  // Reviewer can search but not act.
  assert.equal((await reviewer.get(`/api/accredit/people/${person.id}`)).status, 200);
  assert.equal((await reviewer.post(`/api/accredit/people/${person.id}/attend`, { dayId: day2 })).status, 403);

  const shirt = await acc1.post(`/api/accredit/people/${person.id}/shirt`, { dayId: day2 });
  assert.equal(shirt.status, 200);
  const shirt2 = await acc2.post(`/api/accredit/people/${person.id}/shirt`, { dayId: day3 });
  assert.equal(shirt2.status, 409);

  // Two accreditors tap at once: only the first succeeds; the second sees who and when.
  const [x, y] = await Promise.all([
    acc1.post(`/api/accredit/people/${person.id}/attend`, { dayId: day2 }),
    acc2.post(`/api/accredit/people/${person.id}/attend`, { dayId: day2 }),
  ]);
  const statuses = [x.status, y.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = x.status === 409 ? x : y;
  assert.ok(loser.data.by && loser.data.at);

  // Day 3: not attended today, shirt still collected.
  const card3 = await acc1.get(`/api/accredit/people/${person.id}?dayId=${day3}`);
  assert.equal(card3.data.attendance, null);
  assert.ok(card3.data.shirt);

  // Undo by someone else is refused; by the same accreditor the same day works.
  const winner = x.status === 200 ? acc1 : acc2;
  const other = x.status === 200 ? acc2 : acc1;
  assert.equal((await other.del(`/api/accredit/people/${person.id}/attend?dayId=${day2}`)).status, 403);
  assert.equal((await winner.del(`/api/accredit/people/${person.id}/attend?dayId=${day2}`)).status, 200);
  assert.equal((await acc1.post(`/api/accredit/people/${person.id}/attend`, { dayId: day2 })).status, 200);

  // Zone change after wristband issued warns on the card.
  await reviewer.post('/api/attendees/bulk', { ids: [person.id], action: 'zone', zoneId: ctx.zones[2].id });
  const warn = await acc1.get(`/api/accredit/people/${person.id}?dayId=${day3}`);
  assert.match(warn.data.wristbandWarning, /Swap the wristband/);

  // Attending outside availability is allowed and logged.
  const notAvail = s.data.attendees.find((a) => !a.removed && a.availability[day3] === false);
  const r = await acc2.post(`/api/accredit/people/${notAvail.id}/attend`, { dayId: day3 });
  assert.equal(r.status, 200);
  assert.equal(r.data.availableToday, false);
  const log = await admin.get('/api/audit?action=attendance.outside');
  assert.ok(log.data.length >= 1);
});

test('reconciliation, close day, exports, audit immutability', async () => {
  const day2 = ctx.days[1].id;
  const rep = await reviewer.get(`/api/reconcile?dayId=${day2}`);
  assert.equal(rep.status, 200);
  assert.equal(rep.data.totals.accredited_today, 1);
  assert.equal(rep.data.totals.shirts_today, 1);
  assert.equal(rep.data.totals.approved, rep.data.totals.not_yet + 1);
  assert.equal(rep.data.rows.length, 2);
  assert.equal((await acc1.get(`/api/reconcile?dayId=${day2}`)).status, 403);
  const counts = await acc1.get('/api/accredit/counts');
  assert.equal(counts.status, 200);

  const csv = await reviewer.get(`/api/reconcile/export?dayId=${day2}&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(Buffer.from(csv.data).toString(), /Stagecraft Productions/);
  const xlsx = await admin.get('/api/export/full?format=xlsx');
  assert.equal(xlsx.status, 200);

  assert.equal((await admin.post(`/api/event/days/${day2}/close`)).status, 200);
  const s = await reviewer.get(`/api/submissions/${subB}`);
  const blocked = await acc1.post(`/api/accredit/people/${s.data.attendees[0].id}/attend`, { dayId: day2 });
  assert.equal(blocked.status, 409);
  const locked = await reviewer.get(`/api/reconcile?dayId=${day2}`);
  assert.ok(locked.data.closed);

  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x'").run(), /immutable/);
});

test('re-upload updates rows, keeps zones and check-ins, flags missing people', async () => {
  const [a] = samplePeople();
  const before = await reviewer.get(`/api/submissions/${subA}`);
  const changed = a.people.slice(1).map((p, i) => (i === 0 ? { ...p, position: 'Head Rigger' } : p));
  changed.push({ name: 'New Person', position: 'Runner', job: 'Late addition', period: 'Before & During Event', size: 'M' });
  const staff = ctx.groups.find((g) => g.name === 'Staff').id;
  const p = await admin.upload(await buildTemplate({ ...a, people: changed, days: SAMPLE_DAYS }), 'v2.xlsx', staff);
  assert.equal(p.status, 200);
  assert.equal(p.data.existingSubmission.id, subA);
  assert.ok(p.data.missing.length >= 1);
  assert.ok(p.data.rows.some((r) => r.status === 'new'));
  const ok = await admin.post(`/api/uploads/${p.data.id}/confirm`, { rows: p.data.rows.map((r) => ({ ...r, decision: r.issues.length ? 'accept' : 'import' })) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const after = await reviewer.get(`/api/submissions/${subA}`);
  assert.equal(after.data.attendees.length, before.data.attendees.length + 1);
  const zonedBefore = before.data.attendees.filter((x) => x.zone_id).length;
  assert.equal(after.data.attendees.filter((x) => x.zone_id).length, zonedBefore);
  assert.ok(after.data.attendees.some((x) => x.import_flag === 'missing'));
  assert.ok(after.data.attendees.some((x) => x.import_flag === 'new' && x.status === 'pending'));
  assert.equal(after.data.files.length, 2);
});

test('zones in use cannot be deleted, only retired; walk-ups', async () => {
  const z1 = ctx.zones[0].id;
  assert.equal((await reviewer.del(`/api/zones/${z1}`)).status, 409);
  assert.equal((await reviewer.patch(`/api/zones/${z1}`, { status: 'retired' })).status, 200);
  const s = await reviewer.get(`/api/submissions/${subA}`);
  assert.equal((await reviewer.post('/api/attendees/bulk', { ids: [s.data.attendees[0].id], action: 'zone', zoneId: z1 })).status, 409);

  const w = await admin.post('/api/walkups', { name: 'Walk In', company: 'Stagecraft Productions', groupId: ctx.groups[0].id, shirtSize: 'L', zoneId: ctx.zones[1].id, reason: 'Replacement rigger' });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  const found = await acc1.get('/api/accredit/search?q=walk in');
  assert.ok(found.data.results.some((r) => r.id === w.data.id));
});

test('login is rate limited after repeated failures', async () => {
  const c = new Client();
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/auth/login', { email: 'lead@example.com', password: 'wrong' });
  assert.equal(last.status, 429);
});

test('database backup', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runBackup } = await import('../server/backup.js');
  const { openDb: open } = await import('../server/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const src = open(path.join(dir, 'live.db'));
  src.prepare("INSERT INTO events (name) VALUES ('x')").run();
  for (let i = 0; i < 3; i++) await runBackup(src, path.join(dir, 'b'), 2);
  const files = fs.readdirSync(path.join(dir, 'b'));
  assert.ok(files.length >= 1 && files.length <= 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setup requires SETUP_TOKEN when configured', async () => {
  const d2 = openDb(':memory:');
  const s2 = createApp(d2, { serveClient: false }).listen(0);
  const url = `http://127.0.0.1:${s2.address().port}/api/auth/setup`;
  process.env.SETUP_TOKEN = 'secret-code';
  try {
    const body = { email: 'a@example.com', password: 'password123' };
    const post = (b) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.equal((await post(body)).status, 403);
    assert.equal((await post({ ...body, setupToken: 'secret-code' })).status, 200);
  } finally {
    delete process.env.SETUP_TOKEN;
    s2.close();
  }
});
