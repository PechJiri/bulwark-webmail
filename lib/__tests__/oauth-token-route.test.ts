import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture status from NextResponse.json - this route's behavior is expressed
// almost entirely through status codes and cookie side effects.
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      json: async () => data,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/oauth/cookie-config', () => ({
  getCookieOptions: () => ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 2592000 }),
}));

const getTokenEndpoint = vi.fn();
const buildOAuthParams = vi.fn();
const exchangeCodeForTokens = vi.fn();
const getMetadata = vi.fn();
const getRequiredConfig = vi.fn();
vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokens(...args),
  buildOAuthParams: (...args: unknown[]) => buildOAuthParams(...args),
  getMetadata: (...args: unknown[]) => getMetadata(...args),
  getRequiredConfig: (...args: unknown[]) => getRequiredConfig(...args),
  getTokenEndpoint: (...args: unknown[]) => getTokenEndpoint(...args),
  DEFAULT_CLIENT_ID: 'bulwark-webmail',
}));

/** Minimal in-memory stand-in for the Next.js cookie store. */
class FakeCookies {
  store = new Map<string, string>();
  deleted: string[] = [];
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string, _opts?: unknown) {
    this.store.set(name, value);
  }
  delete(name: string) {
    this.deleted.push(name);
    this.store.delete(name);
  }
}

let cookieStore: FakeCookies;
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

function mockRequest(params: Record<string, string> = {}): unknown {
  return {
    nextUrl: { searchParams: { get: (k: string) => params[k] ?? null } },
  };
}

function mockJsonRequest(body: Record<string, unknown>, params: Record<string, string> = {}): unknown {
  return {
    ...mockRequest(params) as Record<string, unknown>,
    json: async () => body,
  };
}

