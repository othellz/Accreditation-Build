# Accreditation Platform

Replaces the Excel-and-WhatsApp accreditation process with one system. Admins upload each company's Excel file,
the Reviewer decides who attends and which zone they get, and Accreditors issue shirts and wristbands at the gate
while the team reconciles daily numbers. Built from the *Accreditation Platform — Product Requirements Document*
(Flytime Fest 2026, 20–25 December 2026).

## Quick start

Requires Node.js 22.13 or later. The database is SQLite through Node's built-in `node:sqlite`, so there is nothing else to install.

```bash
npm install
npm run build          # build the web app into dist/
npm run seed           # optional: demo users, event, zones and two sample company files
npm start              # http://localhost:3000
```

The seed creates these accounts, all with password `password123`:

| Role       | Email                  |
|------------|------------------------|
| Admin      | admin@example.com      |
| Reviewer   | reviewer@example.com   |
| Accreditor | gate1@example.com, gate2@example.com |

Without seeding, the first visit shows a setup screen that creates the first Admin and the event.

For development, `npm run dev` runs the API on :3000 with reload and the Vite dev server on :5173.

| Command | What it does |
|---|---|
| `npm test` | API tests covering the PRD acceptance examples |
| `npm run sample-files` | Writes a blank template and two sample company files to `samples/` |

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/accreditation.db` | SQLite file |
| `EVENT_TZ` | `Africa/Lagos` | Time zone that decides "today" for the default event day and same-day undo |
| `SECURE_COOKIES` | unset | Set to `1` behind HTTPS |
| `SETUP_TOKEN` | unset | When set, the first-run setup screen requires this code |
| `BACKUP_DIR` | unset (`/data/backups` in Docker) | Write a database backup on start and every `BACKUP_HOURS` (24) hours |
| `BACKUP_KEEP` | `14` | Number of backups to keep |

## Roles

Every permission is checked on the server. Accreditors never receive removed, unzoned or unpublished people in their data.

| Capability | Accreditor | Reviewer | Admin |
|---|---|---|---|
| Configure event, days, groups | – | – | ✓ |
| Upload company submission | – | – | ✓ |
| Create and define zones | – | ✓ | ✓ |
| Assign zone, remove or restore a person, publish | – | ✓ | ✓ |
| Search approved attendees | ✓ | read-only | ✓ |
| Mark shirt collected or attended | ✓ | – | ✓ |
| Reconciliation reports | own counts for today | ✓ | ✓ |
| Manage users, close days, reverse any check-in, audit log, full export | – | – | ✓ |

Each role lands on its own screen: the Admin on **Overview**, the Reviewer on **Review**, the Accreditor on **Accredit**.

## How it works

1. **Set up** (Admin): event name, days and their dates, and accreditation groups. *Staff* and *Partners & Sponsors* exist from the start. Invite users by email and role; the app gives you a one-time invite link to send them, because v1 has no mail server.
2. **Upload** (Admin): pick the group and drop in a company's `.xlsx`. The preview lists every row with its issues: missing name, unknown shirt size or work period, a name repeated in the file, or a name also submitted by another company. Fix the row in place, accept it as is, or skip it. Nothing is saved until you confirm. The original file is kept with the submission.
   *Re-upload* the same company to update it. Rows are matched by name (then position). Zones, shirts and attendance are never touched, and anyone missing from the new file is flagged, not deleted.
3. **Zones** (Reviewer): up to 10 by default (a setting). Each zone has a name, code, access definition and wristband. A zone that is in use can be retired but not deleted.
4. **Review** (Reviewer): the queue shows progress for each company. In the table you can filter by position, work period or status, assign zones inline or in bulk, and remove or restore people. **Publish** turns on only when nobody is Pending. Changes after publishing reach Accreditors immediately and are logged.
5. **Accredit** (Accreditor): built for one-handed phone use. Search shows results as you type. The card shows the zone and shirt size large, plus the access definition. *Shirt collected* can happen once per person. *Mark attended* can happen once per person per day; if two gates tap at the same moment, the second one sees who did it and when. A notice appears when someone arrives on a day they did not mark as available, and when their zone changed after a wristband was issued. Accreditors can undo their own action on the same day; after that, only an Admin can reverse it, with a reason. Admins can also add **walk-ups** with a reason and a zone.
6. **Reconcile** (Reviewer/Admin): each company row shows approved, accredited today, not yet accredited, shirts issued today and accredited to date. Event totals cover each day, unique people, shirts by size and wristbands by zone. Filter by group or company and export to CSV or Excel. **Close day** locks the day's totals and stops check-ins for that day; reopening it requires a reason.

Every upload, zone change, removal, restore, check-in, undo and reversal goes into the **audit log**, which database triggers make append-only.

## The Excel template

The importer reads the *FLYTIME ACCREDITATION – 2026* layout and tolerates small variations:

- A header block above the table with `COMPANY NAME`, `TEAM LEAD` and `CONTACT NUMBER`. The value can sit in a cell to the right or after a colon.
- A table header row with `NAME`, `POSITION`, `EVENT JOB DESCRIPTION`, `WORK PERIOD`, `T-SHIRT SIZE`, then one Yes/No column per event day (`20 Dec`, `20-Dec`, real dates, `Day 1`…). Day headers can also sit on the row under a merged `AVAILABILITY` heading.
- Shirt sizes are normalised to S, M, L, XL, XXL, XXXL (`2XL` becomes XXL). Work periods are normalised to *Before Event Only* or *Before & During Event*. Nigerian phone numbers are normalised to `+234…`.

**Upload → Download blank template** produces a template whose day columns match the configured event days.

## Decisions on the PRD's open questions (v1 defaults; easy to change)

- **Accreditor scope:** Accreditors see all groups.
- **Shirt size handed out:** recorded on the shirt flag. It defaults to the submitted size, and the Accreditor can change it before tapping.
- **Walk-ups:** only Admins can add them, with a reason and a zone (F22).
- **Offline:** the app needs a connection. A weak-connection banner appears, and *Mark attended* retries once safely, so a retry never double-counts.
- **Data retention:** the Admin sets a retention date. Once it has passed, *Event → Delete personal data* replaces names and job details and deletes the stored files. Counts and the audit log are kept.
- **Days and time zone:** "today" uses `EVENT_TZ`. Accreditors can choose another day for dry runs, and the screen warns when the chosen day is not today.

## Project layout

```
server/
  index.js, app.js       HTTP server and route wiring
  db.js                  schema (SQLite) and transactions
  auth.js                sessions, password hashing, role checks
  importer.js            Excel parsing, validation, re-upload merge
  model.js               visibility rule and shared queries
  routes/                admin, review (zones/uploads/submissions), accredit, reports
  template.js, seed.js   template builder and demo data
client/src/              React app (Vite)
test/api.test.js         end-to-end API tests
samples/                 blank template and two sample company files
```

## Deployment

See **[DEPLOY.md](DEPLOY.md)** for step-by-step hosting on your own domain: Docker and Caddy on a small VPS, with automatic
HTTPS and daily backups. In short:

```bash
cp .env.example .env   # set DOMAIN and SETUP_TOKEN
docker compose up -d --build
```
