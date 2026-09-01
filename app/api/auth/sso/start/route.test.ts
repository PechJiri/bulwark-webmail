/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const cookieSet = vi.fn();

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: cookieSet })),
}));
vi.mock('@/lib/auth/session-secret', () => ({ hasSessionSecret: vi.fn(() => true) }));
vi.mock('@/lib/auth/crypto', () => ({ encryptPayload: vi.fn(() => 'encrypted-pending') }));
vi.mock('@/lib/oauth/pkce-server', () => ({
  generateCodeVerifierServer: vi.fn(() => 'verifier'),
  generateCodeChallengeServer: vi.fn(() => 'challenge'),
  generateStateServer: vi.fn(() => 'state'),
}));
vi.mock('@/lib/oauth/token-exchange', () => ({
  getRequiredConfig: vi.fn(() => ({
    clientId: 'family-bulwark',
    discoveryUrl: 'https://sso.example.com/realms/family/.well-known/openid-configuration',
  })),
  getDiscoveryValidator: vi.fn(() => undefined),
}));
vi.mock('@/lib/oauth/discovery', () => ({
  discoverOAuth: vi.fn(async () => ({
    authorization_endpoint: 'https://sso.example.com/realms/family/protocol/openid-connect/auth',
  })),
}));
vi.mock('@/lib/oauth/tokens', () => ({ getOauthScopes: vi.fn(() => 'openid email profile') }));
vi.mock('@/lib/oauth/cookie-config', () => ({
  getCookieOptions: vi.fn(() => ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { get: vi.fn((_key: string, fallback: unknown) => fallback) },
}));

import { GET } from './route';

describe('GET /api/auth/sso/start', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts browser SSO and redirects directly to the provider', async () => {
    const response = await GET(new NextRequest(
      'https://webmail.example.com/api/auth/sso/start?locale=cs&return=redirect',
    ));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(
      'https://sso.example.com/realms/family/protocol/openid-connect/auth',
    );
    expect(location.searchParams.get('client_id')).toBe('family-bulwark');
    expect(location.searchParams.get('redirect_uri')).toBe('https://webmail.example.com/cs/auth/callback');
    expect(location.searchParams.get('ui_locales')).toBe('cs');
    expect(cookieSet).toHaveBeenCalledWith('sso_pending', 'encrypted-pending', expect.objectContaining({
      httpOnly: true,
      maxAge: 300,
    }));
  });

  it('rejects unsupported locales', async () => {
    const response = await GET(new NextRequest(
      'https://webmail.example.com/api/auth/sso/start?locale=xx&return=redirect',
    ));

    expect(response.status).toBe(400);
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
