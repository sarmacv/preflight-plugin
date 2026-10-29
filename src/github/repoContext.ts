import type { GitHub } from './client';
import { RepoContext, type RepoFile, type ScanSettings } from '../engine/context';

/** Files larger than this are never downloaded; checks see them only in the tree. */
export const MAX_READ_BYTES = 1_000_000;

/** Subtrees fetched recursively when GitHub truncates the full tree. */
const TRUNCATED_FALLBACK_DIRS = ['.github', 'docs', '.circleci', 'charts', 'helm', 'terraform', 'infra', 'deploy'];

interface TreeEntry {
  path?: string;
  type?: string;
  size?: number;
  sha?: string;
}

const toFiles = (entries: TreeEntry[], prefix = ''): RepoFile[] =>
  entries.filter((e) => e.type === 'blob' && e.path).map((e) => ({ path: prefix + e.path!, size: e.size ?? 0 }));

/** Builds a scan context for repo@branch without cloning: one tree listing plus lazy blob reads. */
export async function createGitHubContext(
  gh: GitHub,
  fullName: string,
  branch: string,
  settings: ScanSettings,
  signal?: AbortSignal,
): Promise<RepoContext> {
  const [owner, repo] = fullName.split('/');
  const request = { signal };

  const [{ data: repoData }, { data: branchData }] = await Promise.all([
    gh.rest.repos.get({ owner, repo, request }),
    gh.rest.repos.getBranch({ owner, repo, branch, request }),
  ]);
  const sha = branchData.commit.sha;

  const { data: tree } = await gh.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: 'true', request });
  let files = toFiles(tree.tree);
  if (tree.truncated) files = await listTruncated(gh, owner, repo, sha, signal);

  const reader = async (path: string): Promise<string | undefined> => {
    const size = files.find((f) => f.path === path)?.size ?? 0;
    if (size > MAX_READ_BYTES) return undefined;
    try {
      const res = await gh.rest.repos.getContent({ owner, repo, path, ref: sha, mediaType: { format: 'raw' }, request });
      return typeof res.data === 'string' ? res.data : String(res.data);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return undefined;
      throw err;
    }
  };

  return new RepoContext(
    { owner, repo, ref: branch, sha, defaultBranch: repoData.default_branch, branchProtected: branchData.protected, private: repoData.private },
    files,
    reader,
    gh,
    settings,
    tree.truncated,
    signal,
  );
}

async function listTruncated(gh: GitHub, owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<RepoFile[]> {
  const { data: root } = await gh.rest.git.getTree({ owner, repo, tree_sha: sha, request: { signal } });
  const files = toFiles(root.tree);
  const dirs = root.tree.filter((e) => e.type === 'tree' && e.path && TRUNCATED_FALLBACK_DIRS.includes(e.path.toLowerCase()));
  for (const dir of dirs) {
    const { data: sub } = await gh.rest.git.getTree({ owner, repo, tree_sha: dir.sha!, recursive: 'true', request: { signal } });
    files.push(...toFiles(sub.tree, `${dir.path}/`));
  }
  return files;
}
