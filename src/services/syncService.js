import 'dotenv/config';
import { google } from 'googleapis';
import https from 'https';
import { fileURLToPath } from 'url';
import { getAuthenticatedClient } from '../auth/google.js';
import { getAccessToken } from '../auth/soundcloud.js';
import { fetchWithRetry } from '../utils/fetchWithRetry.js';
import { loadState, isSynced, markSynced, getStoredTrackId, getStoredModifiedTime, getStoredVersion, removeStateEntry } from '../utils/syncState.js';

const PRODUCING_FOLDER = 'producing';
const MIME_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.aiff': 'audio/aiff' };
const PLAYLIST_NAME = 'CarPlay Mixes';
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.aiff']);
const SC_BASE = 'https://api.soundcloud.com';

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findBestTrackMatch(playlistTracks, baseTitle) {
  let bestMatch = null;
  const regex = new RegExp('^' + escapeRegExp(baseTitle) + '(?: \\(v(\\d+)\\))?$', 'i');
  for (const track of playlistTracks) {
    if (!track.title) continue;
    const match = track.title.match(regex);
    if (match) {
      const version = match[1] !== undefined ? parseInt(match[1], 10) : 1;
      if (!bestMatch || version > bestMatch.version) {
        bestMatch = {
          id: track.id,
          version,
        };
      }
    }
  }
  return bestMatch;
}

function findMatchingTrackIds(playlistTracks, baseTitle) {
  const matches = [];
  const regex = new RegExp('^' + escapeRegExp(baseTitle) + '(?: \\(v(\\d+)\\))?$', 'i');
  for (const track of playlistTracks) {
    if (!track.title) continue;
    const match = track.title.match(regex);
    if (match) {
      matches.push(track.id);
    }
  }
  return matches;
}

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

