import { google } from 'googleapis';
import { getToken, setToken } from '../utils/tokenStore.js';

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

  return client;
}
