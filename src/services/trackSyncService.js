import {
  isSynced,
  markSynced,
  getStoredTrackId,
  getStoredModifiedTime,
  getStoredVersion,
  getStoredFilename,
  getStoredExt,
  getStoredBaseTitle,
  findStateEntryByBaseTitle,
  findStateEntryByTrackId,
  removeStateEntry,
} from '../utils/syncState.js';
import { getExtension, getDriveStream } from './driveService.js';
import {
  addTrackToPlaylist,
  deleteTrack,
  uploadTrack,
  findBestTrackMatch,
  findMatchingTrackIds,
  sendNotification,
} from './soundCloudService.js';

/**
 * Synchronizes an individual audio file from Google Drive to SoundCloud.
 * Handles existing track updates, replacements (e.g. extension changes), and new uploads.
 *
 * @param {Object} params
 * @param {Object} params.drive - Google Drive client
 * @param {string} params.accessToken - SoundCloud access token
 * @param {string|number} params.playlistId - Target SoundCloud playlist ID
 * @param {Array} params.playlistTracks - Tracks currently in the SoundCloud playlist
 * @param {Object} params.state - In-memory sync state
 * @param {Object} params.info - File info object ({ file, cleanTitle, baseTitle, explicitVersion, version })
 * @param {string} params.artistName - Artist/Folder name
 * @param {Function} params.log - Logger function
 */
