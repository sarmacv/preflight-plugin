// Messages exchanged between the extension host and the Preflight webview.
import type { ProviderId } from '../ai/detect';
import type { RepoScore } from '../engine/score';
import type { CheckResult, Severity } from '../skills/types';
import type { PlanFile, PlanPr, PlanProblem, RepoPlan } from '../fix/planner';
import type { PrKind } from '../fix/branchName';

export type { CheckResult, PlanFile, PlanPr, PlanProblem, PrKind, ProviderId, RepoPlan, RepoScore, Severity };

/** A PR the user approved in the preview, with any edits they made. */
export interface PrSubmission {
  id: string;
  repo: string;
  kind: PrKind;
  branch: string;
  files: { path: string; content: string | null }[];
}

export interface PrResult {
  id: string;
  repo: string;
  kind: PrKind;
  url?: string;
  number?: number;
  branch?: string;
  warnings: string[];
  error?: string;
}

export interface CheckMeta {
  id: string;
  name: string;
  category: string;
  categoryName: string;
  severity: Severity;
  evaluation: 'deterministic' | 'ai' | 'hybrid';
  fixable: boolean;
  fixPr: 'fixes' | 'coverage';
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface OrgAccess {
  login: string;
  /** False when SAML SSO has not been authorised for this session's token. */
  authorized: boolean;
  ssoUrl?: string;
}

export interface RepoSummary {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  canPush: boolean;
}

export type RateLimitState = 'ok' | 'low' | 'waiting';

export interface RateLimit {
  state: RateLimitState;
  remaining: number;
  limit: number;
  /** Epoch seconds. */
  reset: number;
}

export interface UiError {
  /** A few words, shown next to an icon. */
  label: string;
  /** Detail for the tooltip. */
  detail?: string;
  action?: { label: string; command: WebviewMessage };
}

export type AuthState =
  | { status: 'checking' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: GitHubUser; orgs: OrgAccess[] }
  | { status: 'error'; error: UiError };

export type HostMessage =
  | { type: 'auth'; auth: AuthState }
  | { type: 'repos'; repos: RepoSummary[]; done: boolean; reset: boolean }
  | { type: 'reposError'; error: UiError }
  | { type: 'branches'; repo: string; branches: string[] }
  | { type: 'providers'; available: ProviderId[]; selected: ProviderId }
  | { type: 'rateLimit'; rateLimit: RateLimit }
  | { type: 'catalog'; checks: CheckMeta[]; errors: string[] }
  | { type: 'scanStarted'; targets: ScanTarget[]; checkIds: string[]; rerun: boolean }
  | { type: 'repoStarted'; repo: string; branch: string; checkIds: string[] }
  | { type: 'checkStarted'; repo: string; checkId: string }
  | { type: 'checkDone'; repo: string; result: CheckResult }
  | { type: 'repoDone'; repo: string; score: RepoScore }
  | { type: 'repoFailed'; repo: string; error: UiError }
  | { type: 'scanFinished'; cancelled: boolean }
  | { type: 'scanError'; error: UiError }
  | { type: 'fixProgress'; label: string }
  | { type: 'fixPlan'; repos: RepoPlan[]; branchPattern: string }
  | { type: 'fixError'; error: UiError }
  | { type: 'prCreating'; total: number }
  | { type: 'prResults'; results: PrResult[] }
  /** The confirmation dialog was dismissed; return to the preview. */
  | { type: 'prCancelled' };

export interface ScanTarget {
  repo: string;
  branch: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'signIn' }
  | { type: 'refresh' }
  | { type: 'loadBranches'; repo: string }
  | { type: 'selectProvider'; provider: ProviderId }
  | { type: 'openSettings' }
  | { type: 'openExternal'; url: string }
  /** checkIds limits the run to those checks; rerun merges into the existing results instead of replacing them. */
  | { type: 'scan'; targets: ScanTarget[]; provider: ProviderId; checkIds?: string[]; rerun?: boolean }
  | { type: 'cancel' }
  /** repos limits the fix to those repositories (the per-repo Fix button); omitted means every scanned repo. */
  | { type: 'prepareFixes'; provider: ProviderId; repos?: string[] }
  | { type: 'createPrs'; prs: PrSubmission[] }
  | { type: 'cancelFixes' };
