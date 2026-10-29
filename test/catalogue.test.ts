// Runs every bundled deterministic check against a compliant repo and an empty one.
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadSkills } from '../src/skills/loader';
import { runCheck } from '../src/engine/engine';
import type { Skill } from '../src/skills/types';
import { fakeGitHub, fakeRepo, HttpError, NOT_SBOM, sbomRoutes } from './helpers/fakeRepo';

const SHA = '11bd71901bbe5b1630ceea73d27597364c9af683';

const COMPLIANT = {
  '.github/CODEOWNERS': '* @acme/platform\n',
  'AGENTS.md': `# Agent instructions\n\n## Build\n${'Run `npm ci` then `npm test`; lint with `npm run lint`.\n'.repeat(10)}\n## Layout\nsrc/ holds code.\n`,
  '.github/copilot-instructions.md': 'See AGENTS.md.\n',
  'sonar-project.properties': 'sonar.projectKey=api\n',
  'README.md': '# API\n\nSee CONTRIBUTING.md.\n',
  'CONTRIBUTING.md': '# Contributing\n\n## Branching strategy\nWe use trunk-based development with short-lived feature branches.\n',
  '.github/pull_request_template.md': '## Summary\n',
  '.github/ISSUE_TEMPLATE/bug_report.yml': 'name: Bug\n',
  '.gitignore': 'node_modules\n',
  LICENSE: 'Copyright (c) 2026 Acme. All rights reserved.\n',
  'sbom/sbom.spdx.json': '{}',
  'package.json': JSON.stringify({ dependencies: { lodash: '^4.17.21' } }),
  'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' } } }),
  Dockerfile: 'FROM node:22-alpine\nUSER node\n',
  '.github/workflows/ci.yml': [
    'permissions:',
    '  contents: read',
    'jobs:',
    '  build:',
    '    steps:',
    `      - uses: actions/checkout@${SHA} # v4`,
    '      - run: npm ci && npm test -- --coverage',
    `      - uses: hadolint/hadolint-action@${SHA}`,
    `      - uses: SonarSource/sonarqube-scan-action@${SHA}`,
    '        env:',
    '          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}',
  ].join('\n'),
};

const sbom = sbomRoutes([
  { name: 'lodash', versionInfo: '4.17.21', licenseConcluded: 'MIT', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/lodash@4.17.21' }] },
]);

const compliantGitHub = fakeGitHub({
  graphql: (query) =>
    query.includes('refs(')
      ? { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: 'main', target: { committedDate: new Date().toISOString() } }] } } }
      : { p0: { nodes: [{ severity: 'HIGH', vulnerableVersionRange: '< 4.17.21', firstPatchedVersion: { identifier: '4.17.21' }, advisory: { ghsaId: 'GHSA-1', summary: '', permalink: '' } }] } },
  request: (route) => {
    if (route.includes('/rules/branches/')) {
      return [
        { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } },
      ];
    }
    const report = sbom(route);
    if (report !== NOT_SBOM) return report;
    throw new Error(`unexpected ${route}`);
  },
  getBranchProtection: () => { throw new HttpError(404); },
});

const emptyGitHub = fakeGitHub({
  graphql: () => ({
    repository: {
      refs: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: Array.from({ length: 8 }, (_, i) => ({ name: `old-${i}`, target: { committedDate: '2020-01-01T00:00:00Z' } })),
      },
    },
  }),
  request: (route) => {
    if (route.includes('/rules/branches/')) return [];
    throw new HttpError(404);
  },
  getBranchProtection: () => { throw new HttpError(404); },
});

let deterministic: Skill[] = [];

beforeAll(async () => {
  const { skills } = await loadSkills(join(__dirname, '..', 'skills'));
  deterministic = skills.filter((s) => s.evaluation === 'deterministic');
});

describe('deterministic catalogue', () => {
  it('every deterministic check passes on a compliant repo', async () => {
    const ctx = fakeRepo(COMPLIANT, { gh: compliantGitHub });
    const results = await Promise.all(deterministic.map((s) => runCheck(s, ctx)));
    const notPassing = results.filter((r) => r.status !== 'pass').map((r) => `${r.checkId}: ${r.status} ${r.evidence.map((e) => e.message).join('; ')}`);
    // Coverage needs SonarQube, which the unit tests don't configure.
    expect(notPassing).toEqual(['test-coverage: skipped SonarQube is not configured']);
  });

  it('every deterministic check fails or skips on an empty repo', async () => {
    const ctx = fakeRepo({ 'src/main.py': 'print(1)\n' }, { gh: emptyGitHub, info: { branchProtected: false } });
    const results = Object.fromEntries((await Promise.all(deterministic.map((s) => runCheck(s, ctx)))).map((r) => [r.checkId, r.status]));
    // Nothing to inspect in a repo with no manifests, CI or containers.
    const skippedByDesign = ['container-iac-lint', 'test-coverage', 'vulnerable-dependencies', 'license-compliance', 'dependency-pinning'];
    for (const [id, status] of Object.entries(results)) {
      expect(status, id).toBe(skippedByDesign.includes(id) ? 'skipped' : 'fail');
    }
  });
});
