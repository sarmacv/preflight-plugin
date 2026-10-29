// Named evaluators for checks that need logic beyond the generic rules. Skills reference them as
// `{ builtin: { name: <name>, params: {...} } }`.
import { z } from 'zod';
import type { RepoContext } from '../../engine/context';
import { inventory, LOCKFILES, manifestFiles, type Dependency, type Ecosystem } from './dependencies';
import { errored, fail, pass, RuleConfigError, skipped, type RuleFn } from './types';
import { inRange } from './versions';
import { CI_ACTION_GLOBS } from './ciGlobs';

function params<T>(schema: z.ZodType<T>, raw: unknown, name: string): T {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new RuleConfigError(`${name}: ${r.error.issues.map((i) => i.message).join('; ')}`);
  return r.data;
}

const status = (err: unknown) => (err as { status?: number }).status;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Branches

const staleBranches: RuleFn = async (raw, ctx) => {
  const p = params(z.object({ days: z.number().int().positive().optional(), max_stale: z.number().int().nonnegative().default(5) }), raw, 'stale_branches');
  const days = p.days ?? ctx.settings.staleBranchDays;
  const cutoff = Date.now() - days * DAY;

  const stale: { name: string; date: string }[] = [];
  let total = 0;
  let cursor: string | null = null;
  do {
    const res: {
      repository: { refs: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { name: string; target: { committedDate?: string } }[] } };
    } = await ctx.gh.graphql(
      `query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { name target { ... on Commit { committedDate } } }
          }
        }
      }`,
      { owner: ctx.info.owner, repo: ctx.info.repo, cursor, request: { signal: ctx.signal } },
    );
    const refs = res.repository.refs;
    for (const n of refs.nodes) {
      total++;
      if (n.name === ctx.info.defaultBranch || !n.target.committedDate) continue;
      if (Date.parse(n.target.committedDate) < cutoff) stale.push({ name: n.name, date: n.target.committedDate.slice(0, 10) });
    }
    cursor = refs.pageInfo.hasNextPage ? refs.pageInfo.endCursor : null;
  } while (cursor);

  stale.sort((a, b) => a.date.localeCompare(b.date));
  const summary = `${stale.length} of ${total} branches have no commits in ${days} days`;
  const list = stale.slice(0, 10).map((s) => ({ message: `${s.name} (last commit ${s.date})`, url: `${ctx.htmlUrl()}/tree/${encodeURIComponent(s.name)}` }));
  return stale.length > p.max_stale ? fail({ message: `${summary} (limit ${p.max_stale})` }, ...list) : pass({ message: summary }, ...list);
};

async function isBranchProtected(ctx: RepoContext, branch: string): Promise<boolean> {
  if (branch === ctx.info.ref) return ctx.info.branchProtected;
  return ctx.memo(`protected:${branch}`, async () => {
    const { data } = await ctx.gh.rest.repos.getBranch({ owner: ctx.info.owner, repo: ctx.info.repo, branch, request: { signal: ctx.signal } });
    return data.protected;
  });
}

const branchProtected: RuleFn = async (raw, ctx) => {
  const p = params(z.object({ branch: z.enum(['default', 'scanned']).default('default') }), raw, 'branch_protected');
  const branch = p.branch === 'default' ? ctx.info.defaultBranch : ctx.info.ref;
  const isProtected = await isBranchProtected(ctx, branch);
  const url = `${ctx.htmlUrl()}/settings/branches`;
  return isProtected ? pass({ message: `${branch} is protected`, url }) : fail({ message: `${branch} has no branch protection or ruleset`, url });
};

interface BranchRules {
  reviews: number;
  statusChecks: string[];
  source: string;
}

