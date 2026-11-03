import { computed, signal } from '@preact/signals';
import type {
  CoverageProgress, FixTask, HostMessage, PrPending, PrResult, PrStep, PrStepStatus, PrSubmission, RepoPlan, UiError,
} from '../shared/protocol';
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
/** Live state of the "Preparing fixes" screen, per repo, in the order repos start. */
export interface RepoFixProgress {
  repo: string;
  base: string;
  tasks: FixTask[];
  coverage?: CoverageProgress;
}
export const fixProgress = signal<RepoFixProgress[]>([]);
/** When the current preparing or PR-opening phase started, for the elapsed timer. */
export const phaseStartedAt = signal(0);

/** Live state of the "Opening pull requests" screen. */
export interface PrProgress extends PrPending {
  steps: Partial<Record<PrStep, { status: PrStepStatus; detail?: string }>>;
}
export const prProgress = signal<PrProgress[]>([]);
export const fixError = signal<UiError | undefined>(undefined);
export const fixRepos = signal<RepoPlan[]>([]);
export const branchPattern = signal('');
export const prEdits = signal<Record<string, PrEdit>>({});
export const prResults = signal<PrResult[]>([]);

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
  fixProgress.value = [];
  phaseStartedAt.value = Date.now();
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
    case 'fixEvent': {
      const e = m.event;
      if (e.kind === 'repo') {
        fixProgress.value = [...fixProgress.value.filter((r) => r.repo !== e.repo), { repo: e.repo, base: e.base, tasks: e.tasks, coverage: e.coverage }];
        return true;
      }
      fixProgress.value = fixProgress.value.map((r) => {
        if (r.repo !== e.repo) return r;
        const key = (t: FixTask) => `${t.section}:${t.id}`;
        const exists = r.tasks.some((t) => key(t) === key(e.task));
        // Replacement files aren't in the initial list; they're appended when they start.
        return { ...r, tasks: exists ? r.tasks.map((t) => (key(t) === key(e.task) ? e.task : t)) : [...r.tasks, e.task] };
      });
      return true;
    }
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
      prProgress.value = m.prs.map((p) => ({ ...p, steps: {} }));
      phaseStartedAt.value = Date.now();
      fixPhase.value = 'creating';
      return true;
    case 'prStep':
      prProgress.value = prProgress.value.map((p) => (p.id === m.id ? { ...p, steps: { ...p.steps, [m.step]: { status: m.status, detail: m.detail } } } : p));
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
