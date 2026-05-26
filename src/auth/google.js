import { google } from 'googleapis';
import { getToken, setToken, deleteToken } from '../utils/tokenStore.js';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function createClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

export function getAuthUrl() {
  const client = createClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

export async function handleCallback(code) {
  const client = createClient();
  const { tokens } = await client.getToken(code);
  await setToken('google', tokens);
  return tokens;
}

export async function getAuthenticatedClient() {
  const tokens = await getToken('google');
  if (!tokens) throw new Error('Google not authenticated — visit /auth/google first.');

  const client = createClient();
  client.setCredentials(tokens);

  // Persist refreshed tokens automatically
  client.on('tokens', async (refreshed) => {
    const current = await getToken('google');
    await setToken('google', { ...current, ...refreshed });
  });

  // Proactively check/refresh the access token to catch invalid_grant (expired/revoked refresh token)
  try {
    await client.getAccessToken();
  } catch (err) {
    if (err.message.includes('invalid_grant') || err.message.includes('invalid_client') || err.message.includes('revoked')) {
      await deleteToken('google');
      throw new Error('Google Drive credentials expired/revoked. Please visit /auth/google to re-authenticate.');
    }
    throw err;
  }

  return client;
}
