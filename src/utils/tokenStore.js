import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = process.env.DATA_DIR || join(__dirname, '../../');
const TOKENS_PATH = join(basePath, '.tokens.json');

async function loadTokens() {
  try {
    const raw = await readFile(TOKENS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveTokens(tokens) {
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
}

export async function getToken(service) {
  const tokens = await loadTokens();
  return tokens[service] ?? null;
}

export async function setToken(service, tokenData) {
  const tokens = await loadTokens();
  tokens[service] = tokenData;
  await saveTokens(tokens);
}

export async function deleteToken(service) {
  const tokens = await loadTokens();
  if (tokens[service]) {
    delete tokens[service];
    await saveTokens(tokens);
  }
}
