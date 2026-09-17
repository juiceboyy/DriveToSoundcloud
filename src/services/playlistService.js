import { fetchWithRetry } from '../utils/fetchWithRetry.js';
import { SC_BASE, scHeaders } from './soundCloudService.js';

export const PLAYLIST_NAME = 'CarPlay Mixes';

/**
 * Haalt alle afspeellijsten op van de geauthenticeerde SoundCloud gebruiker.
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
export async function getUserPlaylists(accessToken) {
  const res = await fetchWithRetry(`${SC_BASE}/me/playlists?limit=200`, {
    headers: scHeaders(accessToken),
  });
  return await res.json();
}

/**
 * Zorgt ervoor dat de standaard playlist (CarPlay Mixes) bestaat.
 * @param {string} accessToken
 * @param {Function} log
 * @returns {Promise<string|number>} Playlist ID
 */
export async function ensurePlaylist(accessToken, log = console.log) {
  const playlists = await getUserPlaylists(accessToken);

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

/**
 * Voegt een track toe aan een specifieke afspeellijst (optioneel bovenaan met prepend).
 * @param {string} accessToken
 * @param {string|number} playlistId
 * @param {string|number} trackId
 * @param {Array|Set|string|number} excludeTrackIds
 * @param {boolean} prepend - Indien waar, plaats de track bovenaan (index 0)
 */
export async function addTrackToPlaylist(accessToken, playlistId, trackId, excludeTrackIds = null, prepend = false) {
  const getRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlistId}`, {
    headers: scHeaders(accessToken),
  });
  const playlist = await getRes.json();

  const excludes = new Set();
  if (excludeTrackIds) {
    if (Array.isArray(excludeTrackIds) || excludeTrackIds instanceof Set) {
      excludeTrackIds.forEach(id => {
        if (!id) return;
        excludes.add(String(typeof id === 'object' ? id.scTrackId : id));
      });
    } else if (typeof excludeTrackIds === 'object' && excludeTrackIds.scTrackId) {
      excludes.add(String(excludeTrackIds.scTrackId));
    } else {
      excludes.add(String(excludeTrackIds));
    }
  }

  const newIdStr = String(typeof trackId === 'object' ? trackId.scTrackId : trackId);
  excludes.add(newIdStr);

  let trackIds = (playlist.tracks ?? [])
    .map(t => t?.id)
    .filter(id => id && !excludes.has(String(id)));

  if (prepend) {
    trackIds = [trackId, ...trackIds];
  } else {
    trackIds.push(trackId);
  }
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

/**
 * Verwijdert een track uit een specifieke afspeellijst.
 * @param {string} accessToken
 * @param {string|number} playlistId
 * @param {string|number|Object} trackId
 */
export async function removeTrackFromPlaylist(accessToken, playlistId, trackId) {
  const getRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlistId}`, {
    headers: scHeaders(accessToken),
  });
  const playlist = await getRes.json();

  const idStr = String(typeof trackId === 'object' ? trackId.scTrackId : trackId);
  const trackIds = (playlist.tracks ?? [])
    .map(t => t?.id)
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

/**
 * Werkt alle SoundCloud afspeellijsten van de gebruiker bij na het uploaden/vervangen van een track:
 * 1. CarPlay Mixes: track wordt altijd bovenaan geplaatst (positie 1).
 * 2. Overige playlists: track vervangt de oude track-ID in-place op exact dezelfde positie.
 *
 * @param {string} accessToken
 * @param {Object} options
 * @param {Array|Set} options.oldTrackIds - Oude track IDs die vervangen worden
 * @param {string|number} options.newTrackId - Nieuwe SoundCloud track ID
 * @param {string|number} options.carPlayPlaylistId - ID van de CarPlay Mixes playlist
 * @param {Function} options.log - Logger functie
 */
