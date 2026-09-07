// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MedplumClient } from './client';
import { ClientStorage, MemoryStorage } from './storage';
import { createFakeJwt } from './client-test-utils';
import { locationUtils } from './environment';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const tokens = {
  access_token: 'late-access',
  refresh_token: 'late-refresh',
  profile: { reference: 'Practitioner/old' },
  project: { reference: 'Project/test' },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session invalidation', () => {
  it.each([200, 400])('rejects a late refresh HTTP %s after local logout', async (status) => {
    const pending = deferred<Response>();
    const client = new MedplumClient({ storage: new ClientStorage(new MemoryStorage()), fetch: () => pending.promise });
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    const refreshing = client.refreshIfExpired();
    const rejected = expect(refreshing).rejects.toThrow('Session changed');
    client.clear();
    pending.resolve(response(status === 200 ? tokens : { error: 'invalid_grant' }, status));
    await rejected;
    expect(client.getAccessToken()).toBeUndefined();
    expect(client.getLogins()).toEqual([]);
    expect(client.getProfile()).toBeUndefined();
  });

  it.each([200, 400])('preserves a newer login after late refresh HTTP %s', async (status) => {
    const pending = deferred<Response>();
    const client = new MedplumClient({ storage: new ClientStorage(new MemoryStorage()), fetch: () => pending.promise });
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    const refreshing = client.refreshIfExpired();
    const rejected = expect(refreshing).rejects.toThrow('Session changed');
    client.clear();
    await client.setActiveLogin({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      profile: { reference: 'Practitioner/new' },
      project: { reference: 'Project/test' },
    });
    pending.resolve(response(status === 200 ? tokens : { error: 'invalid_grant' }, status));
    await rejected;
    expect(client.getAccessToken()).toBe('new-access');
    expect(client.getLogins()).toHaveLength(1);
    expect(client.getLogins()[0].accessToken).toBe('new-access');
  });

  it('rechecks invalidation after reading the token response body', async () => {
    const body = deferred<unknown>();
    const res = response({});
    vi.spyOn(res, 'json').mockReturnValue(body.promise);
    const client = new MedplumClient({ storage: new ClientStorage(new MemoryStorage()), fetch: async () => res });
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    const refreshing = client.refreshIfExpired();
    const rejected = expect(refreshing).rejects.toThrow('Session changed');
    await vi.waitFor(() => expect(res.json).toHaveBeenCalled());
    client.clear();
    body.resolve(tokens);
    await rejected;
    expect(client.getAccessToken()).toBeUndefined();
  });

  it('rejects refresh after another client clears the shared namespace without a storage event', async () => {
    const storage = new ClientStorage(new MemoryStorage());
    const pending = deferred<Response>();
    const client = new MedplumClient({ storage, fetch: () => pending.promise });
    const peer = new MedplumClient({ storage });
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    const refreshing = client.refreshIfExpired();
    const rejected = expect(refreshing).rejects.toThrow('Session changed');
    peer.clear();
    pending.resolve(response(tokens));
    await rejected;
    expect(storage.getObject('activeLogin')).toBeUndefined();
    expect(client.getLogins()).toEqual([]);
  });

  it('rejects queued refresh after peer logout before acquiring the Web Lock', async () => {
    const lock = deferred<undefined>();
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, run: () => unknown) => {
          await lock.promise;
          return run();
        },
      },
    });
    const storage = new ClientStorage(new MemoryStorage());
    const fetch = vi.fn(async () => response(tokens));
    const client = new MedplumClient({ storage, fetch });
    const peer = new MedplumClient({ storage });
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    const refreshing = client.refreshIfExpired();
    const rejected = expect(refreshing).rejects.toThrow('Session changed');
    peer.clear();
    lock.resolve(undefined);
    await rejected;
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([200, 401])(
    'rejects a late profile HTTP %s without restoring state or clearing a newer login',
    async (status) => {
      const pending = deferred<Response>();
      const client = new MedplumClient({
        storage: new ClientStorage(new MemoryStorage()),
        fetch: () => pending.promise,
      });
      const initializing = client.setActiveLogin({
        accessToken: createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, login_id: 'old-login' }),
        refreshToken: 'old-refresh',
        profile: { reference: 'Practitioner/old' },
        project: { reference: 'Project/test' },
      });
      const rejected = expect(initializing).rejects.toThrow('Session changed');
      await Promise.resolve();
      client.clear();
      await client.setActiveLogin({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        profile: { reference: 'Practitioner/new' },
        project: { reference: 'Project/test' },
      });
      pending.resolve(response({ profile: { resourceType: 'Practitioner', id: 'old' } }, status));
      await rejected;
      expect(client.getAccessToken()).toBe('new-access');
      expect(client.getProfile()).toBeUndefined();
    }
  );

  it('does not start stale work after a peer cleared storage while this client was suspended', async () => {
    const storage = new ClientStorage(new MemoryStorage());
    const fetch = vi.fn(async () => response(tokens));
    const client = new MedplumClient({ storage, fetch });
    const peer = new MedplumClient({ storage });
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    peer.clear();
    await expect(client.refreshIfExpired()).rejects.toThrow('Session changed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reuses the token a peer refreshed while queued on the Web Lock', async () => {
    let tail: Promise<unknown> = Promise.resolve();
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, run: () => unknown) => {
          const current = tail.then(run);
          tail = current.catch(() => {});
          return current;
        },
      },
    });
    const storage = new ClientStorage(new MemoryStorage());
    const refreshedToken = createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetch = vi.fn(async () => response({ ...tokens, access_token: refreshedToken }));
    const first = new MedplumClient({ storage, fetch });
    await first.setActiveLogin({
      accessToken: createFakeJwt({ exp: 1 }),
      refreshToken: 'old-refresh',
      profile: { reference: 'Practitioner/old' },
      project: { reference: 'Project/test' },
    });
    // A peer restoring credentials inherits the namespace version without starting a new login.
    const second = new MedplumClient({ storage, fetch });
    await Promise.all([first.refreshIfExpired(), second.refreshIfExpired()]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(first.getAccessToken()).toBe(refreshedToken);
    expect(second.getAccessToken()).toBe(refreshedToken);
  });

  it('bounds logout during refresh preflight and rejects the late token response', async () => {
    const pending = deferred<Response>();
    const client = new MedplumClient({ storage: new ClientStorage(new MemoryStorage()), fetch: () => pending.promise });
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    const abort = new AbortController();
    const logout = client.signOut({ signal: abort.signal });
    const refresh = client.refreshIfExpired().catch(() => {});
    const rejected = expect(logout).rejects.toThrow();
    abort.abort();
    await rejected;
    expect(client.getAccessToken()).toBeUndefined();
    pending.resolve(response(tokens));
    await refresh;
    expect(client.getAccessToken()).toBeUndefined();
    expect(client.getLogins()).toEqual([]);
  });

  it.each([200, 400])('an older logout HTTP %s cannot clear a newer login', async (status) => {
    const pending = deferred<Response>();
    const client = new MedplumClient({ storage: new ClientStorage(new MemoryStorage()), fetch: () => pending.promise });
    client.setAccessToken('old-access');
    const logout = client.signOut();
    const rejected = expect(logout).rejects.toThrow('Session changed');
    await Promise.resolve();
    await client.setActiveLogin({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      profile: { reference: 'Practitioner/new' },
      project: { reference: 'Project/test' },
    });
    pending.resolve(response({}, status));
    await rejected;
    expect(client.getAccessToken()).toBe('new-access');
    expect(client.getLogins()[0].accessToken).toBe('new-access');
  });

  it('aborted logout preserves a newer peer login and clears only the obsolete local client', async () => {
    const storage = new ClientStorage(new MemoryStorage());
    const pending = deferred<Response>();
    const client = new MedplumClient({ storage, fetch: () => pending.promise });
    const peer = new MedplumClient({ storage });
    client.setAccessToken('old-access');
    const abort = new AbortController();
    const logout = client.signOut({ signal: abort.signal });
    const rejected = expect(logout).rejects.toThrow();
    await peer.setActiveLogin({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      profile: { reference: 'Practitioner/new' },
      project: { reference: 'Project/test' },
    });
    abort.abort();
    await rejected;
    expect(client.getAccessToken()).toBeUndefined();
    expect(peer.getActiveLogin()?.accessToken).toBe('new-access');
    expect(peer.getLogins()).toHaveLength(1);
    pending.resolve(response({}));
    await Promise.resolve();
    expect(peer.getActiveLogin()?.accessToken).toBe('new-access');
  });

  it('clears local saved credentials after a rejected server logout', async () => {
    const client = new MedplumClient({
      storage: new ClientStorage(new MemoryStorage()),
      fetch: async () => response({}, 400),
    });
    await client.setActiveLogin({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      profile: { reference: 'Practitioner/old' },
      project: { reference: 'Project/test' },
    });
    await expect(client.signOut()).rejects.toThrow();
    expect(client.getAccessToken()).toBeUndefined();
    expect(client.getLogins()).toEqual([]);
  });

  it.each(['logout', 'replacement'])(
    'ignores historical credentials in a delayed storage event after %s',
    async (action) => {
      vi.spyOn(locationUtils, 'reload').mockImplementation(() => {});
      const storage = new ClientStorage(new MemoryStorage());
      const client = new MedplumClient({ storage });
      const oldLogin = {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        profile: { reference: 'Practitioner/same' },
        project: { reference: 'Project/test' },
      };
      await client.setActiveLogin(oldLogin);
      client.clear();
      if (action === 'replacement') {
        await client.setActiveLogin({ ...oldLogin, accessToken: 'new-access' });
      }
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: storage.makeKey('activeLogin'),
          oldValue: JSON.stringify(oldLogin),
          newValue: JSON.stringify({ ...oldLogin, accessToken: 'obsolete-rotation' }),
        })
      );
      expect(client.getAccessToken()).toBe(action === 'replacement' ? 'new-access' : undefined);
      expect(client.getActiveLogin()?.accessToken).toBe(action === 'replacement' ? 'new-access' : undefined);
    }
  );

  it('can request with a replacement peer login after its obsolete refresh rejects', async () => {
    vi.spyOn(locationUtils, 'reload').mockImplementation(() => {});
    const pending = deferred<Response>();
    const storage = new ClientStorage(new MemoryStorage());
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/oauth2/token') ? pending.promise : response({ resourceType: 'Patient', id: 'synthetic' })
    );
    const client = new MedplumClient({ storage, fetch });
    const oldLogin = {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      profile: { reference: 'Practitioner/same' },
      project: { reference: 'Project/test' },
    };
    await client.setActiveLogin(oldLogin);
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    const refreshing = client.refreshIfExpired();
    const rejected = expect(refreshing).rejects.toThrow('Session changed');
    const peer = new MedplumClient({ storage });
    const newLogin = { ...oldLogin, accessToken: 'new-access', refreshToken: 'new-refresh' };
    await peer.setActiveLogin(newLogin);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: storage.makeKey('activeLogin'),
        oldValue: JSON.stringify(oldLogin),
        newValue: JSON.stringify(newLogin),
      })
    );
    pending.resolve(response(tokens));
    await rejected;
    expect(client.getAccessToken()).toBe('new-access');
    expect((await client.readResource('Patient', 'synthetic')).id).toBe('synthetic');
  });

  it('restores the persisted version only after asynchronous storage initialization', async () => {
    const loaded = deferred<undefined>();
    const storage = Object.assign(new ClientStorage(new MemoryStorage()), { getInitPromise: () => loaded.promise });
    const client = new MedplumClient({ storage, fetch: async () => response({ resourceType: 'Patient', id: 'test' }) });
    storage.setString('sessionVersion', 'persisted-version');
    storage.setObject('activeLogin', {
      accessToken: createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      profile: { reference: 'Practitioner/old' },
      project: { reference: 'Project/test' },
    });
    loaded.resolve(undefined);
    await client.getInitPromise();
    expect((await client.readResource('Patient', 'test')).id).toBe('test');
  });

  it('clears saved credentials when logout refresh preflight fails', async () => {
    const client = new MedplumClient({
      storage: new ClientStorage(new MemoryStorage()),
      fetch: async () => response({ error: 'invalid_grant' }, 400),
    });
    await client.setActiveLogin({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      profile: { reference: 'Practitioner/old' },
      project: { reference: 'Project/test' },
    });
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    await expect(client.signOut()).rejects.toThrow();
    expect(client.getAccessToken()).toBeUndefined();
    expect(client.getActiveLogin()).toBeUndefined();
    expect(client.getLogins()).toEqual([]);
  });

  it('keeps normal refresh single-flight and persists the result', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn(() => pending.promise);
    const client = new MedplumClient({ storage: new ClientStorage(new MemoryStorage()), fetch });
    client.setAccessToken(createFakeJwt({ exp: 1 }), 'old-refresh');
    const first = client.refreshIfExpired();
    const second = client.refreshIfExpired();
    expect(first).toBe(second);
    pending.resolve(response(tokens));
    await first;
    expect(fetch).toHaveBeenCalledOnce();
    expect(client.getAccessToken()).toBe('late-access');
  });
});