async function findBouncesFolder(drive, parentId) {
  const { data } = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='Bounces' and trashed=false`,
    fields: 'files(id)',
    pageSize: 1,
  });
  return data.files[0] ?? null;
}

async function listAudioFiles(drive, folderId) {
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, size, createdTime, modifiedTime, version)',
    orderBy: 'name',
  });
  return data.files.filter(f => {
    if (!AUDIO_EXTENSIONS.has(getExtension(f.name))) return false;
    const year = (d) => new Date(d).getFullYear();
    // Skip files not touched in 2026 or later
    return year(f.createdTime) >= 2026 || year(f.modifiedTime) >= 2026;
  });
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

  const params = new URLSearchParams();
  params.append('playlist[title]', PLAYLIST_NAME);
  params.append('playlist[sharing]', 'private');

  const createRes = await fetchWithRetry(`${SC_BASE}/playlists`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' },
    body: params,
  });

  const data = await createRes.json();
  log(`  Created playlist "${PLAYLIST_NAME}" (ID: ${data.id})`);
  return data.id;
}

async function addTrackToPlaylist(accessToken, playlistId, trackId, excludeTrackIds = null) {
  const getRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlistId}`, {
    headers: scHeaders(accessToken),
  });
  const playlist = await getRes.json();

  const excludes = new Set();
  if (excludeTrackIds) {
    if (Array.isArray(excludeTrackIds)) {
      excludeTrackIds.forEach(id => excludes.add(String(id)));
    } else if (typeof excludeTrackIds === 'object' && excludeTrackIds.scTrackId) {
      excludes.add(String(excludeTrackIds.scTrackId));
    } else {
      excludes.add(String(excludeTrackIds));
    }
  }
  
  let trackIds = (playlist.tracks ?? [])
    .map(t => t.id)
    .filter(id => id && !excludes.has(String(id)));

  trackIds.push(trackId);

  // Deduplicate
  trackIds = [...new Set(trackIds)];

  const params = new URLSearchParams();
  trackIds.forEach(id => params.append('playlist[tracks][][id]', id));

  const putRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlistId}`, {
    method: 'PUT',
    headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' },
    body: params,
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`Playlist update failed: ${putRes.status} - ${errText}`);
  }
}

async function removeTrackFromPlaylist(accessToken, playlistId, trackId) {
  const getRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlistId}`, {
    headers: scHeaders(accessToken),
  });
  const playlist = await getRes.json();

  const idStr = String(typeof trackId === 'object' ? trackId.scTrackId : trackId);
  const trackIds = (playlist.tracks ?? [])
    .map(t => t.id)
    .filter(id => id && String(id) !== idStr);

  const params = new URLSearchParams();
  trackIds.forEach(id => params.append('playlist[tracks][][id]', id));

  const putRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlistId}`, {
    method: 'PUT',
    headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' },
    body: params,
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`Playlist update failed: ${putRes.status} - ${errText}`);
  }
}

async function sendNotification(message) {
  const user = process.env.PUSHOVER_USER_KEY;
  const token = process.env.PUSHOVER_APP_TOKEN;
  if (!user || !token) return;

  const params = new URLSearchParams();
  params.append('token', token);
  params.append('user', user);
  params.append('message', message);
  params.append('title', '🚗 CarPlay Sync');

  try {
    await fetchWithRetry('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body: params,
    });
  } catch (err) {
    console.warn(`  [WAARSCHUWING] Kon push notificatie niet versturen: ${err.message}`);
  }
}

async function deleteTrack(accessToken, trackId) {
  if (!trackId) return;
  const idStr = typeof trackId === 'object' ? trackId.scTrackId : trackId;

  try {
    await fetchWithRetry(`${SC_BASE}/tracks/${idStr}`, {
      method: 'DELETE',
      headers: scHeaders(accessToken),
    });
    console.log(`  [CLEANUP] Oude track (ID: ${idStr}) verwijderd van SoundCloud.`);
  } catch (err) {
    if (err.message.includes('HTTP 404')) {
      console.warn(`  [WAARSCHUWING] Track ID ${idStr} niet gevonden op SoundCloud (mogelijk al handmatig verwijderd).`);
    } else {
      throw err;
    }
  }
}

async function uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename, fileSize }) {
  if (!fileSize || isNaN(fileSize)) {
    throw new Error(`Kan track niet uploaden: ongeldige bestandsgrootte (${fileSize}) voor ${filename}`);
  }

  const ext = getExtension(filename);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const boundary = '----SoundCloudBoundary' + Date.now().toString(16);
  const CRLF = '\r\n';
  const safeFilename = 'upload' + ext;

  const fields = {
    'track[title]': trackTitle.trim(),
    'track[sharing]': 'private',
  };
  let header = '';
  for (const [name, value] of Object.entries(fields)) {
    header += `--${boundary}${CRLF}`;
    header += `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`;
    header += `${value}${CRLF}`;
  }
  header += `--${boundary}${CRLF}`;
  header += `Content-Disposition: form-data; name="track[asset_data]"; filename="${safeFilename}"${CRLF}`;
  header += `Content-Type: ${contentType}${CRLF}${CRLF}`;
  const footer = `${CRLF}--${boundary}--${CRLF}`;

  const totalLength = Buffer.byteLength(header) + fileSize + Buffer.byteLength(footer);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.soundcloud.com',
      port: 443,
      path: '/tracks',
      method: 'POST',
      headers: {
        Authorization: `OAuth ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': totalLength,
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`Upload failed — SoundCloud returned non-JSON: ${body.slice(0, 500)}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} — ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(header);
    driveStream.pipe(req, { end: false });
    driveStream.on('end', () => { req.end(footer); });
    driveStream.on('error', (err) => { req.destroy(err); reject(err); });
  });
}

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

  const getRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlistId}`, {
    headers: scHeaders(accessToken),
  });
  const playlist = await getRes.json();
  const playlistTracks = playlist.tracks ?? [];

  const subfolders = await listSubfolders(drive, producingFolder.id);
  const state = await loadState();
  const activeDriveIds = new Set();

  for (const subfolder of subfolders) {
    const artistName = subfolder.name;

    if (artistName === 'Admin') {
      log(`[Admin] — skipped`);
      continue;
    }

    const bouncesFolder = await findBouncesFolder(drive, subfolder.id);
    const sourceFolderId = bouncesFolder ? bouncesFolder.id : subfolder.id;
    const sourceLabel = bouncesFolder ? `${artistName}/Bounces` : artistName;

    const audioFiles = await listAudioFiles(drive, sourceFolderId);

    if (audioFiles.length === 0) continue;
    log(`[${sourceLabel}] — ${audioFiles.length} track(s)`);

    for (const file of audioFiles) {
      activeDriveIds.add(file.id);
      const ext = getExtension(file.name);
      const rawTitle = file.name.slice(0, file.name.length - ext.length);
      const baseTitle = `${artistName} - ${rawTitle}`;

      // Versienummer bepalen op basis van het aantal Google Drive revisies
      let driveVersion = 1;
      try {
        const revisionsRes = await drive.revisions.list({ fileId: file.id, fields: 'revisions(id)' });
        driveVersion = (revisionsRes.data.revisions && revisionsRes.data.revisions.length > 0)
          ? revisionsRes.data.revisions.length
          : 1;
      } catch (err) {
        log(`  [WAARSCHUWING] Kon revisies niet ophalen voor ${file.name}, standaardversie v1 wordt gebruikt: ${err.message}`);
      }

      const trackTitle = `${baseTitle} (v${driveVersion})`;
      const matchingIds = findMatchingTrackIds(playlistTracks, baseTitle);

      if (isSynced(state, file.id)) {
        const storedVersion = getStoredVersion(state, file.id);
        const storedModified = getStoredModifiedTime(state, file.id);
        const storedTime = storedModified ? new Date(storedModified).getTime() : 0;
        const fileTime = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;

        let needsUpdate = false;
        if (storedVersion === null) {
          needsUpdate = (storedTime && fileTime > storedTime) || !storedTime;
        } else {
          needsUpdate = driveVersion !== storedVersion;
        }

        if (needsUpdate) {
          const oldVersionStr = storedVersion !== null ? `v${storedVersion}` : 'legacy';
          log(`  [UPDATE] Nieuwe versie gedetecteerd voor ${baseTitle} (${oldVersionStr} → v${driveVersion}), oude track(s) worden verwijderd...`);
          for (const matchId of matchingIds) {
            await deleteTrack(accessToken, matchId);
          }

          const driveStream = await getDriveStream(drive, file.id);
          const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name, fileSize: parseInt(file.size, 10) });
          await addTrackToPlaylist(accessToken, playlistId, track.id, matchingIds);
          await markSynced(state, file.id, track.id, file.modifiedTime, driveVersion);
          await sendNotification(`🔄 Mix geüpdatet:\n${trackTitle}`);
          log(`  ✓ ${trackTitle} (ID: ${track.id}) [REPLACED]`);
        } else {
          log(`  [SKIPPED] ${trackTitle} - already synced`);
        }
        continue;
      }

      // Herstel / Duplicaatdetectie op basis van SoundCloud playlist tracks
      const bestMatch = findBestTrackMatch(playlistTracks, baseTitle);

      if (bestMatch) {
        log(`  [RECOVERY] SoundCloud track gevonden voor ${baseTitle} met versie v${bestMatch.version}`);

        if (bestMatch.version === driveVersion) {
          log(`  [RECOVERY] Lokale status hersteld voor ${trackTitle}. Geen upload nodig.`);
          await markSynced(state, file.id, bestMatch.id, file.modifiedTime, driveVersion);
          continue;
        } else {
          log(`  [RECOVERY-UPDATE] Versieverschil gedetecteerd voor ${baseTitle} (SoundCloud v${bestMatch.version} → Drive v${driveVersion}), oude track(s) worden verwijderd...`);
          for (const matchId of matchingIds) {
            await deleteTrack(accessToken, matchId);
          }

          const driveStream = await getDriveStream(drive, file.id);
          const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name, fileSize: parseInt(file.size, 10) });
          await addTrackToPlaylist(accessToken, playlistId, track.id, matchingIds);
          await markSynced(state, file.id, track.id, file.modifiedTime, driveVersion);
          await sendNotification(`🔄 Mix geüpdatet:\n${trackTitle}`);
          log(`  ✓ ${trackTitle} (ID: ${track.id}) [REPLACED]`);
          continue;
        }
      }

      // Echt nieuw bestand (of stray opruimen indien aanwezig)
      if (matchingIds.length > 0) {
        log(`  [CLEANUP] Oude losse track(s) gedetecteerd voor ${baseTitle}, deze worden verwijderd...`);
        for (const matchId of matchingIds) {
          await deleteTrack(accessToken, matchId);
        }
      }

      log(`  ↑ ${trackTitle} …`);

      const driveStream = await getDriveStream(drive, file.id);
      const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name, fileSize: parseInt(file.size, 10) });
      await addTrackToPlaylist(accessToken, playlistId, track.id, matchingIds);
      await markSynced(state, file.id, track.id, file.modifiedTime, driveVersion);
      await sendNotification(`✅ Nieuwe mix:\n${trackTitle}`);
      log(`  ✓ ${trackTitle} (ID: ${track.id})`);
    }
  }

  // ── Opruimfase voor verwijderde/vervangen bestanden ───────────────────────
  log('\nStarten met opruimen van wees-tracks...');
  const stateKeys = Object.keys(state);
  let cleanupCount = 0;

  for (const driveFileId of stateKeys) {
    if (!activeDriveIds.has(driveFileId)) {
      const oldTrackId = getStoredTrackId(state, driveFileId);
      if (oldTrackId) {
        log(`  [CLEANUP] Google Drive bestand (ID: ${driveFileId}) is niet meer aanwezig. SoundCloud track (ID: ${oldTrackId}) wordt verwijderd.`);
        
        try {
          await removeTrackFromPlaylist(accessToken, playlistId, oldTrackId);
        } catch (err) {
          log(`  [WAARSCHUWING] Kon track ID ${oldTrackId} niet uit de afspeellijst verwijderen: ${err.message}`);
        }

        try {
          await deleteTrack(accessToken, oldTrackId);
        } catch (err) {
          log(`  [WAARSCHUWING] Kon track ID ${oldTrackId} niet verwijderen van SoundCloud: ${err.message}`);
        }
      }
      await removeStateEntry(state, driveFileId);
      cleanupCount++;
    }
  }

  if (cleanupCount > 0) {
    log(`  ✓ Opruimen voltooid: ${cleanupCount} wees-track(s) verwijderd.`);
  } else {
    log('  Geen wees-tracks gevonden.');
  }

  log('\nSync complete.');
}

// Run directly via: npm run sync
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sync().catch(err => { console.error(err.message); process.exit(1); });
}
