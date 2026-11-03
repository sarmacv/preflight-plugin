import { computed, effect, signal } from '@preact/signals';
import type {
  AuthState, CheckMeta, CheckResult, HostMessage, ProviderId, RateLimit, RepoScore, RepoSummary, ScanTarget, UiError,
} from '../shared/protocol';
import { loadState, post, saveState } from './vscode';

const persisted = loadState();

export const auth = signal<AuthState>({ status: 'checking' });
export const repos = signal<RepoSummary[]>([]);
export const reposDone = signal(false);
export const reposError = signal<UiError | undefined>(undefined);
export const branches = signal<Record<string, string[] | 'loading'>>({});
export const providers = signal<ProviderId[]>([]);
export const provider = signal<ProviderId>('copilot');
export const rateLimit = signal<RateLimit | undefined>(undefined);
export const scanning = signal(false);
export const scanError = signal<UiError | undefined>(undefined);

export const catalog = signal<CheckMeta[]>([]);
/** Skill files that couldn't be loaded (bad frontmatter, missing sections), shown as a warning in Checks. */
export const catalogErrors = signal<string[]>([]);
/** Checks imported a moment ago, highlighted in the Checks tab. */
export const justImported = signal<Set<string>>(new Set());
export const catalogById = computed(() => new Map(catalog.value.map((c) => [c.id, c])));
/** Checks excluded from scans by the user (empty = run everything). */
export const excludedChecks = signal<Set<string>>(new Set(persisted.excluded ?? []));
export const failuresOnly = signal(false);
/** Which list the left pane shows. */
export const leftTab = signal<'repos' | 'checks'>(persisted.leftTab ?? 'repos');

export const checkCounts = computed(() => {
  const total = catalog.value.length;
  return { selected: total - catalog.value.filter((c) => excludedChecks.value.has(c.id)).length, total };
});

