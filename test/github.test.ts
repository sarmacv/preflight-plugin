import { describe, expect, it } from 'vitest';
import { parseSsoHeader, orgSsoUrl } from '../src/github/sso';
import { readRateLimit } from '../src/github/rateLimit';
import { toRepoSummary } from '../src/github/repos';

describe('parseSsoHeader', () => {
  it('reads the authorisation URL from a required header', () => {
    expect(parseSsoHeader('required; url=https://github.com/orgs/acme/sso?authorization_request=abc')).toEqual({
      kind: 'required',
      url: 'https://github.com/orgs/acme/sso?authorization_request=abc',
    });
  });

  it('reads org ids from a partial-results header', () => {
    expect(parseSsoHeader('partial-results; organizations=21955855,20582480')).toEqual({ kind: 'partial', orgIds: [21955855, 20582480] });
  });

  it('ignores missing or unknown values', () => {
    expect(parseSsoHeader(undefined)).toBeUndefined();
    expect(parseSsoHeader('something-else')).toBeUndefined();
    expect(parseSsoHeader('required;')).toBeUndefined();
  });

  it('builds an org SSO URL', () => {
    expect(orgSsoUrl('acme corp')).toBe('https://github.com/orgs/acme%20corp/sso');
  });
});

describe('readRateLimit', () => {
  const h = (remaining: number, limit = 5000) => ({ 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-limit': String(limit), 'x-ratelimit-reset': '1700000000' });

  it('reports ok, low and waiting states', () => {
    expect(readRateLimit(h(4000))?.state).toBe('ok');
    expect(readRateLimit(h(100))?.state).toBe('low');
    expect(readRateLimit(h(4000), true)?.state).toBe('waiting');
  });

  it('returns undefined without rate-limit headers', () => {
    expect(readRateLimit({})).toBeUndefined();
  });
});

describe('toRepoSummary', () => {
  const base = { id: 1, full_name: 'acme/api', name: 'api', owner: { login: 'acme' }, private: true, default_branch: 'develop', pushed_at: null };

  it('maps API repos', () => {
    expect(toRepoSummary({ ...base, permissions: { push: true } })).toEqual({
      id: 1, fullName: 'acme/api', owner: 'acme', name: 'api', private: true, defaultBranch: 'develop', pushedAt: null, canPush: true,
    });
  });

  it('drops archived and disabled repos', () => {
    expect(toRepoSummary({ ...base, archived: true })).toBeUndefined();
    expect(toRepoSummary({ ...base, disabled: true })).toBeUndefined();
  });
});
