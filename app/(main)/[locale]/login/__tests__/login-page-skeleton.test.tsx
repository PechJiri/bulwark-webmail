import React from 'react';
import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Until /api/config answers (and in the server HTML, where it never has),
// the login page draws its card's skeleton instead of a spinner, the same
// one signed-out visitors of the app pages see first.

const loginState = vi.hoisted(() => ({
  loading: true,
  oauthOnly: false,
  autoSsoEnabled: false,
  loggedOut: false,
}));
const apiFetchMock = vi.hoisted(() => vi.fn(async (input: RequestInfo | URL) => {
  if (String(input) === '/api/auth/oauth/metadata') {
    return new Response(JSON.stringify({ authorization_endpoint: 'https://idp.example.org/auth' }));
  }
  if (String(input) === '/api/auth/sso/start') {
    return new Response(JSON.stringify({ authorize_url: 'https://idp.example.org/auth' }));
  }
  return new Response('{}');
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(loginState.loggedOut ? 'logged_out=1' : ''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({
    appName: 'Webmail',
    isLoading: loginState.loading,
    error: null,
    jmapServerUrl: 'https://mail.example.org',
    jmapServers: [],
    loginShowHeading: true,
    loginShowSubtitle: true,
    loginShowVersion: true,
    loginShowTotp: true,
    oauthEnabled: loginState.oauthOnly,
    oauthOnly: loginState.oauthOnly,
    autoSsoEnabled: loginState.autoSsoEnabled,
  }),
}));

// The provider's metadata never arrives in these tests.
vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  apiFetch: apiFetchMock,
}));

const { default: LoginPage } = await import('../page');

describe('login page while the config loads', () => {
  it('server-renders the card skeleton, not a spinner', () => {
    loginState.loading = true;
    const html = renderToString(<LoginPage />);
    expect(html).toContain('data-boot-skeleton="login"');
    expect(html).not.toContain('animate-spin');
  });

  it('keeps the skeleton on the client until the config is there', () => {
    loginState.loading = true;
    const { container } = render(<LoginPage />);
    const region = container.querySelector('[data-boot-skeleton="login"]');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('loading');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('draws the sign-in button\'s place while the provider is looked up, not a spinner', () => {
    loginState.loading = false;
    loginState.oauthOnly = true;
    try {
      const { container } = render(<LoginPage />);
      expect(container.querySelector('[data-boot-skeleton]')).toBeNull();
      expect(container.querySelector('.animate-spin')).toBeNull();
      expect(container.querySelector('.sk-shape.h-11')).not.toBeNull();
    } finally {
      loginState.oauthOnly = false;
    }
  });

  it('keeps explicit logout interactive when storage is unavailable, while normal login still starts SSO', async () => {
    loginState.loading = false;
    loginState.oauthOnly = true;
    loginState.autoSsoEnabled = true;
    loginState.loggedOut = true;
    const storageGet = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage) {
      if (this === sessionStorage) throw new Error('sessionStorage unavailable');
      return null;
    });
    try {
      render(<LoginPage />);
      await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/auth/oauth/metadata', expect.anything(),
      ));
      expect(apiFetchMock.mock.calls.some(([input]) => String(input) === '/api/auth/sso/start')).toBe(false);

      storageGet.mockRestore();
      loginState.loggedOut = false;
      apiFetchMock.mockClear();
      render(<LoginPage />);
      await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/auth/sso/start', expect.objectContaining({ method: 'POST' }),
      ));
    } finally {
      storageGet.mockRestore();
      loginState.loading = true;
      loginState.oauthOnly = false;
      loginState.autoSsoEnabled = false;
      loginState.loggedOut = false;
      apiFetchMock.mockClear();
    }
  }, 20_000);
});
