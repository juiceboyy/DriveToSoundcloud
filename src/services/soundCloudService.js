import https from 'https';
import { fetchWithRetry } from '../utils/fetchWithRetry.js';
import { getExtension, MIME_TYPES } from './driveService.js';

export const PLAYLIST_NAME = 'CarPlay Mixes';
export const SC_BASE = 'https://api.soundcloud.com';

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findBestTrackMatch(playlistTracks, baseTitle) {
  let bestMatch = null;
  const regex = new RegExp('^' + escapeRegExp(baseTitle) + '(?:[\\s_\\-\\.\\(\\[]+(?:versie|v)[\\s\\.]*(\\d+)[\\)\\]]?)?$', 'i');
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

export function findMatchingTrackIds(playlistTracks, baseTitle) {
  const matches = [];
  const regex = new RegExp('^' + escapeRegExp(baseTitle) + '(?:[\\s_\\-\\.\\(\\[]+(?:versie|v)[\\s\\.]*(\\d+)[\\)\\]]?)?$', 'i');
  for (const track of playlistTracks) {
    if (!track.title) continue;
    const match = track.title.match(regex);
    if (match) {
      matches.push(track.id);
    }
  }
  return matches;
}

export function scHeaders(accessToken) {
  return { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' };
}

export async function ensurePlaylist(accessToken, log) {
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

export async function addTrackToPlaylist(accessToken, playlistId, trackId, excludeTrackIds = null) {
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

export async function removeTrackFromPlaylist(accessToken, playlistId, trackId) {
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

export async function sendNotification(message) {
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

export async function deleteTrack(accessToken, trackId) {
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

export async function uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename, fileSize }) {
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
