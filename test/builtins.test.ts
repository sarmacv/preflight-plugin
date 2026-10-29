import { describe, expect, it } from 'vitest';
import { evaluateRule } from '../src/skills/rules';
import { exactVersion, licenseAcceptable } from '../src/skills/rules/builtins';
import { fromPurl, parseManifest } from '../src/skills/rules/dependencies';
import { exportSbom } from '../src/skills/rules/dependencies';
import { fakeGitHub, fakeRepo, HttpError, sbomRoutes } from './helpers/fakeRepo';

const builtin = (name: string, params: Record<string, unknown> = {}) => ({ builtin: { name, params } });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('stale_branches', () => {
  const gh = (names: [string, number][]) =>
    fakeGitHub({
      graphql: () => ({
        repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: names.map(([name, age]) => ({ name, target: { committedDate: daysAgo(age) } })) } },
      }),
    });

  it('passes under the limit and ignores the default branch', async () => {
    const ctx = fakeRepo({}, { gh: gh([['main', 400], ['feature/a', 200], ['feature/b', 1]]) });
    const o = await evaluateRule(builtin('stale_branches', { max_stale: 1 }), ctx);
    expect(o.status).toBe('pass');
    expect(o.evidence[0].message).toBe('1 of 3 branches have no commits in 90 days');
  });

  it('fails over the limit and lists the oldest first', async () => {
    const ctx = fakeRepo({}, { gh: gh([['a', 100], ['b', 300], ['c', 200]]), settings: { staleBranchDays: 30 } });
    const o = await evaluateRule(builtin('stale_branches', { max_stale: 1 }), ctx);
    expect(o.status).toBe('fail');
    expect(o.evidence.slice(1).map((e) => e.message.split(' ')[0])).toEqual(['b', 'c', 'a']);
  });
});

describe('branch_protected', () => {
  it('uses the scanned branch flag when scanning the default branch', async () => {
    expect((await evaluateRule(builtin('branch_protected'), fakeRepo({}, { info: { branchProtected: false } }))).status).toBe('fail');
    expect((await evaluateRule(builtin('branch_protected'), fakeRepo({}))).status).toBe('pass');
  });

  it('looks up the default branch when scanning another branch', async () => {
    const gh = fakeGitHub({ getBranch: (b) => ({ protected: b === 'main' }) });
    const ctx = fakeRepo({}, { gh, info: { ref: 'develop', branchProtected: false } });
    expect((await evaluateRule(builtin('branch_protected'), ctx)).status).toBe('pass');
  });
});

