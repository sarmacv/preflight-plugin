import * as vscode from 'vscode';
import type { CheckMeta, HostMessage, ProviderId, RateLimit, WebviewMessage } from '../shared/protocol';
import { describeError, GitHubAuth } from '../auth/github';
import { listAllRepos, listBranches } from '../github/repos';
import { createGitHubContext } from '../github/repoContext';
import { availableProviders } from '../ai/providers';
import { createProvider } from '../ai/lmProvider';
import { loadSkillRoots, type LoadResult } from '../skills/loader';
import { importSkills, removeImportedSkill } from './skillImport';
import type { CheckResult, Skill } from '../skills/types';
import type { RepoContext } from '../engine/context';
import { runScan } from '../engine/queue';
import { scoreRepo } from '../engine/score';
import { readSettings } from '../settings';
import { renderHtml } from './html';
import { FixFlow } from './fixFlow';
import { SonarClient } from '../sonar/client';
import { createSonarLink, type SonarLink } from '../sonar/access';

export const SONAR_TOKEN_KEY = 'preflight.sonar.token';
const SONAR_LINKS_KEY = 'preflight.sonar.projects';

/** The latest results per repo, kept for re-runs and for building fixes. */
export interface RepoRun {
  ctx: RepoContext;
  results: Map<string, CheckResult>;
}

export class PreflightPanel implements vscode.Disposable {
  private static current: PreflightPanel | undefined;

  static show(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
    if (PreflightPanel.current) {
      PreflightPanel.current.panel.reveal();
      return;
    }
    PreflightPanel.current = new PreflightPanel(context, output);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly auth: GitHubAuth;
  private readonly disposables: vscode.Disposable[] = [];
  private catalog: Promise<LoadResult>;
  private repoLoad: AbortController | undefined;
  private scanAbort: AbortController | undefined;
  private provider: ProviderId;
  private lastRateLimit: RateLimit | undefined;
  readonly runs = new Map<string, RepoRun>();
  private readonly fixes: FixFlow;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.panel = vscode.window.createWebviewPanel('preflight', 'Preflight', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    this.panel.webview.html = renderHtml(this.panel.webview, context.extensionUri, String(context.extension.packageJSON.version ?? ''));
    this.provider = vscode.workspace.getConfiguration('preflight').get<ProviderId>('model.default', 'copilot');

    this.catalog = this.loadCatalog();

    this.auth = new GitHubAuth(
      (rl) => {
        this.lastRateLimit = rl;
        this.post({ type: 'rateLimit', rateLimit: rl });
      },
      (msg) => this.output.appendLine(msg),
    );

    this.fixes = new FixFlow({
      gh: () => this.auth.gh,
      user: () => (this.auth.state.status === 'signedIn' ? this.auth.state.user.login : 'preflight'),
      runs: this.runs,
      skills: () => this.skills,
      sonar: () => this.sonarAccess(readSettings().sonarUrl),
      post: (m) => this.post(m),
      log: (m) => this.output.appendLine(m),
    });

    this.disposables.push(
      this.auth,
      this.auth.onDidChange((auth) => {
        this.post({ type: 'auth', auth });
        if (auth.status === 'signedIn') void this.loadRepos();
        else {
          this.repoLoad?.abort();
          this.scanAbort?.abort();
          this.fixes.cancel();
        }
      }),
      this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => void this.handle(m)),
      this.panel.onDidDispose(() => this.dispose()),
      vscode.lm.onDidChangeChatModels(() => void this.sendProviders()),
    );
  }

