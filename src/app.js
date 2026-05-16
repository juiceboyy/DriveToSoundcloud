import 'dotenv/config';
import express from 'express';
import * as googleAuth from './auth/google.js';
import * as soundcloudAuth from './auth/soundcloud.js';
import { getToken } from './utils/tokenStore.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

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

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nServer running on http://localhost:${PORT}`);
  console.log(`  Google auth:     http://localhost:${PORT}/auth/google`);
  console.log(`  SoundCloud auth: http://localhost:${PORT}/auth/soundcloud`);
  console.log(`  Status:          http://localhost:${PORT}/status\n`);
});
