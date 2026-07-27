import 'dotenv/config';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import { getAuthenticatedClient } from '../auth/google.js';
import { getAccessToken } from '../auth/soundcloud.js';
import { fetchWithRetry } from '../utils/fetchWithRetry.js';
import {
  loadState,
  isSynced,
  markSynced,
  getStoredTrackId,
  getStoredModifiedTime,
  getStoredVersion,
  removeStateEntry,
} from '../utils/syncState.js';
import {
  getExtension,
  findDriveFolder,
  listSubfolders,
  findBouncesFolder,
  listAudioFiles,
  getDriveStream,
} from './driveService.js';
import {
  PLAYLIST_NAME,
  SC_BASE,
  scHeaders,
  ensurePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  deleteTrack,
  uploadTrack,
  findBestTrackMatch,
  findMatchingTrackIds,
  sendNotification,
} from './soundCloudService.js';

import { parseVersionAndCleanTitle, deduplicateDriveFiles } from '../utils/versionUtils.js';

const PRODUCING_FOLDER = 'producing';

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

    const fileInfos = [];
    for (const file of audioFiles) {
      const ext = getExtension(file.name);
      const rawTitle = file.name.slice(0, file.name.length - ext.length);
      const { cleanTitle, explicitVersion } = parseVersionAndCleanTitle(rawTitle);
      const baseTitle = `${artistName} - ${cleanTitle}`;

      let version = 1;
      if (explicitVersion !== null) {
        version = explicitVersion;
      } else {
        try {
          const revisionsRes = await drive.revisions.list({ fileId: file.id, fields: 'revisions(id)' });
          version = (revisionsRes.data.revisions && revisionsRes.data.revisions.length > 0)
            ? revisionsRes.data.revisions.length
            : 1;
        } catch (err) {
          log(`  [WAARSCHUWING] Kon revisies niet ophalen voor ${file.name}, standaardversie v1 wordt gebruikt: ${err.message}`);
        }
      }

      fileInfos.push({ file, cleanTitle, baseTitle, explicitVersion, version });
    }

    const activeFiles = deduplicateDriveFiles(fileInfos, log);

    for (const info of activeFiles) {
      const { file, baseTitle, version } = info;
      activeDriveIds.add(file.id);
      const trackTitle = `${baseTitle} (v${version})`;
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
          needsUpdate = version !== storedVersion;
        }

        if (needsUpdate) {
          const oldVersionStr = storedVersion !== null ? `v${storedVersion}` : 'legacy';
          log(`  [UPDATE] Nieuwe versie gedetecteerd voor ${baseTitle} (${oldVersionStr} → v${version}), oude track(s) worden verwijderd...`);
          for (const matchId of matchingIds) {
            await deleteTrack(accessToken, matchId);
          }

          const driveStream = await getDriveStream(drive, file.id);
          const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name, fileSize: parseInt(file.size, 10) });
          await addTrackToPlaylist(accessToken, playlistId, track.id, matchingIds);
          await markSynced(state, file.id, track.id, file.modifiedTime, version);
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

        if (bestMatch.version === version) {
          log(`  [RECOVERY] Lokale status hersteld voor ${trackTitle}. Geen upload nodig.`);
          await markSynced(state, file.id, bestMatch.id, file.modifiedTime, version);
          continue;
        } else {
          log(`  [RECOVERY-UPDATE] Versieverschil gedetecteerd voor ${baseTitle} (SoundCloud v${bestMatch.version} → Drive v${version}), oude track(s) worden verwijderd...`);
          for (const matchId of matchingIds) {
            await deleteTrack(accessToken, matchId);
          }

          const driveStream = await getDriveStream(drive, file.id);
          const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name, fileSize: parseInt(file.size, 10) });
          await addTrackToPlaylist(accessToken, playlistId, track.id, matchingIds);
          await markSynced(state, file.id, track.id, file.modifiedTime, version);
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
      await markSynced(state, file.id, track.id, file.modifiedTime, version);
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
