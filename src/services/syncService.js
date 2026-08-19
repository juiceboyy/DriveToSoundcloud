import 'dotenv/config';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import { getAuthenticatedClient } from '../auth/google.js';
import { getAccessToken } from '../auth/soundcloud.js';
import { fetchWithRetry } from '../utils/fetchWithRetry.js';
import { loadState } from '../utils/syncState.js';
import {
  getExtension,
  findDriveFolder,
  listSubfolders,
  findBouncesFolder,
  listAudioFiles,
} from './driveService.js';
import {
  PLAYLIST_NAME,
  SC_BASE,
  scHeaders,
  ensurePlaylist,
} from './soundCloudService.js';
import { parseVersionAndCleanTitle, deduplicateDriveFiles } from '../utils/versionUtils.js';
import { syncTrack } from './trackSyncService.js';
import { cleanupOrphanTracks } from './cleanupService.js';

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
      activeDriveIds.add(info.file.id);
      await syncTrack({
        drive,
        accessToken,
        playlistId,
        playlistTracks,
        state,
        info,
        artistName,
        log,
      });
    }
  }

  // ── Opruimfase voor verwijderde/vervangen bestanden ───────────────────────
  await cleanupOrphanTracks(accessToken, playlistId, state, activeDriveIds, log);

  log('\nSync complete.');
}

// Run directly via: npm run sync
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sync().catch(err => { console.error(err.message); process.exit(1); });
}
