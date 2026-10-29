import { computed, signal } from '@preact/signals';
import type { HostMessage, PrResult, PrSubmission, RepoPlan, UiError } from '../shared/protocol';
import { validateBranchName } from '../fix/branchName';
import { canScan, provider, runs, scanning } from './store';
import { post } from './vscode';

export type FixPhase = 'idle' | 'preparing' | 'review' | 'confirming' | 'creating' | 'done' | 'error';

export interface PrEdit {
  include: boolean;
  branch: string;
  files: Record<string, { include: boolean; content?: string }>;
}

export const fixPhase = signal<FixPhase>('idle');
export const fixLabel = signal('');
export const fixError = signal<UiError | undefined>(undefined);
export const fixRepos = signal<RepoPlan[]>([]);
export const branchPattern = signal('');
export const prEdits = signal<Record<string, PrEdit>>({});
export const prResults = signal<PrResult[]>([]);
export const prTotal = signal(0);

export const hasFixable = computed(() =>
  runs.value.some((r) => r.status === 'done' && Object.values(r.results).some((x) => x.status === 'fail' && x.fixable)),
);

export const canFix = computed(() => hasFixable.value && !scanning.value && fixPhase.value === 'idle');

export function branchProblem(id: string): string | undefined {
  const e = prEdits.value[id];
  return e ? validateBranchName(e.branch.trim(), branchPattern.value || undefined) : undefined;
}

export const submissions = computed<PrSubmission[]>(() => {
  const out: PrSubmission[] = [];
  for (const repo of fixRepos.value) {
    for (const pr of repo.prs) {
      const e = prEdits.value[pr.id];
      if (!e?.include) continue;
      const files = pr.files
        .filter((f) => e.files[f.path]?.include)
        .map((f) => ({ path: f.path, content: e.files[f.path]?.content ?? f.after }));
      if (files.length) out.push({ id: pr.id, repo: repo.repo, kind: pr.kind, branch: e.branch.trim(), files });
    }
  }
  return out;
});

export const canCreate = computed(
  () => fixPhase.value === 'review' && submissions.value.length > 0 && submissions.value.every((s) => !branchProblem(s.id)),
);

/** Exactly one prominent control at a time. */
export const primaryAction = computed<'createPrs' | 'fix' | 'scan' | undefined>(() => {
  if (fixPhase.value === 'review') return 'createPrs';
  if (fixPhase.value !== 'idle') return undefined;
  if (canFix.value) return 'fix';
  if (canScan.value) return 'scan';
  return undefined;
});

/** Fix every scanned repo, or just the given ones (the Fix button on a repo card). */
export function prepareFixes(repos?: string[]): void {
  if (!canFix.value) return;
  fixPhase.value = 'preparing';
  fixLabel.value = '';
  fixError.value = undefined;
  prResults.value = [];
  post({ type: 'prepareFixes', provider: provider.value, repos });
}

export function closeFixes(): void {
  if (fixPhase.value === 'preparing') post({ type: 'cancelFixes' });
  if (fixPhase.value === 'creating' || fixPhase.value === 'confirming') return;
  fixPhase.value = 'idle';
  fixRepos.value = [];
  prEdits.value = {};
  fixError.value = undefined;
}

export function createPrs(): void {
  if (!canCreate.value) return;
  fixPhase.value = 'confirming';
  fixError.value = undefined;
  post({ type: 'createPrs', prs: submissions.value });
}

export function updateEdit(id: string, fn: (e: PrEdit) => PrEdit): void {
  const e = prEdits.value[id];
  if (e) prEdits.value = { ...prEdits.value, [id]: fn(e) };
}

export function handleFixMessage(m: HostMessage): boolean {
  switch (m.type) {
    case 'fixProgress':
      fixLabel.value = m.label;
      return true;
    case 'fixPlan': {
      fixRepos.value = m.repos;
      branchPattern.value = m.branchPattern;
      const edits: Record<string, PrEdit> = {};
      for (const repo of m.repos) {
        for (const pr of repo.prs) {
          edits[pr.id] = { include: true, branch: pr.branch, files: Object.fromEntries(pr.files.map((f) => [f.path, { include: true }])) };
        }
      }
      prEdits.value = edits;
      fixPhase.value = 'review';
      return true;
    }
    case 'fixError':
      fixError.value = m.error;
      fixPhase.value = fixRepos.value.length ? 'review' : 'error';
      return true;
    case 'prCreating':
      prTotal.value = m.total;
      fixPhase.value = 'creating';
      return true;
    case 'prResults':
      prResults.value = m.results;
      fixPhase.value = 'done';
      return true;
    case 'prCancelled':
      fixPhase.value = 'review';
      return true;
    default:
      return false;
  }
}
