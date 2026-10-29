import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import type { RateLimit } from '../shared/protocol';
import { readRateLimit } from './rateLimit';

const PreflightOctokit = Octokit.plugin(throttling, retry);
export type GitHub = InstanceType<typeof PreflightOctokit>;

const MAX_THROTTLE_RETRIES = 3;

interface RequestInfo {
  method: string;
  url: string;
}

export function createGitHub(token: string, onRateLimit: (rl: RateLimit) => void, log: (msg: string) => void): GitHub {
  let last: RateLimit | undefined;
  const waiting = () => last && onRateLimit({ ...last, state: 'waiting' });

  const octokit = new PreflightOctokit({
    auth: token,
    userAgent: 'preflight-vscode',
    throttle: {
      onRateLimit: (retryAfter: number, options: RequestInfo, _o: unknown, retryCount: number) => {
        log(`Primary rate limit hit for ${options.method} ${options.url}; retrying in ${retryAfter}s`);
        waiting();
        return retryCount < MAX_THROTTLE_RETRIES;
      },
      onSecondaryRateLimit: (retryAfter: number, options: RequestInfo, _o: unknown, retryCount: number) => {
        log(`Secondary rate limit hit for ${options.method} ${options.url}; retrying in ${retryAfter}s`);
        waiting();
        return retryCount < MAX_THROTTLE_RETRIES;
      },
    },
    // Failed requests are handled by the caller; only deprecations and throttling warnings are logged.
    log: { debug: () => {}, info: () => {}, warn: log, error: () => {} },
  });

  octokit.hook.after('request', (response) => {
    const rl = readRateLimit(response.headers as Record<string, string>);
    if (rl) {
      last = rl;
      onRateLimit(rl);
    }
  });

  return octokit;
}