async function readBranchRules(ctx: RepoContext, branch: string): Promise<BranchRules | 'forbidden'> {
  const { owner, repo } = ctx.info;
  const request = { signal: ctx.signal };
  const rules: BranchRules = { reviews: 0, statusChecks: [], source: 'rulesets' };

  // Rulesets are readable by anyone with read access.
  try {
    const { data } = await ctx.gh.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', { owner, repo, branch, per_page: 100, request });
    for (const r of data as { type: string; parameters?: Record<string, unknown> }[]) {
      if (r.type === 'pull_request') rules.reviews = Math.max(rules.reviews, Number(r.parameters?.required_approving_review_count ?? 0));
      if (r.type === 'required_status_checks') {
        const checks = (r.parameters?.required_status_checks as { context: string }[] | undefined) ?? [];
        rules.statusChecks.push(...checks.map((c) => c.context));
      }
    }
  } catch (err) {
    const s = status(err);
    if (s !== 404 && s !== 403) throw err;
  }

  // Classic protection needs admin access; merge it in when we can read it.
  try {
    const { data } = await ctx.gh.rest.repos.getBranchProtection({ owner, repo, branch, request });
    rules.reviews = Math.max(rules.reviews, data.required_pull_request_reviews?.required_approving_review_count ?? 0);
    rules.statusChecks.push(...(data.required_status_checks?.contexts ?? []));
    rules.source = rules.source === 'rulesets' && (rules.reviews || rules.statusChecks.length) ? 'rulesets + classic protection' : 'classic protection';
  } catch (err) {
    const s = status(err);
    if (s === 403 && rules.reviews === 0 && rules.statusChecks.length === 0) return 'forbidden';
    if (s !== 404 && s !== 403) throw err;
  }
  rules.statusChecks = [...new Set(rules.statusChecks)];
  return rules;
}

const branchRules: RuleFn = async (raw, ctx) => {
  const p = params(z.object({ min_reviews: z.number().int().nonnegative().default(1), require_status_checks: z.boolean().default(true) }), raw, 'branch_rules');
  const branch = ctx.info.defaultBranch;
  const url = `${ctx.htmlUrl()}/settings/branches`;
  if (!(await isBranchProtected(ctx, branch))) {
    return fail({ message: `${branch} isn't protected, so no reviews or status checks are required`, url });
  }
  const rules = await readBranchRules(ctx, branch);
  if (rules === 'forbidden') return errored(`Reading ${branch} protection needs admin access to ${ctx.fullName}`);

  const problems: string[] = [];
  if (rules.reviews < p.min_reviews) problems.push(`requires ${rules.reviews} approving review(s) (needs ${p.min_reviews})`);
  if (p.require_status_checks && rules.statusChecks.length === 0) problems.push('requires no status checks');
  const detail = `${rules.reviews} review(s), ${rules.statusChecks.length ? rules.statusChecks.join(', ') : 'no'} status checks (${rules.source})`;
  return problems.length ? fail({ message: `${branch} ${problems.join(' and ')}`, url }, { message: detail }) : pass({ message: `${branch}: ${detail}`, url });
};

// ---------------------------------------------------------------------------------------------
// Dependencies

const GH_ECOSYSTEM: Partial<Record<Ecosystem, string>> = {
  npm: 'NPM', pypi: 'PIP', maven: 'MAVEN', golang: 'GO', cargo: 'RUST', nuget: 'NUGET', gem: 'RUBYGEMS', composer: 'COMPOSER',
};

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'] as const;
const MAX_PACKAGES = 400;
const BATCH = 40;

/** Exact version, or undefined for ranges (which can't be matched against advisories reliably). */
export function exactVersion(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^[=v]+/, '');
  return /^\d+(\.\d+)*([-+][\w.-]+)?$/.test(s) ? s : undefined;
}

interface Vulnerability {
  severity: (typeof SEVERITY_ORDER)[number];
  vulnerableVersionRange: string;
  firstPatchedVersion: { identifier: string } | null;
  advisory: { ghsaId: string; summary: string; permalink: string };
}

