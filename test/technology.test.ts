import { describe, expect, it } from 'vitest';
import { evaluateRule } from '../src/skills/rules';
import { technologyProfile } from '../src/skills/rules/technology';
import { runCheck } from '../src/engine/engine';
import { loadSkills } from '../src/skills/loader';
import { join } from 'node:path';
import { fakeRepo } from './helpers/fakeRepo';
import type { SonarAccess } from '../src/engine/context';
import type { CheckResult } from '../src/skills/types';

const required = (files: Record<string, string>, min = 5) => evaluateRule({ builtin: { name: 'sonar_required', params: { min_source_files: min } } }, fakeRepo(files));
const many = (prefix: string, ext: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}/f${i}.${ext}`, '']));

describe('technologyProfile', () => {
  it('counts application source by language and ignores tests, config code and vendored output', () => {
    const p = technologyProfile([
      'src/a.ts', 'src/b.tsx', 'src/a.test.ts', 'test/x.ts', 'src/types.d.ts', 'vite.config.ts', '.eslintrc.js',
      'node_modules/lib/index.js', 'dist/out.js', 'app/main.py', 'conftest.py', 'README.md', 'docs/guide.md', 'k8s/deploy.yaml', 'main.tf', 'Dockerfile',
    ]);
    expect(p.source).toEqual({ TypeScript: 2, Python: 1 });
    expect(p.sourceFiles).toBe(3);
    expect(p.other).toEqual({ Docs: 2, Config: 1, 'Terraform/IaC': 1, Docker: 1 });
  });
});

describe('sonar_required', () => {
  it('is required for a repo with application code', async () => {
    const o = await required({ ...many('src', 'ts', 6), 'README.md': '' });
    expect(o.status).toBe('pass');
    expect(o.evidence[0].message).toBe('Required: application code found (TypeScript 6 files)');
  });

  it('is not required for a docs-only repo', async () => {
    const o = await required({ ...many('docs', 'md', 12), 'mkdocs.yml': '' });
    expect(o.status).toBe('skipped');
    expect(o.evidence[0].message).toBe('Not required: no application code; repo is Docs 12, Config 1 files');
  });

  it('is not required for infrastructure-as-code', async () => {
    const o = await required({ ...many('infra', 'tf', 8), 'scripts/deploy.sh': '', 'charts/api/Chart.yaml': '' });
    expect(o.status).toBe('skipped');
    expect(o.evidence[0].message).toMatch(/^Not required: no application code; repo is Terraform\/IaC 8/);
  });

  it('is not required below the source-file minimum', async () => {
    const o = await required({ 'docs/a.md': '', 'tools/gen.py': '' });
    expect(o.evidence[0].message).toBe('Not required: only 1 source file (Python 1); repo is Docs 1 files');
  });

  it('is always required when sonar-project.properties exists', async () => {
    const o = await required({ 'sonar-project.properties': 'sonar.projectKey=x', 'docs/a.md': '' });
    expect(o.status).toBe('pass');
    expect(o.evidence[0].message).toMatch(/^Required: sonar-project.properties is present/);
  });
});

describe('Code Quality chain', () => {
  const run = async (files: Record<string, string>) => {
    const { skills } = await loadSkills(join(__dirname, '..', 'skills'));
    const chain = skills.filter((s) => s.category === 'code-quality');
    const ctx = fakeRepo(files);
    const results: Record<string, { status: string; message?: string }> = {};
    for (const s of chain) {
      const prerequisites = s.depends_on.map((id) => results[id]).filter(Boolean) as never[];
      const r = await runCheck(s, ctx, { prerequisites });
      results[s.id] = r as never;
      (results[s.id] as { message?: string }).message = r.evidence[0]?.message;
    }
    return { order: chain.map((s) => s.id), results };
  };

  it('is ordered required, onboarded, coverage', async () => {
    expect((await run({})).order).toEqual(['sonar-required', 'sonar-onboarded', 'sonar-code-coverage']);
  });

  it('skips the whole chain with the same reason for a docs-only repo', async () => {
    const { results } = await run(many('docs', 'md', 3));
    expect(Object.values(results).map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(results['sonar-code-coverage'].message).toBe('Not required: no application code; repo is Docs 3 files');
  });

  it('fails onboarding for a code repo without Sonar, and reports coverage in the same scan', async () => {
    const { results } = await run(many('src', 'go', 7));
    expect(results['sonar-required'].status).toBe('pass');
    expect(results['sonar-onboarded'].status).toBe('fail');
    // Coverage no longer waits for onboarding; without SonarQube it is estimated from the code.
    expect(results['sonar-code-coverage']).toMatchObject({ status: 'fail', message: 'Estimated: 0 of 7 source files have tests (0%, threshold 80%)' });
  });
});

describe('one scan, full picture (Sonar server configured)', () => {
  const sonar = (project?: string, coverage?: number): SonarAccess => ({
    findProject: async () => (project ? { projectKey: project, url: `https://sonar/${project}` } : undefined),
    coverage: async () => (project ? { projectKey: project, coverage, url: `https://sonar/${project}` } : undefined),
  });
  const runChain = async (files: Record<string, string>, access: SonarAccess) => {
    const { skills } = await loadSkills(join(__dirname, '..', 'skills'));
    const ctx = fakeRepo(files, { settings: { sonar: access } });
    const out: Record<string, CheckResult> = {};
    for (const s of skills.filter((x) => x.category === 'code-quality')) {
      out[s.id] = await runCheck(s, ctx, { prerequisites: s.depends_on.map((id) => out[id]).filter(Boolean) });
    }
    return out;
  };

  it('counts a project that exists on the server as onboarded, even without sonar-project.properties', async () => {
    const r = await runChain(many('src', 'ts', 6), sonar('skillcraft', 85));
    expect(r['sonar-onboarded'].status).toBe('pass');
    expect(r['sonar-onboarded'].evidence[0].message).toBe('SonarQube project skillcraft exists');
    expect(r['sonar-code-coverage'].status).toBe('pass');
  });

  it('fails onboarding and coverage together when the repo has no Sonar project, so one Fix covers both', async () => {
    const r = await runChain(many('src', 'ts', 6), sonar());
    expect(r['sonar-onboarded'].status).toBe('fail');
    expect(r['sonar-code-coverage'].status).toBe('fail');
    expect(r['sonar-code-coverage'].evidence[0].message).toBe('Estimated: 0 of 6 source files have tests (0%, threshold 80%)');
    expect(r['sonar-code-coverage'].evidence[1].message).toBe('5 more source files need tests to reach 80%; counts source files with a test file named after them');
  });
});

