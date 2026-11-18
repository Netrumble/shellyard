import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The browser side of authentication, driven with a fake page: address, storage, history,
// WebSocket and fetch are stand-ins, so every step of the token's life can be observed.

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  fail(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  static last(): FakeSocket {
    const s = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!s) throw new Error('no socket was opened');
    return s;
  }
}

type FetchMode = 'ok' | 'unauthorized' | 'network-error';

describe('token and connection in the browser', () => {
  let storage: Map<string, string>;
  let replaced: string[];
  let fetchMode: FetchMode;
  let fetchCalls: Array<{ url: string; token: string | undefined }>;

  function page(hash: string): void {
    vi.stubGlobal('location', { hash, pathname: '/', search: '', protocol: 'http:', host: '127.0.0.1:7717' });
  }

  async function start(): Promise<typeof import('../../src/web/store.js')> {
    const store = await import('../../src/web/store.js');
    store.startStore();
    return store;
  }

  /** Lets pending promises (the fetch and what follows it) settle. */
  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeSocket.instances = [];
    storage = new Map();
    replaced = [];
    fetchMode = 'ok';
    fetchCalls = [];
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url) });
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
      fetchCalls.push({ url, token: init?.headers?.['x-shellyard-token'] });
      if (fetchMode === 'network-error') throw new TypeError('Failed to fetch');
      if (fetchMode === 'unauthorized') return { ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'Unauthorized' }) };
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ profiles: [], models: [] }) };
    });
    page('');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('with no token at all, says so and opens no connection', async () => {
    const store = await start();
    expect(store.getState().connection).toBe('unauthorized');
    expect(FakeSocket.instances).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it('takes the token from the address, removes it from the address bar, and sends it explicitly', async () => {
    page('#token=fresh-token');
    await start();
    await settle();
    expect(replaced).toEqual(['/']);
    expect(FakeSocket.last().protocols).toEqual(['shellyard', 'shellyard-token.fresh-token']);
    expect(fetchCalls[0]).toEqual({ url: '/api/meta', token: 'fresh-token' });
  });

  it('keeps a token from the address only once the server has accepted it', async () => {
    page('#token=fresh-token');
    fetchMode = 'network-error';
    await start();
    await settle();
    expect(storage.get('shellyard-token')).toBeUndefined();
    fetchMode = 'ok';
    FakeSocket.last().open();
    await settle();
    expect(storage.get('shellyard-token')).toBe('fresh-token');
  });

  it('a token planted in the address by another page does not replace the stored one', async () => {
    storage.set('shellyard-token', 'good-token');
    page('#token=planted');
    fetchMode = 'unauthorized';
    const store = await start();
    await settle();
    expect(store.getState().connection).toBe('unauthorized');
    expect(storage.get('shellyard-token')).toBe('good-token');
  });

  it('uses the stored token on a later visit', async () => {
    storage.set('shellyard-token', 'stored-token');
    const store = await start();
    await settle();
    FakeSocket.last().open();
    expect(store.getState().connection).toBe('open');
    expect(fetchCalls[0]!.token).toBe('stored-token');
    expect(replaced).toEqual([]);
  });

  it('a stale token on load ends on the "run shellyard" state', async () => {
    storage.set('shellyard-token', 'stale-token');
    fetchMode = 'unauthorized';
    const store = await start();
    await settle();
    expect(store.getState().connection).toBe('unauthorized');
  });

  it('a tab that outlives a server restart is told to run shellyard, and stops retrying', async () => {
    storage.set('shellyard-token', 'old-token');
    const store = await start();
    await settle();
    FakeSocket.last().open();
    expect(store.getState().connection).toBe('open');

    // The server goes away: connections fail and so do API calls.
    fetchMode = 'network-error';
    FakeSocket.last().fail();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(8000);
      FakeSocket.last().fail();
    }
    await settle();
    expect(store.getState().connection).toBe('down');

    // A new server is up, with a new token: the handshake is refused, the API answers 401.
    fetchMode = 'unauthorized';
    await vi.advanceTimersByTimeAsync(8000);
    FakeSocket.last().fail();
    await settle();
    expect(store.getState().connection).toBe('unauthorized');

    const opened = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances.length).toBe(opened);
    expect(store.getState().connection).toBe('unauthorized');
  });

  it('a server that comes back with the same token is simply reconnected', async () => {
    storage.set('shellyard-token', 'token');
    const store = await start();
    await settle();
    FakeSocket.last().open();
    fetchMode = 'network-error';
    FakeSocket.last().fail();
    await settle();
    expect(store.getState().connection).toBe('reconnecting');
    fetchMode = 'ok';
    await vi.advanceTimersByTimeAsync(500);
    FakeSocket.last().open();
    await settle();
    expect(store.getState().connection).toBe('open');
  });
});