export async function updatePlaylistsOnTrackChange(accessToken, {
  oldTrackIds = [],
  newTrackId,
  carPlayPlaylistId,
  log = console.log,
}) {
  const oldSet = new Set();
  const rawList = Array.isArray(oldTrackIds)
    ? oldTrackIds
    : (oldTrackIds instanceof Set ? Array.from(oldTrackIds) : [oldTrackIds]);

  for (const item of rawList) {
    if (!item) continue;
    const id = typeof item === 'object' ? item.scTrackId : item;
    if (id) oldSet.add(String(id));
  }

  const playlists = await getUserPlaylists(accessToken);
  const targetNewId = typeof newTrackId === 'object' ? newTrackId.scTrackId : newTrackId;
  const targetNewIdStr = String(targetNewId);

  let carPlayProcessed = false;

  for (const playlist of playlists) {
    const isCarPlay = String(playlist.id) === String(carPlayPlaylistId) || playlist.title === PLAYLIST_NAME;

    if (isCarPlay) {
      carPlayProcessed = true;
      let tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];

      if (tracks.length === 0) {
        try {
          const res = await fetchWithRetry(`${SC_BASE}/playlists/${playlist.id}`, {
            headers: scHeaders(accessToken),
          });
          const fullPl = await res.json();
          tracks = fullPl.tracks ?? [];
        } catch (err) {
          log(`  [WAARSCHUWING] Kon tracks voor "${playlist.title}" niet ophalen: ${err.message}`);
        }
      }

      const remainingTrackIds = tracks
        .map(t => t?.id)
        .filter(id => id && !oldSet.has(String(id)) && String(id) !== targetNewIdStr);

      const updatedTrackIds = [targetNewId, ...remainingTrackIds];

      const params = new URLSearchParams();
      updatedTrackIds.forEach(id => params.append('playlist[tracks][][id]', id));

      const putRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlist.id}`, {
        method: 'PUT',
        headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' },
        body: params,
      });

      if (!putRes.ok) {
        const errText = await putRes.text();
        throw new Error(`CarPlay playlist update mislukt: ${putRes.status} - ${errText}`);
      }

      log(`  [PLAYLIST] Track bovenaan geplaatst in "${playlist.title}" (positie 1)`);
      continue;
    }

    // Voor overige playlists: alleen bijwerken als een oude versie in de playlist staat
    if (oldSet.size === 0) continue;

    let tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    if (!playlist.tracks || tracks.length === 0) {
      try {
        const res = await fetchWithRetry(`${SC_BASE}/playlists/${playlist.id}`, {
          headers: scHeaders(accessToken),
        });
        const fullPl = await res.json();
        tracks = fullPl.tracks ?? [];
      } catch {
        continue;
      }
    }

    const hasMatch = tracks.some(t => t?.id && oldSet.has(String(t.id)));
    if (!hasMatch) continue;

    let replacedIndex = -1;
    const newTrackIds = [];

    for (const track of tracks) {
      if (!track || !track.id) continue;
      const strId = String(track.id);

      if (oldSet.has(strId)) {
        if (replacedIndex === -1) {
          replacedIndex = newTrackIds.length;
          newTrackIds.push(targetNewId);
        }
      } else if (strId !== targetNewIdStr) {
        newTrackIds.push(track.id);
      }
    }

    if (replacedIndex !== -1) {
      const params = new URLSearchParams();
      newTrackIds.forEach(id => params.append('playlist[tracks][][id]', id));

      const putRes = await fetchWithRetry(`${SC_BASE}/playlists/${playlist.id}`, {
        method: 'PUT',
        headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' },
        body: params,
      });

      if (!putRes.ok) {
        const errText = await putRes.text();
        log(`  [WAARSCHUWING] Kon afspeellijst "${playlist.title}" niet updaten: ${errText}`);
      } else {
        log(`  [PLAYLIST] Positie behouden in "${playlist.title}" (positie ${replacedIndex + 1})`);
      }
    }
  }

  // Fallback indien CarPlay Mixes niet in de initiële lijst zat
  if (!carPlayProcessed && carPlayPlaylistId) {
    await addTrackToPlaylist(accessToken, carPlayPlaylistId, targetNewId, Array.from(oldSet), true);
    log(`  [PLAYLIST] Track bovenaan geplaatst in "${PLAYLIST_NAME}" (positie 1)`);
  }
}
