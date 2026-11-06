/**
 * Validate and normalise a user-supplied API base URL.
 * - https only, except plain http to the loopback host (so a key is never sent in clear
 *   text over a network)
 * - no embedded credentials; query string and fragment are dropped
 * Returns null when the URL is not acceptable.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  if (!schemeOk || url.username || url.password) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