export async function syncTrack({
  drive,
  accessToken,
  playlistId,
  playlistTracks,
  state,
  info,
  artistName,
  log = console.log,
}) {
  const { file, baseTitle, version } = info;
  const ext = getExtension(file.name);
  const trackTitle = `${baseTitle} (v${version})`;
  const matchingIds = findMatchingTrackIds(playlistTracks, baseTitle);
  const storedTrackId = getStoredTrackId(state, file.id);

  // Controleer of de track aanwezig is in de SoundCloud playlist
  const existsOnSoundCloud = storedTrackId
    ? playlistTracks.some(t => String(t.id) === String(storedTrackId))
    : matchingIds.length > 0;

  // Zoek een eerdere state entry voor deze baseTitle (bijv. vorig bestand met andere extensie/fileId)
  const priorStateMatch = findStateEntryByBaseTitle(state, baseTitle);
  const [priorDriveId, priorEntry] = priorStateMatch || [null, null];
  const isReplacementFile = priorDriveId && priorDriveId !== file.id;

  if (isSynced(state, file.id)) {
    const storedVersion = getStoredVersion(state, file.id);
    const storedModified = getStoredModifiedTime(state, file.id);
    const storedExt = getStoredExt(state, file.id);
    const storedFilename = getStoredFilename(state, file.id);
    const storedBaseTitle = getStoredBaseTitle(state, file.id);
    const storedTime = storedModified ? new Date(storedModified).getTime() : 0;
    const fileTime = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;

    let needsUpdate = false;
    let updateReason = '';

    if (!existsOnSoundCloud) {
      needsUpdate = true;
      updateReason = 'track ontbreekt op SoundCloud';
    } else if (storedExt && ext !== storedExt) {
      needsUpdate = true;
      updateReason = `extensie gewijzigd (${storedExt} → ${ext})`;
    } else if (storedFilename && file.name !== storedFilename) {
      needsUpdate = true;
      updateReason = `bestandsnaam gewijzigd (${storedFilename} → ${file.name})`;
    } else if (storedVersion === null) {
      needsUpdate = (storedTime && fileTime > storedTime) || !storedTime;
      if (needsUpdate) updateReason = 'gewijzigde tijd (legacy)';
    } else if (version !== storedVersion) {
      needsUpdate = true;
      updateReason = `versie v${storedVersion} → v${version}`;
    } else if (fileTime > storedTime) {
      needsUpdate = true;
      updateReason = 'bestand aangepast in Drive';
    }

    if (needsUpdate) {
      log(`  [UPDATE] Update gedetecteerd voor ${baseTitle} (${updateReason}), oude track(s) worden vervangen...`);
      const toDelete = new Set([...matchingIds, ...(storedTrackId ? [storedTrackId] : [])]);
      for (const matchId of toDelete) {
        await deleteTrack(accessToken, matchId);
      }

      const driveStream = await getDriveStream(drive, file.id);
      const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name, fileSize: parseInt(file.size, 10) });
      await addTrackToPlaylist(accessToken, playlistId, track.id, Array.from(toDelete));
      await markSynced(state, file.id, track.id, file.modifiedTime, version, file.name, ext, baseTitle);
      await sendNotification(`🔄 Mix geüpdatet:\n${trackTitle}`);
      log(`  ✓ ${trackTitle} (ID: ${track.id}) [REPLACED]`);
    } else {
      // Bewaar metadata in state indien nog niet aanwezig
      if (!storedExt || !storedBaseTitle || !storedFilename) {
        await markSynced(state, file.id, storedTrackId, storedModified, storedVersion ?? version, file.name, ext, baseTitle);
      }
      log(`  [SKIPPED] ${trackTitle} - already synced`);
    }
    return;
  }

  // Bestand niet in state onder huidig file.id: controleer of het een vervangend bestand is
  if (isReplacementFile) {
    const oldExt = priorEntry?.ext || 'onbekend';
    log(`  [UPDATE] Vervangend bestand gedetecteerd voor ${baseTitle} (${oldExt} → ${ext}), oude track(s) worden vervangen...`);
    const toDelete = new Set([...matchingIds, ...(priorEntry?.scTrackId ? [priorEntry.scTrackId] : [])]);
    for (const matchId of toDelete) {
      await deleteTrack(accessToken, matchId);
    }

    await removeStateEntry(state, priorDriveId);

    const driveStream = await getDriveStream(drive, file.id);
    const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name, fileSize: parseInt(file.size, 10) });
    await addTrackToPlaylist(accessToken, playlistId, track.id, Array.from(toDelete));
    await markSynced(state, file.id, track.id, file.modifiedTime, version, file.name, ext, baseTitle);
    await sendNotification(`🔄 Mix geüpdatet:\n${trackTitle}`);
    log(`  ✓ ${trackTitle} (ID: ${track.id}) [REPLACED]`);
    return;
  }

  // Controleer of er een match is in de SoundCloud playlist
  const bestMatch = findBestTrackMatch(playlistTracks, baseTitle);
  const stateEntryForBestMatch = bestMatch ? findStateEntryByTrackId(state, bestMatch.id) : null;

  // Als de SoundCloud track gekoppeld was aan een ander Drive bestand in state
  if (bestMatch && stateEntryForBestMatch && stateEntryForBestMatch[0] !== file.id) {
    const [oldDriveId, oldEntry] = stateEntryForBestMatch;
    const oldExt = oldEntry?.ext || 'onbekend';
    log(`  [UPDATE] Nieuw bestand (${ext}) vervangt eerdere track voor ${baseTitle} (SoundCloud track ID: ${bestMatch.id}, ${oldExt}), oude track wordt vervangen...`);
    const toDelete = new Set([...matchingIds, bestMatch.id]);
    for (const matchId of toDelete) {
      await deleteTrack(accessToken, matchId);
    }
    await removeStateEntry(state, oldDriveId);

    const driveStream = await getDriveStream(drive, file.id);
    const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name, fileSize: parseInt(file.size, 10) });
    await addTrackToPlaylist(accessToken, playlistId, track.id, Array.from(toDelete));
    await markSynced(state, file.id, track.id, file.modifiedTime, version, file.name, ext, baseTitle);
    await sendNotification(`🔄 Mix geüpdatet:\n${trackTitle}`);
    log(`  ✓ ${trackTitle} (ID: ${track.id}) [REPLACED]`);
    return;
  }

  if (bestMatch) {
    log(`  [RECOVERY] SoundCloud track gevonden voor ${baseTitle} met versie v${bestMatch.version}`);

    if (bestMatch.version === version) {
      log(`  [RECOVERY] Lokale status hersteld voor ${trackTitle}. Geen upload nodig.`);
      await markSynced(state, file.id, bestMatch.id, file.modifiedTime, version, file.name, ext, baseTitle);
      return;
    } else {
      log(`  [RECOVERY-UPDATE] Versieverschil gedetecteerd voor ${baseTitle} (SoundCloud v${bestMatch.version} → Drive v${version}), oude track(s) worden verwijderd...`);
      for (const matchId of matchingIds) {
        await deleteTrack(accessToken, matchId);
      }

      const driveStream = await getDriveStream(drive, file.id);
      const track = await uploadTrack(accessToken, { trackTitle, artistName, driveStream, filename: file.name, fileSize: parseInt(file.size, 10) });
      await addTrackToPlaylist(accessToken, playlistId, track.id, matchingIds);
      await markSynced(state, file.id, track.id, file.modifiedTime, version, file.name, ext, baseTitle);
      await sendNotification(`🔄 Mix geüpdatet:\n${trackTitle}`);
      log(`  ✓ ${trackTitle} (ID: ${track.id}) [REPLACED]`);
      return;
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
  await markSynced(state, file.id, track.id, file.modifiedTime, version, file.name, ext, baseTitle);
  await sendNotification(`✅ Nieuwe mix:\n${trackTitle}`);
  log(`  ✓ ${trackTitle} (ID: ${track.id})`);
}
