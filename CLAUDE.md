# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start server with --watch (auto-restart on file changes)
npm start        # Start server (production)
npm run sync     # Run sync pipeline directly from CLI (bypasses HTTP layer)
```

No linter or test suite is configured.

## Setup before first sync

Both OAuth flows must be completed before sync will work:

1. Copy `.env.example` → `.env` and fill in credentials
2. `npm run dev`
3. Visit `http://localhost:3000/auth/google` → authorizes Google Drive (read-only)
4. Visit `http://localhost:3000/auth/soundcloud` → authorizes SoundCloud
5. Tokens persist to `.tokens.json` (gitignored); sync state persists to `.sync-state.json`

## Architecture

**Entry point:** `src/app.js` — Express server. Exposes `/auth/google`, `/auth/google/callback`, `/auth/soundcloud`, `/auth/soundcloud/callback`, `/status`, and `POST /api/sync`. The sync endpoint streams NDJSON (`{ type, data }` lines) to the browser while the sync runs; a 409 is returned if a sync is already in progress.

**Frontend:** `public/index.html` — single static file (no build step). Reads the NDJSON stream and renders a live log with color-coded lines.

**Auth layer:**
- `src/auth/google.js` — wraps `googleapis` OAuth2 client; auto-persists refreshed tokens via the `tokens` event.
- `src/auth/soundcloud.js` — manual OAuth2 via `fetch`; handles token refresh by checking `obtained_at + expires_in`. Non-expiring SoundCloud tokens (no `expires_in`) skip refresh entirely.

**Sync pipeline** (`src/services/syncService.js`):
- Looks for a Google Drive folder named `producing` at the root of the authenticated user's Drive.
- Each subfolder inside `producing` is treated as an **artist name**.
- Audio files (`.wav`, `.mp3`, `.aiff`) inside subfolders are the tracks; the filename without extension becomes the **track title**.
- Uploads stream directly from Google Drive → SoundCloud via `Readable.toWeb()` + `duplex: 'half'` — audio is never buffered in memory.
- Upload retries are disabled (`retries: 0`) because streams are not replayable.
- Uploaded tracks are added to a SoundCloud playlist named `CarPlay Mixes` (created if missing).

**Idempotency:** `src/utils/syncState.js` maps Google Drive file IDs → SoundCloud track IDs in `.sync-state.json`. Files already in the map are skipped on subsequent runs.

**Utilities:**
- `src/utils/tokenStore.js` — reads/writes `.tokens.json` keyed by service name (`google`, `soundcloud`).
- `src/utils/fetchWithRetry.js` — exponential backoff (default 3 retries, 500 ms base). Supports an `onUnauthorized` hook for 401-triggered token refresh.
