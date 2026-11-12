import ExcelJS from 'exceljs';
import {
  cleanText, nameKey, companyKey, normalizePhone, normalizeShirtSize, normalizeWorkPeriod,
  parseYesNo, HttpError, audit, nowISO, SHIRT_SIZES, WORK_PERIODS,
} from './util.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Plain value of an ExcelJS cell (rich text, formulas, hyperlinks, dates). */
function cellValue(cell) {
  let v = cell?.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) v = v.result;
    else if ('text' in v) v = v.text;
    else if ('error' in v) return null;
  }
  return v;
}

function cellText(cell) {
  const v = cellValue(cell);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return cleanText(v);
}

/** Recognise a day column header. Returns {month, day} | {index} | null. */
export function parseDayHeader(v) {
  if (v instanceof Date) return { month: v.getUTCMonth() + 1, day: v.getUTCDate() };
  const s = cleanText(v).toLowerCase();
  if (!s) return null;
  let m = s.match(/^day\s*(\d{1,2})$/);
  if (m) return { index: Number(m[1]) };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { month: Number(m[2]), day: Number(m[3]) };
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/);
  if (m) return { month: MONTHS[m[2]], day: Number(m[1]) };
  m = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-/.]*(\d{1,2})/);
  if (m) return { month: MONTHS[m[1]], day: Number(m[2]) };
  m = s.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/);
  if (m) return { month: Number(m[2]), day: Number(m[1]) }; // dd/mm[/yyyy]
  return null;
}

