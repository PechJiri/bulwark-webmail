/** Build a standards-based RP-initiated logout URL from trusted configuration. */
export function buildEndSessionUrl(
  endpoint: string,
  clientId: string,
  postLogoutRedirectUri: string,
  idTokenHint?: string,
): string | undefined {
  try {
    const url = new URL(endpoint);
    const redirect = new URL(postLogoutRedirectUri);
    if (url.protocol !== 'https:' || redirect.protocol !== 'https:' || !clientId) return undefined;
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('post_logout_redirect_uri', redirect.href);
    if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
    return url.href;
  } catch {
    return undefined;
  }
}
