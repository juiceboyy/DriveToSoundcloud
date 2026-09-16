/**
 * Parses raw filename (without extension) to extract clean title and explicit version.
 * Supports patterns like "- versie 2", "- v2", "(v2)", "(versie 2)", " v2", "_v2", etc.
 * @param {string} rawTitle - Filename without extension
 * @returns {{ cleanTitle: string, explicitVersion: number|null }}
 */
export function parseVersionAndCleanTitle(rawTitle) {
  const versionRegex = /(?:[\s_\-\.\(\[]+(?:versie|v)[\s\.]*(\d+)[\)\]]?)$/i;
  const match = rawTitle.match(versionRegex);
  if (match && match[1]) {
    const explicitVersion = parseInt(match[1], 10);
    const cleanTitle = rawTitle.slice(0, match.index).trim();
    return { cleanTitle, explicitVersion };
  }
  return { cleanTitle: rawTitle.trim(), explicitVersion: null };
}

import { getExtension } from '../services/driveService.js';

export const FORMAT_PRIORITIES = {
  '.wav': 30,
  '.aiff': 30,
  '.flac': 30,
  '.m4a': 10,
  '.aac': 10,
  '.mp3': 10,
};

/**
 * Compares two file info objects for the same baseTitle to decide which one is the active file.
 * 1. If explicit versions differ in filename (e.g. "Song - v2.mp3" vs "Song - v1.wav"), higher explicit version wins.
 * 2. If explicit versions are equal (or both absent), format quality priority wins (lossless .wav/.aiff/.flac > lossy .mp3/.m4a/.aac).
 * 3. If format quality is the same, recency in Drive (latest of createdTime or modifiedTime) wins.
 * 4. Fallback: version number.
 */
export function compareDriveFiles(a, b) {
  const aExplicit = a.explicitVersion !== null;
  const bExplicit = b.explicitVersion !== null;

  if (aExplicit && bExplicit) {
    if (b.explicitVersion !== a.explicitVersion) {
      return b.explicitVersion - a.explicitVersion;
    }
  } else if (aExplicit !== bExplicit) {
    const explicitInfo = aExplicit ? a : b;
    if (explicitInfo.explicitVersion > 1) {
      return aExplicit ? -1 : 1;
    }
  }

  // Quality / Format priority (e.g. .wav > .mp3)
  const extA = getExtension(a.file.name);
  const extB = getExtension(b.file.name);
  const priorityA = FORMAT_PRIORITIES[extA] ?? 0;
  const priorityB = FORMAT_PRIORITIES[extB] ?? 0;

  if (priorityB !== priorityA) {
    return priorityB - priorityA;
  }

  // Recency in Drive (latest timestamp between modifiedTime and createdTime)
  const timeA = Math.max(
    a.file.modifiedTime ? new Date(a.file.modifiedTime).getTime() : 0,
    a.file.createdTime ? new Date(a.file.createdTime).getTime() : 0
  );
  const timeB = Math.max(
    b.file.modifiedTime ? new Date(b.file.modifiedTime).getTime() : 0,
    b.file.createdTime ? new Date(b.file.createdTime).getTime() : 0
  );

  if (timeB !== timeA) {
    return timeB - timeA;
  }

  return b.version - a.version;
}

/**
 * Deduplicates audio files for a folder by baseTitle, retaining the best/highest version per track.
 * Prioritizes explicit versions, lossless audio formats (.wav > .mp3), and recency.
 * @param {Array} fileInfos - Array of { file, cleanTitle, baseTitle, explicitVersion, version }
 * @param {Function} log - Logger function
 * @returns {Array} Array of active fileInfos to process
 */
export function deduplicateDriveFiles(fileInfos, log = console.log) {
  const groups = new Map();
  for (const info of fileInfos) {
    if (!groups.has(info.baseTitle)) {
      groups.set(info.baseTitle, []);
    }
    groups.get(info.baseTitle).push(info);
  }

  const activeFiles = [];
  for (const [baseTitle, infos] of groups.entries()) {
    if (infos.length === 1) {
      activeFiles.push(infos[0]);
    } else {
      infos.sort(compareDriveFiles);

      const chosen = infos[0];

      // If the chosen file has no explicit version, inherit the highest version among duplicates
      // so replacing an mp3 (v8) with a newly uploaded wav does not downgrade the track version
      const maxVersionInGroup = Math.max(...infos.map(i => i.version));
      if (chosen.explicitVersion === null && maxVersionInGroup > chosen.version) {
        chosen.version = maxVersionInGroup;
      }

      activeFiles.push(chosen);

      for (let i = 1; i < infos.length; i++) {
        log(`  [DUBBEL-OVERSLAAN] ${infos[i].file.name} (v${infos[i].version}) overgeslagen in Drive ten gunste van versie v${chosen.version} (${chosen.file.name})`);
      }
    }
  }

  return activeFiles;
}
