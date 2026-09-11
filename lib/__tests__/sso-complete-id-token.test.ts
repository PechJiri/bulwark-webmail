import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  getCookieOptions: () => ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' }),
}));

const decryptPayload = vi.fn();
vi.mock('@/lib/auth/crypto', () => ({
  decryptPayload: (...args: unknown[]) => decryptPayload(...args),
}));

const exchangeCodeForTokens = vi.fn();
vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokens(...args),
  getRequiredConfig: vi.fn(),
  getTokenEndpoint: vi.fn(),
}));

class FakeCookies {
  store = new Map<string, string>();
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string) {
    this.store.set(name, value);
  }
  delete(name: string) {
    this.store.delete(name);
  }
}

let cookieStore: FakeCookies;
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

describe('server-side SSO completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore = new FakeCookies();
    cookieStore.set('sso_pending', 'encrypted-pending-state');
    decryptPayload.mockReturnValue({
      state: 'expected-state',
      code_verifier: 'pkce-verifier',
      redirect_uri: 'https://webmail.pechovic.cz/cs/auth/callback',
      created_at: Date.now(),
    });
    exchangeCodeForTokens.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      id_token: 'signed-keycloak-id-token',
      expires_in: 3600,
    });
  });

  it('stores the ID token required for the later RP-initiated logout', async () => {
    const { POST } = await import('@/app/api/auth/sso/complete/route');
    const request = {
      json: async () => ({ code: 'authorization-code', state: 'expected-state', slot: 0 }),
    } as Parameters<typeof POST>[0];

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(cookieStore.get('jmap_it')?.value).toBe('signed-keycloak-id-token');
  });

  it('identifies a missing transaction for fresh login without exchanging its code', async () => {
    cookieStore.delete('sso_pending');
    const { POST } = await import('@/app/api/auth/sso/complete/route');
    const response = await POST({
      json: async () => ({ code: 'old-code', state: 'expected-state' }),
    } as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: 'sso_session_missing' });
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(cookieStore.get('jmap_rt')).toBeUndefined();
  });

  it('identifies an expired transaction without extending its five-minute lifetime', async () => {
    decryptPayload.mockReturnValue({ state: 'expected-state', created_at: Date.now() - 300001 });
    const { POST } = await import('@/app/api/auth/sso/complete/route');
    const response = await POST({
      json: async () => ({ code: 'old-code', state: 'expected-state' }),
    } as Parameters<typeof POST>[0]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: 'sso_session_expired' });
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(cookieStore.get('sso_pending')).toBeUndefined();
  });

  it('does not classify a state mismatch as recoverable or exchange its code', async () => {
    const { POST } = await import('@/app/api/auth/sso/complete/route');
    const response = await POST({
      json: async () => ({ code: 'old-code', state: 'wrong-state' }),
    } as Parameters<typeof POST>[0]);
    expect(response.status).toBe(400);
    expect((await response.json()).error_code).toBeUndefined();
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });
});
