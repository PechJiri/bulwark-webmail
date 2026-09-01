import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/oauth/discovery', () => ({
  discoverOAuth: vi.fn(),
}));

vi.mock('@/lib/security/url-guard', () => ({
  isPublicHttpUrl: vi.fn(),
}));

vi.mock('@/lib/read-file-env', () => ({
  readFileEnv: () => '',
}));

// No admin config set - every lookup falls through to its default, so the
// env vars stubbed per-test are the only configuration source.
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    get: (_key: string, def: unknown) => def,
    ensureLoaded: async () => {},
  },
}));

import { discoverOAuth } from '@/lib/oauth/discovery';
import {
  getRequiredConfig,
  buildOAuthParams,
  exchangeCodeForTokens,
  DEFAULT_CLIENT_ID,
} from '@/lib/oauth/token-exchange';

describe('token-exchange client id fallback (#873)', () => {
  beforeEach(() => {
    vi.stubEnv('JMAP_SERVER_URL', 'https://mail.example.com');
    vi.stubEnv('OAUTH_CLIENT_ID', '');
    vi.stubEnv('OAUTH_ISSUER_URL', '');
    vi.stubEnv('OAUTH_CLIENT_SECRET', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('still fails loudly without a fallback so OAuth-initiating flows surface misconfiguration', () => {
    expect(() => getRequiredConfig(null)).toThrow(/OAUTH_CLIENT_ID/);
  });

  it('uses the fallback client id when no client is configured', () => {
    const config = getRequiredConfig(null, { fallbackClientId: DEFAULT_CLIENT_ID });
    expect(config.clientId).toBe('bulwark-webmail');
    // Discovery must target the mail server itself - that is where the TOTP
    // login route minted the token.
    expect(config.discoveryUrl).toBe('https://mail.example.com');
  });

  it('prefers a configured client id over the fallback', () => {
    vi.stubEnv('OAUTH_CLIENT_ID', 'configured-client');
    const config = getRequiredConfig(null, { fallbackClientId: DEFAULT_CLIENT_ID });
    expect(config.clientId).toBe('configured-client');
  });

  it('builds refresh params with the fallback client id', () => {
    const params = buildOAuthParams(
      { grant_type: 'refresh_token', refresh_token: 'rt' },
      null,
      { fallbackClientId: DEFAULT_CLIENT_ID },
    );
    expect(params.get('client_id')).toBe('bulwark-webmail');
    expect(params.get('grant_type')).toBe('refresh_token');
  });
});

describe('authorization-code token exchange', () => {
  beforeEach(() => {
    vi.stubEnv('JMAP_SERVER_URL', 'https://mail.example.com');
    vi.stubEnv('OAUTH_CLIENT_ID', 'family-bulwark');
    vi.stubEnv('OAUTH_ISSUER_URL', 'https://sso.pechovic.cz/realms/pechovic');
    vi.mocked(discoverOAuth).mockResolvedValue({
      issuer: 'https://sso.pechovic.cz/realms/pechovic',
      authorization_endpoint: 'https://sso.pechovic.cz/realms/pechovic/protocol/openid-connect/auth',
      token_endpoint: 'https://sso.pechovic.cz/realms/pechovic/protocol/openid-connect/token',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('preserves the ID token needed to terminate the matching browser SSO session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        id_token: 'signed-keycloak-id-token',
        expires_in: 3600,
      }),
    }));

    const tokens = await exchangeCodeForTokens(
      'authorization-code',
      'pkce-verifier',
      'https://webmail.pechovic.cz/cs/auth/callback',
    );

    expect(tokens.id_token).toBe('signed-keycloak-id-token');
  });
});