describe('branch_rules', () => {
  const rulesets = (rules: unknown[]) => () => rules;

  it('fails without reading rules when the default branch is unprotected', async () => {
    const o = await evaluateRule(builtin('branch_rules'), fakeRepo({}, { info: { branchProtected: false } }));
    expect(o.status).toBe('fail');
    expect(o.evidence[0].message).toMatch(/isn't protected/);
  });

  it('treats a 403 from rulesets (GitHub Free private repo) as no rulesets', async () => {
    const gh = fakeGitHub({
      request: () => { throw new HttpError(403, 'Upgrade to GitHub Pro'); },
      getBranchProtection: () => ({ required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: { contexts: ['build'] } }),
    });
    expect((await evaluateRule(builtin('branch_rules'), fakeRepo({}, { gh }))).status).toBe('pass');
  });

  it('passes with a ruleset requiring reviews and checks', async () => {
    const gh = fakeGitHub({
      request: rulesets([
        { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci/test' }] } },
      ]),
      getBranchProtection: () => { throw new HttpError(404); },
    });
    const o = await evaluateRule(builtin('branch_rules'), fakeRepo({}, { gh }));
    expect(o.status).toBe('pass');
    expect(o.evidence[0].message).toMatch(/2 review\(s\), ci\/test/);
  });

  it('fails when status checks are missing', async () => {
    const gh = fakeGitHub({
      request: rulesets([{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }]),
      getBranchProtection: () => { throw new HttpError(404); },
    });
    const o = await evaluateRule(builtin('branch_rules'), fakeRepo({}, { gh }));
    expect(o.status).toBe('fail');
    expect(o.evidence[0].message).toMatch(/requires no status checks/);
  });

  it('merges classic protection', async () => {
    const gh = fakeGitHub({
      request: rulesets([]),
      getBranchProtection: () => ({ required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: { contexts: ['build'] } }),
    });
    expect((await evaluateRule(builtin('branch_rules'), fakeRepo({}, { gh }))).status).toBe('pass');
  });

  it('reports an error, not a failure, when nothing is readable', async () => {
    const gh = fakeGitHub({ request: rulesets([]), getBranchProtection: () => { throw new HttpError(403); } });
    const o = await evaluateRule(builtin('branch_rules'), fakeRepo({}, { gh }));
    expect(o.status).toBe('error');
    expect(o.evidence[0].message).toMatch(/admin access/);
  });
});

describe('vulnerable_dependencies', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { version: '1.0.0' }, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/left-pad': { version: '1.3.0' } },
  });
  const advisories = {
    p0: { nodes: [{ severity: 'HIGH', vulnerableVersionRange: '< 4.17.21', firstPatchedVersion: { identifier: '4.17.21' }, advisory: { ghsaId: 'GHSA-1', summary: 'Prototype pollution', permalink: 'https://github.com/advisories/GHSA-1' } }] },
    p1: { nodes: [{ severity: 'LOW', vulnerableVersionRange: '< 1.0.0', firstPatchedVersion: null, advisory: { ghsaId: 'GHSA-2', summary: 'x', permalink: 'https://github.com/advisories/GHSA-2' } }] },
  };

  it('matches lockfile versions against advisories on non-default branches', async () => {
    let queries = 0;
    const gh = fakeGitHub({ graphql: () => { queries++; return advisories; } });
    const ctx = fakeRepo({ 'package-lock.json': lock, 'package.json': '{}' }, { gh, info: { ref: 'feature/x' } });
    const o = await evaluateRule(builtin('vulnerable_dependencies', { fail_on: ['CRITICAL', 'HIGH'] }), ctx);
    expect(queries).toBe(1);
    expect(o.status).toBe('fail');
    expect(o.evidence[0].message).toMatch(/1 known vulnerabilities across 2 packages \(from manifests on this branch\)/);
    expect(o.evidence[1].message).toBe('high: lodash@4.17.20 GHSA-1, fixed in 4.17.21');
  });

  it('passes when only lower severities match', async () => {
    const gh = fakeGitHub({ graphql: () => ({ p0: { nodes: [] }, p1: advisories.p1 }) });
    const ctx = fakeRepo({ 'package-lock.json': lock }, { gh, info: { ref: 'feature/x' } });
    expect((await evaluateRule(builtin('vulnerable_dependencies', { fail_on: ['HIGH'] }), ctx)).status).toBe('pass');
  });

  it('uses the dependency graph on the default branch', async () => {
    const gh = fakeGitHub({
      request: sbomRoutes([{ name: 'lodash', versionInfo: '4.17.20', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/lodash@4.17.20' }] }]),
      graphql: () => ({ p0: advisories.p0 }),
    });
    const o = await evaluateRule(builtin('vulnerable_dependencies'), fakeRepo({}, { gh }));
    expect(o.status).toBe('fail');
    expect(o.evidence[0].message).toMatch(/from dependency graph/);
  });

  it('gives up on the SBOM report when the repo has no dependency graph', async () => {
    const gh = fakeGitHub({ request: () => { throw new HttpError(404); } });
    expect(await exportSbom(fakeRepo({}, { gh }), 0)).toBeUndefined();
  });

  it('skips when only version ranges are known', async () => {
    const ctx = fakeRepo({ 'package.json': JSON.stringify({ dependencies: { lodash: '^4.0.0' } }) }, { info: { ref: 'feature/x' } });
    const o = await evaluateRule(builtin('vulnerable_dependencies'), ctx);
    expect(o.status).toBe('skipped');
  });
});

describe('dependency_pinning', () => {
  it('passes for lockfiles, SHA-pinned actions and tagged images', async () => {
    const ctx = fakeRepo({
      'package.json': '{}',
      'package-lock.json': '{}',
      '.github/workflows/ci.yml': 'steps:\n  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\n  - uses: ./local-action\n',
      Dockerfile: 'FROM node:22-alpine AS build\nFROM build\n',
    });
    expect((await evaluateRule(builtin('dependency_pinning'), ctx)).status).toBe('pass');
  });

  it('reports each unpinned source', async () => {
    const ctx = fakeRepo({
      'web/package.json': '{}',
      '.github/workflows/ci.yml': 'steps:\n  - uses: actions/checkout@v4\n  - uses: "actions/setup-node@main"\n',
      Dockerfile: 'FROM node\nFROM python:latest\n',
    });
    const o = await evaluateRule(builtin('dependency_pinning'), ctx);
    expect(o.status).toBe('fail');
    expect(o.evidence[0].message).toBe('5 unpinned dependency source(s)');
    expect(o.evidence.map((e) => e.message).join('\n')).toMatch(/web\/package.json has no lockfile[\s\S]*checkout@v4[\s\S]*setup-node@main[\s\S]*node uses a floating tag[\s\S]*python:latest/);
  });
});

describe('license_compliance', () => {
  const sbom = (licenses: string[]) =>
    fakeGitHub({
      request: sbomRoutes(licenses.map((l, i) => ({ name: `p${i}`, licenseConcluded: l, externalRefs: [{ referenceType: 'purl', referenceLocator: `pkg:npm/p${i}@1.0.0` }] }))),
    });

  it('fails on denied licences', async () => {
    const o = await evaluateRule(builtin('license_compliance'), fakeRepo({}, { gh: sbom(['MIT', 'AGPL-3.0-only']) }));
    expect(o.status).toBe('fail');
    expect(o.evidence[1].message).toBe('p1@1.0.0: AGPL-3.0-only');
  });

  it('applies the allow list', async () => {
    const ctx = fakeRepo({}, { gh: sbom(['MIT', 'BSD-3-Clause']), settings: { licenseAllow: ['MIT'] } });
    expect((await evaluateRule(builtin('license_compliance'), ctx)).status).toBe('fail');
  });

  it('skips without licence data', async () => {
    expect((await evaluateRule(builtin('license_compliance'), fakeRepo({}, { gh: sbom([]) }))).status).toBe('skipped');
  });

  it('evaluates SPDX expressions', () => {
    expect(licenseAcceptable('MIT OR AGPL-3.0', [], ['AGPL-3.0'])).toBe(true);
    expect(licenseAcceptable('MIT AND AGPL-3.0', [], ['AGPL-3.0'])).toBe(false);
    expect(licenseAcceptable('(Apache-2.0)', ['apache-2.0'], [])).toBe(true);
  });
});

describe('dependency parsing', () => {
  it('reads purls', () => {
    expect(fromPurl('pkg:npm/%40scope/pkg@1.2.3')).toEqual({ ecosystem: 'npm', name: '@scope/pkg', version: '1.2.3' });
    expect(fromPurl('pkg:maven/org.apache/commons-lang3@3.12.0')).toEqual({ ecosystem: 'maven', name: 'org.apache:commons-lang3', version: '3.12.0' });
    expect(fromPurl('pkg:unknown/x@1')).toBeUndefined();
  });

  it('parses common manifests', () => {
    expect(parseManifest('requirements.txt', 'requests==2.31.0\n# comment\nflask>=2\n-r other.txt\n').map((d) => `${d.name}:${d.version}`)).toEqual(['requests:2.31.0', 'flask:>=2']);
    expect(parseManifest('go.mod', 'module x\nrequire (\n\tgithub.com/pkg/errors v0.9.1\n)\n')[0]).toMatchObject({ name: 'github.com/pkg/errors', version: 'v0.9.1' });
    expect(parseManifest('pom.xml', '<dependency><groupId>g</groupId><artifactId>a</artifactId><version>1.0</version></dependency>')[0]).toMatchObject({ name: 'g:a', version: '1.0' });
    expect(parseManifest('package.json', 'not json')).toEqual([]);
  });

  it('only treats exact versions as resolved', () => {
    expect(exactVersion('4.17.21')).toBe('4.17.21');
    expect(exactVersion('v0.9.1')).toBe('0.9.1');
    expect(exactVersion('^4.0.0')).toBeUndefined();
    expect(exactVersion('>=2')).toBeUndefined();
  });
});
