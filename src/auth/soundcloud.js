import { getToken, setToken } from '../utils/tokenStore.js';
import { fetchWithRetry } from '../utils/fetchWithRetry.js';

const AUTH_URL = 'https://soundcloud.com/connect';
const TOKEN_URL = 'https://api.soundcloud.com/oauth2/token';

export function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.SOUNDCLOUD_CLIENT_ID,
    redirect_uri: process.env.SOUNDCLOUD_REDIRECT_URI,
    response_type: 'code',
    scope: 'non-expiring',
  });
  return `${AUTH_URL}?${params}`;
}

async function exchangeToken(body) {
  const response = await fetchWithRetry(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body),
  });
  return response.json();
}

export async function handleCallback(code) {
  const tokens = await exchangeToken({
    client_id: process.env.SOUNDCLOUD_CLIENT_ID,
    client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
    redirect_uri: process.env.SOUNDCLOUD_REDIRECT_URI,
    grant_type: 'authorization_code',
    code,
  });

  await setToken('soundcloud', { ...tokens, obtained_at: Date.now() });
  return tokens;
}

export async function refreshAccessToken() {
  const current = await getToken('soundcloud');
  if (!current?.refresh_token) throw new Error('No SoundCloud refresh token stored.');

  const tokens = await exchangeToken({
    client_id: process.env.SOUNDCLOUD_CLIENT_ID,
    client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
  });

  const updated = { ...current, ...tokens, obtained_at: Date.now() };
  await setToken('soundcloud', updated);
  return updated;
}

export async function getAccessToken() {
  const tokens = await getToken('soundcloud');
  if (!tokens) throw new Error('SoundCloud not authenticated — visit /auth/soundcloud first.');

  // Non-expiring tokens have no expires_in; skip refresh if absent
  if (tokens.expires_in) {
    const expiresAt = tokens.obtained_at + tokens.expires_in * 1000;
    if (Date.now() > expiresAt - 60_000) {
      const refreshed = await refreshAccessToken();
      return refreshed.access_token;
    }
  }

  return tokens.access_token;
}