function headerField(text) {
  const t = text.toLowerCase();
  if (/^(s\/?n|no\.?|#|serial)/.test(t)) return 'sn';
  if (/shirt|size/.test(t)) return 'shirtSize';
  if (/period/.test(t)) return 'workPeriod';
  if (/job|description|duty|duties|role/.test(t)) return 'jobDescription';
  if (/position|designation|title/.test(t)) return 'position';
  if (/name/.test(t) && !/company/.test(t)) return 'name';
  if (/company/.test(t)) return 'company';
  if (/availab/.test(t)) return 'availability';
  return null;
}

/**
 * Parse a company workbook in the Flytime template.
 * Header block (company, team lead, contact) sits above a table with one row per person
 * and one Yes/No column per event day.
 */
export async function parseWorkbook(buffer, days) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new HttpError(400, 'This file could not be read. Upload the Excel (.xlsx) template.');
  }
  const ws = wb.worksheets.find((w) => w.state !== 'hidden' && w.actualRowCount > 0) || wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'The workbook has no sheets');

  const warnings = [];
  const maxScan = Math.min(ws.rowCount, 40);

  // Locate the table header row: has a Name column plus at least one other known column.
  let headerRow = null;
  for (let r = 1; r <= maxScan; r++) {
    const row = ws.getRow(r);
    const fields = [];
    row.eachCell({ includeEmpty: false }, (cell) => fields.push(headerField(cellText(cell))));
    if (fields.includes('name') && fields.some((f) => ['position', 'shirtSize', 'workPeriod', 'jobDescription'].includes(f))) {
      headerRow = r;
      break;
    }
  }
  if (!headerRow) throw new HttpError(400, 'Could not find the table header (a row with NAME and POSITION columns).');

  // Header block above the table.
  const meta = { company: '', teamLead: '', contactNumber: '' };
  const labelPatterns = [
    ['company', /company/],
    ['teamLead', /team\s*lead|lead\b|contact\s*person/],
    ['contactNumber', /contact|phone|tel|number|mobile/],
  ];
  for (let r = 1; r < headerRow; r++) {
    const row = ws.getRow(r);
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => cells.push({ col, text: cellText(cell) }));
    for (let i = 0; i < cells.length; i++) {
      const text = cells[i].text;
      const label = text.split(':')[0].toLowerCase();
      if (label.length > 40) continue;
      for (const [key, re] of labelPatterns) {
        if (meta[key] || !re.test(label)) continue;
        if (key === 'contactNumber' && /company/.test(label)) continue;
        const inline = text.includes(':') ? cleanText(text.slice(text.indexOf(':') + 1)) : '';
        const value = inline || (cells[i + 1] ? cells[i + 1].text : '');
        if (value) meta[key] = value;
        break;
      }
    }
  }

  // Column map.
  const cols = {};
  const dayCols = [];
  const header = ws.getRow(headerRow);
  let availabilityCol = null;
  header.eachCell({ includeEmpty: false }, (cell, col) => {
    const raw = cellValue(cell);
    const dh = parseDayHeader(raw);
    if (dh) { dayCols.push({ col, header: cellText(cell), ...dh }); return; }
    const f = headerField(cellText(cell));
    if (f === 'availability') availabilityCol = col;
    else if (f && !cols[f]) cols[f] = col;
  });

  // Day headers may sit on the row under a merged "AVAILABILITY" heading.
  let firstDataRow = headerRow + 1;
  if (dayCols.length === 0) {
    const below = ws.getRow(headerRow + 1);
    below.eachCell({ includeEmpty: false }, (cell, col) => {
      const dh = parseDayHeader(cellValue(cell));
      if (dh) dayCols.push({ col, header: cellText(cell), ...dh });
    });
    if (dayCols.length) firstDataRow = headerRow + 2;
    else if (availabilityCol) warnings.push('Found an AVAILABILITY heading but no day columns under it.');
  }

  // Map day columns to configured event days.
  const dayMap = [];
  for (const dc of dayCols) {
    let day = null;
    if (dc.index) day = days[dc.index - 1];
    else day = days.find((d) => Number(d.date.slice(5, 7)) === dc.month && Number(d.date.slice(8, 10)) === dc.day);
    if (day) dayMap.push({ col: dc.col, dayId: day.id, header: dc.header });
    else warnings.push(`Column "${dc.header}" does not match a configured event day and was ignored.`);
  }
  const missingDays = days.filter((d) => !dayMap.some((m) => m.dayId === d.id));
  if (missingDays.length && days.length) {
    warnings.push(`No availability column for: ${missingDays.map((d) => d.date).join(', ')}.`);
  }

  const rows = [];
  for (let r = firstDataRow; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (f) => (cols[f] ? cellText(row.getCell(cols[f])) : '');
    const rec = {
      rowNumber: r,
      name: get('name'),
      position: get('position'),
      jobDescription: get('jobDescription'),
      workPeriod: get('workPeriod'),
      shirtSize: get('shirtSize'),
      availability: {},
    };
    for (const m of dayMap) {
      const v = cellValue(row.getCell(m.col));
      rec.availability[m.dayId] = parseYesNo(v);
    }
    const hasContent = rec.name || rec.position || rec.jobDescription || rec.workPeriod || rec.shirtSize;
    if (!hasContent) continue;
    rows.push(rec);
  }

  return {
    company: cleanText(meta.company),
    teamLead: cleanText(meta.teamLead),
    contactNumber: normalizePhone(meta.contactNumber),
    dayIds: dayMap.map((m) => m.dayId),
    warnings,
    rows,
  };
}

