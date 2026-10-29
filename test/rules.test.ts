import { describe, expect, it } from 'vitest';
import { evaluateRule, evaluateRules } from '../src/skills/rules';
import { inRange, compareVersions } from '../src/skills/rules/versions';
import { fakeGitHub, fakeRepo } from './helpers/fakeRepo';

const repo = fakeRepo({
  'README.md': '# API\n\nHello',
  '.github/CODEOWNERS': '* @acme/team',
  '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: npm test\n',
  'src/index.ts': 'export {}',
});

const status = async (rule: Record<string, unknown>) => (await evaluateRule(rule, repo)).status;

describe('file rules', () => {
  it('file_exists is case-insensitive and returns the stored path', async () => {
    const o = await evaluateRule({ file_exists: '.github/codeowners' }, repo);
    expect(o.status).toBe('pass');
    expect(o.evidence[0].path).toBe('.github/CODEOWNERS');
    expect(await status({ file_exists: 'LICENSE' })).toBe('fail');
  });

  it('any_file_exists passes on the first hit', async () => {
    expect(await status({ any_file_exists: ['CODEOWNERS', '.github/CODEOWNERS'] })).toBe('pass');
    expect(await status({ any_file_exists: ['AGENTS.md', 'CLAUDE.md'] })).toBe('fail');
  });

  it('glob_present and glob_absent', async () => {
    expect(await status({ glob_present: 'src/**/*.ts' })).toBe('pass');
    expect(await status({ glob_present: ['**/*.py'] })).toBe('fail');
    expect(await status({ glob_absent: '**/*.py' })).toBe('pass');
    expect(await status({ glob_absent: '**/*.md' })).toBe('fail');
  });

  it('file_min_content measures characters, lines, headings and placeholders', async () => {
    const good = fakeRepo({ 'AGENTS.md': `# Agents\n\n## Build\n${'Run npm ci then npm test.\n'.repeat(12)}` });
    const stub = fakeRepo({ 'AGENTS.md': '# Agents\n\nTODO\n' });
    const rule = { file_min_content: { paths: ['AGENTS.md'], min_chars: 200, min_lines: 5, min_headings: 2, reject: ['^\\s*TODO\\s*$'] } };
    expect((await evaluateRule(rule, good)).status).toBe('pass');
    const o = await evaluateRule(rule, stub);
    expect(o.status).toBe('fail');
    expect(o.evidence[0].message).toMatch(/characters.*lines.*headings.*placeholder/);
  });

  it('file_contains searches paths and globs', async () => {
    expect(await status({ file_contains: { paths: ['README.md'], pattern: 'hello' } })).toBe('pass');
    expect(await status({ file_contains: { globs: ['**/*.md'], pattern: 'goodbye' } })).toBe('fail');
    expect(await status({ file_contains: { paths: ['NOPE.md'], pattern: 'x' } })).toBe('fail');
  });

  it('workflow_contains searches CI configuration', async () => {
    expect(await status({ workflow_contains: 'npm (run )?test' })).toBe('pass');
    expect(await status({ workflow_contains: { pattern: 'sonar', description: 'Sonar' } })).toBe('fail');
    expect((await evaluateRule({ workflow_contains: 'x' }, fakeRepo({}))).evidence[0].message).toMatch(/No CI/);
  });
});

describe('api_field', () => {
  const gh = fakeGitHub({ request: (route) => (route === 'GET /repos/{owner}/{repo}' ? { has_wiki: false, open_issues: 3, license: { spdx_id: 'MIT' } } : undefined) });
  const ctx = fakeRepo({}, { gh });
  const run = async (p: Record<string, unknown>) => (await evaluateRule({ api_field: { endpoint: 'GET /repos/{owner}/{repo}', ...p } }, ctx)).status;

  it('supports equals, exists and gte', async () => {
    expect(await run({ field: 'has_wiki', equals: false })).toBe('pass');
    expect(await run({ field: 'license.spdx_id', exists: true })).toBe('pass');
    expect(await run({ field: 'missing', exists: true })).toBe('fail');
    expect(await run({ field: 'open_issues', gte: 5 })).toBe('fail');
  });

  it('refuses non-GET endpoints', async () => {
    const o = await evaluateRules([{ api_field: { endpoint: 'DELETE /repos/{owner}/{repo}', field: 'x' } }], ctx);
    expect(o.status).toBe('error');
    expect(o.evidence[0].message).toMatch(/only GET/);
  });
});

describe('combinators', () => {
  it('all_of fails with only the failing evidence', async () => {
    const o = await evaluateRule({ all_of: [{ file_exists: 'README.md' }, { file_exists: 'LICENSE' }] }, repo);
    expect(o.status).toBe('fail');
    expect(o.evidence).toHaveLength(1);
    expect(o.evidence[0].message).toMatch(/LICENSE/);
  });

  it('any_of passes if one passes', async () => {
    expect(await status({ any_of: [{ file_exists: 'LICENSE' }, { file_exists: 'README.md' }] })).toBe('pass');
    expect(await status({ any_of: [{ file_exists: 'LICENSE' }, { file_exists: 'COPYING' }] })).toBe('fail');
  });

  it('not inverts', async () => {
    expect(await status({ not: { file_exists: 'LICENSE' } })).toBe('pass');
  });

  it('unknown rules surface as a skill configuration error', async () => {
    const o = await evaluateRules([{ bogus: true }], repo);
    expect(o.status).toBe('error');
    expect(o.evidence[0].message).toMatch(/Skill misconfigured: unknown rule "bogus"/);
  });

  it('bad parameters surface as a skill configuration error', async () => {
    expect((await evaluateRules([{ any_file_exists: 'not-an-array' }], repo)).status).toBe('error');
  });
});

describe('versions', () => {
  it('compares numerically and orders pre-releases first', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v2.0.0', '2.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
  });

  it('evaluates advisory ranges', () => {
    expect(inRange('4.17.20', '< 4.17.21')).toBe(true);
    expect(inRange('4.17.21', '< 4.17.21')).toBe(false);
    expect(inRange('1.1.0', '>= 1.0.0, < 1.2.3')).toBe(true);
    expect(inRange('1.2.3', '>= 1.0.0, < 1.2.3')).toBe(false);
    expect(inRange('2.0.0', '= 2.0.0')).toBe(true);
  });
});