async function callPut(params?: Record<string, string>) {
  const { PUT } = await import('@/app/api/auth/token/route');
  const res = (await PUT(mockRequest(params) as Parameters<typeof PUT>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

async function callPost(body: Record<string, unknown>, params?: Record<string, string>) {
  const { POST } = await import('@/app/api/auth/token/route');
  const res = (await POST(mockJsonRequest(body, params) as Parameters<typeof POST>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

async function callDelete(params?: Record<string, string>) {
  const { DELETE } = await import('@/app/api/auth/token/route');
  const res = (await DELETE(mockRequest(params) as Parameters<typeof DELETE>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

/** Seed the access-token cache cookie with a token expiring in `expiresIn` seconds. */
function seedCachedToken(token: string, expiresIn: number, name = 'jmap_at') {
  cookieStore.set(name, `${Math.floor(Date.now() / 1000) + expiresIn}.${token}`);
}

const fetchMock = vi.fn();

describe('oauth token route - access token cache (#552)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore = new FakeCookies();
    getTokenEndpoint.mockResolvedValue('https://auth.example.com/token');
    getMetadata.mockResolvedValue(null);
    getRequiredConfig.mockReturnValue({ clientId: 'family-bulwark' });
    buildOAuthParams.mockReturnValue(new URLSearchParams({ grant_type: 'refresh_token' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves the cached access token without contacting the IdP', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('cached-access-token', 1500);

    const { status, body } = await callPut();

    expect(status).toBe(200);
    expect(body.access_token).toBe('cached-access-token');
    // The whole point: no refresh is spent, so an nbf-gated IdP never sees an
    // early redemption attempt.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports remaining lifetime, not the original lifetime', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('cached-access-token', 900);

    const { body } = await callPut();

    // Client schedules its renewal off this value; handing back the full
    // lifetime would push the timer past the token's actual expiry.
    expect(body.expires_in as number).toBeGreaterThan(880);
    expect(body.expires_in as number).toBeLessThanOrEqual(900);
  });

  it('refreshes for real once the cached token is inside the renewal margin', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('nearly-expired', 30);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    const { status, body } = await callPut();

    expect(status).toBe(200);
    expect(body.access_token).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores an expired cached token', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('long-gone', -600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    const { body } = await callPut();

    expect(body.access_token).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when force=true', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('rejected-by-jmap', 1500);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    const { body } = await callPut({ force: 'true' });

    // A token the resource server rejected must not be handed back again.
    expect(body.access_token).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches the newly minted token after a real refresh', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    await callPut();

    expect(cookieStore.get('jmap_at')?.value).toMatch(/^\d+\.fresh-token$/);
  });

  it('preserves dots inside a JWT access token', async () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl';
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken(jwt, 1500);

    const { body } = await callPut();

    expect(body.access_token).toBe(jwt);
  });

  it('uses slot-scoped cache cookies', async () => {
    cookieStore.set('jmap_rt_2', 'refresh-token');
    seedCachedToken('slot-two-token', 1500, 'jmap_at_2');

    const { body } = await callPut({ slot: '2' });

    expect(body.access_token).toBe('slot-two-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops the cached token when the IdP definitively rejects the refresh', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    });

    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(401);
    expect(cookieStore.deleted).toContain('jmap_at');
    expect(cookieStore.deleted).toContain('jmap_rt');
  });

  it('keeps the cached token when the token endpoint is merely unavailable', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('still-good', 1500);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'upstream down',
    });

    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(503);
    // An outage must not cost the user their session.
    expect(cookieStore.deleted).not.toContain('jmap_at');
    expect(cookieStore.deleted).not.toContain('jmap_rt');
  });

  it('refreshes with the default client id fallback so TOTP sessions survive reloads (#873)', async () => {
    cookieStore.set('jmap_rt', 'totp-minted-refresh-token');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(200);
    // Tokens minted by the TOTP login route exist even when no OAuth client is
    // configured; the refresh must offer the same default client id instead of
    // failing on the missing OAUTH_CLIENT_ID.
    expect(getTokenEndpoint).toHaveBeenCalledWith(null, { fallbackClientId: 'bulwark-webmail' });
    expect(buildOAuthParams).toHaveBeenCalledWith(
      { grant_type: 'refresh_token', refresh_token: 'totp-minted-refresh-token' },
      null,
      { fallbackClientId: 'bulwark-webmail' },
    );
  });

  it('does not serve a cached token once the refresh token is gone', async () => {
    seedCachedToken('orphan-token', 1500);
    cookieStore.set('jmap_it', 'logout-hint');

    const { status } = await callPut();

    expect(status).toBe(401);
    expect(cookieStore.deleted).toContain('jmap_at');
    expect(cookieStore.get('jmap_it')?.value).toBe('logout-hint');
  });

  it('preserves the ID-token hint when refresh is rejected so provider logout can still finish', async () => {
    cookieStore.set('jmap_rt', 'rejected-refresh-token');
    cookieStore.set('jmap_it', 'logout-hint');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    });

    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(401);
    expect(cookieStore.get('jmap_it')?.value).toBe('logout-hint');
  });

  it('stores the ID token returned by the authorization-code exchange', async () => {
    exchangeCodeForTokens.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      id_token: 'signed-keycloak-id-token',
      expires_in: 3600,
    });

    const { status } = await callPost({
      code: 'authorization-code',
      code_verifier: 'pkce-verifier',
      redirect_uri: 'https://webmail.pechovic.cz/cs/auth/callback',
    });

    expect(status).toBe(200);
    expect(cookieStore.get('jmap_it')?.value).toBe('signed-keycloak-id-token');
  });

  it('updates the stored ID token when the provider returns one during refresh', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh-token',
        id_token: 'refreshed-keycloak-id-token',
        expires_in: 1800,
      }),
    });

    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(200);
    expect(cookieStore.get('jmap_it')?.value).toBe('refreshed-keycloak-id-token');
  });

  it('uses and deletes the stored ID token during RP-initiated logout', async () => {
    vi.stubEnv('OAUTH_POST_LOGOUT_REDIRECT_URI', 'https://webmail.pechovic.cz/cs/login');
    cookieStore.set('jmap_rt', 'refresh-token');
    cookieStore.set('jmap_it', 'signed-keycloak-id-token');
    getMetadata.mockResolvedValue({
      revocation_endpoint: 'https://sso.pechovic.cz/realms/pechovic/protocol/openid-connect/revoke',
      end_session_endpoint: 'https://sso.pechovic.cz/realms/pechovic/protocol/openid-connect/logout',
    });
    fetchMock.mockResolvedValue({ ok: true });

    const { status, body } = await callDelete();

    expect(status).toBe(200);
    const logoutUrl = new URL(body.end_session_url as string);
    expect(logoutUrl.searchParams.get('id_token_hint')).toBe('signed-keycloak-id-token');
    expect(cookieStore.deleted).toContain('jmap_it');
  });

  it('recovers an ID-token hint from the refresh token for sessions created before the fix', async () => {
    vi.stubEnv('OAUTH_POST_LOGOUT_REDIRECT_URI', 'https://webmail.pechovic.cz/cs/login');
    cookieStore.set('jmap_rt', 'pre-fix-refresh-token');
    getMetadata.mockResolvedValue({
      token_endpoint: 'https://sso.pechovic.cz/realms/pechovic/protocol/openid-connect/token',
      revocation_endpoint: 'https://sso.pechovic.cz/realms/pechovic/protocol/openid-connect/revoke',
      end_session_endpoint: 'https://sso.pechovic.cz/realms/pechovic/protocol/openid-connect/logout',
    });
    buildOAuthParams.mockImplementation((base: Record<string, string>) => new URLSearchParams(base));
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'unused-access-token',
          refresh_token: 'rotated-refresh-token',
          id_token: 'recovered-keycloak-id-token',
        }),
      })
      .mockResolvedValueOnce({ ok: true });

    const { status, body } = await callDelete();

    expect(status).toBe(200);
    const logoutUrl = new URL(body.end_session_url as string);
    expect(logoutUrl.searchParams.get('id_token_hint')).toBe('recovered-keycloak-id-token');
    expect(buildOAuthParams).toHaveBeenNthCalledWith(
      1,
      { grant_type: 'refresh_token', refresh_token: 'pre-fix-refresh-token' },
      null,
      { fallbackClientId: 'bulwark-webmail' },
    );
    expect(buildOAuthParams).toHaveBeenNthCalledWith(
      2,
      { token: 'rotated-refresh-token', token_type_hint: 'refresh_token' },
      null,
      { fallbackClientId: 'bulwark-webmail' },
    );
  });
});
