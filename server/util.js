export const ROLES = ['accreditor', 'reviewer', 'admin'];
export const SHIRT_SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
export const WORK_PERIODS = ['Before Event Only', 'Before & During Event'];

export const TIME_ZONE = process.env.EVENT_TZ || 'Africa/Lagos';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Key used to match people by name: case, spacing and punctuation insensitive. */
export function nameKey(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const companyKey = nameKey;

export function cleanText(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

/** Map spreadsheet spellings to one of the allowed shirt sizes, or null. */
export function normalizeShirtSize(v) {
  const s = cleanText(v).toUpperCase().replace(/[\s.-]/g, '');
  if (!s) return null;
  const aliases = {
    SMALL: 'S', MEDIUM: 'M', LARGE: 'L', XLARGE: 'XL', EXTRALARGE: 'XL',
    '2XL': 'XXL', '2X': 'XXL', '3XL': 'XXXL', '3X': 'XXXL',
  };
  const out = aliases[s] || s;
  return SHIRT_SIZES.includes(out) ? out : null;
}

/** Map spreadsheet spellings to one of the two work periods, or null. */
export function normalizeWorkPeriod(v) {
  const s = cleanText(v).toLowerCase().replace(/and/g, '&').replace(/\s+/g, ' ');
  if (!s) return null;
  if (/before\s*&\s*during/.test(s) || /during/.test(s)) return 'Before & During Event';
  if (/before/.test(s)) return 'Before Event Only';
  return null;
}

/** Normalise a Nigerian phone number to +234XXXXXXXXXX; other numbers keep their digits. */
export function normalizePhone(v) {
  const raw = cleanText(v);
  if (!raw) return '';
  let digits = raw.replace(/[^\d]/g, '');
  if (!digits) return raw;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return '+234' + digits.slice(1);
  if (digits.length === 10 && /^[789]/.test(digits)) return '+234' + digits;
  if (digits.startsWith('234') && digits.length === 13) return '+' + digits;
  return '+' + digits;
}

export function parseYesNo(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = cleanText(v).toLowerCase();
  if (['yes', 'y', 'true', '1', 'x', '✓', '✔'].includes(s)) return true;
  if (['no', 'n', 'false', '0', ''].includes(s)) return false;
  return null;
}

/** Today's date (YYYY-MM-DD) in the event's time zone. */
export function todayISO(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function nowISO() {
  return new Date().toISOString();
}

export function isoToLocalDate(iso) {
  return todayISO(new Date(iso));
}

export function audit(db, userId, action, entity, entityId, details) {
  db.prepare(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)'
  ).run(userId ?? null, action, entity ?? null, entityId ?? null, details ? JSON.stringify(details) : null);
}

export function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n') + '\r\n';
}

export function intParam(v, name = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}