export function setChecksExcluded(ids: string[], exclude: boolean): void {
  const next = new Set(excludedChecks.value);
  for (const id of ids) (exclude ? next.add(id) : next.delete(id));
  excludedChecks.value = next;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RepoRunView {
  repo: string;
  branch: string;
  status: RunStatus;
  checkIds: string[];
  results: Record<string, CheckResult>;
  running: string[];
  score?: RepoScore;
  error?: UiError;
}

/** Result cards in scan order. */
export const runs = signal<RepoRunView[]>([]);

export const queueProgress = computed(() => {
  const list = runs.value;
  const finished = list.filter((r) => r.status === 'done' || r.status === 'failed').length;
  return { finished, total: list.length };
});

export const search = signal('');

/** Organizations (and the personal account) whose repos are shown; empty means all. */
export const orgFilter = signal<Set<string>>(
  new Set(Array.isArray(persisted.orgFilter) ? persisted.orgFilter : persisted.orgFilter ? [persisted.orgFilter] : []),
);
/** Selected repos mapped to the branch to scan. */
export const selection = signal<Map<string, string>>(new Map(persisted.selection ?? []));

export type Popover =
  | { kind: 'branch'; repo: string; anchor: DOMRect }
  | { kind: 'model'; anchor: DOMRect }
  | { kind: 'connection'; anchor: DOMRect }
  | { kind: 'filter'; anchor: DOMRect }
  | { kind: 'orgs'; anchor: DOMRect };
export const popover = signal<Popover | undefined>(undefined);

effect(() => saveState({ selection: [...selection.value], orgFilter: [...orgFilter.value], excluded: [...excludedChecks.value], leftTab: leftTab.value }));

export interface OwnerOption {
  login: string;
  repos: number;
  /** The signed-in user's own account rather than an organization. */
  personal: boolean;
  /** SSO not yet authorized, so GitHub hides this org's repos. */
  ssoUrl?: string;
  /** The org hasn't approved VS Code's GitHub sign-in, so its private repos are hidden. */
  restricted?: boolean;
  requestUrl?: string;
}

/** Every account whose repos can be shown: the user, their orgs (even with no visible repos), and other owners. */
export const owners = computed<OwnerOption[]>(() => {
  const counts = new Map<string, number>();
  for (const r of repos.value) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  const a = auth.value;
  const me = a.status === 'signedIn' ? a.user.login : undefined;
  const orgs = a.status === 'signedIn' ? a.orgs : [];
  const logins = new Set([...(me ? [me] : []), ...orgs.map((o) => o.login), ...counts.keys()]);
  return [...logins]
    .map((login) => {
      const org = orgs.find((o) => o.login === login);
      return { login, repos: counts.get(login) ?? 0, personal: login === me, ssoUrl: org && !org.authorized ? org.ssoUrl : undefined, restricted: org?.restricted, requestUrl: org?.requestUrl };
    })
    .sort((x, y) => Number(y.personal) - Number(x.personal) || x.login.localeCompare(y.login));
});

export function toggleOrg(login: string): void {
  const next = new Set(orgFilter.value);
  if (next.has(login)) next.delete(login);
  else next.add(login);
  orgFilter.value = next;
}

/** Show only this organization's repos (from the connection menu). */
export function onlyOrg(login: string): void {
  orgFilter.value = new Set([login]);
  leftTab.value = 'repos';
}

export const visibleRepos = computed(() => {
  const q = search.value.trim().toLowerCase();
  const orgs = orgFilter.value;
  return repos.value.filter((r) => (orgs.size === 0 || orgs.has(r.owner)) && (!q || r.fullName.toLowerCase().includes(q)));
});

/** Branch chips become editable once more than one repo is selected. */
export const branchesEditable = computed(() => selection.value.size > 1);

export const scopeEmpty = computed(() => catalog.value.length > 0 && catalog.value.every((c) => excludedChecks.value.has(c.id)));

export const canScan = computed(
  () => auth.value.status === 'signedIn' && selection.value.size > 0 && !scanning.value && !scopeEmpty.value,
);

export const ssoBlockedOrgs = computed(() =>
  auth.value.status === 'signedIn' ? auth.value.orgs.filter((o) => !o.authorized) : [],
);

export function toggle(repo: RepoSummary, on?: boolean): void {
  const next = new Map(selection.value);
  const select = on ?? !next.has(repo.fullName);
  if (select) next.set(repo.fullName, next.get(repo.fullName) ?? repo.defaultBranch);
  else next.delete(repo.fullName);
  selection.value = next;
}

export function selectAllVisible(): void {
  const next = new Map(selection.value);
  for (const r of visibleRepos.value) if (!next.has(r.fullName)) next.set(r.fullName, r.defaultBranch);
  selection.value = next;
}

export function clearSelection(): void {
  selection.value = new Map();
}

export function setBranch(repo: string, branch: string): void {
  const next = new Map(selection.value);
  if (next.has(repo)) next.set(repo, branch);
  selection.value = next;
}

export function requestBranches(repo: string): void {
  if (branches.value[repo]) return;
  branches.value = { ...branches.value, [repo]: 'loading' };
  post({ type: 'loadBranches', repo });
}

export function scanTargets(): ScanTarget[] {
  const known = new Set(repos.value.map((r) => r.fullName));
  return [...selection.value].filter(([repo]) => known.has(repo)).map(([repo, branch]) => ({ repo, branch }));
}

function scopedCheckIds(): string[] | undefined {
  if (excludedChecks.value.size === 0) return undefined;
  return catalog.value.map((c) => c.id).filter((id) => !excludedChecks.value.has(id));
}

export function startScan(): void {
  if (!canScan.value) return;
  post({ type: 'scan', targets: scanTargets(), provider: provider.value, checkIds: scopedCheckIds() });
}

/** Re-run some checks (or the current scope) for one repo, merging into its card. */
export function rerun(repo: string, branch: string, checkIds?: string[]): void {
  if (scanning.value || auth.value.status !== 'signedIn') return;
  post({ type: 'scan', targets: [{ repo, branch }], provider: provider.value, checkIds: checkIds ?? scopedCheckIds(), rerun: true });
}

export function cancelScan(): void {
  if (scanning.value) post({ type: 'cancel' });
}

function updateRun(repo: string, fn: (r: RepoRunView) => RepoRunView): void {
  runs.value = runs.value.map((r) => (r.repo === repo ? fn(r) : r));
}

const REPO_DATA = new Set<HostMessage['type']>(['repos', 'reposError', 'branches']);

export function handleHostMessage(m: HostMessage): void {
  // Repo data is only accepted once the GitHub connection is verified; late responses from a
  // previous session are dropped.
  if (REPO_DATA.has(m.type) && auth.value.status !== 'signedIn') return;
  switch (m.type) {
    case 'auth':
      auth.value = m.auth;
      if (m.auth.status !== 'signedIn') {
        repos.value = [];
        reposDone.value = false;
        reposError.value = undefined;
        branches.value = {};
        popover.value = undefined;
      }
      return;
    case 'repos':
      repos.value = m.reset ? m.repos : [...repos.value, ...m.repos];
      reposDone.value = m.done;
      reposError.value = undefined;
      if (m.done) pruneSelection();
      return;
    case 'reposError':
      reposError.value = m.error;
      reposDone.value = true;
      return;
    case 'branches':
      branches.value = { ...branches.value, [m.repo]: m.branches };
      return;
    case 'providers':
      providers.value = m.available;
      provider.value = m.selected;
      return;
    case 'rateLimit':
      rateLimit.value = m.rateLimit;
      return;
    case 'catalog':
      catalog.value = m.checks;
      catalogErrors.value = m.errors;
      return;
    case 'skillsImported': {
      // New checks run by default, and the Checks tab shows them.
      setChecksExcluded(m.ids, false);
      leftTab.value = 'checks';
      justImported.value = new Set(m.ids);
      setTimeout(() => (justImported.value = new Set()), 6000);
      return;
    }
    case 'scanStarted': {
      scanning.value = true;
      scanError.value = undefined;
      const fresh = (t: ScanTarget): RepoRunView => ({ repo: t.repo, branch: t.branch, status: 'queued', checkIds: m.checkIds, results: {}, running: [] });
      if (!m.rerun) {
        runs.value = m.targets.map(fresh);
        return;
      }
      for (const t of m.targets) {
        if (runs.value.some((r) => r.repo === t.repo)) updateRun(t.repo, (r) => ({ ...r, status: 'queued', branch: t.branch, error: undefined }));
        else runs.value = [...runs.value, fresh(t)];
      }
      return;
    }
    case 'repoStarted':
      updateRun(m.repo, (r) => {
        const results = { ...r.results };
        for (const id of m.checkIds) delete results[id];
        return { ...r, status: 'running', branch: m.branch, checkIds: [...new Set([...r.checkIds, ...m.checkIds])], results, running: [] };
      });
      return;
    case 'checkStarted':
      updateRun(m.repo, (r) => ({ ...r, running: [...r.running, m.checkId] }));
      return;
    case 'checkDone':
      updateRun(m.repo, (r) => ({
        ...r,
        running: r.running.filter((id) => id !== m.result.checkId),
        results: { ...r.results, [m.result.checkId]: m.result },
      }));
      return;
    case 'repoDone':
      updateRun(m.repo, (r) => ({ ...r, status: 'done', running: [], score: m.score }));
      return;
    case 'repoFailed':
      updateRun(m.repo, (r) => ({ ...r, status: 'failed', running: [], error: m.error }));
      return;
    case 'scanFinished':
      scanning.value = false;
      runs.value = runs.value.map((r) => (r.status === 'queued' || r.status === 'running' ? { ...r, status: 'cancelled', running: [] } : r));
      return;
    case 'scanError':
      scanError.value = m.error;
      return;
  }
}

/** Drop persisted selections for repos the user can no longer see. */
function pruneSelection(): void {
  const known = new Set(repos.value.map((r) => r.fullName));
  const next = new Map([...selection.value].filter(([repo]) => known.has(repo)));
  if (next.size !== selection.value.size) selection.value = next;
}
