import { Router } from 'express';
import multer from 'multer';
import { requireRole } from '../auth.js';
import { tx } from '../db.js';
import { HttpError, audit, cleanText, intParam, nowISO, nameKey, normalizePhone, normalizeShirtSize, SHIRT_SIZES } from '../util.js';
import { requireEvent, getDays, reviewStatus, submissionCounts } from '../model.js';
import { parseWorkbook, validateRows, previewChanges, commitImport } from '../importer.js';
import { buildTemplate } from '../template.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

export function zoneRoutes(db) {
  const r = Router();
  const reviewer = requireRole('reviewer');

  r.post('/zones', reviewer, (req, res) => {
    const ev = requireEvent(db);
    const b = req.body || {};
    const number = Number(b.number);
    if (!Number.isInteger(number) || number < 1 || number > ev.zone_limit) {
      throw new HttpError(400, `Zone number must be between 1 and ${ev.zone_limit}`);
    }
    const name = cleanText(b.name);
    if (!name) throw new HttpError(400, 'Zone name is required');
    try {
      const info = db.prepare(`INSERT INTO zones (event_id, number, name, code, access_definition, wristband) VALUES (?,?,?,?,?,?)`)
        .run(ev.id, number, name, cleanText(b.code), String(b.accessDefinition || '').trim(), cleanText(b.wristband));
      audit(db, req.user.id, 'zone.created', 'zone', Number(info.lastInsertRowid), { number, name });
      res.json({ id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, `Zone ${number} already exists`);
      throw e;
    }
  });

  // Editing a zone updates it everywhere; existing assignments stay.
  r.patch('/zones/:id', reviewer, (req, res) => {
    const ev = requireEvent(db);
    const id = intParam(req.params.id);
    const z = db.prepare('SELECT * FROM zones WHERE id = ? AND event_id = ?').get(id, ev.id);
    if (!z) throw new HttpError(404, 'Zone not found');
    const b = req.body || {};
    const next = {
      name: b.name !== undefined ? cleanText(b.name) : z.name,
      code: b.code !== undefined ? cleanText(b.code) : z.code,
      access_definition: b.accessDefinition !== undefined ? String(b.accessDefinition).trim() : z.access_definition,
      wristband: b.wristband !== undefined ? cleanText(b.wristband) : z.wristband,
      status: b.status !== undefined ? b.status : z.status,
    };
    if (!next.name) throw new HttpError(400, 'Zone name is required');
    if (!['active', 'retired'].includes(next.status)) throw new HttpError(400, 'Status must be active or retired');
    db.prepare('UPDATE zones SET name = ?, code = ?, access_definition = ?, wristband = ?, status = ? WHERE id = ?')
      .run(next.name, next.code, next.access_definition, next.wristband, next.status, id);
    audit(db, req.user.id, next.status !== z.status ? `zone.${next.status === 'retired' ? 'retired' : 'reactivated'}` : 'zone.updated',
      'zone', id, { from: z, to: next });
    res.json({ ok: true });
  });

  // A zone in use cannot be deleted; retire it instead.
  r.delete('/zones/:id', reviewer, (req, res) => {
    const ev = requireEvent(db);
    const id = intParam(req.params.id);
    const z = db.prepare('SELECT * FROM zones WHERE id = ? AND event_id = ?').get(id, ev.id);
    if (!z) throw new HttpError(404, 'Zone not found');
    const used = db.prepare(`SELECT (SELECT COUNT(*) FROM attendees WHERE zone_id = ?) + (SELECT COUNT(*) FROM attendance WHERE zone_id = ?) AS n`)
      .get(id, id).n;
    if (used) throw new HttpError(409, 'This zone is in use. Retire it instead; existing assignments stay visible.');
    db.prepare('DELETE FROM zones WHERE id = ?').run(id);
    audit(db, req.user.id, 'zone.deleted', 'zone', id, { number: z.number, name: z.name });
    res.json({ ok: true });
  });

  return r;
}

export function uploadRoutes(db) {
  const r = Router();
  const admin = requireRole();

  function previewResponse(ev, pendingId, parsed, groupId, filename) {
    const rows = validateRows(db, ev.id, parsed.company, parsed.rows);
    const changes = previewChanges(db, ev.id, parsed.company, rows);
    return {
      id: pendingId,
      filename,
      groupId,
      company: parsed.company,
      teamLead: parsed.teamLead,
      contactNumber: parsed.contactNumber,
      dayIds: parsed.dayIds,
      warnings: parsed.warnings,
      rows: rows.map((row, i) => ({ ...row, status: changes.statuses[i] })),
      existingSubmission: changes.existingSubmission,
      missing: changes.missing,
    };
  }

  // Step 1: parse the file and show the preview. Nothing is saved to the attendee list yet.
  r.post('/uploads', admin, upload.single('file'), async (req, res) => {
    const ev = requireEvent(db);
    if (!req.file) throw new HttpError(400, 'Choose an Excel file');
    const groupId = intParam(req.body?.groupId, 'group');
    const group = db.prepare('SELECT * FROM groups WHERE id = ? AND event_id = ? AND archived = 0').get(groupId, ev.id);
    if (!group) throw new HttpError(400, 'Pick an active accreditation group');
    const days = getDays(db, ev.id);
    const parsed = await parseWorkbook(req.file.buffer, days);
    if (parsed.rows.length === 0) throw new HttpError(400, 'No people found in this file');
    const info = db.prepare('INSERT INTO pending_uploads (event_id, group_id, filename, content, parsed, created_by) VALUES (?,?,?,?,?,?)')
      .run(ev.id, groupId, req.file.originalname, req.file.buffer, JSON.stringify(parsed), req.user.id);
    res.json(previewResponse(ev, Number(info.lastInsertRowid), parsed, groupId, req.file.originalname));
  });

  // Re-validate an edited preview (company name changed, rows fixed) without saving.
  r.post('/uploads/:id/validate', admin, (req, res) => {
    const ev = requireEvent(db);
    const pending = db.prepare('SELECT * FROM pending_uploads WHERE id = ? AND event_id = ?').get(intParam(req.params.id), ev.id);
    if (!pending) throw new HttpError(404, 'Preview expired. Upload the file again.');
    const parsed = JSON.parse(pending.parsed);
    const next = { ...parsed, company: cleanText(req.body?.company ?? parsed.company), rows: req.body?.rows ?? parsed.rows };
    res.json(previewResponse(ev, pending.id, next, Number(req.body?.groupId) || pending.group_id, pending.filename));
  });

  // Step 2: confirm. Each flagged row must be fixed, accepted as is, or skipped.
  r.post('/uploads/:id/confirm', admin, (req, res) => {
    const ev = requireEvent(db);
    const id = intParam(req.params.id);
    const pending = db.prepare('SELECT * FROM pending_uploads WHERE id = ? AND event_id = ?').get(id, ev.id);
    if (!pending) throw new HttpError(404, 'Preview expired. Upload the file again.');
    const parsed = JSON.parse(pending.parsed);
    const b = req.body || {};
    const company = cleanText(b.company ?? parsed.company);
    if (!company) throw new HttpError(400, 'Company name is required');
    const groupId = Number(b.groupId) || pending.group_id;
    if (!db.prepare('SELECT 1 FROM groups WHERE id = ? AND event_id = ? AND archived = 0').get(groupId, ev.id)) {
      throw new HttpError(400, 'Pick an active accreditation group');
    }
    const inputRows = Array.isArray(b.rows) ? b.rows : parsed.rows.map((r) => ({ ...r, decision: 'import' }));
    const kept = inputRows.filter((r) => r.decision !== 'skip');
    const validated = validateRows(db, ev.id, company, kept);
    const unresolved = [];
    validated.forEach((row, i) => {
      const accepted = kept[i].decision === 'accept';
      if (row.issues.some((x) => x.blocking)) unresolved.push({ rowNumber: row.rowNumber, reason: 'Missing name: fix or skip' });
      else if (row.issues.length && !accepted) unresolved.push({ rowNumber: row.rowNumber, reason: row.issues.map((x) => x.message).join('; ') });
    });
    if (unresolved.length) throw new HttpError(422, `${unresolved.length} row(s) still need a decision`, { unresolved });

    const result = tx(db, () => {
      const out = commitImport(db, {
        eventId: ev.id, groupId, company,
        teamLead: cleanText(b.teamLead ?? parsed.teamLead),
        contactNumber: normalizePhone(b.contactNumber ?? parsed.contactNumber),
        rows: validated, dayIds: parsed.dayIds, filename: pending.filename, content: pending.content, userId: req.user.id,
      });
      out.skipped = inputRows.length - kept.length;
      db.prepare('DELETE FROM pending_uploads WHERE id = ?').run(id);
      return out;
    });
    res.json(result);
  });

  r.delete('/uploads/:id', admin, (req, res) => {
    db.prepare('DELETE FROM pending_uploads WHERE id = ?').run(intParam(req.params.id));
    res.json({ ok: true });
  });

  // Blank template with this event's day columns, to send to companies.
  r.get('/template', admin, async (_req, res) => {
    const ev = requireEvent(db);
    const buf = await buildTemplate({ title: `${ev.name.toUpperCase()} ACCREDITATION`, days: getDays(db, ev.id).map((d) => d.date) });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="accreditation-template.xlsx"');
    res.end(buf);
  });

  // Walk-ups (F22): Admin adds a person on site with a reason and zones them.
  r.post('/walkups', admin, (req, res) => {
    const ev = requireEvent(db);
    const b = req.body || {};
    const name = cleanText(b.name);
    const company = cleanText(b.company);
    const reason = cleanText(b.reason);
    const shirt = normalizeShirtSize(b.shirtSize);
    if (!name || !company || !reason) throw new HttpError(400, 'Name, company and reason are required');
    if (!shirt) throw new HttpError(400, `Shirt size must be one of ${SHIRT_SIZES.join(', ')}`);
    const group = db.prepare('SELECT 1 FROM groups WHERE id = ? AND event_id = ? AND archived = 0').get(Number(b.groupId), ev.id);
    if (!group) throw new HttpError(400, 'Pick an active accreditation group');
    const zone = db.prepare(`SELECT * FROM zones WHERE id = ? AND event_id = ? AND status = 'active'`).get(Number(b.zoneId), ev.id);
    if (!zone) throw new HttpError(400, 'Pick an active zone');
    const id = tx(db, () => {
      const info = db.prepare(`INSERT INTO attendees (event_id, submission_id, group_id, company, name, name_key, position, job_description,
          work_period, shirt_size, zone_id, walkup_reason) VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?)`)
        .run(ev.id, Number(b.groupId), company, name, nameKey(name), cleanText(b.position), cleanText(b.jobDescription),
          'Before & During Event', shirt, zone.id, reason);
      const aid = Number(info.lastInsertRowid);
      audit(db, req.user.id, 'walkup.added', 'attendee', aid, { name, company, reason, zone: zone.number });
      return aid;
    });
    res.json({ id });
  });

  return r;
}

export function submissionRoutes(db) {
  const r = Router();
  const reviewer = requireRole('reviewer');

  // Review queue: submissions with progress counts.
  r.get('/submissions', reviewer, (_req, res) => {
    const ev = requireEvent(db);
    const rows = db.prepare(`SELECT s.id, s.company, s.team_lead, s.contact_number, s.status, s.created_at, s.updated_at, s.published_at,
        g.name AS group_name, g.id AS group_id,
        COUNT(a.id) AS total,
        COALESCE(SUM(CASE WHEN a.removed = 0 AND a.zone_id IS NOT NULL THEN 1 ELSE 0 END),0) AS zoned,
        COALESCE(SUM(CASE WHEN a.removed = 1 THEN 1 ELSE 0 END),0) AS removed,
        COALESCE(SUM(CASE WHEN a.removed = 0 AND a.zone_id IS NULL THEN 1 ELSE 0 END),0) AS pending,
        COALESCE(SUM(CASE WHEN a.import_flag IS NOT NULL THEN 1 ELSE 0 END),0) AS flagged
      FROM submissions s JOIN groups g ON g.id = s.group_id
      LEFT JOIN attendees a ON a.submission_id = s.id
      WHERE s.event_id = ? GROUP BY s.id ORDER BY s.status = 'published', s.company`).all(ev.id);
    res.json(rows);
  });

  r.get('/submissions/:id', reviewer, (req, res) => {
    const ev = requireEvent(db);
    const id = intParam(req.params.id);
    const sub = db.prepare(`SELECT s.*, g.name AS group_name FROM submissions s JOIN groups g ON g.id = s.group_id
      WHERE s.id = ? AND s.event_id = ?`).get(id, ev.id);
    if (!sub) throw new HttpError(404, 'Submission not found');
    const attendees = db.prepare(`SELECT a.id, a.name, a.position, a.job_description, a.work_period, a.shirt_size, a.zone_id,
        a.removed, a.removed_at, a.import_flag, a.import_issues, a.name_key,
        (SELECT group_concat(DISTINCT o.company) FROM attendees o WHERE o.event_id = a.event_id AND o.name_key = a.name_key
           AND o.id != a.id AND o.removed = 0 AND (o.submission_id IS NULL OR o.submission_id != a.submission_id)) AS also_in,
        (SELECT COUNT(*) FROM attendees d WHERE d.submission_id = a.submission_id AND d.name_key = a.name_key AND d.id != a.id) AS same_name
      FROM attendees a WHERE a.submission_id = ? ORDER BY a.id`).all(id);
    const avail = db.prepare(`SELECT av.attendee_id, av.day_id, av.available FROM availability av
      JOIN attendees a ON a.id = av.attendee_id WHERE a.submission_id = ?`).all(id);
    const byAtt = new Map();
    for (const a of avail) {
      if (!byAtt.has(a.attendee_id)) byAtt.set(a.attendee_id, {});
      byAtt.get(a.attendee_id)[a.day_id] = !!a.available;
    }
    const files = db.prepare(`SELECT f.id, f.filename, f.uploaded_at, f.summary, u.email AS uploaded_by FROM submission_files f
      LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.submission_id = ? ORDER BY f.id DESC`).all(id)
      .map((f) => ({ ...f, summary: f.summary ? JSON.parse(f.summary) : null }));
    res.json({
      submission: sub,
      counts: submissionCounts(db, id),
      attendees: attendees.map((a) => ({
        ...a,
        status: reviewStatus(a),
        availability: byAtt.get(a.id) || {},
        import_issues: a.import_issues ? JSON.parse(a.import_issues) : [],
        also_in: a.also_in ? a.also_in.split(',') : [],
      })),
      files,
    });
  });

  r.get('/submissions/:id/files/:fileId', reviewer, (req, res) => {
    const f = db.prepare('SELECT * FROM submission_files WHERE id = ? AND submission_id = ?')
      .get(intParam(req.params.fileId), intParam(req.params.id));
    if (!f) throw new HttpError(404, 'File not found');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`);
    res.end(Buffer.from(f.content));
  });

  // Publishing is blocked while anyone is Pending (F12).
  r.post('/submissions/:id/publish', reviewer, (req, res) => {
    const ev = requireEvent(db);
    const id = intParam(req.params.id);
    const sub = db.prepare('SELECT * FROM submissions WHERE id = ? AND event_id = ?').get(id, ev.id);
    if (!sub) throw new HttpError(404, 'Submission not found');
    const counts = submissionCounts(db, id);
    if (counts.pending > 0) {
      throw new HttpError(409, `${counts.pending} ${counts.pending === 1 ? 'person is' : 'people are'} still Pending. Assign a zone or remove them first.`, { pending: counts.pending });
    }
    if (sub.status === 'published') throw new HttpError(409, 'Already published');
    db.prepare(`UPDATE submissions SET status = 'published', published_at = ?, published_by = ?, updated_at = ? WHERE id = ?`)
      .run(nowISO(), req.user.id, nowISO(), id);
    audit(db, req.user.id, 'submission.published', 'submission', id, { company: sub.company, ...counts });
    res.json({ ok: true, counts });
  });

  // Zone, remove, restore — one person or many at once (F8–F10). Changes after publishing apply immediately.
  r.post('/attendees/bulk', reviewer, (req, res) => {
    const ev = requireEvent(db);
    const { ids, action, zoneId } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, 'Select at least one person');
    if (ids.length > 5000) throw new HttpError(400, 'Too many people selected');
    if (!['zone', 'remove', 'restore', 'clear_zone', 'clear_flag'].includes(action)) throw new HttpError(400, 'Unknown action');
    let zone = null;
    if (action === 'zone') {
      zone = db.prepare(`SELECT * FROM zones WHERE id = ? AND event_id = ?`).get(Number(zoneId), ev.id);
      if (!zone) throw new HttpError(400, 'Pick a zone');
      if (zone.status !== 'active') throw new HttpError(409, 'This zone is retired and cannot be assigned');
    }
    const now = nowISO();
    const result = tx(db, () => {
      const get = db.prepare('SELECT * FROM attendees WHERE id = ? AND event_id = ?');
      let changed = 0;
      const touchedSubs = new Set();
      for (const rawId of ids) {
        const a = get.get(Number(rawId), ev.id);
        if (!a) continue;
        if (action === 'zone' && a.zone_id !== zone.id) {
          db.prepare('UPDATE attendees SET zone_id = ?, updated_at = ? WHERE id = ?').run(zone.id, now, a.id);
          audit(db, req.user.id, a.zone_id ? 'attendee.zone_changed' : 'attendee.zoned', 'attendee', a.id,
            { name: a.name, company: a.company, fromZoneId: a.zone_id, toZoneId: zone.id, toZone: zone.number });
          changed++;
        } else if (action === 'clear_zone' && a.zone_id) {
          db.prepare('UPDATE attendees SET zone_id = NULL, updated_at = ? WHERE id = ?').run(now, a.id);
          audit(db, req.user.id, 'attendee.zone_cleared', 'attendee', a.id, { name: a.name, fromZoneId: a.zone_id });
          changed++;
        } else if (action === 'remove' && !a.removed) {
          db.prepare('UPDATE attendees SET removed = 1, removed_at = ?, removed_by = ?, updated_at = ? WHERE id = ?').run(now, req.user.id, now, a.id);
          audit(db, req.user.id, 'attendee.removed', 'attendee', a.id, { name: a.name, company: a.company });
          changed++;
        } else if (action === 'restore' && a.removed) {
          db.prepare('UPDATE attendees SET removed = 0, removed_at = NULL, removed_by = NULL, updated_at = ? WHERE id = ?').run(now, a.id);
          audit(db, req.user.id, 'attendee.restored', 'attendee', a.id, { name: a.name, company: a.company });
          changed++;
        } else if (action === 'clear_flag' && a.import_flag) {
          db.prepare('UPDATE attendees SET import_flag = NULL WHERE id = ?').run(a.id);
          changed++;
        } else continue;
        if (a.submission_id) touchedSubs.add(a.submission_id);
      }
      // First review action moves a submission from Uploaded to In review.
      for (const sid of touchedSubs) {
        db.prepare(`UPDATE submissions SET status = 'in_review', updated_at = ? WHERE id = ? AND status = 'uploaded'`).run(now, sid);
      }
      return { changed };
    });
    res.json(result);
  });

  return r;
}
