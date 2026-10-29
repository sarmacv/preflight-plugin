import * as vscode from 'vscode';
import type { ScanSettings } from './engine/context';

export interface PreflightSettings extends ScanSettings {
  sonarUrl: string;
  coverageMaxFiles: number;
  branchTemplate: string;
  branchPattern: string;
}

export function readSettings(): PreflightSettings {
  const c = vscode.workspace.getConfiguration('preflight');
  return {
    staleBranchDays: c.get('staleBranchDays', 90),
    licenseAllow: c.get<string[]>('license.allow', []),
    licenseDeny: c.get<string[]>('license.deny', []),
    coverageThreshold: c.get('coverage.threshold', 80),
    coverageMaxFiles: c.get('coverage.maxFiles', 5),
    sonarUrl: c.get('sonar.url', '').replace(/\/+$/, ''),
    branchTemplate: c.get('branch.template', 'preflight/{type}/{date}-{shortid}'),
    branchPattern: c.get('branch.pattern', ''),
  };
}
