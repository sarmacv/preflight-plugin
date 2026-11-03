import type { RepoSummary } from '../shared/protocol';
import type { GitHub } from './client';
import { parseSsoHeader } from './sso';

const MAX_BRANCHES = 2000;

export interface ApiRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  archived?: boolean;
  disabled?: boolean;
  default_branch?: string;
  pushed_at?: string | null;
  permissions?: { push?: boolean; admin?: boolean };
}

/** Archived and disabled repos are dropped: they can't be scanned usefully or receive PRs. */
export function toRepoSummary(r: ApiRepo): RepoSummary | undefined {
  if (r.archived || r.disabled) return undefined;
  return {
    id: r.id,
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch ?? 'main',
    pushedAt: r.pushed_at ?? null,
    canPush: Boolean(r.permissions?.push || r.permissions?.admin),
  };
}

export interface RepoPage {
  repos: RepoSummary[];
  /** Org ids GitHub left out because the token isn't SSO-authorised for them. */
  ssoPartialOrgIds: number[];
  /** Org logins that restrict third-party apps and haven't approved VS Code's sign-in. */
  restrictedOrgs?: string[];
}

const status = (err: unknown) => (err as { status?: number }).status;

/** GitHub's wording when an org's OAuth App access restrictions block a request. */
export function isAppRestriction(err: unknown): boolean {
  return status(err) === 403 && /OAuth App access restrictions|third-parties is limited/i.test((err as Error).message ?? '');
}

/**
 * Everything the user can see: their own listing, then each org's listing (which can include repos the
 * user listing misses, such as internal repos), de-duplicated. Orgs that block VS Code's sign-in are
 * reported rather than failing the whole load.
 */
export async function* listAllRepos(gh: GitHub, orgs: string[], signal?: AbortSignal): AsyncGenerator<RepoPage> {
  const seen = new Set<number>();
  const fresh = (repos: RepoSummary[]) => repos.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
  for await (const page of listRepos(gh, signal)) yield { ...page, repos: fresh(page.repos) };

  for (const org of orgs) {
    if (signal?.aborted) return;
    try {
      for await (const page of gh.paginate.iterator(gh.rest.repos.listForOrg, { org, type: 'all', per_page: 100, request: { signal } })) {
        const repos = fresh((page.data as ApiRepo[]).map(toRepoSummary).filter((r): r is RepoSummary => r !== undefined));
        if (repos.length) yield { repos, ssoPartialOrgIds: [] };
      }
      // Restricted orgs still list their public repos, so ask for something private to find out.
      await gh.request('GET /orgs/{org}/teams', { org, per_page: 1, request: { signal } });
    } catch (err) {
      if (signal?.aborted) return;
      if (isAppRestriction(err)) yield { repos: [], ssoPartialOrgIds: [], restrictedOrgs: [org] };
      // Other failures (SSO, no permission to list teams) leave what was listed in place.
    }
  }
}

export async function* listRepos(gh: GitHub, signal?: AbortSignal): AsyncGenerator<RepoPage> {
  const pages = gh.paginate.iterator(gh.rest.repos.listForAuthenticatedUser, {
    per_page: 100,
    affiliation: 'owner,collaborator,organization_member',
    sort: 'full_name',
    request: { signal },
  });
  for await (const page of pages) {
    const sso = parseSsoHeader(page.headers['x-github-sso'] as string | undefined);
    yield {
      repos: (page.data as ApiRepo[]).map(toRepoSummary).filter((r): r is RepoSummary => r !== undefined),
      ssoPartialOrgIds: sso?.kind === 'partial' ? sso.orgIds : [],
    };
  }
}

export async function listBranches(gh: GitHub, fullName: string): Promise<string[]> {
  const [owner, repo] = fullName.split('/');
  const names: string[] = [];
  for await (const page of gh.paginate.iterator(gh.rest.repos.listBranches, { owner, repo, per_page: 100 })) {
    names.push(...page.data.map((b) => b.name));
    if (names.length >= MAX_BRANCHES) break;
  }
  return names;
}
