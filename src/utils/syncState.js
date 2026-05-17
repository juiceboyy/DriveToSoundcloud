import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '../../.sync-state.json');

// State format: { driveFileId: { scTrackId: string, modifiedTime: string } }
// Legacy entries may be plain strings — handled gracefully below.

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

export function getStoredTrackId(state, driveFileId) {
  const entry = state[driveFileId];
  if (typeof entry === 'string') return entry; // legacy format
  return entry?.scTrackId ?? null;
}

export function getStoredModifiedTime(state, driveFileId) {
  const entry = state[driveFileId];
  if (!entry || typeof entry === 'string') return null;
  return entry.modifiedTime ?? null;
}

// Mutates state in-place and immediately flushes to disk
export async function markSynced(state, driveFileId, scTrackId, modifiedTime) {
  state[driveFileId] = { scTrackId, modifiedTime };
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}
