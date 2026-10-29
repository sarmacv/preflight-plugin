import type { RepoContext } from '../engine/context';
import type { CheckStatus, Evidence, Skill } from '../skills/types';

export interface EvaluationContext {
  repo: RepoContext;
  /** Files listed in the skill's context_files (or chosen by the fix step), already fetched. */
  files: { path: string; content: string }[];
  /** Outcome of the deterministic rules for hybrid checks, or the failure being fixed. */
  ruleEvidence?: Evidence[];
  /** Extra task-specific instructions, e.g. which files a coverage PR must target. */
  instructions?: string;
}

export interface Evaluation {
  status: Extract<CheckStatus, 'pass' | 'fail'>;
  evidence: Evidence[];
}

export interface FileChange {
  path: string;
  /** New full content; undefined deletes the file. */
  content: string | undefined;
}

export interface FixProposal {
  changes: FileChange[];
  /** What the reviewer should verify; goes into the PR body. */
  notes?: string;
}

/** Same skill files for every provider: the skill markdown is the prompt. */
export interface ModelProvider {
  readonly id: string;
  readonly label: string;
  evaluate(skill: Skill, ctx: EvaluationContext, signal?: AbortSignal): Promise<Evaluation>;
  generateFix(skill: Skill, ctx: EvaluationContext, signal?: AbortSignal): Promise<FixProposal>;
}

/**
 * An AI failure with a plain message for the UI. Model names and raw errors go to the log only:
 * users choose a provider, they don't need to know which model ran.
 */
export class AiError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

/** Repo-relative paths only; never touch .git or escape the repo. */
export function isSafeRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((seg) => seg === '..' || seg === '' || seg === '.git')
  );
}
