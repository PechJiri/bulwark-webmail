import { afterEach, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth-store';
import { useAccountStore } from './account-store';

afterEach(() => { vi.unstubAllGlobals(); });

it('preserves the SSO recovery reason at the auth-store boundary without authenticating', async () => {
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, error: null, client: null });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/auth/sso/complete') {
      return new Response(JSON.stringify({ error: 'No pending SSO session', error_code: 'sso_session_missing' }), { status: 400 });
    }
    if (String(input) === '/api/config') {
      return new Response(JSON.stringify({ jmapServerUrl: 'https://mail.example.invalid' }));
    }
    throw new Error('Unexpected network request');
  }));
  expect(await useAuthStore.getState().loginWithServerSso('old-code', 'old-state')).toBe(false);
  expect(useAuthStore.getState().error).toBe('sso_session_missing');
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(useAuthStore.getState().client).toBeNull();
});
