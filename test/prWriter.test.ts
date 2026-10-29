import { describe, expect, it } from 'vitest';
import type { GitHub } from '../src/github/client';
import { openPullRequest } from '../src/fix/prWriter';
import { buildPrText } from '../src/fix/prBody';
import { HttpError } from './helpers/fakeRepo';

interface Opts {
  existing?: string[];
  draftUnsupported?: boolean;
  labelMissing?: boolean;
  labelForbidden?: boolean;
  commitFails?: boolean;
}

function fakeWriter(o: Opts = {}) {
  const calls: string[] = [];
  const refs = new Set(['heads/main', ...(o.existing ?? []).map((b) => `heads/${b}`)]);
  let commitInput: Record<string, unknown> | undefined;
  const gh = {
    rest: {
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (!refs.has(ref)) throw new HttpError(404);
          return { data: { object: { sha: 'base-sha' } } };
        },
        createRef: async ({ ref, sha }: { ref: string; sha: string }) => {
          calls.push(`createRef ${ref} ${sha}`);
          refs.add(ref.replace('refs/', ''));
        },
        deleteRef: async ({ ref }: { ref: string }) => {
          calls.push(`deleteRef ${ref}`);
        },
      },
      pulls: {
        create: async (p: { draft?: boolean; title: string; base: string; head: string }) => {
          calls.push(`pr ${p.head}->${p.base} draft=${p.draft} ${p.title}`);
          if (p.draft && o.draftUnsupported) throw Object.assign(new HttpError(422, 'Draft pull requests are not supported in this repository.'));
          return { data: { html_url: 'https://github.com/acme/api/pull/7', number: 7 } };
        },
      },
      issues: {
        getLabel: async () => {
          if (o.labelForbidden) throw new HttpError(403);
          if (o.labelMissing) throw new HttpError(404);
        },
        createLabel: async (p: { name: string; color: string; description: string }) => {
          calls.push(`createLabel ${p.name} ${p.color} ${p.description}`);
        },
        addLabels: async (p: { labels: string[] }) => {
          calls.push(`addLabels ${p.labels.join(',')}`);
        },
      },
    },
    graphql: async (_q: string, vars: { input: Record<string, unknown> }) => {
      if (o.commitFails) throw new Error('Commit rejected by ruleset');
      commitInput = vars.input;
      calls.push('commit');
    },
  } as unknown as GitHub;
  return { gh, calls, commit: () => commitInput };
}

const req = (draft = false) => ({
  owner: 'acme',
  repo: 'api',
  base: 'main',
  branch: 'preflight/fixes/x',
  changes: [{ path: 'AGENTS.md', content: '# Hi' }, { path: 'old.txt', content: undefined }],
  text: buildPrText('fixes', [{ id: 'a', name: 'A', severity: 'high' }], ['AGENTS.md'], [], 'main'),
  draft,
});

describe('openPullRequest', () => {
  it('creates a new branch from the scanned branch, commits, opens the PR and labels it', async () => {
    const w = fakeWriter();
    const out = await openPullRequest(w.gh, req());
    expect(out).toMatchObject({ url: 'https://github.com/acme/api/pull/7', branch: 'preflight/fixes/x', labelApplied: true, draftFallback: false });
    expect(w.calls).toEqual(['createRef refs/heads/preflight/fixes/x base-sha', 'commit', 'pr preflight/fixes/x->main draft=false Preflight: A', 'addLabels preflight']);
    const input = w.commit() as { expectedHeadOid: string; fileChanges: { additions: { path: string; contents: string }[]; deletions: { path: string }[] } };
    expect(input.expectedHeadOid).toBe('base-sha');
    expect(input.fileChanges.additions).toEqual([{ path: 'AGENTS.md', contents: Buffer.from('# Hi').toString('base64') }]);
    expect(input.fileChanges.deletions).toEqual([{ path: 'old.txt' }]);
  });

  it('adds a suffix when the branch exists', async () => {
    const w = fakeWriter({ existing: ['preflight/fixes/x', 'preflight/fixes/x-2'] });
    expect((await openPullRequest(w.gh, req())).branch).toBe('preflight/fixes/x-3');
  });

  it('never commits to an existing branch, even one named like the base', async () => {
    const w = fakeWriter();
    const out = await openPullRequest(w.gh, { ...req(), branch: 'main' });
    expect(out.branch).toBe('main-2');
    expect(w.calls[0]).toBe('createRef refs/heads/main-2 base-sha');
  });

  it('creates the label when missing', async () => {
    const w = fakeWriter({ labelMissing: true });
    await openPullRequest(w.gh, req());
    expect(w.calls).toContain('createLabel preflight F58025 Opened by Preflight');
  });

  it('still opens the PR when the label cannot be applied', async () => {
    const w = fakeWriter({ labelForbidden: true });
    const out = await openPullRequest(w.gh, req());
    expect(out.url).toBeDefined();
    expect(out.labelApplied).toBe(false);
    expect(out.labelWarning).toMatch(/could not be applied: no permission/);
  });

  it('falls back to a [Draft] titled PR when drafts are unsupported', async () => {
    const w = fakeWriter({ draftUnsupported: true });
    const out = await openPullRequest(w.gh, req(true));
    expect(out.draftFallback).toBe(true);
    expect(w.calls.at(-2)).toBe('pr preflight/fixes/x->main draft=undefined [Draft] Preflight: A');
  });

  it('deletes the new branch when the commit fails', async () => {
    const w = fakeWriter({ commitFails: true });
    await expect(openPullRequest(w.gh, req())).rejects.toThrow('Commit rejected');
    expect(w.calls).toContain('deleteRef heads/preflight/fixes/x');
  });
});