  post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async handle(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'auth', auth: this.auth.state });
        if (this.lastRateLimit) this.post({ type: 'rateLimit', rateLimit: this.lastRateLimit });
        void this.sendProviders();
        void this.sendCatalog();
        if (this.auth.state.status === 'checking') await this.auth.connect(false);
        else if (this.auth.state.status === 'signedIn') void this.loadRepos();
        return;
      case 'signIn':
        return this.auth.connect(true);
      case 'refresh':
        if (this.auth.state.status === 'signedIn') return this.loadRepos();
        return this.auth.connect(false);
      case 'loadBranches':
        return this.loadBranches(m.repo);
      case 'selectProvider':
        this.provider = m.provider;
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.context.extension.id}`);
        return;
      case 'openExternal':
        if (m.url.startsWith('https://github.com/') || m.url.startsWith(readSettings().sonarUrl || '\u0000')) {
          await vscode.env.openExternal(vscode.Uri.parse(m.url));
        }
        return;
      case 'scan':
        return this.scan(m.targets, m.provider, m.checkIds, m.rerun ?? false);
      case 'cancel':
        this.scanAbort?.abort();
        return;
      case 'prepareFixes':
        if (!this.scanAbort) await this.fixes.prepare(m.provider, m.repos);
        return;
      case 'createPrs':
        return this.fixes.create(m.prs);
      case 'cancelFixes':
        this.fixes.cancel();
        return;
      case 'importSkills':
        return this.importSkills();
      case 'removeSkill':
        return this.removeSkill(m.id);
    }
  }

  /** Where imported skills are kept: outside the extension folder, so updates don't remove them. */
  private get importedRoot(): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'skills').fsPath;
  }

  private loadCatalog(): Promise<LoadResult> {
    return loadSkillRoots([
      { dir: vscode.Uri.joinPath(this.context.extensionUri, 'skills').fsPath, origin: 'bundled' },
      { dir: this.importedRoot, origin: 'imported' },
    ]).then((r) => {
      for (const e of r.errors) this.output.appendLine(`Skill skipped: ${e}`);
      return r;
    });
  }

  private async importSkills(): Promise<void> {
    const outcome = await importSkills(this.importedRoot, await this.skills, (m) => this.output.appendLine(m));
    if (!outcome) return;
    this.catalog = this.loadCatalog();
    await this.sendCatalog();
    const n = outcome.imported.length;
    if (n) {
      this.post({ type: 'skillsImported', ids: outcome.imported.map((i) => i.id) });
      void vscode.window.showInformationMessage(`Preflight: imported ${n === 1 ? `"${outcome.imported[0].name}"` : `${n} checks`}.`);
    }
    if (outcome.problems.length) void vscode.window.showWarningMessage(`Preflight: ${outcome.problems.join('. ')}`);
  }

  private async removeSkill(id: string): Promise<void> {
    const skill = (await this.skills).find((s) => s.id === id);
    if (!skill || !(await removeImportedSkill(this.importedRoot, skill))) return;
    this.catalog = this.loadCatalog();
    await this.sendCatalog();
  }

  private async sendCatalog(): Promise<void> {
    const { skills, errors } = await this.catalog;
    const checks: CheckMeta[] = skills.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      categoryName: s.categoryName,
      severity: s.severity,
      evaluation: s.evaluation,
      fixable: s.fixable,
      fixPr: s.fix_pr,
      imported: s.origin === 'imported',
    }));
    this.post({ type: 'catalog', checks, errors });
  }

  private async sendProviders(): Promise<void> {
    const available = await availableProviders();
    if (!available.includes(this.provider) && available.length > 0) this.provider = available[0];
    this.post({ type: 'providers', available, selected: this.provider });
  }

  get skills(): Promise<Skill[]> {
    return this.catalog.then((c) => c.skills);
  }

  private async scan(targets: { repo: string; branch: string }[], providerId: ProviderId, checkIds: string[] | undefined, rerun: boolean): Promise<void> {
    const gh = this.auth.gh;
    if (!gh || this.scanAbort || this.fixes.busy || targets.length === 0) return;
    const abort = (this.scanAbort = new AbortController());

    try {
      const all = await this.skills;
      const skills = checkIds ? all.filter((s) => checkIds.includes(s.id)) : all;
      const provider = skills.some((s) => s.evaluation !== 'deterministic') ? await createProvider(providerId, (m) => this.output.appendLine(m)) : undefined;
      const settings = readSettings();
      if (!rerun) this.runs.clear();
      this.post({ type: 'scanStarted', targets, checkIds: skills.map((s) => s.id), rerun });
      this.output.appendLine(`Scan: ${targets.length} repo(s), ${skills.length} check(s), model ${provider?.label ?? 'none'}`);

      const sonar = skills.some((s) => s.id === 'sonar-code-coverage') ? await this.sonarAccess(settings.sonarUrl) : undefined;
      const result = await runScan(
        {
          targets,
          skills,
          provider,
          signal: abort.signal,
          createContext: (t, signal) => createGitHubContext(gh, t.repo, t.branch, { ...settings, sonar }, signal),
        },
        {
          repoStarted: (repo, branch, ids) => this.post({ type: 'repoStarted', repo, branch, checkIds: ids }),
          checkStarted: (repo, checkId) => this.post({ type: 'checkStarted', repo, checkId }),
          checkDone: (repo, r) => this.post({ type: 'checkDone', repo, result: r }),
          repoFailed: (repo, err) => {
            this.output.appendLine(`${repo}: ${(err as Error).message}`);
            this.post({ type: 'repoFailed', repo, error: describeError(err) });
          },
          repoDone: (repo, _score, results, ctx) => {
            const prior = rerun ? this.runs.get(repo)?.results : undefined;
            const merged = new Map(prior);
            for (const r of results) merged.set(r.checkId, r);
            this.runs.set(repo, { ctx, results: merged });
            this.post({ type: 'repoDone', repo, score: scoreRepo([...merged.values()]) });
          },
        },
      );
      this.post({ type: 'scanFinished', cancelled: result.cancelled });
    } catch (err) {
      this.output.appendLine(`Scan failed: ${(err as Error).stack ?? err}`);
      this.post({ type: 'scanError', error: describeError(err) });
      this.post({ type: 'scanFinished', cancelled: abort.signal.aborted });
    } finally {
      this.scanAbort = undefined;
    }
  }

  private sonarLink: { url: string; token: string; link: SonarLink } | undefined;

  /** Sonar is optional: without a URL the coverage check is skipped. The token lives in SecretStorage. */
  private async sonarAccess(url: string): Promise<SonarLink | undefined> {
    if (!url) return undefined;
    let token = await this.context.secrets.get(SONAR_TOKEN_KEY);
    if (!token) {
      token = await promptSonarToken(this.context, url);
      if (!token) return undefined;
    }
    if (this.sonarLink?.url === url && this.sonarLink.token === token) return this.sonarLink.link;
    const state = this.context.globalState;
    const link = createSonarLink(
      new SonarClient(url, token),
      {
        get: (repo) => state.get<Record<string, string>>(SONAR_LINKS_KEY, {})[repo],
        set: (repo, key) => state.update(SONAR_LINKS_KEY, { ...state.get<Record<string, string>>(SONAR_LINKS_KEY, {}), [repo]: key }),
      },
      pickSonarProject,
    );
    this.sonarLink = { url, token, link };
    return link;
  }

  private async loadRepos(): Promise<void> {
    const gh = this.auth.gh;
    if (!gh) return;
    this.repoLoad?.abort();
    const load = (this.repoLoad = new AbortController());
    let first = true;
    try {
      for await (const page of listAllRepos(gh, this.auth.orgLogins, load.signal)) {
        if (load.signal.aborted || this.auth.state.status !== 'signedIn') return;
        this.post({ type: 'repos', repos: page.repos, done: false, reset: first });
        this.auth.markSsoBlocked(page.ssoPartialOrgIds);
        this.auth.markRestricted(page.restrictedOrgs ?? []);
        first = false;
      }
      this.post({ type: 'repos', repos: [], done: true, reset: first });
    } catch (err) {
      if (!load.signal.aborted) this.post({ type: 'reposError', error: describeError(err) });
    }
  }

  private async loadBranches(repo: string): Promise<void> {
    const gh = this.auth.gh;
    if (!gh) return;
    try {
      const list = await listBranches(gh, repo);
      if (this.auth.gh !== gh) return;
      this.post({ type: 'branches', repo, branches: list });
    } catch (err) {
      this.output.appendLine(`Could not list branches for ${repo}: ${(err as Error).message}`);
      this.post({ type: 'branches', repo, branches: [] });
    }
  }

  dispose(): void {
    PreflightPanel.current = undefined;
    this.repoLoad?.abort();
    this.scanAbort?.abort();
    this.fixes.cancel();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export async function promptSonarToken(context: vscode.ExtensionContext, url: string): Promise<string | undefined> {
  const token = await vscode.window.showInputBox({
    title: 'SonarQube token',
    prompt: `User token for ${url} (stored in VS Code's secret storage)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (token) await context.secrets.store(SONAR_TOKEN_KEY, token.trim());
  return token?.trim() || undefined;
}

async function pickSonarProject(repo: string, client: SonarClient): Promise<string | undefined> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { key?: string }>();
  qp.title = `Sonar project for ${repo}`;
  qp.placeholder = 'Search SonarQube projects';
  qp.matchOnDescription = true;
  qp.busy = true;
  const skip = { label: '$(circle-slash) Skip', description: 'Leave coverage unchecked for this repo' };
  const load = async (q: string) => {
    qp.busy = true;
    try {
      const projects = await client.searchProjects(q);
      qp.items = [...projects.map((p) => ({ label: p.name, description: p.key, key: p.key })), skip];
    } catch (err) {
      qp.items = [{ label: `$(error) ${(err as Error).message}` }, skip];
    } finally {
      qp.busy = false;
    }
  };
  void load('');
  let timer: NodeJS.Timeout | undefined;
  qp.onDidChangeValue((v) => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(v), 300);
  });
  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.key);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}