describe('estimateTestCoverage', () => {
  const isTest = (p: string) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.|_test\.|^test_|\/test_|Test\.java$/.test(p);

  it('matches tests to the source file they are named after', async () => {
    const { estimateTestCoverage } = await import('../src/skills/rules/technology');
    const est = estimateTestCoverage(
      [
        'src/user.service.ts', 'src/user.service.spec.ts',
        'app/parser.py', 'tests/test_parser.py',
        'src/main/java/Foo.java', 'src/test/java/FooTest.java',
        'pkg/store/store.go', 'pkg/store/store_test.go',
        'src/router/index.ts', 'test/router/index.test.ts',
        'src/api/index.ts',
        'src/untested.ts',
      ],
      isTest,
    );
    expect(est.tested.sort()).toEqual(['app/parser.py', 'pkg/store/store.go', 'src/main/java/Foo.java', 'src/router/index.ts', 'src/user.service.ts']);
    expect(est.untested.sort()).toEqual(['src/api/index.ts', 'src/untested.ts']);
    expect(est.percent).toBe(71);
  });

  it('does not count a test for a different file with a similar name', async () => {
    const { estimateTestCoverage } = await import('../src/skills/rules/technology');
    expect(estimateTestCoverage(['src/user.ts', 'src/user.service.test.ts'], isTest).untested).toEqual(['src/user.ts']);
  });
});

describe('sonar_coverage estimate', () => {
  it('passes exactly at the threshold', async () => {
    const files = { ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/m${i}.ts`, ''])), ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`src/m${i}.test.ts`, ''])) };
    const o = await evaluateRule({ builtin: { name: 'sonar_coverage' } }, fakeRepo(files));
    expect(o.status).toBe('pass');
    expect(o.evidence[0].message).toBe('Estimated: 4 of 5 source files have tests (80%, threshold 80%)');
    expect(o.evidence[1].message).toBe('Counts source files with a test file named after them');
    expect(o.evidence[2].message).toBe('No tests: src/m4.ts');
  });

  it('says how many more files need tests', async () => {
    const files = { ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/m${i}.ts`, ''])), 'src/m0.test.ts': '' };
    const o = await evaluateRule({ builtin: { name: 'sonar_coverage' } }, fakeRepo(files));
    expect(o.status).toBe('fail');
    expect(o.evidence[1].message).toMatch(/^7 more source files need tests to reach 80%/);
  });
});

describe('generic file names', () => {
  const isTest = (p: string) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(p);
  it('matches index files by their folder, never by any index test', async () => {
    const { estimateTestCoverage } = await import('../src/skills/rules/technology');
    const est = estimateTestCoverage(
      ['src/core/index.ts', 'src/api/index.ts', 'src/ui/index.ts', 'index.ts', 'test/core/index.test.ts', 'test/api.test.ts', 'test/other/index.test.ts', 'test/index.test.ts'],
      isTest,
    );
    expect(est.tested.sort()).toEqual(['index.ts', 'src/api/index.ts', 'src/core/index.ts']);
    expect(est.untested).toEqual(['src/ui/index.ts']);
  });

  it('suggests a test path the estimate will recognise', async () => {
    const { expectedTestPath } = await import('../src/fix/planner');
    const { testsRecognised } = await import('../src/skills/rules/technology');
    for (const src of ['src/core/index.ts', 'app/models/user.py', 'pkg/store/store.go', 'src/main/java/com/acme/Foo.java']) {
      expect(testsRecognised(src, [expectedTestPath(src)], (p) => /\.test\.|^test_|\/test_|_test\.|Test\.java$/.test(p)), src).toBe(true);
    }
  });
});
