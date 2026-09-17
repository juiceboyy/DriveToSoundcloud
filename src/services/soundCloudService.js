import https from 'https';
import { fetchWithRetry } from '../utils/fetchWithRetry.js';
import { getExtension, MIME_TYPES } from './driveService.js';

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

// Re-export playlist management functions from playlistService
export {
  PLAYLIST_NAME,
  ensurePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  updatePlaylistsOnTrackChange,
  getUserPlaylists,
} from './playlistService.js';

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
          catch { reject(new Error(`Upload failed - SoundCloud returned non-JSON: ${body.slice(0, 500)}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} - ${body}`));
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
