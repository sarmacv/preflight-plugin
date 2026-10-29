import { describe, expect, it } from 'vitest';
import { runScan, type ScanEvents } from '../src/engine/queue';
import { parseSkill } from '../src/skills/parser';
import type { CheckResult } from '../src/skills/types';
import { fakeRepo } from './helpers/fakeRepo';

const BODY = '\n## What this checks\na\n## How to evaluate\nb\n## Pass criteria\nc\n## Fail criteria\nd\n## How to fix\ne\n';
const skill = (id: string, file: string) =>
  parseSkill(`---\nid: ${id}\nname: ${id}\ncategory: t\nseverity: high\nevaluation: deterministic\nfixable: false\nrules:\n  - file_exists: ${file}\n---\n${BODY}`, `t/${id}.md`);

const skills = [skill('readme', 'README.md'), skill('license', 'LICENSE'), skill('agents', 'AGENTS.md')];

function recorder() {
  const log: string[] = [];
  const done: Record<string, CheckResult[]> = {};
  const events: ScanEvents = {
    repoStarted: (repo) => log.push(`start ${repo}`),
    checkStarted: () => {},
    checkDone: () => {},
    repoDone: (repo, score, results) => {
      log.push(`done ${repo} ${score.score}`);
      done[repo] = results;
    },
    repoFailed: (repo, err) => log.push(`failed ${repo} ${(err as Error).message}`),
  };
  return { log, done, events };
}

describe('runScan', () => {
  it('scans repos one at a time and keeps catalogue order', async () => {
    const r = recorder();
    const summary = await runScan(
      {
        targets: [{ repo: 'acme/a', branch: 'main' }, { repo: 'acme/b', branch: 'dev' }],
        skills,
        createContext: async (t) => fakeRepo(t.repo === 'acme/a' ? { 'README.md': '', LICENSE: '' } : {}),
        signal: new AbortController().signal,
      },
      r.events,
    );
    expect(r.log).toEqual(['start acme/a', 'done acme/a 67', 'start acme/b', 'done acme/b 0']);
    expect(r.done['acme/a'].map((x) => x.checkId)).toEqual(['readme', 'license', 'agents']);
    expect(summary).toEqual({ cancelled: false, completed: ['acme/a', 'acme/b'] });
  });

  it('reports a repo that cannot be opened and moves on', async () => {
    const r = recorder();
    await runScan(
      {
        targets: [{ repo: 'acme/gone', branch: 'main' }, { repo: 'acme/b', branch: 'main' }],
        skills,
        createContext: async (t) => {
          if (t.repo === 'acme/gone') throw new Error('Branch not found');
          return fakeRepo({});
        },
        signal: new AbortController().signal,
      },
      r.events,
    );
    expect(r.log).toEqual(['start acme/gone', 'failed acme/gone Branch not found', 'start acme/b', 'done acme/b 0']);
  });

  it('stops on cancel and keeps completed repos', async () => {
    const r = recorder();
    const ac = new AbortController();
    r.events.repoDone = ((orig) => (...args: Parameters<ScanEvents['repoDone']>) => {
      orig(...args);
      ac.abort();
    })(r.events.repoDone);
    const summary = await runScan(
      { targets: ['a', 'b', 'c'].map((x) => ({ repo: `acme/${x}`, branch: 'main' })), skills, createContext: async () => fakeRepo({}), signal: ac.signal },
      r.events,
    );
    expect(summary).toEqual({ cancelled: true, completed: ['acme/a'] });
    expect(r.log).toEqual(['start acme/a', 'done acme/a 0']);
  });
});

describe('prerequisites', () => {
  const dep = (id: string, file: string, dependsOn: string) =>
    parseSkill(`---\nid: ${id}\nname: ${id}\ncategory: t\nseverity: high\nevaluation: deterministic\nfixable: false\ndepends_on: [${dependsOn}]\nrules:\n  - file_exists: ${file}\n---\n${BODY}`, `t/${id}.md`);

  it('skips a check whose prerequisite fails, even when listed first', async () => {
    const r = recorder();
    const skills = [dep('quality', 'AGENTS.md', 'present'), skill('present', 'AGENTS.md')];
    await runScan({ targets: [{ repo: 'acme/a', branch: 'main' }], skills, createContext: async () => fakeRepo({}), signal: new AbortController().signal }, r.events);
    const byId = Object.fromEntries(r.done['acme/a'].map((x) => [x.checkId, x]));
    expect(byId.present.status).toBe('fail');
    expect(byId.quality.status).toBe('skipped');
    expect(byId.quality.evidence[0].message).toBe('Needs "present" to pass first');
    // Skipped dependents don't count against the score twice.
    expect(r.log).toContain('done acme/a 0');
  });

  it('runs the dependent normally when the prerequisite passes', async () => {
    const r = recorder();
    const skills = [skill('present', 'AGENTS.md'), dep('quality', 'AGENTS.md', 'present')];
    await runScan({ targets: [{ repo: 'acme/a', branch: 'main' }], skills, createContext: async () => fakeRepo({ 'AGENTS.md': 'x' }), signal: new AbortController().signal }, r.events);
    expect(r.done['acme/a'].map((x) => x.status)).toEqual(['pass', 'pass']);
  });

  it('orders prerequisites first', async () => {
    const { dependencyOrder } = await import('../src/engine/queue');
    const order = dependencyOrder([dep('c', 'x', 'b'), dep('b', 'x', 'a'), skill('a', 'x')]).map((s) => s.id);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
