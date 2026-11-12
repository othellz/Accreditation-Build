import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sessionMiddleware } from './auth.js';
import { HttpError } from './util.js';
import { authRoutes, eventRoutes } from './routes/admin.js';
import { zoneRoutes, uploadRoutes, submissionRoutes } from './routes/review.js';
import { accreditRoutes } from './routes/accredit.js';
import { reportRoutes } from './routes/reports.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db, { secureCookies = false, serveClient = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '5mb' }));
  app.use(sessionMiddleware(db));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', authRoutes(db, { secureCookies }));
  app.use('/api', eventRoutes(db));
  app.use('/api', zoneRoutes(db));
  app.use('/api', uploadRoutes(db));
  app.use('/api', submissionRoutes(db));
  app.use('/api', accreditRoutes(db));
  app.use('/api', reportRoutes(db));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  const dist = path.resolve(here, '../dist');
  if (serveClient && fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message, ...(err.extra || {}) });
  });
  return app;
}
