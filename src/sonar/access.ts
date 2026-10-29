import type { RepoContext, SonarAccess } from '../engine/context';
import { projectKeyFromProperties, SonarClient, SonarError, type FileCoverage } from './client';

export interface ProjectKeyStore {
  get(repo: string): string | undefined;
  set(repo: string, key: string): Thenable<void> | void;
}

export interface SonarLink extends SonarAccess {
  client: SonarClient;
  resolveKey(ctx: RepoContext): Promise<string | undefined>;
  lowestCoverage(ctx: RepoContext, limit: number): Promise<{ projectKey: string; files: FileCoverage[] } | undefined>;
}

/**
 * Finds a repo's Sonar project by (1) sonar-project.properties, (2) a remembered choice, (3) the repo
 * name as the project key, (4) asking the user to pick one.
 */
export function createSonarLink(
  client: SonarClient,
  store: ProjectKeyStore,
  pick: (repo: string, client: SonarClient) => Promise<string | undefined>,
): SonarLink {
  const resolved = new Map<string, Promise<string | undefined>>();

  async function find(ctx: RepoContext): Promise<string | undefined> {
    const fromFile = projectKeyFromProperties(await ctx.read('sonar-project.properties'));
    if (fromFile && (await client.projectExists(fromFile, ctx.signal))) return fromFile;
    const remembered = store.get(ctx.fullName);
    if (remembered) return remembered;
    for (const candidate of [ctx.info.repo, `${ctx.info.owner}_${ctx.info.repo}`, `${ctx.info.owner}:${ctx.info.repo}`]) {
      if (await client.projectExists(candidate, ctx.signal)) return candidate;
    }
    const picked = await pick(ctx.fullName, client);
    if (picked) await store.set(ctx.fullName, picked);
    return picked;
  }

  const resolveKey = (ctx: RepoContext) => {
    let p = resolved.get(ctx.fullName);
    if (!p) {
      p = find(ctx);
      resolved.set(ctx.fullName, p);
    }
    return p;
  };

  const branchParam = (ctx: RepoContext) => (ctx.isDefaultBranch ? undefined : ctx.info.ref);

  return {
    client,
    resolveKey,
    async coverage(ctx) {
      const key = await resolveKey(ctx);
      if (!key) return undefined;
      let value: number | undefined;
      try {
        value = await client.coverage(key, branchParam(ctx), ctx.signal);
      } catch (err) {
        // Community Edition has no branch analysis; fall back to the main branch only for the default branch.
        if (err instanceof SonarError && err.status === 404 && branchParam(ctx)) {
          throw new SonarError(404, `Branch ${ctx.info.ref} has not been analysed in Sonar project ${key}`);
        }
        throw err;
      }
      return { projectKey: key, coverage: value, url: client.projectUrl(key, branchParam(ctx)) };
    },
    async lowestCoverage(ctx, limit) {
      const key = await resolveKey(ctx);
      if (!key) return undefined;
      return { projectKey: key, files: await client.lowestCoverage(key, branchParam(ctx), limit, ctx.signal) };
    },
  };
}
