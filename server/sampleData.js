export const SAMPLE_DAYS = ['2026-12-20', '2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25'];

const FIRST = ['Ada', 'Chinedu', 'Bola', 'Tunde', 'Ngozi', 'Emeka', 'Funmi', 'Ike', 'Kemi', 'Segun', 'Amaka', 'Yemi', 'Obi', 'Zainab', 'Femi', 'Halima', 'Dayo', 'Uche', 'Tolu', 'Musa'];
const LAST = ['Okafor', 'Adeyemi', 'Balogun', 'Eze', 'Ibrahim', 'Okonkwo', 'Bello', 'Nwosu', 'Ogunleye', 'Danjuma', 'Afolabi', 'Chukwu'];
const FIRST_B = ['Chioma', 'Kelechi', 'Aisha', 'Babatunde', 'Nkechi', 'Olumide', 'Sade', 'Gbenga', 'Hauwa', 'Jide', 'Lola', 'Nnamdi'];
const LAST_B = ['Oyelaran', 'Umeh', 'Abubakar', 'Fashola', 'Igwe', 'Lawal', 'Onyeka', 'Sanni'];
const SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

function make(n, seed, roles, first = FIRST, last = LAST) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const role = roles[i % roles.length];
    out.push({
      name: `${first[(i * 7 + seed) % first.length]} ${last[i % last.length]}`,
      position: role[0],
      job: role[1],
      period: i % 4 === 0 ? 'Before Event Only' : 'Before & During Event',
      size: SIZES[(i + seed) % SIZES.length],
      days: SAMPLE_DAYS.map((_, d) => (i % 4 === 0 ? d < 2 : (i + d) % 5 !== 0)),
    });
  }
  return out;
}

export function samplePeople() {
  return [
    {
      file: 'Stagecraft_Productions.xlsx',
      company: 'Stagecraft Productions',
      teamLead: 'Kunle Ajayi',
      contact: '0803 123 4567',
      people: make(24, 1, [
        ['Stage Manager', 'Runs the main stage changeovers'],
        ['Rigger', 'Truss and lighting rig setup, backstage'],
        ['Sound Engineer', 'Front of house mix and monitors'],
        ['Runner', 'Moves equipment between stores and stage'],
      ]),
    },
    {
      file: 'Brightside_Beverages.xlsx',
      company: 'Brightside Beverages',
      teamLead: 'Ifeoma Obi',
      contact: '+234 812 555 0199',
      people: make(16, 4, [
        ['Brand Ambassador', 'Activation booth in the main arena'],
        ['Bar Supervisor', 'Manages the VIP bar'],
        ['Logistics', 'Stock deliveries before gates open'],
      ], FIRST_B, LAST_B).map((p, i) => (i === 5 ? { ...p, name: 'Chinedu Okafor' } : p)), // one person also on another list
    },
  ];
}
