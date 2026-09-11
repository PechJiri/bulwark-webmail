import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import OAuthCallbackPage from './page';

const mocks = vi.hoisted(() => ({
  login: vi.fn(), push: vi.fn(), replaceLocation: vi.fn(),
  error: 'sso_session_missing' as string | null,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useParams: () => ({ locale: 'cs' }),
  useSearchParams: () => new URLSearchParams('code=old-code&state=old-state'),
}));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: Object.assign(
    () => ({ loginWithOAuth: vi.fn(), loginWithServerSso: mocks.login }),
    { getState: () => ({ error: mocks.error }) },
  ),
}));
vi.mock('@/lib/browser-navigation', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/browser-navigation')>(),
  replaceWindowLocation: mocks.replaceLocation,
}));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.error = 'sso_session_missing';
  mocks.login.mockResolvedValue(false);
  window.history.replaceState({}, '', '/cs/auth/callback');
});
afterEach(() => { vi.restoreAllMocks(); });

it('starts fresh browser login instead of retrying a callback with no pending SSO transaction', async () => {
  render(<OAuthCallbackPage />);
  await waitFor(() => expect(mocks.replaceLocation).toHaveBeenCalledWith('/cs/login'));
  expect(mocks.login).toHaveBeenCalledTimes(1);
  expect(mocks.push).not.toHaveBeenCalled();
});

it('stops automatic recovery when the next callback fails too', async () => {
  sessionStorage.setItem('sso_recovery_attempted', '1');
  render(<OAuthCallbackPage />);
  expect(await screen.findByText('oauth_error.token_exchange_failed')).toBeVisible();
  expect(mocks.replaceLocation).not.toHaveBeenCalled();
});

it.each(['State mismatch', 'token_exchange_failed', null])('does not recover unrelated failure %s', async reason => {
  mocks.error = reason;
  render(<OAuthCallbackPage />);
  expect(await screen.findByText('oauth_error.token_exchange_failed')).toBeVisible();
  expect(mocks.replaceLocation).not.toHaveBeenCalled();
});

it('preserves add-account flow instead of falling back to the default login', async () => {
  sessionStorage.setItem('oauth_add_account_mode', '1');
  render(<OAuthCallbackPage />);
  expect(await screen.findByText('oauth_error.token_exchange_failed')).toBeVisible();
  expect(mocks.replaceLocation).not.toHaveBeenCalled();
});

it('clears the recovery guard after a successful SSO login and preserves the destination', async () => {
  sessionStorage.setItem('sso_recovery_attempted', '1');
  sessionStorage.setItem('redirect_after_login', '/cs/calendar?view=day');
  mocks.login.mockResolvedValue(true);
  render(<OAuthCallbackPage />);
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/cs/calendar?view=day'));
  expect(sessionStorage.getItem('sso_recovery_attempted')).toBeNull();
});

it('lets explicit Back to login start a new journey without replaying the callback', async () => {
  sessionStorage.setItem('sso_recovery_attempted', '1');
  render(<OAuthCallbackPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'oauth_error.back_to_login' }));
  expect(mocks.replaceLocation).toHaveBeenCalledWith('/cs/login');
  expect(sessionStorage.getItem('sso_recovery_attempted')).toBeNull();
});

it('recovers an expired transaction through the mount-prefixed login path', async () => {
  mocks.error = 'sso_session_expired';
  window.history.replaceState({}, '', '/webmail/cs/auth/callback');
  render(<OAuthCallbackPage />);
  await waitFor(() => expect(mocks.replaceLocation).toHaveBeenCalledWith('/webmail/cs/login'));
});

it('keeps the error screen if the loop guard cannot be persisted', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  render(<OAuthCallbackPage />);
  expect(await screen.findByText('oauth_error.token_exchange_failed')).toBeVisible();
  expect(mocks.replaceLocation).not.toHaveBeenCalled();
});
