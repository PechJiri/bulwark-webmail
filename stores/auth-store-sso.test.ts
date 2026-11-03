import { afterEach, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth-store';
import { useAccountStore } from './account-store';
import { createConfig } from '@/lib/__tests__/fixtures/config';

afterEach(() => { vi.unstubAllGlobals(); });

it.each(['sso_session_missing', 'sso_session_expired'])(
  'preserves safe recovery code %s at the auth-store boundary without authenticating', async (errorCode) => {
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, error: null, client: null });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/auth/sso/complete') {
      return new Response(JSON.stringify({ error: 'server detail must not escape', error_code: errorCode }), { status: 400 });
    }
    if (String(input) === '/api/config') {
      return new Response(JSON.stringify(createConfig({ jmapServerUrl: 'https://mail.example.invalid' })));
    }
    throw new Error('Unexpected network request');
  }));
  expect(await useAuthStore.getState().loginWithServerSso('old-code', 'old-state')).toBe(false);
  expect(useAuthStore.getState().error).toBe(errorCode);
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(useAuthStore.getState().client).toBeNull();
});

it('normalizes unrecognized SSO response codes before exposing them to UI state', async () => {
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, error: null, client: null });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/auth/sso/complete') {
      return new Response(JSON.stringify({ error: 'provider detail', error_code: 'arbitrary-untrusted-code' }), { status: 400 });
    }
    if (String(input) === '/api/config') return new Response(JSON.stringify(createConfig()));
    throw new Error('Unexpected network request');
  }));

  expect(await useAuthStore.getState().loginWithServerSso('code', 'state')).toBe(false);
  expect(useAuthStore.getState().error).toBe('token_exchange_failed');
});
