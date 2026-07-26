export const MIME_TYPES = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aiff': 'audio/aiff',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

export const AUDIO_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

export function getExtension(filename) {
  const idx = filename.lastIndexOf('.');
  return idx !== -1 ? filename.slice(idx).toLowerCase() : '';
}

export async function findDriveFolder(drive, name) {
  const { data } = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });
  const [folder] = data.files;
  if (!folder) throw new Error(`Drive folder "${name}" not found.`);
  return folder;
}

export async function listSubfolders(drive, parentId) {
  const { data } = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    orderBy: 'name',
  });
  return data.files;
}

export async function findBouncesFolder(drive, parentId) {
  const { data } = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='Bounces' and trashed=false`,
    fields: 'files(id)',
    pageSize: 1,
  });
  return data.files[0] ?? null;
}

export async function listAudioFiles(drive, folderId) {
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, size, createdTime, modifiedTime, version)',
    orderBy: 'name',
  });
  return data.files.filter(f => {
    if (!AUDIO_EXTENSIONS.has(getExtension(f.name))) return false;
    const year = (d) => new Date(d).getFullYear();
    // Skip files not touched in 2026 or later
    return year(f.createdTime) >= 2026 || year(f.modifiedTime) >= 2026;
  });
}

export async function getDriveStream(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' },
  );
  return res.data; // Node.js Readable — never buffered
}
