import { getStoredTrackId, removeStateEntry } from '../utils/syncState.js';
import { removeTrackFromPlaylist, deleteTrack } from './soundCloudService.js';

/**
 * Removes SoundCloud tracks and state entries for Google Drive files that no longer exist.
 * @param {string} accessToken
 * @param {string|number} playlistId
 * @param {Object} state
 * @param {Set<string>} activeDriveIds
 * @param {Function} log
 */
export async function cleanupOrphanTracks(accessToken, playlistId, state, activeDriveIds, log = console.log) {
  log('\nStarten met opruimen van wees-tracks...');
  const stateKeys = Object.keys(state);
  let cleanupCount = 0;

  for (const driveFileId of stateKeys) {
    if (!state[driveFileId]) continue;
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
}
