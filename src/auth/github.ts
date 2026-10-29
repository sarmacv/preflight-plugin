// GitHub sign-in through VS Code's built-in auth provider. Preflight never sees or stores raw credentials
// beyond handing the session token to Octokit in memory.
import * as vscode from 'vscode';
import type { AuthState, OrgAccess, RateLimit, UiError } from '../shared/protocol';
import { createGitHub, type GitHub } from '../github/client';
import { orgSsoUrl, parseSsoHeader } from '../github/sso';

export const SCOPES = ['repo', 'read:org', 'workflow'];

interface Org {
  id: number;
  login: string;
}

export class GitHubAuth implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<AuthState>();
  readonly onDidChange = this.emitter.event;

  private _state: AuthState = { status: 'checking' };
  private _gh: GitHub | undefined;
  private orgs: Org[] = [];
  private readonly ssoBlocked = new Set<string>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly onRateLimit: (rl: RateLimit) => void,
    private readonly log: (msg: string) => void,
  ) {
    this.subscription = vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'github') void this.connect(false);
    });
  }

  get state(): AuthState {
    return this._state;
  }

  /** The authenticated client; only defined while signed in. */
  get gh(): GitHub | undefined {
    return this._state.status === 'signedIn' ? this._gh : undefined;
  }

  async connect(interactive: boolean): Promise<void> {
    this.set({ status: 'checking' });
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('github', SCOPES, interactive ? { createIfNone: true } : { silent: true });
    } catch (err) {
      // The user dismissed the sign-in prompt.
      this.log(`Sign-in cancelled: ${(err as Error).message}`);
    }
    if (!session) {
      this.set({ status: 'signedOut' });
      return;
    }

    this._gh = createGitHub(session.accessToken, this.onRateLimit, this.log);
    try {
      const { data: user } = await this._gh.rest.users.getAuthenticated();
      this.orgs = (await this._gh.paginate(this._gh.rest.orgs.listForAuthenticatedUser, { per_page: 100 })).map((o) => ({
        id: o.id,
        login: o.login,
      }));
      this.ssoBlocked.clear();
      this.set({
        status: 'signedIn',
        user: { login: user.login, name: user.name, avatarUrl: user.avatar_url },
        orgs: this.orgAccess(),
      });
    } catch (err) {
      this.set({ status: 'error', error: describeError(err) });
    }
  }

  /** Record orgs that GitHub omitted from a listing because SSO isn't authorised for them. */
  markSsoBlocked(orgIds: number[]): void {
    if (this._state.status !== 'signedIn' || orgIds.length === 0) return;
    let changed = false;
    for (const id of orgIds) {
      const org = this.orgs.find((o) => o.id === id);
      if (org && !this.ssoBlocked.has(org.login)) {
        this.ssoBlocked.add(org.login);
        changed = true;
      }
    }
    if (changed) this.set({ ...this._state, orgs: this.orgAccess() });
  }

  private orgAccess(): OrgAccess[] {
    return this.orgs.map((o) =>
      this.ssoBlocked.has(o.login)
        ? { login: o.login, authorized: false, ssoUrl: orgSsoUrl(o.login) }
        : { login: o.login, authorized: true },
    );
  }

  private set(state: AuthState): void {
    this._state = state;
    this.emitter.fire(state);
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

/** Turns an Octokit/network failure into a short UI error with a fix action. */
export function describeError(err: unknown): UiError {
  const e = err as { status?: number; message?: string; response?: { headers?: Record<string, string> } };
  const sso = parseSsoHeader(e.response?.headers?.['x-github-sso']);
  if (sso?.kind === 'required') {
    return { label: 'SSO authorization needed', detail: e.message, action: { label: 'Authorize', command: { type: 'openExternal', url: sso.url } } };
  }
  if (e.status === 401) {
    return { label: 'Session expired', detail: e.message, action: { label: 'Sign in', command: { type: 'signIn' } } };
  }
  if (e.status === 404) {
    return { label: 'Not found', detail: e.message, action: { label: 'Retry', command: { type: 'refresh' } } };
  }
  if (e.status === 403) {
    return { label: 'Access denied', detail: e.message, action: { label: 'Retry', command: { type: 'refresh' } } };
  }
  if (e.status === undefined) {
    return { label: 'GitHub unreachable', detail: e.message, action: { label: 'Retry', command: { type: 'refresh' } } };
  }
  return { label: `GitHub error ${e.status}`, detail: e.message, action: { label: 'Retry', command: { type: 'refresh' } } };
}
