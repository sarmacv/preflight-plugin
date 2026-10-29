import { SEVERITIES, type CheckResult, type Severity } from '../skills/types';

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, high: 5, medium: 2, low: 1 };

export type Verdict = 'cleared' | 'grounded';

export interface RepoScore {
  /** 0-100: severity-weighted share of evaluated checks that passed. */
  score: number;
  verdict: Verdict;
  failures: Record<Severity, number>;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
}

/** A repo is grounded by any critical or high failure. */
export function scoreRepo(results: readonly CheckResult[]): RepoScore {
  const failures = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  let earned = 0;
  let possible = 0;
  const count = { passed: 0, failed: 0, skipped: 0, errored: 0 };
  for (const r of results) {
    const w = SEVERITY_WEIGHT[r.severity];
    if (r.status === 'pass') {
      earned += w;
      possible += w;
      count.passed++;
    } else if (r.status === 'fail') {
      possible += w;
      failures[r.severity]++;
      count.failed++;
    } else if (r.status === 'skipped') count.skipped++;
    else count.errored++;
  }
  return {
    score: possible === 0 ? 100 : Math.round((earned / possible) * 100),
    verdict: failures.critical + failures.high > 0 ? 'grounded' : 'cleared',
    failures,
    ...count,
  };
}

/** Critical failures first, then other failures by severity, then everything else. */
export function sortResults(results: readonly CheckResult[]): CheckResult[] {
  const rank = (r: CheckResult) => (r.status === 'fail' ? SEVERITIES.indexOf(r.severity) : r.status === 'error' ? 4 : 5);
  return [...results].sort((a, b) => rank(a) - rank(b));
}
