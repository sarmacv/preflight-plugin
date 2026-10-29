// Sequential scan queue: one repo at a time, a few checks in parallel inside a repo,
// cancellable, and completed results are kept when the user stops part-way.
import type { ModelProvider } from '../ai/provider';
import type { CheckResult, Skill } from '../skills/types';
import type { RepoContext } from './context';
import { runCheck, ScanCancelled } from './engine';
import { scoreRepo, type RepoScore } from './score';

export interface ScanTarget {
  repo: string;
  branch: string;
}

export interface ScanEvents {
  repoStarted(repo: string, branch: string, checkIds: string[]): void;
  checkStarted(repo: string, checkId: string): void;
  checkDone(repo: string, result: CheckResult): void;
  repoDone(repo: string, score: RepoScore, results: CheckResult[], ctx: RepoContext): void;
  repoFailed(repo: string, error: unknown): void;
}

export interface ScanOptions {
  targets: ScanTarget[];
  skills: Skill[];
  createContext(target: ScanTarget, signal: AbortSignal): Promise<RepoContext>;
  provider?: ModelProvider;
  signal: AbortSignal;
  /** Checks run in parallel within one repo. */
  concurrency?: number;
}

export interface ScanSummary {
  cancelled: boolean;
  completed: string[];
}

/** Prerequisites before dependents, otherwise catalogue order. Cycles are broken by catalogue order. */
export function dependencyOrder(skills: Skill[]): Skill[] {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const out: Skill[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: Skill) => {
    if (state.get(s.id)) return;
    state.set(s.id, 'visiting');
    for (const dep of s.depends_on) {
      const d = byId.get(dep);
      if (d && !state.get(d.id)) visit(d);
    }
    state.set(s.id, 'done');
    out.push(s);
  };
  skills.forEach(visit);
  return out;
}

export async function runScan(opts: ScanOptions, events: ScanEvents): Promise<ScanSummary> {
  const completed: string[] = [];
  const concurrency = opts.concurrency ?? 3;

  for (const target of opts.targets) {
    if (opts.signal.aborted) break;
    const skills = opts.skills;
    events.repoStarted(target.repo, target.branch, skills.map((s) => s.id));

    let ctx: RepoContext;
    try {
      ctx = await opts.createContext(target, opts.signal);
    } catch (err) {
      if (opts.signal.aborted) break;
      events.repoFailed(target.repo, err);
      continue;
    }

    const results: CheckResult[] = [];
    const ordered = dependencyOrder(skills);
    const pending = new Map<string, Promise<CheckResult>>();
    const settle = new Map<string, (r: CheckResult) => void>();
    for (const s of ordered) pending.set(s.id, new Promise((resolve) => settle.set(s.id, resolve)));
    let next = 0;
    try {
      const worker = async () => {
        while (next < ordered.length) {
          const skill = ordered[next++];
          if (opts.signal.aborted) throw new ScanCancelled();
          // Prerequisites come earlier in the order, so they are already running or done.
          const prerequisites = await Promise.all(skill.depends_on.filter((id) => pending.has(id)).map((id) => pending.get(id)!));
          events.checkStarted(target.repo, skill.id);
          const result = await runCheck(skill, ctx, { provider: opts.provider, prerequisites });
          results.push(result);
          settle.get(skill.id)!(result);
          events.checkDone(target.repo, result);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, skills.length) }, worker));
    } catch (err) {
      if (err instanceof ScanCancelled || opts.signal.aborted) break;
      events.repoFailed(target.repo, err);
      continue;
    }

    // Keep catalogue order for stable display.
    const order = new Map(skills.map((s, i) => [s.id, i]));
    results.sort((a, b) => order.get(a.checkId)! - order.get(b.checkId)!);
    events.repoDone(target.repo, scoreRepo(results), results, ctx);
    completed.push(target.repo);
  }

  return { cancelled: opts.signal.aborted, completed };
}