const vulnerableDependencies: RuleFn = async (raw, ctx) => {
  const p = params(z.object({ fail_on: z.array(z.enum(SEVERITY_ORDER)).default([...SEVERITY_ORDER]) }), raw, 'vulnerable_dependencies');
  const inv = await inventory(ctx);
  const resolved = inv.dependencies
    .map((d) => ({ ...d, version: exactVersion(d.version) }))
    .filter((d): d is Dependency & { version: string } => !!d.version && !!GH_ECOSYSTEM[d.ecosystem]);
  if (inv.dependencies.length === 0) return skipped('No dependencies found');
  if (resolved.length === 0) return skipped('No dependencies with exact versions (add a lockfile)');

  const unique = [...new Map(resolved.map((d) => [`${d.ecosystem}:${d.name}`, d])).values()];
  const packages = unique.slice(0, MAX_PACKAGES);
  const advisories = new Map<string, Vulnerability[]>();
  for (let i = 0; i < packages.length; i += BATCH) {
    const batch = packages.slice(i, i + BATCH);
    const fields = batch
      .map((d, j) => `p${j}: securityVulnerabilities(ecosystem: ${GH_ECOSYSTEM[d.ecosystem]}, package: ${JSON.stringify(d.name)}, first: 100) {
          nodes { severity vulnerableVersionRange firstPatchedVersion { identifier } advisory { ghsaId summary permalink } } }`)
      .join('\n');
    const res = await ctx.gh.graphql<Record<string, { nodes: Vulnerability[] }>>(`query { ${fields} }`, { request: { signal: ctx.signal } });
    batch.forEach((d, j) => advisories.set(`${d.ecosystem}:${d.name}`, res[`p${j}`]?.nodes ?? []));
  }

  const hits: { dep: Dependency & { version: string }; vuln: Vulnerability }[] = [];
  for (const dep of resolved) {
    for (const vuln of advisories.get(`${dep.ecosystem}:${dep.name}`) ?? []) {
      if (inRange(dep.version, vuln.vulnerableVersionRange)) hits.push({ dep, vuln });
    }
  }
  hits.sort((a, b) => SEVERITY_ORDER.indexOf(a.vuln.severity) - SEVERITY_ORDER.indexOf(b.vuln.severity));
  const failing = hits.filter((h) => p.fail_on.includes(h.vuln.severity));
  const origin = inv.origin === 'dependency-graph' ? 'dependency graph' : 'manifests on this branch';
  const scope = unique.length > packages.length ? `the first ${packages.length} of ${unique.length} packages` : `${packages.length} packages`;
  const summary = { message: `${hits.length} known vulnerabilities across ${scope} (from ${origin})` };
  const list = hits.slice(0, 15).map((h) => ({
    message: `${h.vuln.severity.toLowerCase()}: ${h.dep.name}@${h.dep.version} ${h.vuln.advisory.ghsaId}${h.vuln.firstPatchedVersion ? `, fixed in ${h.vuln.firstPatchedVersion.identifier}` : ''}`,
    url: h.vuln.advisory.permalink,
    path: h.dep.source,
  }));
  return failing.length ? fail(summary, ...list) : pass(summary, ...list);
};

