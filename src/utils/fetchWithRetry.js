/**
 * Fetch wrapper with exponential backoff and optional 401-refresh hook.
 * onUnauthorized(options) → refreshed options object, or null to abort retry.
 */
export async function fetchWithRetry(url, options = {}, { retries = 3, backoffMs = 500, onUnauthorized = null } = {}) {
  let currentOptions = { ...options };
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, currentOptions);

      if (response.status === 401 && onUnauthorized && attempt === 0) {
        const refreshed = await onUnauthorized(currentOptions);
        if (refreshed) {
          currentOptions = refreshed;
          continue;
        }
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${response.statusText}${body ? ` — ${body}` : ''}`);
      }

      return response;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, backoffMs * 2 ** attempt));
      }
    }
  }

  throw lastError;
}
