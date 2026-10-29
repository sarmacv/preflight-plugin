// Turns a repo's failed, fixable checks into at most two PRs: a Fixes PR and a draft Coverage PR.
import type { ModelProvider } from '../ai/provider';
import type { RepoContext } from '../engine/context';
import { contextFiles } from '../engine/engine';
import type { CheckResult, Skill } from '../skills/types';
import type { SonarLink } from '../sonar/access';
import { isTestPath } from '../sonar/client';
import { checkOrCategory, renderBranchName, type PrKind } from './branchName';
import { BUILTIN_FIXES } from './builtinFixes';

export interface PlanFile {
  path: string;
  /** Current content on the scanned branch; undefined for new files. */
  before?: string;
  /** Proposed content; null deletes the file. */
  after: string | null;
  /** The user should review and may edit this file (e.g. proposed CODEOWNERS). */
  editable: boolean;
  checkIds: string[];
}

export interface PlanCheck {
  id: string;
  name: string;
  category: string;
  severity: Skill['severity'];
}

export interface PlanPr {
  id: string;
  kind: PrKind;
  branch: string;
  base: string;
  draft: boolean;
  checks: PlanCheck[];
  files: PlanFile[];
  notes: string[];
}

export interface PlanProblem {
  checkId: string;
  name: string;
  reason: string;
}

export interface RepoPlan {
  repo: string;
  base: string;
  prs: PlanPr[];
  problems: PlanProblem[];
}

export interface PlanOptions {
  ctx: RepoContext;
  skills: Skill[];
  results: CheckResult[];
  provider?: ModelProvider;
  sonar?: SonarLink;
  branchTemplate: string;
  coverageMaxFiles: number;
  sonarUrl?: string;
  user: string;
  onProgress?: (label: string) => void;
}

const BUILD_FILES = ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'setup.cfg', 'go.mod', 'Cargo.toml', 'jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'pytest.ini', 'tsconfig.json'];

