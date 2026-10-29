// GitHub signals SAML SSO gaps through the X-GitHub-SSO header:
//   "required; url=https://github.com/orgs/acme/sso?authorization_request=..."  (403 on an org resource)
//   "partial-results; organizations=21955855,20582480"                          (list omitted some orgs)

export type SsoHeader =
  | { kind: 'required'; url: string }
  | { kind: 'partial'; orgIds: number[] };

export function parseSsoHeader(value: string | undefined): SsoHeader | undefined {
  if (!value) return undefined;
  const [kind, rest = ''] = value.split(';').map((s) => s.trim());
  if (kind === 'required') {
    const url = rest.startsWith('url=') ? rest.slice(4) : '';
    return url ? { kind: 'required', url } : undefined;
  }
  if (kind === 'partial-results') {
    const ids = rest.startsWith('organizations=') ? rest.slice('organizations='.length) : '';
    const orgIds = ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return { kind: 'partial', orgIds };
  }
  return undefined;
}

export function orgSsoUrl(org: string): string {
  return `https://github.com/orgs/${encodeURIComponent(org)}/sso`;
}
