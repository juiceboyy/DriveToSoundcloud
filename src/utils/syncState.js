import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '../../.sync-state.json');

// Returns the full state map { driveFileId: soundcloudTrackId }
export async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function isSynced(state, driveFileId) {
  return Object.prototype.hasOwnProperty.call(state, driveFileId);
}

// Mutates state in-place and immediately flushes to disk
export async function markSynced(state, driveFileId, scTrackId) {
  state[driveFileId] = scTrackId;
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}
