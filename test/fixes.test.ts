import { describe, expect, it } from 'vitest';
import type { GitHub } from '../src/github/client';
import type { ModelProvider } from '../src/ai/provider';
import { BUILTIN_FIXES } from '../src/fix/builtinFixes';
import { planRepoFixes } from '../src/fix/planner';
import { parseSkill } from '../src/skills/parser';
import type { CheckResult, Skill } from '../src/skills/types';
import type { SonarLink } from '../src/sonar/access';
import { fakeRepo, HttpError } from './helpers/fakeRepo';

const SHA = 'a'.repeat(40);

describe('builtin fixes', () => {
  it('pins actions to commit SHAs and keeps the tag as a comment', async () => {
    const gh = {
      rest: { repos: { getCommit: async ({ owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
        if (repo === 'gone') throw new HttpError(404);
        return { data: { sha: `${owner}${repo}${ref}`.replace(/[^a-f0-9]/g, '').padEnd(40, 'f').slice(0, 40) } };
      } } },
    } as unknown as GitHub;
    const ctx = fakeRepo({
      '.github/workflows/ci.yml': [
        'steps:',
        '  - uses: actions/checkout@v4',
        `  - uses: actions/setup-node@${SHA} # v4`,
        '  - uses: ./local',
        '  - uses: github/codeql-action/init@v3 # keep',
        '  - uses: acme/gone@v1',
      ].join('\n'),
    }, { gh });
    const fix = await BUILTIN_FIXES.pin_actions(ctx);
    const out = fix.changes[0].content!.split('\n');
    expect(out[1]).toMatch(/^  - uses: actions\/checkout@[0-9a-f]{40} # v4$/);
    expect(out[2]).toBe(`  - uses: actions/setup-node@${SHA} # v4`);
    expect(out[3]).toBe('  - uses: ./local');
    expect(out[4]).toMatch(/^  - uses: github\/codeql-action\/init@[0-9a-f]{40} # v3$/);
    expect(out[5]).toBe('  - uses: acme/gone@v1');
    expect(fix.notes).toMatch(/Could not resolve: .*acme\/gone@v1/);
  });

  it('writes .gitignore for detected stacks and a proprietary LICENSE for private repos', async () => {
    const ctx = fakeRepo({ 'package.json': '{}', 'main.tf': '' }, { info: { private: true } });
    const fix = await BUILTIN_FIXES.gitignore_license(ctx);
    const files = Object.fromEntries(fix.changes.map((c) => [c.path, c.content!]));
    expect(files['.gitignore']).toMatch(/# Node[\s\S]*# Terraform[\s\S]*# Editors and OS/);
    expect(files['.gitignore']).not.toMatch(/# Python/);
    expect(files.LICENSE).toMatch(/All rights reserved[\s\S]*internal use by acme/);
  });

  it('does not pick a licence for a public repo', async () => {
    const fix = await BUILTIN_FIXES.gitignore_license(fakeRepo({ '.gitignore': '' }, { info: { private: false } }));
    expect(fix.changes).toEqual([]);
    expect(fix.notes).toMatch(/public/);
  });

  it('proposes CODEOWNERS from active committers with write access, skipping bots', async () => {
    const commits = ['ann', 'bob', 'ann', 'dependabot[bot]', 'cat', 'ann', 'bob', 'dan', null].map((login) => ({ author: login ? { login } : null }));
    const gh = {
      rest: { repos: {
        listCommits: async () => ({ data: commits }),
        getCollaboratorPermissionLevel: async ({ username }: { username: string }) => ({ data: { permission: username === 'bob' ? 'read' : 'write', role_name: username === 'bob' ? 'read' : 'write' } }),
      } },
    } as unknown as GitHub;
    const fix = await BUILTIN_FIXES.codeowners_from_history(fakeRepo({}, { gh }));
    expect(fix.changes[0].path).toBe('.github/CODEOWNERS');
    expect(fix.changes[0].content).toMatch(/^\* @ann @cat @dan$/m);
    expect(fix.editable).toEqual(['.github/CODEOWNERS']);
  });

  it('adds only the missing templates', async () => {
    const fix = await BUILTIN_FIXES.pr_issue_templates(fakeRepo({ '.github/PULL_REQUEST_TEMPLATE/default.md': 'x' }));
    expect(fix.changes.map((c) => c.path)).toEqual(['.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml']);
  });

  it('generates an SPDX SBOM from manifests off the default branch', async () => {
    const lock = JSON.stringify({ packages: { '': {}, 'node_modules/@scope/pkg': { version: '1.2.3', license: 'MIT' } } });
    const fix = await BUILTIN_FIXES.generate_sbom(fakeRepo({ 'package-lock.json': lock }, { info: { ref: 'dev' } }));
    const doc = JSON.parse(fix.changes[0].content!);
    expect(fix.changes[0].path).toBe('sbom/sbom.spdx.json');
    expect(doc.spdxVersion).toBe('SPDX-2.3');
    expect(doc.packages[0]).toMatchObject({ name: '@scope/pkg', versionInfo: '1.2.3', licenseConcluded: 'MIT' });
    expect(doc.packages[0].externalRefs[0].referenceLocator).toBe('pkg:npm/%40scope/pkg@1.2.3');
  });
});

const BODY = '\n## What this checks\na\n## How to evaluate\nb\n## Pass criteria\nc\n## Fail criteria\nd\n## How to fix\ne\n';
const mk = (fm: string): Skill => parseSkill(`---\n${fm}\n---\n${BODY}`, 'x.md');
const fail = (s: Skill): CheckResult => ({ checkId: s.id, name: s.name, category: s.category, categoryName: s.categoryName, severity: s.severity, status: 'fail', evidence: [{ message: 'missing' }], fixable: s.fixable, fixPr: s.fix_pr, durationMs: 0 });

const templateSkill = mk("id: sonar\nname: Sonar\ncategory: code-quality\nseverity: high\nevaluation: deterministic\nfixable: true\nrules:\n  - file_exists: x\nfix:\n  kind: template\n  path: sonar-project.properties\n  template: \"sonar.projectKey={repo}\\n\"");
const aiSkill = mk('id: agents\nname: Agents\ncategory: ai-readiness\nseverity: medium\nevaluation: deterministic\nfixable: true\nrules:\n  - file_exists: AGENTS.md\nfix:\n  kind: ai\n  path: AGENTS.md\ncontext_files: [README.md]');
const aiSkill2 = mk('id: agents-quality\nname: Agents quality\ncategory: ai-readiness\nseverity: medium\nevaluation: hybrid\nfixable: true\nrules:\n  - file_exists: AGENTS.md\nfix:\n  kind: ai\n  path: AGENTS.md');
const coverageSkill = mk('id: test-coverage\nname: Coverage\ncategory: code-quality\nseverity: high\nevaluation: deterministic\nfixable: true\nfix_pr: coverage\nrules:\n  - builtin: { name: sonar_coverage }\nfix:\n  kind: ai');

const provider: ModelProvider = {
  id: 'fake',
  label: 'Fake',
  evaluate: async () => ({ status: 'pass', evidence: [] }),
  generateFix: async (skill, ctx) => {
    if (skill.id === 'test-coverage') {
      const src = ctx.files[0].path;
      return { changes: [{ path: src.replace('src/', 'test/').replace('.ts', '.test.ts'), content: `test(${JSON.stringify(src)})` }, { path: src, content: 'hacked' }], notes: '- Tests mock the network' };
    }
    return { changes: [{ path: 'AGENTS.md', content: `# Agents\nfrom ${ctx.files.map((f) => f.path).join(',')}` }], notes: '- Confirm the commands' };
  },
};

const sonar = {
  lowestCoverage: async () => ({ projectKey: 'api', files: [{ path: 'src/a.ts', coverage: 10, uncoveredLines: 40 }, { path: 'missing.ts', coverage: 0, uncoveredLines: 9 }] }),
} as unknown as SonarLink;

describe('planRepoFixes', () => {
  const files = { 'README.md': '# Api', 'src/a.ts': 'export const a = 1;', 'test/b.test.ts': 'test()', 'package.json': '{}' };

  it('builds a Fixes PR from template and AI fixes, crediting both checks for a shared file', async () => {
    const skills = [templateSkill, aiSkill, aiSkill2];
    const plan = await planRepoFixes({
      ctx: fakeRepo(files), skills, results: skills.map(fail), provider, branchTemplate: '{type}/{check-or-category}', coverageMaxFiles: 5, user: 'me',
    });
    expect(plan.prs).toHaveLength(1);
    const pr = plan.prs[0];
    expect(pr).toMatchObject({ kind: 'fixes', base: 'main', draft: false, branch: 'fixes/multi' });
    expect(pr.files.map((f) => [f.path, f.checkIds])).toEqual([['sonar-project.properties', ['sonar']], ['AGENTS.md', ['agents', 'agents-quality']]]);
    expect(pr.files[0].after).toBe('sonar.projectKey=api\n');
    expect(pr.files[1].after).toContain('from AGENTS.md,README.md'.replace('AGENTS.md,', ''));
    expect(pr.checks.map((c) => c.id)).toEqual(['sonar', 'agents', 'agents-quality']);
  });

  it('reports AI fixes as not fixed without a model', async () => {
    const plan = await planRepoFixes({ ctx: fakeRepo(files), skills: [aiSkill], results: [fail(aiSkill)], branchTemplate: '', coverageMaxFiles: 5, user: 'me' });
    expect(plan.prs).toEqual([]);
    expect(plan.problems[0]).toMatchObject({ checkId: 'agents', reason: expect.stringMatching(/AI isn't available/) });
  });

  it('builds a draft Coverage PR with test files only', async () => {
    const plan = await planRepoFixes({
      ctx: fakeRepo(files), skills: [coverageSkill], results: [fail(coverageSkill)], provider, sonar, branchTemplate: '{type}', coverageMaxFiles: 5, user: 'me',
    });
    const pr = plan.prs[0];
    expect(pr).toMatchObject({ kind: 'coverage', draft: true, branch: 'coverage' });
    expect(pr.files.map((f) => f.path)).toEqual(['test/a.test.ts']);
    expect(pr.notes.join('\n')).toMatch(/src\/a\.ts \(10% covered\)/);
    expect(pr.notes.join('\n')).toMatch(/src\/a\.ts \(not a test file, dropped\)/);
    expect(pr.notes.join('\n')).toMatch(/missing\.ts \(not found/);
  });

  it('only opens the Fixes PR when coverage passes', async () => {
    const skills = [templateSkill, coverageSkill];
    const results = [fail(templateSkill), { ...fail(coverageSkill), status: 'pass' as const }];
    const plan = await planRepoFixes({ ctx: fakeRepo(files), skills, results, provider, sonar, branchTemplate: '', coverageMaxFiles: 5, user: 'me' });
    expect(plan.prs.map((p) => p.kind)).toEqual(['fixes']);
  });
});
