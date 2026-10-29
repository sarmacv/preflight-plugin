import { describe, expect, it } from 'vitest';
import { runCheck, ScanCancelled } from '../src/engine/engine';
import { scoreRepo, sortResults } from '../src/engine/score';
import { parseSkill } from '../src/skills/parser';
import type { ModelProvider } from '../src/ai/provider';
import type { CheckResult, Severity } from '../src/skills/types';
import { fakeGitHub, fakeRepo, HttpError } from './helpers/fakeRepo';

const BODY = '\n## What this checks\na\n## How to evaluate\nb\n## Pass criteria\nc\n## Fail criteria\nd\n## How to fix\ne\n';
const make = (fm: string) =>
  parseSkill(`---\nid: t\nname: Test\ncategory: test\nseverity: high\nfixable: false\n${fm}\n---\n${BODY}`, 'test/t.md');

const provider = (status: 'pass' | 'fail'): ModelProvider => ({
  id: 'fake',
  label: 'Fake',
  evaluate: async (_skill, ctx) => ({ status, evidence: [{ message: `model saw ${ctx.files.map((f) => f.path).join(',')}` }] }),
  generateFix: async () => ({ changes: [] }),
});

describe('runCheck', () => {
  it('skips when applies_to matches nothing', async () => {
    const skill = make("evaluation: deterministic\napplies_to:\n  any_file: ['**/*.tf']\nrules:\n  - file_exists: x");
    const r = await runCheck(skill, fakeRepo({ 'a.md': '' }));
    expect(r.status).toBe('skipped');
    expect(r.evidence[0].message).toMatch(/Not applicable/);
  });

  it('skips AI checks without a model', async () => {
    expect((await runCheck(make('evaluation: ai'), fakeRepo({}))).status).toBe('skipped');
  });

  it('sends context files to the model, never secrets', async () => {
    const skill = make("evaluation: ai\ncontext_files: ['**/*']");
    const ctx = fakeRepo({ 'README.md': 'x', '.env': 'SECRET=1', 'certs/server.key': 'k' });
    const r = await runCheck(skill, ctx, { provider: provider('pass') });
    expect(r.status).toBe('pass');
    expect(r.evidence[0].message).toBe('model saw README.md');
  });

  it('hybrid: failing rules short-circuit the model', async () => {
    const skill = make('evaluation: hybrid\nrules:\n  - file_exists: AGENTS.md');
    const r = await runCheck(skill, fakeRepo({}), { provider: provider('pass') });
    expect(r.status).toBe('fail');
  });

  it('hybrid: passing rules defer to the model', async () => {
    const skill = make('evaluation: hybrid\nrules:\n  - file_exists: AGENTS.md');
    const r = await runCheck(skill, fakeRepo({ 'AGENTS.md': 'x' }), { provider: provider('fail') });
    expect(r.status).toBe('fail');
    expect(r.evidence).toHaveLength(2);
  });

  it('hybrid without a model keeps the rule result and says so', async () => {
    const skill = make('evaluation: hybrid\nrules:\n  - file_exists: AGENTS.md');
    const r = await runCheck(skill, fakeRepo({ 'AGENTS.md': 'x' }));
    expect(r.status).toBe('pass');
    expect(r.evidence.at(-1)?.message).toMatch(/AI review unavailable/);
  });

  it('maps API failures to an error result', async () => {
    const gh = fakeGitHub({ request: () => { throw new HttpError(403, 'Resource not accessible'); } });
    const skill = make("evaluation: deterministic\nrules:\n  - api_field: { endpoint: 'GET /repos/{owner}/{repo}', field: x }");
    const r = await runCheck(skill, fakeRepo({}, { gh }));
    expect(r.status).toBe('error');
    expect(r.evidence[0].message).toBe('Permission denied: Resource not accessible');
  });

  it('throws ScanCancelled when the scan is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runCheck(make('evaluation: ai'), fakeRepo({}, { signal: ac.signal }))).rejects.toBeInstanceOf(ScanCancelled);
  });
});

const res = (severity: Severity, status: CheckResult['status'], id = `${severity}-${status}`): CheckResult => ({
  checkId: id, name: id, category: 'c', categoryName: 'C', severity, status, evidence: [], fixable: false, fixPr: 'fixes', durationMs: 0,
});

describe('scoring', () => {
  it('weights by severity and ignores skipped and errored checks', () => {
    const s = scoreRepo([res('critical', 'pass'), res('low', 'fail'), res('high', 'skipped'), res('medium', 'error')]);
    expect(s.score).toBe(91); // 10 / 11
    expect(s.verdict).toBe('cleared');
    expect(s).toMatchObject({ passed: 1, failed: 1, skipped: 1, errored: 1 });
  });

  it('grounds a repo on any critical or high failure', () => {
    expect(scoreRepo([res('high', 'fail')]).verdict).toBe('grounded');
    expect(scoreRepo([res('medium', 'fail'), res('low', 'fail')]).verdict).toBe('cleared');
  });

  it('scores an empty run as 100', () => {
    expect(scoreRepo([]).score).toBe(100);
  });

  it('pins critical failures to the top', () => {
    const sorted = sortResults([res('low', 'pass'), res('low', 'fail'), res('critical', 'fail'), res('high', 'error'), res('high', 'fail')]);
    expect(sorted.map((r) => r.checkId)).toEqual(['critical-fail', 'high-fail', 'low-fail', 'high-error', 'low-pass']);
  });
});