const USES = /^\s*-?\s*uses:\s*["']?([^\s"'#]+)/gm;
const FROM = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim;

const dependencyPinning: RuleFn = async (raw, ctx) => {
  const p = params(z.object({ actions_sha: z.boolean().default(true), docker_digest: z.boolean().default(false) }), raw, 'dependency_pinning');
  const problems: { message: string; path?: string }[] = [];
  let inspected = 0;

  for (const manifest of manifestFiles(ctx).concat(ctx.match(['**/pyproject.toml', '**/Pipfile', '**/Gemfile', '**/composer.json']))) {
    const file = manifest.split('/').pop()!;
    const locks = LOCKFILES[file];
    if (!locks || /(^|\/)(node_modules|vendor)\//.test(manifest)) continue;
    inspected++;
    const dir = manifest.slice(0, manifest.length - file.length);
    if (!locks.some((l) => ctx.exists(dir + l))) problems.push({ message: `${manifest} has no lockfile (${locks.slice(0, 3).join(', ')})`, path: manifest });
  }

  if (p.actions_sha) {
    for (const wf of ctx.match(CI_ACTION_GLOBS)) {
      inspected++;
      const text = (await ctx.read(wf)) ?? '';
      for (const m of text.matchAll(USES)) {
        const ref = m[1];
        if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
        const at = ref.split('@')[1];
        if (!at || !/^[0-9a-f]{40}$/.test(at)) problems.push({ message: `${wf}: ${ref} isn't pinned to a commit SHA`, path: wf });
      }
    }
  }

  for (const df of ctx.match(['**/Dockerfile', '**/*.Dockerfile', '**/Dockerfile.*'])) {
    inspected++;
    const text = (await ctx.read(df)) ?? '';
    const stages = new Set<string>();
    for (const line of text.matchAll(/^\s*FROM\s+.*\s+AS\s+(\S+)/gim)) stages.add(line[1].toLowerCase());
    for (const m of text.matchAll(FROM)) {
      const image = m[1];
      if (image === 'scratch' || stages.has(image.toLowerCase()) || image.includes('$')) continue;
      const digest = image.includes('@sha256:');
      const tag = image.split('/').pop()!.split(':')[1];
      if (!digest && (!tag || tag === 'latest')) problems.push({ message: `${df}: ${image} uses a floating tag`, path: df });
      else if (!digest && p.docker_digest) problems.push({ message: `${df}: ${image} isn't pinned by digest`, path: df });
    }
  }

  if (inspected === 0) return skipped('No manifests, workflows or Dockerfiles to check');
  const ev = problems.slice(0, 15).map((x) => ({ ...x, url: x.path ? ctx.htmlUrl(x.path) : undefined }));
  return problems.length ? fail({ message: `${problems.length} unpinned dependency source(s)` }, ...ev) : pass({ message: 'Lockfiles present, actions and base images pinned' });
};

/** Evaluates an SPDX expression: "MIT OR Apache-2.0" passes if any alternative is acceptable. */
export function licenseAcceptable(expr: string, allow: string[], deny: string[]): boolean {
  const ok = (id: string) => {
    const clean = id.replace(/[()]/g, '').trim();
    if (deny.some((d) => d.toLowerCase() === clean.toLowerCase())) return false;
    return allow.length === 0 || allow.some((a) => a.toLowerCase() === clean.toLowerCase());
  };
  return expr.split(/\s+OR\s+/i).some((alt) => alt.split(/\s+AND\s+/i).every(ok));
}

const licenseCompliance: RuleFn = async (_raw, ctx) => {
  const { licenseAllow: allow, licenseDeny: deny } = ctx.settings;
  const inv = await inventory(ctx);
  const withLicense = inv.dependencies.filter((d) => d.license);
  if (withLicense.length === 0) {
    return skipped(ctx.isDefaultBranch ? 'No licence data in the dependency graph' : 'Licence data is only available for the default branch');
  }
  const bad = withLicense.filter((d) => !licenseAcceptable(d.license!, allow, deny));
  const summary = { message: `${bad.length} of ${withLicense.length} dependencies have disallowed licences` };
  const list = bad.slice(0, 15).map((d) => ({ message: `${d.name}${d.version ? `@${d.version}` : ''}: ${d.license}`, path: d.source }));
  return bad.length ? fail(summary, ...list) : pass(summary);
};

// ---------------------------------------------------------------------------------------------
// Sonar

const sonarCoverage: RuleFn = async (_raw, ctx) => {
  const sonar = ctx.settings.sonar;
  if (!sonar) return skipped('SonarQube is not configured');
  const threshold = ctx.settings.coverageThreshold;
  const found = await sonar.coverage(ctx);
  if (!found) return errored(`No SonarQube project is linked to ${ctx.fullName}`);
  const ev = { url: found.url };
  if (found.coverage === undefined) return fail({ message: `Sonar project ${found.projectKey} has no coverage measure`, ...ev });
  const message = `Coverage ${found.coverage.toFixed(1)}% (threshold ${threshold}%) in Sonar project ${found.projectKey}`;
  return found.coverage >= threshold ? pass({ message, ...ev }) : fail({ message, ...ev });
};

export const BUILTINS: Record<string, RuleFn> = {
  stale_branches: staleBranches,
  branch_protected: branchProtected,
  branch_rules: branchRules,
  vulnerable_dependencies: vulnerableDependencies,
  dependency_pinning: dependencyPinning,
  license_compliance: licenseCompliance,
  sonar_coverage: sonarCoverage,
};
