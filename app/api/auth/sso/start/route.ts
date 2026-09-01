import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { encryptPayload } from '@/lib/auth/crypto';
import { generateCodeVerifierServer, generateCodeChallengeServer, generateStateServer } from '@/lib/oauth/pkce-server';
import { getRequiredConfig, getDiscoveryValidator } from '@/lib/oauth/token-exchange';
import { discoverOAuth } from '@/lib/oauth/discovery';
import { getOauthScopes } from '@/lib/oauth/tokens';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { configManager } from '@/lib/admin/config-manager';
import { routing } from '@/i18n/routing';

const SSO_PENDING_COOKIE = 'sso_pending';
const SSO_PENDING_MAX_AGE = 300;
const MOBILE_REDIRECT_SCHEME = 'bulwarkmobile://';

interface StartSsoInput {
  redirectUri: string;
  locale?: string;
  serverId?: string | null;
  mobileRedirectUri?: string | null;
  mobileState?: string | null;
  purpose?: string | null;
  directRedirect?: boolean;
}

async function startSso(request: NextRequest, input: StartSsoInput): Promise<NextResponse> {
  if (!hasSessionSecret()) {
    return NextResponse.json({ error: 'SESSION_SECRET is required for SSO' }, { status: 500 });
  }

  const {
    redirectUri,
    locale,
    serverId = null,
    mobileRedirectUri = null,
    mobileState = null,
    purpose = null,
    directRedirect = false,
  } = input;
  const isReauth = purpose === 'reauth';

  if (mobileRedirectUri && !mobileRedirectUri.startsWith(MOBILE_REDIRECT_SCHEME)) {
    return NextResponse.json({ error: 'Invalid mobile_redirect_uri' }, { status: 400 });
  }

  const requestOrigin = request.headers.get('origin') || request.nextUrl.origin;
  try {
    const redirectOrigin = new URL(redirectUri).origin;
    if (redirectOrigin !== requestOrigin) {
      logger.warn('SSO start: redirect_uri origin mismatch', { redirectOrigin, requestOrigin });
      return NextResponse.json({ error: 'Invalid redirect_uri' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid redirect_uri' }, { status: 400 });
  }

  const { clientId, discoveryUrl } = getRequiredConfig(serverId);
  const metadata = await discoverOAuth(discoveryUrl, { validateEndpoint: getDiscoveryValidator() });
  if (!metadata?.authorization_endpoint) {
    return NextResponse.json({ error: 'OAuth discovery failed' }, { status: 502 });
  }

  const codeVerifier = generateCodeVerifierServer();
  const codeChallenge = generateCodeChallengeServer(codeVerifier);
  const state = generateStateServer();
  const pendingData = {
    state,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    created_at: Date.now(),
    ...(serverId ? { server_id: serverId } : {}),
    ...(mobileRedirectUri ? { mobile_redirect_uri: mobileRedirectUri } : {}),
    ...(mobileState ? { mobile_state: mobileState } : {}),
    ...(isReauth ? { purpose: 'reauth' } : {}),
  };

  const cookieStore = await cookies();
  cookieStore.set(SSO_PENDING_COOKIE, encryptPayload(pendingData), {
    ...getCookieOptions(),
    maxAge: SSO_PENDING_MAX_AGE,
  });

  const authorizeOverride =
    configManager.get<string>('oauthAuthorizeUrl', '') || process.env.OAUTH_AUTHORIZE_URL;
  const authUrl = new URL(authorizeOverride?.trim() || metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', getOauthScopes());
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (locale) authUrl.searchParams.set('ui_locales', locale);
  if (isReauth) {
    authUrl.searchParams.set('prompt', 'login');
    authUrl.searchParams.set('max_age', '0');
  }

  if (directRedirect) return NextResponse.redirect(authUrl);
  return NextResponse.json({ authorize_url: authUrl.toString(), state });
}

/** Browser entrypoint used by the proxy for deterministic automatic SSO. */
export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.get('return') !== 'redirect') {
      return NextResponse.json({ error: 'Invalid return mode' }, { status: 400 });
    }
    const locale = request.nextUrl.searchParams.get('locale') || '';
    if (!(routing.locales as readonly string[]).includes(locale)) {
      return NextResponse.json({ error: 'Invalid locale' }, { status: 400 });
    }

    return await startSso(request, {
      redirectUri: `${request.nextUrl.origin}/${locale}/auth/callback`,
      locale,
      directRedirect: true,
    });
  } catch (error) {
    logger.error('SSO start error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const {
      redirect_uri: redirectUri,
      locale,
      server_id: bodyServerId,
      mobile_redirect_uri: rawMobileRedirectUri,
      mobile_state: rawMobileState,
      purpose: rawPurpose,
    } = await request.json();

    if (!redirectUri || typeof redirectUri !== 'string') {
      return NextResponse.json({ error: 'Missing redirect_uri' }, { status: 400 });
    }

    return await startSso(request, {
      redirectUri,
      locale: typeof locale === 'string' ? locale : undefined,
      serverId: typeof bodyServerId === 'string' && bodyServerId ? bodyServerId : null,
      mobileRedirectUri:
        typeof rawMobileRedirectUri === 'string' && rawMobileRedirectUri ? rawMobileRedirectUri : null,
      mobileState: typeof rawMobileState === 'string' && rawMobileState ? rawMobileState : null,
      purpose: typeof rawPurpose === 'string' ? rawPurpose : null,
    });
  } catch (error) {
    logger.error('SSO start error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