function renderTemplate(template: string, ctx: RepoContext, sonarUrl?: string): string {
  const vars: Record<string, string> = {
    repo: ctx.info.repo,
    owner: ctx.info.owner,
    branch: ctx.info.ref,
    defaultBranch: ctx.info.defaultBranch,
    year: String(new Date().getFullYear()),
    sonarUrl: sonarUrl || 'your SonarQube server',
  };
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

async function proposalFor(skill: Skill, result: CheckResult, opts: PlanOptions): Promise<{ changes: { path: string; content: string | undefined }[]; notes?: string; editable?: string[] }> {
  const { ctx } = opts;
  const fix = skill.fix!;
  switch (fix.kind) {
    case 'builtin': {
      const fn = fix.name ? BUILTIN_FIXES[fix.name] : undefined;
      if (!fn) throw new Error(`Unknown built-in fix "${fix.name}"`);
      return fn(ctx);
    }
    case 'template':
      if (!fix.path || fix.template === undefined) throw new Error('Template fix needs path and template');
      return { changes: [{ path: fix.path, content: renderTemplate(fix.template, ctx, opts.sonarUrl) }] };
    case 'ai': {
      if (!opts.provider) throw new Error("AI isn't available for this fix right now");
      const files = await contextFiles(skill, ctx);
      if (fix.path && !files.some((f) => f.path === fix.path)) {
        const current = await ctx.read(fix.path);
        if (current !== undefined) files.unshift({ path: fix.path, content: current });
      }
      return opts.provider.generateFix(
        skill,
        { repo: ctx, files, ruleEvidence: result.evidence, instructions: fix.path ? `Write the fix to ${fix.path}.` : undefined },
        ctx.signal,
      );
    }
  }
}

async function addChanges(
  pr: PlanPr,
  changes: { path: string; content: string | undefined }[],
  checkId: string,
  editable: string[],
  ctx: RepoContext,
): Promise<number> {
  let added = 0;
  for (const change of changes) {
    const existing = pr.files.find((f) => f.path === change.path);
    if (existing) {
      // Another check already writes this file; the first proposal wins, both checks are credited.
      if (!existing.checkIds.includes(checkId)) existing.checkIds.push(checkId);
      added++;
      continue;
    }
    const before = await ctx.read(change.path);
    const after = change.content === undefined ? null : change.content;
    if (after !== null && before === after) continue;
    if (after === null && before === undefined) continue;
    pr.files.push({ path: change.path, before, after, editable: editable.includes(change.path), checkIds: [checkId] });
    added++;
  }
  return added;
}

export async function planRepoFixes(opts: PlanOptions): Promise<RepoPlan> {
  const { ctx } = opts;
  const byId = new Map(opts.skills.map((s) => [s.id, s]));
  const failed = opts.results.filter((r) => r.status === 'fail' && r.fixable && byId.get(r.checkId)?.fix);
  const problems: PlanProblem[] = [];
  const base = ctx.info.ref;

  const makePr = (kind: PrKind): PlanPr => ({ id: `${ctx.fullName}#${kind}`, kind, branch: '', base, draft: kind === 'coverage', checks: [], files: [], notes: [] });
  const fixes = makePr('fixes');
  const coverage = makePr('coverage');

  for (const result of failed.filter((r) => r.fixPr === 'fixes')) {
    const skill = byId.get(result.checkId)!;
    opts.onProgress?.(`${ctx.fullName}: ${skill.name}`);
    try {
      const proposal = await proposalFor(skill, result, opts);
      const added = await addChanges(fixes, proposal.changes, skill.id, proposal.editable ?? [], ctx);
      if (added === 0) {
        problems.push({ checkId: skill.id, name: skill.name, reason: 'No file changes were needed' });
        continue;
      }
      fixes.checks.push({ id: skill.id, name: skill.name, category: skill.category, severity: skill.severity });
      if (proposal.notes) fixes.notes.push(proposal.notes);
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      problems.push({ checkId: skill.id, name: skill.name, reason: (err as Error).message });
    }
  }

  const coverageResult = failed.find((r) => r.fixPr === 'coverage');
  if (coverageResult) {
    const skill = byId.get(coverageResult.checkId)!;
    try {
      await planCoverage(skill, coverage, opts);
      if (coverage.files.length) coverage.checks.push({ id: skill.id, name: skill.name, category: skill.category, severity: skill.severity });
      else problems.push({ checkId: skill.id, name: skill.name, reason: 'No tests were generated' });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      problems.push({ checkId: skill.id, name: skill.name, reason: (err as Error).message });
    }
  }

  const prs = [fixes, coverage].filter((pr) => pr.files.length > 0);
  for (const pr of prs) {
    pr.branch = renderBranchName(opts.branchTemplate, {
      user: opts.user,
      repo: ctx.info.repo,
      checkOrCategory: checkOrCategory(pr.checks),
      type: pr.kind,
    });
  }
  return { repo: ctx.fullName, base, prs, problems };
}

/** Locates a Sonar file path in the repo (Sonar paths are relative to the analysed module). */
function locate(ctx: RepoContext, sonarPath: string): string | undefined {
  const direct = ctx.exists(sonarPath);
  if (direct) return direct;
  const suffix = `/${sonarPath.toLowerCase()}`;
  return ctx.files.find((f) => f.path.toLowerCase().endsWith(suffix))?.path;
}

function nearbyTests(ctx: RepoContext, source: string): string[] {
  const file = source.split('/').pop()!;
  const stem = file.replace(/\.[^.]+$/, '').toLowerCase();
  const dir = source.slice(0, source.length - file.length);
  const tests = ctx.files.map((f) => f.path).filter((p) => isTestPath(p));
  const sameStem = tests.filter((p) => p.split('/').pop()!.toLowerCase().includes(stem));
  const sameDir = tests.filter((p) => p.startsWith(dir));
  return [...new Set([...sameStem, ...sameDir, ...tests])].slice(0, 2);
}

async function planCoverage(skill: Skill, pr: PlanPr, opts: PlanOptions): Promise<void> {
  const { ctx } = opts;
  if (!opts.sonar) throw new Error('SonarQube is not configured');
  if (!opts.provider) throw new Error("AI isn't available for this fix right now");
  opts.onProgress?.(`${ctx.fullName}: finding lowest-coverage files`);
  const lowest = await opts.sonar.lowestCoverage(ctx, opts.coverageMaxFiles);
  if (!lowest || lowest.files.length === 0) throw new Error('Sonar reported no files with uncovered lines');

  const buildFiles = BUILD_FILES.map((p) => ctx.exists(p)).filter((p): p is string => !!p).slice(0, 3);
  const dropped: string[] = [];
  const targets: string[] = [];

  for (const f of lowest.files) {
    const source = locate(ctx, f.path);
    if (!source) {
      dropped.push(`${f.path} (not found in the repository)`);
      continue;
    }
    opts.onProgress?.(`${ctx.fullName}: writing tests for ${source}`);
    const paths = [source, ...nearbyTests(ctx, source), ...buildFiles];
    const files: { path: string; content: string }[] = [];
    for (const p of paths) {
      const content = await ctx.read(p);
      if (content !== undefined) files.push({ path: p, content });
    }
    const instructions = [
      `Write unit tests for ${source}. Sonar reports ${f.coverage}% line coverage with ${f.uncoveredLines} uncovered lines.`,
      'Use the same test framework, assertion style, naming and location as the existing tests shown. If there are none, use the conventional framework for this stack declared in the build file.',
      'Cover the public behaviour and the branches that are currently untested. Mock external I/O.',
      'Only create or modify test files. Do not change production code or build files.',
    ].join('\n');
    const proposal = await opts.provider.generateFix(skill, { repo: ctx, files, instructions }, ctx.signal);
    const tests = proposal.changes.filter((c) => isTestPath(c.path) && c.content !== undefined);
    for (const c of proposal.changes.filter((c) => !tests.includes(c))) dropped.push(`${c.path} (not a test file, dropped)`);
    if ((await addChanges(pr, tests, skill.id, [], ctx)) > 0) targets.push(`${source} (${f.coverage}% covered)`);
    if (proposal.notes) pr.notes.push(proposal.notes);
  }

  pr.notes.unshift(`- Targets from Sonar project \`${lowest.projectKey}\`: ${targets.join(', ') || 'none'}.`);
  if (dropped.length) pr.notes.push(`- Skipped: ${dropped.join('; ')}.`);
}
