// Creates a branch, one verified commit and a labelled PR entirely through the GitHub API.
import type { GitHub } from '../github/client';
import type { FileChange } from '../ai/provider';
import { resolveCollision } from './branchName';
import { PR_LABEL, type PrText } from './prBody';

export interface PrRequest {
  owner: string;
  repo: string;
  /** The branch that was scanned; the PR targets it. */
  base: string;
  /** Desired new branch name; a suffix is added if it already exists. */
  branch: string;
  changes: FileChange[];
  text: PrText;
  draft: boolean;
}

export interface PrOutcome {
  url: string;
  number: number;
  branch: string;
  /** Drafts aren't available on this plan, so a ready PR was opened with a [Draft] title. */
  draftFallback: boolean;
  labelApplied: boolean;
  labelWarning?: string;
}

const status = (err: unknown) => (err as { status?: number }).status;
const toBase64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export async function branchExists(gh: GitHub, owner: string, repo: string, branch: string): Promise<boolean> {
  try {
    await gh.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return true;
  } catch (err) {
    if (status(err) === 404) return false;
    throw err;
  }
}

export async function openPullRequest(gh: GitHub, req: PrRequest): Promise<PrOutcome> {
  const { owner, repo } = req;
  if (req.changes.length === 0) throw new Error('Nothing to commit');

  const { data: baseRef } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${req.base}` });
  const baseSha = baseRef.object.sha;

  // Never commit to the scanned or default branch: always a brand-new branch.
  const branch = await resolveCollision(req.branch, (b) => branchExists(gh, owner, repo, b));
  if (branch === req.base) throw new Error('Refusing to commit to the scanned branch');
  await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });

  try {
    // createCommitOnBranch produces a commit signed by GitHub, which satisfies "require signed commits" rules.
    await gh.graphql(
      `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }`,
      {
        input: {
          branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
          expectedHeadOid: baseSha,
          message: { headline: req.text.commitHeadline, body: req.text.commitBody },
          fileChanges: {
            additions: req.changes.filter((c) => c.content !== undefined).map((c) => ({ path: c.path, contents: toBase64(c.content!) })),
            deletions: req.changes.filter((c) => c.content === undefined).map((c) => ({ path: c.path })),
          },
        },
      },
    );
  } catch (err) {
    await gh.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` }).catch(() => undefined);
    throw err;
  }

  let draftFallback = false;
  let pr: { html_url: string; number: number };
  try {
    pr = (await gh.rest.pulls.create({ owner, repo, head: branch, base: req.base, title: req.text.title, body: req.text.body, draft: req.draft })).data;
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (!(req.draft && status(err) === 422 && /draft/i.test(message))) throw err;
    draftFallback = true;
    pr = (await gh.rest.pulls.create({ owner, repo, head: branch, base: req.base, title: `[Draft] ${req.text.title}`, body: req.text.body })).data;
  }

  const label = await applyLabel(gh, owner, repo, pr.number);
  return { url: pr.html_url, number: pr.number, branch, draftFallback, ...label };
}

async function applyLabel(gh: GitHub, owner: string, repo: string, issue: number): Promise<{ labelApplied: boolean; labelWarning?: string }> {
  try {
    try {
      await gh.rest.issues.getLabel({ owner, repo, name: PR_LABEL.name });
    } catch (err) {
      if (status(err) !== 404) throw err;
      try {
        await gh.rest.issues.createLabel({ owner, repo, ...PR_LABEL });
      } catch (createErr) {
        // Someone else created it in the meantime.
        if (status(createErr) !== 422) throw createErr;
      }
    }
    await gh.rest.issues.addLabels({ owner, repo, issue_number: issue, labels: [PR_LABEL.name] });
    return { labelApplied: true };
  } catch (err) {
    const why = status(err) === 403 || status(err) === 404 ? 'no permission to manage labels' : (err as Error).message;
    return { labelApplied: false, labelWarning: `The "${PR_LABEL.name}" label could not be applied: ${why}` };
  }
}
