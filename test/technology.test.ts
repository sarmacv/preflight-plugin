import { describe, expect, it } from 'vitest';
import { evaluateRule } from '../src/skills/rules';
import { technologyProfile } from '../src/skills/rules/technology';
import { runCheck } from '../src/engine/engine';
import { loadSkills } from '../src/skills/loader';
import { join } from 'node:path';
import { fakeRepo } from './helpers/fakeRepo';

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

  it('fails onboarding for a code repo without Sonar and skips coverage', async () => {
    const { results } = await run(many('src', 'go', 7));
    expect(results['sonar-required'].status).toBe('pass');
    expect(results['sonar-onboarded'].status).toBe('fail');
    expect(results['sonar-code-coverage']).toMatchObject({ status: 'skipped', message: 'Needs "Sonar onboarded" to pass first' });
  });
});
