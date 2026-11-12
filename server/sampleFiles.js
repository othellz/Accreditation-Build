// Writes a blank template and two sample company files to ./samples for a dry run.
import fs from 'node:fs';
import { buildTemplate } from './template.js';
import { samplePeople, SAMPLE_DAYS } from './sampleData.js';

fs.mkdirSync('samples', { recursive: true });
fs.writeFileSync('samples/FLYTIME_ACCREDITATION_2026_template.xlsx', await buildTemplate({ days: SAMPLE_DAYS }));
for (const s of samplePeople()) {
  fs.writeFileSync(`samples/${s.file}`, await buildTemplate({ ...s, days: SAMPLE_DAYS, rows: s.people.length + 5 }));
}
console.log('Wrote samples/ (template + sample company files)');