/** Normalise and validate rows. Issues must be fixed, accepted or skipped before import. */
export function validateRows(db, eventId, company, rows) {
  const ck = companyKey(company);
  const seen = new Map();
  for (const r of rows) {
    const k = nameKey(r.name);
    if (k) seen.set(k, (seen.get(k) || 0) + 1);
  }
  const other = db.prepare(`
    SELECT company FROM attendees
    WHERE event_id = ? AND name_key = ? AND removed = 0`);

  return rows.map((r) => {
    const issues = [];
    const name = cleanText(r.name);
    const shirt = normalizeShirtSize(r.shirtSize);
    const period = normalizeWorkPeriod(r.workPeriod);
    if (!name) issues.push({ code: 'missing_name', message: 'Missing name', blocking: true });
    if (!shirt) issues.push({ code: 'shirt_size', message: r.shirtSize ? `Unknown shirt size "${r.shirtSize}"` : 'Missing shirt size' });
    if (!period) issues.push({ code: 'work_period', message: r.workPeriod ? `Unknown work period "${r.workPeriod}"` : 'Missing work period' });
    const k = nameKey(name);
    if (k && seen.get(k) > 1) issues.push({ code: 'duplicate', message: 'Same name appears more than once in this file' });
    if (k) {
      const others = [...new Set(other.all(eventId, k).map((o) => o.company))]
        .filter((c) => companyKey(c) !== ck).slice(0, 3);
      if (others.length) issues.push({ code: 'duplicate_other', message: `Also submitted by ${others.join(', ')}` });
    }
    const badAvail = Object.values(r.availability || {}).some((v) => v === null);
    if (badAvail) issues.push({ code: 'availability', message: 'Some day cells are not Yes/No (treated as No)' });
    return {
      ...r,
      name,
      position: cleanText(r.position),
      jobDescription: cleanText(r.jobDescription),
      shirtSize: shirt || cleanText(r.shirtSize),
      workPeriod: period || cleanText(r.workPeriod),
      issues,
    };
  });
}

/** Pair incoming rows with existing attendees of the same company by name (then position). */
export function matchExisting(existing, rows) {
  const byKey = new Map();
  for (const e of existing) {
    if (!byKey.has(e.name_key)) byKey.set(e.name_key, []);
    byKey.get(e.name_key).push(e);
  }
  const used = new Set();
  const matches = rows.map((r) => {
    const candidates = (byKey.get(nameKey(r.name)) || []).filter((e) => !used.has(e.id));
    if (!candidates.length) return null;
    const pk = nameKey(r.position);
    const pick = candidates.find((e) => nameKey(e.position) === pk) || candidates[0];
    used.add(pick.id);
    return pick;
  });
  const missing = existing.filter((e) => !used.has(e.id) && !e.walkup_reason);
  return { matches, missing };
}

function rowDiffers(existing, row, availability) {
  if (existing.name !== row.name || existing.position !== row.position ||
      existing.job_description !== row.jobDescription || existing.work_period !== row.workPeriod ||
      existing.shirt_size !== row.shirtSize) return true;
  return Object.entries(row.availability || {}).some(([dayId, v]) => (availability.get(Number(dayId)) ?? null) !== (v ? 1 : 0));
}

/** Summarise what confirming would change, for the preview. */
export function previewChanges(db, eventId, company, rows) {
  const sub = db.prepare('SELECT * FROM submissions WHERE event_id = ? AND company_key = ?').get(eventId, companyKey(company));
  if (!sub) return { existingSubmission: null, statuses: rows.map(() => 'new'), missing: [] };
  const existing = db.prepare('SELECT * FROM attendees WHERE submission_id = ?').all(sub.id);
  const availStmt = db.prepare('SELECT day_id, available FROM availability WHERE attendee_id = ?');
  const { matches, missing } = matchExisting(existing, rows);
  const statuses = rows.map((r, i) => {
    const m = matches[i];
    if (!m) return 'new';
    const av = new Map(availStmt.all(m.id).map((a) => [a.day_id, a.available]));
    return rowDiffers(m, r, av) ? 'changed' : 'unchanged';
  });
  return {
    existingSubmission: { id: sub.id, status: sub.status, people: existing.length },
    statuses,
    missing: missing.map((m) => ({ id: m.id, name: m.name, position: m.position })),
  };
}

/**
 * Save confirmed rows. A re-upload for the same company updates matching people and never
 * touches zones, shirt or attendance; people dropped from the file are flagged "missing".
 */
