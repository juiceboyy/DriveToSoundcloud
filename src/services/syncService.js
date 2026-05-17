import 'dotenv/config';
import { google } from 'googleapis';
import https from 'https';
import { fileURLToPath } from 'url';
import { getAuthenticatedClient } from '../auth/google.js';
import { getAccessToken } from '../auth/soundcloud.js';
import { fetchWithRetry } from '../utils/fetchWithRetry.js';
import { loadState, isSynced, markSynced } from '../utils/syncState.js';

const PRODUCING_FOLDER = 'producing';
const PLAYLIST_NAME = 'CarPlay Mixes';
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.aiff']);
const SC_BASE = 'https://api.soundcloud.com';

const MIME_TYPES = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aiff': 'audio/aiff',
};

// ── Google Drive helpers ──────────────────────────────────────────────────────

function getExtension(filename) {
  const idx = filename.lastIndexOf('.');
  return idx !== -1 ? filename.slice(idx).toLowerCase() : '';
}

async function findDriveFolder(drive, name) {
  const { data } = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });
  const [folder] = data.files;
  if (!folder) throw new Error(`Drive folder "${name}" not found.`);
  return folder;
}

async function listSubfolders(drive, parentId) {
  const { data } = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    orderBy: 'name',
  });
  return data.files;
}

async function listAudioFiles(drive, folderId) {
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    orderBy: 'name',
  });
  return data.files.filter(f => AUDIO_EXTENSIONS.has(getExtension(f.name)));
}

async function getDriveStream(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' },
  );
  return res.data; // Node.js Readable — never buffered
}

// ── SoundCloud helpers ────────────────────────────────────────────────────────

function scHeaders(accessToken) {
  return { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' };
}

async function ensurePlaylist(accessToken, log) {
  const res = await fetchWithRetry(`${SC_BASE}/me/playlists?limit=200`, {
    headers: scHeaders(accessToken),
  });
  const playlists = await res.json();

  const existing = playlists.find(p => p.title === PLAYLIST_NAME);
  if (existing) return existing.id;

  const createRes = await fetchWithRetry(`${SC_BASE}/playlists`, {
    method: 'POST',
    headers: { ...scHeaders(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlist: { title: PLAYLIST_NAME, sharing: 'private', tracks: [] } }),
  });
  const { id } = await createRes.json();
  log(`  Created playlist "${PLAYLIST_NAME}" (ID: ${id})`);
  return id;
}

async function addTrackToPlaylist(accessToken, playlistId, trackId) {
  const getRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlistId}`, {
    headers: scHeaders(accessToken),
  });
  const playlist = await getRes.json();
  const updatedTracks = [...(playlist.tracks ?? []).map(t => ({ id: t.id })), { id: trackId }];

  await fetchWithRetry(`${SC_BASE}/playlists/${playlistId}`, {
    method: 'PUT',
    headers: { ...scHeaders(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlist: { tracks: updatedTracks } }),
  });
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function buildMultipart(fields, file) {
  const boundary = '----SoundCloudBoundary' + Date.now().toString(16);
  const e = s => Buffer.from(s);
  const CRLF = '\r\n';

  const parts = Object.entries(fields).map(([name, value]) =>
    Buffer.concat([
      e(`--${boundary}${CRLF}`),
      e(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`),
      e(value),
      e(CRLF),
    ])
  );

  parts.push(Buffer.concat([
    e(`--${boundary}${CRLF}`),
    e(`Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"${CRLF}`),
    e(`Content-Type: ${file.contentType}${CRLF}${CRLF}`),
    file.buffer,
    e(CRLF),
    e(`--${boundary}--${CRLF}`),
  ]));

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename }) {
  const ext = getExtension(filename);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const audioBuffer = await streamToBuffer(driveStream);

  const { body, contentType: multipartType } = buildMultipart(
    { 'track[title]': trackTitle, 'track[sharing]': 'private' },
    { fieldName: 'track[asset_data]', filename, contentType, buffer: audioBuffer },
  );

  const result = await httpsPost(`${SC_BASE}/tracks`, {
    Authorization: `OAuth ${accessToken}`,
    'Content-Type': multipartType,
    'Content-Length': body.length,
  }, body);

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`HTTP ${result.status}: ${result.statusText} — ${result.body}`);
  }
  return JSON.parse(result.body);
}

function httpsRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        statusText: res.statusMessage,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const httpsPost = (url, headers, body) => httpsRequest('POST', url, headers, body);
const httpsPut  = (url, headers, body) => httpsRequest('PUT',  url, headers, body);

// ── Main pipeline ─────────────────────────────────────────────────────────────

export async function sync(log = console.log) {
  const [driveClient, accessToken] = await Promise.all([
    getAuthenticatedClient(),
    getAccessToken(),
  ]);

  const drive = google.drive({ version: 'v3', auth: driveClient });

  const producingFolder = await findDriveFolder(drive, PRODUCING_FOLDER);
  log(`Found Drive folder: "${producingFolder.name}" (${producingFolder.id})`);

  const playlistId = await ensurePlaylist(accessToken, log);
  log(`Playlist "${PLAYLIST_NAME}" ready (ID: ${playlistId})\n`);

  const subfolders = await listSubfolders(drive, producingFolder.id);
  const state = await loadState();

  for (const subfolder of subfolders) {
    const artistName = subfolder.name;
    const audioFiles = await listAudioFiles(drive, subfolder.id);

    if (audioFiles.length === 0) continue;
    log(`[${artistName}] — ${audioFiles.length} track(s)`);

    for (const file of audioFiles) {
      const ext = getExtension(file.name);
      const trackTitle = file.name.slice(0, file.name.length - ext.length);

      if (isSynced(state, file.id)) {
        log(`  [SKIPPED] ${trackTitle} - already synced`);
        continue;
      }

      log(`  ↑ ${trackTitle} …`);

      const driveStream = await getDriveStream(drive, file.id);
      const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name });
      await addTrackToPlaylist(accessToken, playlistId, track.id);
      await markSynced(state, file.id, track.id);

      log(`  ✓ ${trackTitle} (ID: ${track.id})`);
    }
  }

  log('\nSync complete.');
}

// Run directly via: npm run sync
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sync().catch(err => { console.error(err.message); process.exit(1); });
}
