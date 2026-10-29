import type { RepoContext } from '../../engine/context';
import type { CheckStatus, Evidence } from '../types';

export interface RuleOutcome {
  status: CheckStatus;
  evidence: Evidence[];
}

export type RuleFn = (params: unknown, ctx: RepoContext) => Promise<RuleOutcome>;

export const pass = (...evidence: Evidence[]): RuleOutcome => ({ status: 'pass', evidence });
export const fail = (...evidence: Evidence[]): RuleOutcome => ({ status: 'fail', evidence });
export const skipped = (message: string): RuleOutcome => ({ status: 'skipped', evidence: [{ message }] });
export const errored = (message: string): RuleOutcome => ({ status: 'error', evidence: [{ message }] });

export class RuleConfigError extends Error {}
