import * as vscode from 'vscode';
import type { ScanSettings } from './engine/context';

export interface PreflightSettings extends ScanSettings {
  /** SonarQube base URL. Empty (the default) means no SonarQube: coverage is estimated from the code. */
  sonarUrl: string;
  /**
   * Most source files one Coverage PR writes tests for.
   * 0 (the default) = no limit: write tests for exactly as many files as the coverage threshold needs.
   * N > 0 = at most N files per PR; the PR notes say if that leaves coverage below the threshold.
   */
  coverageMaxFiles: number;
  /** Branch name template; placeholders {user} {repo} {check-or-category} {date} {shortid} {type}. */
  branchTemplate: string;
  /** Regex every branch name must match. Empty (the default) = no extra rule beyond git's own. */
  branchPattern: string;
}

/**
 * Reads the preflight.* settings. Defaults here must match package.json.
 *
 * Values that need explaining:
 * - coverage.threshold: target coverage in percent (0-100, default 80). With SonarQube it is measured
 *   line coverage; without it, the share of source files that have a test file named after them.
 * - coverage.maxFiles: see coverageMaxFiles above (0 = no limit).
 * - staleBranchDays: a branch with no commits for this many days counts as stale (default 90).
 * - license.allow: SPDX IDs dependencies may use. Empty (default) = no allow list, anything not denied passes.
 * - license.deny: SPDX IDs that always fail licence compliance (default AGPL and SSPL).
 */
export function readSettings(): PreflightSettings {
  const c = vscode.workspace.getConfiguration('preflight');
  return {
    staleBranchDays: c.get('staleBranchDays', 90),
    licenseAllow: c.get<string[]>('license.allow', []),
    licenseDeny: c.get<string[]>('license.deny', []),
    coverageThreshold: c.get('coverage.threshold', 80),
    coverageMaxFiles: c.get('coverage.maxFiles', 0),
    sonarUrl: c.get('sonar.url', '').replace(/\/+$/, ''),
    branchTemplate: c.get('branch.template', 'preflight/{type}/{date}-{shortid}'),
    branchPattern: c.get('branch.pattern', ''),
  };
}
