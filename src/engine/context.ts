import picomatch from 'picomatch';
import type { GitHub } from '../github/client';

export interface ScanSettings {
  staleBranchDays: number;
  /** Present when SonarQube is configured; the coverage check is skipped otherwise. */
  sonar?: SonarAccess;
  licenseAllow: string[];
  licenseDeny: string[];
  coverageThreshold: number;
}

/** The slice of the Sonar client the checks need. */
export interface SonarAccess {
  coverage(ctx: RepoContext): Promise<{ projectKey: string; coverage: number | undefined; url: string } | undefined>;
}

export const DEFAULT_SETTINGS: ScanSettings = {
  staleBranchDays: 90,
  licenseAllow: [],
  licenseDeny: ['AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'SSPL-1.0'],
  coverageThreshold: 80,
};

export interface RepoFile {
  path: string;
  size: number;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  /** Branch being scanned. */
  ref: string;
  sha: string;
  defaultBranch: string;
  /** From GET /repos/{o}/{r}/branches/{b}. */
  branchProtected: boolean;
  private?: boolean;
}

export type FileReader = (path: string) => Promise<string | undefined>;

/** Everything a check may look at. Files come from one tree listing; contents are fetched lazily and cached. */
export class RepoContext {
  readonly fullName: string;
  private readonly byLower = new Map<string, string>();
  private readonly contents = new Map<string, Promise<string | undefined>>();
  private readonly memos = new Map<string, Promise<unknown>>();

  constructor(
    readonly info: RepoInfo,
    readonly files: readonly RepoFile[],
    private readonly reader: FileReader,
    readonly gh: GitHub,
    readonly settings: ScanSettings,
    /** True when GitHub truncated the tree and only part of the repo was listed. */
    readonly truncated = false,
    readonly signal?: AbortSignal,
  ) {
    this.fullName = `${info.owner}/${info.repo}`;
    for (const f of files) this.byLower.set(f.path.toLowerCase(), f.path);
  }

  get isDefaultBranch(): boolean {
    return this.info.ref === this.info.defaultBranch;
  }

  /** Case-insensitive existence check; returns the path as stored in the repo. */
  exists(path: string): string | undefined {
    return this.byLower.get(path.replace(/^\/+/, '').toLowerCase());
  }

  match(globs: readonly string[]): string[] {
    const isMatch = picomatch(globs as string[], { dot: true, nocase: true });
    return this.files.filter((f) => isMatch(f.path)).map((f) => f.path);
  }

  size(path: string): number | undefined {
    const actual = this.exists(path);
    return actual === undefined ? undefined : this.files.find((f) => f.path === actual)?.size;
  }

  read(path: string): Promise<string | undefined> {
    const actual = this.exists(path);
    if (actual === undefined) return Promise.resolve(undefined);
    let p = this.contents.get(actual);
    if (!p) {
      p = this.reader(actual);
      this.contents.set(actual, p);
    }
    return p;
  }

  /** Shares one API result between checks in the same scan (e.g. the SBOM used by several checks). */
  memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memos.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.memos.set(key, p);
    }
    return p;
  }

  /** Same repo snapshot and caches, different cancellation signal (e.g. for the fix step after a scan). */
  withSignal(signal: AbortSignal | undefined): RepoContext {
    return Object.assign(Object.create(RepoContext.prototype) as RepoContext, this, { signal });
  }

  htmlUrl(path?: string): string {
    const base = `https://github.com/${this.fullName}`;
    return path ? `${base}/blob/${encodeURIComponent(this.info.ref)}/${path.split('/').map(encodeURIComponent).join('/')}` : base;
  }
}