export function commitImport(db, { eventId, groupId, company, teamLead, contactNumber, rows, dayIds, filename, content, userId }) {
  const ck = companyKey(company);
  const now = nowISO();
  let sub = db.prepare('SELECT * FROM submissions WHERE event_id = ? AND company_key = ?').get(eventId, ck);
  const isReupload = !!sub;
  if (sub) {
    db.prepare(`UPDATE submissions SET company = ?, group_id = ?, team_lead = ?, contact_number = ?, updated_at = ? WHERE id = ?`)
      .run(company, groupId, teamLead, contactNumber, now, sub.id);
  } else {
    const info = db.prepare(`INSERT INTO submissions (event_id, group_id, company, company_key, team_lead, contact_number) VALUES (?,?,?,?,?,?)`)
      .run(eventId, groupId, company, ck, teamLead, contactNumber);
    sub = { id: Number(info.lastInsertRowid) };
  }

  const existing = isReupload ? db.prepare('SELECT * FROM attendees WHERE submission_id = ?').all(sub.id) : [];
  const { matches, missing } = matchExisting(existing, rows);
  const availStmt = db.prepare('SELECT day_id, available FROM availability WHERE attendee_id = ?');
  const insert = db.prepare(`INSERT INTO attendees
    (event_id, submission_id, group_id, company, name, name_key, position, job_description, work_period, shirt_size, import_flag, import_issues)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare(`UPDATE attendees SET group_id = ?, company = ?, name = ?, name_key = ?, position = ?, job_description = ?,
    work_period = ?, shirt_size = ?, import_flag = ?, import_issues = ?, updated_at = ? WHERE id = ?`);
  const setAvail = db.prepare(`INSERT INTO availability (attendee_id, day_id, available) VALUES (?,?,?)
    ON CONFLICT (attendee_id, day_id) DO UPDATE SET available = excluded.available`);

  const counts = { new: 0, changed: 0, unchanged: 0, missing: missing.length, skipped: 0 };
  rows.forEach((r, i) => {
    const issues = (r.issues || []).map((x) => x.message);
    const issuesJson = issues.length ? JSON.stringify(issues) : null;
    const m = matches[i];
    let id;
    if (m) {
      const av = new Map(availStmt.all(m.id).map((a) => [a.day_id, a.available]));
      const changed = rowDiffers(m, r, av);
      counts[changed ? 'changed' : 'unchanged']++;
      update.run(groupId, company, r.name, nameKey(r.name), r.position, r.jobDescription, r.workPeriod, r.shirtSize,
        isReupload ? (changed ? 'changed' : null) : null, issuesJson, now, m.id);
      id = m.id;
      if (changed) audit(db, userId, 'attendee.updated_by_upload', 'attendee', id, { name: r.name, company });
    } else {
      counts.new++;
      const info = insert.run(eventId, sub.id, groupId, company, r.name, nameKey(r.name), r.position, r.jobDescription,
        r.workPeriod, r.shirtSize, isReupload ? 'new' : null, issuesJson);
      id = Number(info.lastInsertRowid);
    }
    for (const dayId of dayIds) setAvail.run(id, dayId, r.availability?.[dayId] ? 1 : 0);
  });

  const flagMissing = db.prepare(`UPDATE attendees SET import_flag = 'missing', updated_at = ? WHERE id = ?`);
  for (const m of missing) flagMissing.run(now, m.id);

  const summary = { ...counts, rows: rows.length };
  db.prepare('INSERT INTO submission_files (submission_id, filename, content, uploaded_by, summary) VALUES (?,?,?,?,?)')
    .run(sub.id, filename, content, userId, JSON.stringify(summary));
  audit(db, userId, isReupload ? 'submission.reuploaded' : 'submission.uploaded', 'submission', sub.id, { company, filename, ...summary });
  return { submissionId: sub.id, isReupload, ...summary };
}

export { SHIRT_SIZES, WORK_PERIODS };
