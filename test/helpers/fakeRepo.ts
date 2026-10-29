import type { GitHub } from '../../src/github/client';
import { DEFAULT_SETTINGS, RepoContext, type RepoInfo, type ScanSettings } from '../../src/engine/context';

export interface FakeGitHubHandlers {
  request?: (route: string, params: Record<string, unknown>) => unknown;
  graphql?: (query: string, vars: Record<string, unknown>) => unknown;
  getBranch?: (branch: string) => { protected: boolean };
  getBranchProtection?: (branch: string) => unknown;
}

export class HttpError extends Error {
  constructor(readonly status: number, message = `HTTP ${status}`) {
    super(message);
  }
}

/** Minimal stand-in for the Octokit surface the checks use. Unhandled calls fail loudly. */
export function fakeGitHub(h: FakeGitHubHandlers = {}): GitHub {
  const missing = (what: string) => () => {
    throw new Error(`unexpected GitHub call: ${what}`);
  };
  return {
    request: async (route: string, params: Record<string, unknown>) => {
      const data = await (h.request ?? missing(route))(route, params);
      return data === undefined ? { status: 202, data: '' } : { status: 200, data };
    },
    graphql: async (query: string, vars: Record<string, unknown>) => (h.graphql ?? missing('graphql'))(query, vars),
    rest: {
      repos: {
        getBranch: async ({ branch }: { branch: string }) => ({ data: (h.getBranch ?? missing('getBranch'))(branch) }),
        getBranchProtection: async ({ branch }: { branch: string }) => ({ data: (h.getBranchProtection ?? missing('getBranchProtection'))(branch) }),
      },
    },
  } as unknown as GitHub;
}

export function fakeRepo(
  files: Record<string, string>,
  opts: { info?: Partial<RepoInfo>; gh?: GitHub; settings?: Partial<ScanSettings>; signal?: AbortSignal } = {},
): RepoContext {
  const info: RepoInfo = { owner: 'acme', repo: 'api', ref: 'main', sha: 'abc123', defaultBranch: 'main', branchProtected: true, ...opts.info };
  return new RepoContext(
    info,
    Object.entries(files).map(([path, content]) => ({ path, size: content.length })),
    async (path) => files[path],
    opts.gh ?? fakeGitHub(),
    { ...DEFAULT_SETTINGS, ...opts.settings },
    false,
    opts.signal,
  );
}

const SBOM_URL = 'https://api.github.com/repos/acme/api/dependency-graph/sbom/fetch-report/u1';

/** Answers the async SBOM report flow: generate-report hands out a URL, which returns 202 once, then the report. */
export function sbomRoutes(packages: unknown[]): (route: string) => unknown {
  let polled = false;
  return (route) => {
    if (route.endsWith('/dependency-graph/sbom/generate-report')) return { sbom_url: SBOM_URL };
    if (route === `GET ${SBOM_URL}`) {
      if (!polled) {
        polled = true;
        return undefined;
      }
      return { sbom: { spdxVersion: 'SPDX-2.3', packages } };
    }
    return NOT_SBOM;
  };
}

/** Returned by sbomRoutes for routes it doesn't handle. */
export const NOT_SBOM = Symbol('not-sbom');
