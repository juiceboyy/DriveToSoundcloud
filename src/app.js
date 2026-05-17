import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as googleAuth from './auth/google.js';
import * as soundcloudAuth from './auth/soundcloud.js';
import { getToken } from './utils/tokenStore.js';
import { sync } from './services/syncService.js';
import { start as startScheduler, stop as stopScheduler, isActive as schedulerActive } from './utils/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.static(path.join(__dirname, '../public')));

// ── Google Drive OAuth2 ───────────────────────────────────────────────────────

app.get('/auth/google', (_req, res) => {
  res.redirect(googleAuth.getAuthUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ error });

  try {
    await googleAuth.handleCallback(String(code));
    res.json({ status: 'Google Drive authenticated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SoundCloud OAuth2 ─────────────────────────────────────────────────────────

app.get('/auth/soundcloud', (_req, res) => {
  res.redirect(soundcloudAuth.getAuthUrl());
});

app.get('/auth/soundcloud/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ error });

  try {
    await soundcloudAuth.handleCallback(String(code));
    res.json({ status: 'SoundCloud authenticated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Status ────────────────────────────────────────────────────────────────────

app.get('/status', async (_req, res) => {
  const [google, soundcloud] = await Promise.all([
    getToken('google').catch(() => null),
    getToken('soundcloud').catch(() => null),
  ]);

  res.json({
    google: google ? 'authenticated' : 'not authenticated',
    soundcloud: soundcloud ? 'authenticated' : 'not authenticated',
  });
});

// ── Sync API ──────────────────────────────────────────────────────────────────

let isSyncing = false;

app.post('/api/sync', async (_req, res) => {
  if (isSyncing) {
    return res.status(409).json({ error: 'Sync already in progress.' });
  }

  isSyncing = true;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  const send = (type, data) => res.write(JSON.stringify({ type, data }) + '\n');

  try {
    await sync((msg) => send('log', msg));
    send('done', null);
  } catch (err) {
    send('error', err.message);
  } finally {
    isSyncing = false;
    res.end();
  }
});

// ── Scheduler API ─────────────────────────────────────────────────────────────

app.get('/api/cron/status', (_req, res) => {
  res.json({ active: schedulerActive() });
});

app.post('/api/cron/toggle', (_req, res) => {
  if (schedulerActive()) {
    stopScheduler();
  } else {
    startScheduler(async () => {
      if (isSyncing) return; // silently skip if a manual sync is running
      isSyncing = true;
      try {
        await sync(() => {}); // background — log output is discarded
      } finally {
        isSyncing = false;
      }
    });
  }
  res.json({ active: schedulerActive() });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nServer running on http://localhost:${PORT}`);
  console.log(`  Google auth:     http://localhost:${PORT}/auth/google`);
  console.log(`  SoundCloud auth: http://localhost:${PORT}/auth/soundcloud`);
  console.log(`  Status:          http://localhost:${PORT}/status\n`);
});
