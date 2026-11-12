import ExcelJS from 'exceljs';
import { SHIRT_SIZES, WORK_PERIODS } from './util.js';

const fmtDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Build a workbook laid out like the FLYTIME ACCREDITATION – 2026 template:
 * title, header block (company, team lead, contact), then one row per person with
 * Work period / T-shirt size dropdowns and a Yes/No column per event day.
 */
export async function buildTemplate({ title = 'FLYTIME ACCREDITATION – 2026', company = '', teamLead = '', contact = '', days = [], people = [], rows = 800 }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Accreditation');
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A3').value = 'COMPANY NAME:'; ws.getCell('C3').value = company;
  ws.getCell('A4').value = 'TEAM LEAD:'; ws.getCell('C4').value = teamLead;
  ws.getCell('A5').value = 'CONTACT NUMBER:'; ws.getCell('C5').value = contact;
  ['A3', 'A4', 'A5'].forEach((c) => { ws.getCell(c).font = { bold: true }; });

  const headers = ['S/N', 'NAME', 'POSITION', 'EVENT JOB DESCRIPTION', 'WORK PERIOD', 'T-SHIRT SIZE', ...days.map(fmtDay)];
  const hr = ws.getRow(7);
  hr.values = headers;
  hr.font = { bold: true };
  ws.columns = headers.map((h, i) => ({ width: [6, 28, 22, 36, 22, 13][i] ?? 10 }));

  const total = Math.max(rows, people.length);
  for (let i = 0; i < total; i++) {
    const r = ws.getRow(8 + i);
    const p = people[i];
    r.getCell(1).value = i + 1;
    if (p) {
      r.getCell(2).value = p.name;
      r.getCell(3).value = p.position;
      r.getCell(4).value = p.job;
      r.getCell(5).value = p.period;
      r.getCell(6).value = p.size;
      days.forEach((_, d) => { r.getCell(7 + d).value = p.days?.[d] === false ? 'No' : 'Yes'; });
    }
    r.getCell(5).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${WORK_PERIODS.join(',')}"`] };
    r.getCell(6).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${SHIRT_SIZES.join(',')}"`] };
    days.forEach((_, d) => { r.getCell(7 + d).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Yes,No"'] }; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
