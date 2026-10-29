import * as vscode from 'vscode';
import type { GitHub } from '../github/client';
import type { HostMessage, PrResult, PrSubmission, ProviderId } from '../shared/protocol';
import type { Skill } from '../skills/types';
import type { SonarLink } from '../sonar/access';
import { createProvider } from '../ai/lmProvider';
import { isSafeRepoPath } from '../ai/provider';
import { describeError } from '../auth/github';
import { planRepoFixes, type PlanPr, type RepoPlan } from '../fix/planner';
import { validateBranchName } from '../fix/branchName';
import { buildPrText } from '../fix/prBody';
import { openPullRequest } from '../fix/prWriter';
import { readSettings } from '../settings';
import type { RepoRun } from './panel';

export interface FixFlowDeps {
  gh(): GitHub | undefined;
  user(): string;
  runs: Map<string, RepoRun>;
  skills(): Promise<Skill[]>;
  sonar(): Promise<SonarLink | undefined>;
  post(m: HostMessage): void;
  log(msg: string): void;
}

export class FixFlow {
  private abort: AbortController | undefined;
  private plans = new Map<string, { pr: PlanPr; repo: RepoPlan }>();

  constructor(private readonly deps: FixFlowDeps) {}

  get busy(): boolean {
    return this.abort !== undefined;
  }

  cancel(): void {
    this.abort?.abort();
  }

  async prepare(providerId: ProviderId, only?: string[]): Promise<void> {
    if (this.abort || !this.deps.gh()) return;
    const abort = (this.abort = new AbortController());
    this.plans.clear();
    try {
      const skills = await this.deps.skills();
      const runs = [...this.deps.runs].filter(([repo]) => !only || only.includes(repo));
      const settings = readSettings();
      const needsModel = runs.some(([, run]) =>
        [...run.results.values()].some((r) => r.status === 'fail' && r.fixable && skills.find((s) => s.id === r.checkId)?.fix?.kind === 'ai'),
      );
      const provider = needsModel ? await createProvider(providerId, this.deps.log) : undefined;
      const sonar = runs.some(([, run]) => run.results.get('test-coverage')?.status === 'fail') ? await this.deps.sonar() : undefined;

      const repos: RepoPlan[] = [];
      for (const [repo, run] of runs) {
        if (abort.signal.aborted) return;
        const results = [...run.results.values()];
        if (!results.some((r) => r.status === 'fail' && r.fixable)) continue;
        this.deps.post({ type: 'fixProgress', label: repo });
        // Fresh signal for this flow; the scan's signal is long finished.
        const ctx = run.ctx.withSignal(abort.signal);
        const plan = await planRepoFixes({
          ctx,
          skills,
          results,
          provider,
          sonar,
          branchTemplate: settings.branchTemplate,
          coverageMaxFiles: settings.coverageMaxFiles,
          sonarUrl: settings.sonarUrl,
          user: this.deps.user(),
          onProgress: (label) => this.deps.post({ type: 'fixProgress', label }),
        });
        repos.push(plan);
        for (const pr of plan.prs) this.plans.set(pr.id, { pr, repo: plan });
      }
      if (!abort.signal.aborted) this.deps.post({ type: 'fixPlan', repos, branchPattern: settings.branchPattern });
    } catch (err) {
      if (abort.signal.aborted) return;
      this.deps.log(`Preparing fixes failed: ${(err as Error).stack ?? err}`);
      this.deps.post({ type: 'fixError', error: describeError(err) });
    } finally {
      this.abort = undefined;
    }
  }

  /** Validates the user's edits against the plan, confirms in a modal, then opens the PRs. */
  async create(subs: PrSubmission[]): Promise<void> {
    const gh = this.deps.gh();
    if (!gh || this.abort || subs.length === 0) return;
    const { branchPattern } = readSettings();

    const approved: { sub: PrSubmission; pr: PlanPr; repo: RepoPlan }[] = [];
    for (const sub of subs) {
      const planned = this.plans.get(sub.id);
      if (!planned) continue;
      const problem = validateBranchName(sub.branch, branchPattern);
      if (problem) {
        this.deps.post({ type: 'fixError', error: { label: `Invalid branch for ${sub.repo}`, detail: problem } });
        return;
      }
      const allowed = new Set(planned.pr.files.map((f) => f.path));
      const files = sub.files.filter((f) => allowed.has(f.path) && isSafeRepoPath(f.path));
      if (files.length === 0) continue;
      approved.push({ sub: { ...sub, files }, pr: planned.pr, repo: planned.repo });
    }
    if (approved.length === 0) return;

    const detail = approved
      .map(({ sub, pr }) => `${sub.repo}: ${sub.branch} → ${pr.base} (${sub.files.length} file${sub.files.length === 1 ? '' : 's'}${pr.draft ? ', draft' : ''})`)
      .join('\n');
    const n = approved.length;
    const choice = await vscode.window.showWarningMessage(
      `Create ${n} branch${n === 1 ? '' : 'es'} and ${n} pull request${n === 1 ? '' : 's'}?`,
      { modal: true, detail: `${detail}\n\nEach PR gets the "preflight" label. Nothing is committed to an existing branch.` },
      'Create',
    );
    if (choice !== 'Create') {
      this.deps.post({ type: 'prCancelled' });
      return;
    }

    this.abort = new AbortController();
    this.deps.post({ type: 'prCreating', total: n });
    const results: PrResult[] = [];
    try {
      for (const { sub, pr } of approved) {
        const [owner, repo] = sub.repo.split('/');
        const notes = [...pr.notes];
        const text = buildPrText(pr.kind, pr.checks, sub.files.map((f) => f.path), notes, pr.base);
        try {
          const out = await openPullRequest(gh, {
            owner,
            repo,
            base: pr.base,
            branch: sub.branch,
            changes: sub.files.map((f) => ({ path: f.path, content: f.content ?? undefined })),
            text,
            draft: pr.draft,
          });
          const warnings: string[] = [];
          if (out.branch !== sub.branch) warnings.push(`Branch ${sub.branch} existed; used ${out.branch}`);
          if (out.draftFallback) warnings.push('Draft PRs aren\'t available for this repository, so it was opened as a regular PR titled [Draft]');
          if (out.labelWarning) warnings.push(out.labelWarning);
          results.push({ id: sub.id, repo: sub.repo, kind: sub.kind, url: out.url, number: out.number, branch: out.branch, warnings });
          this.deps.log(`Opened ${out.url}`);
        } catch (err) {
          this.deps.log(`PR for ${sub.repo} failed: ${(err as Error).stack ?? err}`);
          results.push({ id: sub.id, repo: sub.repo, kind: sub.kind, warnings: [], error: describeError(err).detail ?? (err as Error).message });
        }
      }
    } finally {
      this.abort = undefined;
      this.deps.post({ type: 'prResults', results });
    }
  }
}
