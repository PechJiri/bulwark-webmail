/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const values: Record<string, unknown> = {};

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => key in values ? values[key] : fallback),
    getPolicy: vi.fn(() => ({ features: {} })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { proxy } from '@/proxy';

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(values)) delete values[key];
  Object.assign(values, {
    oauthEnabled: true,
    oauthOnly: true,
    autoSsoEnabled: true,
    jmapServers: [],
  });
});

describe('proxy automatic SSO entrypoint', () => {
  it('redirects a clean localized login request before browser state can suppress SSO', async () => {
    const response = await proxy(new NextRequest('https://webmail.example.com/cs/login'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location'))
      .toBe('https://webmail.example.com/api/auth/sso/start?locale=cs&return=redirect');
  });

  it.each([
    '?logged_out=1',
    '?sso_error=failed',
    '?mode=add-account',
    '?mobile_redirect_uri=bulwarkmobile%3A%2F%2Fcallback',
  ])('keeps an explicit interactive login state on the page (%s)', async (query) => {
    const response = await proxy(new NextRequest(`https://webmail.example.com/cs/login${query}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});
