import type { RepoSummary } from '../shared/protocol';
import type { GitHub } from './client';
import { parseSsoHeader } from './sso';

const MAX_BRANCHES = 2000;

interface ApiRepo {
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
