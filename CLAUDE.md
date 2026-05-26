# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start server with --watch (auto-restart on file changes)
npm start        # Start server (production)
npm run sync     # Run sync pipeline directly from CLI (bypasses HTTP layer)
```

No linter or test suite is configured. Requires Node >= 18 (ES modules, native `fetch`).

## Setup before first sync

Both OAuth flows must be completed before sync will work:

1. Copy `.env.example` → `.env` and fill in credentials
2. `npm run dev`
3. Visit `http://localhost:3000/auth/google` → authorizes Google Drive (read-only)
4. Visit `http://localhost:3000/auth/soundcloud` → authorizes SoundCloud
5. Tokens persist to `.tokens.json` (gitignored); sync state persists to `.sync-state.json`

## Environment Variables

All configuration is loaded via environment variables (using `dotenv` in development):

### Required for Auth & API
- `GOOGLE_CLIENT_ID` — Google Cloud console client ID
- `GOOGLE_CLIENT_SECRET` — Google Cloud console client secret
- `GOOGLE_REDIRECT_URI` — Google OAuth redirect URI (default: `http://localhost:3000/auth/google/callback`)
- `SOUNDCLOUD_CLIENT_ID` — SoundCloud developer client ID
- `SOUNDCLOUD_CLIENT_SECRET` — SoundCloud developer client secret
- `SOUNDCLOUD_REDIRECT_URI` — SoundCloud OAuth redirect URI (default: `http://localhost:3000/auth/soundcloud/callback`)

### Optional Configuration
- `PORT` — Web server port (default: `3000`)
- `DATA_DIR` — Custom directory path where `.tokens.json` and `.sync-state.json` are stored (default: project root)
- `PUSHOVER_USER_KEY` — Pushover user key for mobile push notifications
- `PUSHOVER_APP_TOKEN` — Pushover application token for mobile push notifications

## Architecture

**Entry point:** `src/app.js` — Express server. Exposes `/auth/google`, `/auth/google/callback`, `/auth/soundcloud`, `/auth/soundcloud/callback`, `/status`, and `POST /api/sync`. The sync endpoint streams NDJSON (`{ type, data }` lines) to the browser while the sync runs; a 409 is returned if a sync is already in progress.

**Frontend:** `public/index.html` — single static file (no build step). Reads the NDJSON stream and renders a live log with color-coded lines.

**Auth layer:**
- `src/auth/google.js` — wraps `googleapis` OAuth2 client; auto-persists refreshed tokens via the `tokens` event.
- `src/auth/soundcloud.js` — manual OAuth2 via `fetch`; handles token refresh by checking `obtained_at + expires_in`. Non-expiring SoundCloud tokens (no `expires_in`) skip refresh entirely.

**Sync pipeline** (`src/services/syncService.js`):
- Looks for a Google Drive folder named `producing` at the root of the authenticated user's Drive.
- Each subfolder inside `producing` is treated as an **artist name** (except `Admin` which is skipped).
- Audio files (`.wav`, `.mp3`, `.aiff`) inside subfolders are the tracks; the filename without extension becomes the **track title**.
- Track title sent to SoundCloud is formatted as `"${artistName} - ${rawTitle}"`.
- Uploads stream directly from Google Drive → SoundCloud using raw `https.request` (not `fetchWithRetry`) — streams are not replayable so retries are not possible.
- Uploaded tracks are added to a SoundCloud playlist named `CarPlay Mixes` (created if missing). Playlist update reads existing tracks then PUTs the full list — it only appends, never removes.
- **Crawl rules:** The `Admin` subfolder is always skipped. Within each artist folder, if a `Bounces` subfolder exists, audio files are sourced from there; otherwise from the artist folder directly.
- **Date filter:** Only audio files with a `createdTime` or `modifiedTime` in 2026 or later are processed.
- **Pushover Notifications:** If both `PUSHOVER_USER_KEY` and `PUSHOVER_APP_TOKEN` are set, mobile push notifications are sent for newly synced mixes (`✅ Nieuwe mix:\n...`) or updated versions (`🔄 Mix geüpdatet:\n...`).

**Idempotency & versioning:** `src/utils/syncState.js` maps Google Drive file IDs → `{ scTrackId, modifiedTime }` in `.sync-state.json` (stored in `DATA_DIR` if specified). Files already in the map are skipped unless their `modifiedTime` has advanced — in that case the old SoundCloud track is deleted and re-uploaded. Legacy state entries (plain string values) are treated as synced with no known modification date.

**Scheduler:** `src/utils/scheduler.js` — wraps `node-cron` to run sync every 15 minutes. Toggled via `POST /api/cron/toggle`; status via `GET /api/cron/status`. Background runs discard log output and silently skip if a manual sync is already in progress.

**Utilities:**
- `src/utils/tokenStore.js` — reads/writes `.tokens.json` (stored in `DATA_DIR` if specified) keyed by service name (`google`, `soundcloud`).
- `src/utils/fetchWithRetry.js` — exponential backoff (default 3 retries, 500 ms base). Supports an `onUnauthorized` hook for 401-triggered token refresh. Used for all SoundCloud API calls except the streaming upload.

## Docker deployment

`docker-compose.yml` mounts `.env`, `.tokens.json`, and `.sync-state.json` from the host so credentials and sync state survive container restarts. Complete auth on the host before deploying, or expose port 3000 and complete auth through the container. Alternatively, configure `DATA_DIR` to mount a persistent volume containing all data files.

## Coding Style & Conventions

- **JavaScript Style**: Modern ES6+ syntax using ES modules (`import`/`export`, `"type": "module"` in `package.json`).
- **Formatting**: Use 2 spaces for indentation, single quotes for strings, and semi-colons.
- **Naming Conventions**: Use `camelCase` for variables and function names, `UPPER_SNAKE_CASE` for constants, and `kebab-case` for UI elements or routes if applicable.
- **Language**: Core logic and files are in English, but user-facing console logs, terminal outputs, and client UI elements (e.g. log warnings, error messages, static HTML UI) are written in **Dutch** (Nederlands) or a mix of English/Dutch (e.g. `[WAARSCHUWING]`, `[UPDATE]`, `Oude track verwijderd`).
- **Error Handling**: Use `try/catch` for asynchronous operations. Keep network resilience high by utilizing `fetchWithRetry` for API calls, and fail gracefully without crashing when using background cron jobs.
