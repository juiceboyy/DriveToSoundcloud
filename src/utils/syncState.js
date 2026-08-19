import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = process.env.DATA_DIR || join(__dirname, '../../');
const STATE_PATH = join(basePath, '.sync-state.json');

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

export function getStoredVersion(state, driveFileId) {
  const entry = state[driveFileId];
  if (!entry || typeof entry === 'string') return null;
  return entry.version ?? null;
}

export function getStoredFilename(state, driveFileId) {
  const entry = state[driveFileId];
  if (!entry || typeof entry === 'string') return null;
  return entry.filename ?? null;
}

export function getStoredExt(state, driveFileId) {
  const entry = state[driveFileId];
  if (!entry || typeof entry === 'string') return null;
  return entry.ext ?? null;
}

export function getStoredBaseTitle(state, driveFileId) {
  const entry = state[driveFileId];
  if (!entry || typeof entry === 'string') return null;
  return entry.baseTitle ?? null;
}

/**
 * Finds an existing state entry matching the given baseTitle.
 * @param {Object} state
 * @param {string} baseTitle
 * @returns {[string, Object]|null} [driveFileId, entry] or null
 */
export function findStateEntryByBaseTitle(state, baseTitle) {
  if (!baseTitle) return null;
  for (const [id, entry] of Object.entries(state)) {
    if (typeof entry === 'object' && entry !== null && entry.baseTitle === baseTitle) {
      return [id, entry];
    }
  }
  return null;
}

/**
 * Finds an existing state entry matching the given scTrackId.
 * @param {Object} state
 * @param {string|number} scTrackId
 * @returns {[string, Object]|null} [driveFileId, entry] or null
 */
export function findStateEntryByTrackId(state, scTrackId) {
  if (!scTrackId) return null;
  const idStr = String(scTrackId);
  for (const [id, entry] of Object.entries(state)) {
    const entryTrackId = typeof entry === 'string' ? entry : entry?.scTrackId;
    if (entryTrackId && String(entryTrackId) === idStr) {
      return [id, entry];
    }
  }
  return null;
}

// Mutates state in-place and immediately flushes to disk
export async function markSynced(state, driveFileId, scTrackId, modifiedTime, version, filename, ext, baseTitle) {
  state[driveFileId] = {
    scTrackId,
    modifiedTime,
    version,
    ...(filename ? { filename } : {}),
    ...(ext ? { ext } : {}),
    ...(baseTitle ? { baseTitle } : {}),
  };
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

// Mutates state in-place by removing the entry and immediately flushes to disk
export async function removeStateEntry(state, driveFileId) {
  delete state[driveFileId];
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

