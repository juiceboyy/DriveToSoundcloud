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

/**
 * Deduplicates audio files for a folder by baseTitle, retaining only the highest version per track.
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
      // Sort by version descending, then modifiedTime descending
      infos.sort((a, b) => {
        if (b.version !== a.version) return b.version - a.version;
        const timeA = a.file.modifiedTime ? new Date(a.file.modifiedTime).getTime() : 0;
        const timeB = b.file.modifiedTime ? new Date(b.file.modifiedTime).getTime() : 0;
        return timeB - timeA;
      });

      const chosen = infos[0];
      activeFiles.push(chosen);

      for (let i = 1; i < infos.length; i++) {
        log(`  [DUBBEL-OVERSLAAN] ${infos[i].file.name} (v${infos[i].version}) overgeslagen in Drive ten gunste van versie v${chosen.version} (${chosen.file.name})`);
      }
    }
  }

  return activeFiles;
}
