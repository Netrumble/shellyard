// The access token reaches the page in the fragment of its address (#token=…), which a
// browser never sends to any server. The page keeps it in localStorage, which is private to
// this exact origin (scheme, host and port), and sends it explicitly on each request.

const STORAGE_KEY = 'shellyard-token';

export interface LoadedToken {
  token: string;
  /** True when it came from the address and has not been stored yet. */
  fromAddress: boolean;
}

export function takeTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token');
  // Exactly what the server makes (32 random bytes as hex): anything else is not passed on.
  return token && /^[0-9a-f]{64}$/.test(token) ? token : null;
}

export function wsProtocols(token: string): string[] {
  return ['shellyard', `shellyard-token.${token}`];
}

/**
 * The token to use: a fresh one from the address if present (removed at once from the
 * address bar and the history entry), otherwise the one stored earlier. A token from the
 * address is not stored here: any page can open ours with a made-up token in the address,
 * and storing that would throw away the real one. It is stored once the server accepts it.
 */
export function loadToken(): LoadedToken | null {
  const fresh = takeTokenFromHash(location.hash);
  if (fresh) {
    history.replaceState(null, '', location.pathname + location.search);
    return { token: fresh, fromAddress: true };
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? { token: stored, fromAddress: false } : null;
  } catch {
    return null;
  }
}

export function rememberToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage can be unavailable (private mode); the token still works for this page load.
  }
}
