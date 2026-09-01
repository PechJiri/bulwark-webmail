import { describe, expect, it } from 'vitest';
import { buildEndSessionUrl } from '@/lib/oauth/logout';

describe('RP-initiated logout URL', () => {
  it('includes the client id and exact registered post-logout redirect', () => {
    const result = buildEndSessionUrl(
      'https://sso.pechovic.cz/realms/pechovic/protocol/openid-connect/logout',
      'family-bulwark',
      'https://webmail.pechovic.cz/cs/login',
      'signed-keycloak-id-token',
    );

    const url = new URL(result!);
    expect(url.searchParams.get('client_id')).toBe('family-bulwark');
    expect(url.searchParams.get('post_logout_redirect_uri'))
      .toBe('https://webmail.pechovic.cz/cs/login');
    expect(url.searchParams.get('id_token_hint')).toBe('signed-keycloak-id-token');
  });

  it('rejects non-HTTPS provider and return URLs', () => {
    expect(buildEndSessionUrl('http://idp.example/logout', 'client', 'https://mail.example/login'))
      .toBeUndefined();
    expect(buildEndSessionUrl('https://idp.example/logout', 'client', 'http://mail.example/login'))
      .toBeUndefined();
  });
});
