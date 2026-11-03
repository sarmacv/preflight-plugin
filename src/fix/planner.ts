// Turns a repo's failed, fixable checks into at most two PRs: a Fixes PR and a draft Coverage PR.
import type { ModelProvider } from '../ai/provider';
import type { RepoContext } from '../engine/context';
import { contextFiles } from '../engine/engine';
import type { CheckResult, Skill } from '../skills/types';
import type { SonarLink } from '../sonar/access';
import { isTestPath } from '../sonar/client';
import { estimateTestCoverage, filesNeeded } from '../skills/rules/technology';
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
  /** Most files a Coverage PR targets; 0 means no limit (as many as the threshold needs). */
  coverageMaxFiles: number;
  /** Target percentage; the Coverage PR writes enough tests to reach it. Defaults to 80. */
  coverageThreshold?: number;
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

/** Largest application source files with no test file mentioning their name: the fallback when Sonar has no data. */
export function untestedSourceFiles(ctx: RepoContext, limit: number): string[] {
  const untested = new Set(estimateTestCoverage(ctx.files.map((f) => f.path), isTestPath).untested);
  return ctx.files
    .filter((f) => untested.has(f.path))
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map((f) => f.path);
}

interface CoverageTarget {
  path: string;
  /** Why this file was chosen, for the instructions and PR notes. */
  reason: string;
}

interface CoverageGoal {
  /** How many files need tests written successfully. */
  goal: number;
  /** Files to try, in order; the ones after `goal` are replacements for files that fail. */
  candidates: CoverageTarget[];
  origin: string;
  dropped: string[];
}

async function coverageTargets(opts: PlanOptions): Promise<CoverageGoal> {
  const { ctx } = opts;
  const dropped: string[] = [];
  if (opts.sonar) {
    opts.onProgress?.(`${ctx.fullName}: finding lowest-coverage files`);
    // No project or no analysis yet: fall through to the untested-files heuristic.
    const lowest = await opts.sonar.lowestCoverage(ctx, opts.coverageMaxFiles > 0 ? opts.coverageMaxFiles : 50).catch(() => undefined);
    if (lowest && lowest.files.length) {
      const targets: CoverageTarget[] = [];
      for (const f of lowest.files) {
        const path = locate(ctx, f.path);
        if (path) targets.push({ path, reason: `Sonar reports ${f.coverage}% line coverage with ${f.uncoveredLines} uncovered lines` });
        else dropped.push(`${f.path} (not found in the repository)`);
      }
      if (targets.length) return { goal: targets.length, candidates: targets, origin: `the lowest-coverage files in Sonar project \`${lowest.projectKey}\``, dropped };
    }
  }
  // Estimated from the code: write tests for just enough untested files to reach the threshold,
  // keeping the remaining untested files as replacements in case some fail.
  const threshold = opts.coverageThreshold ?? 80;
  const est = estimateTestCoverage(ctx.files.map((f) => f.path), isTestPath);
  const needed = filesNeeded(est, threshold);
  if (needed === 0) throw new Error(`Estimated coverage is already ${est.percent}%, at or above ${threshold}%`);
  const goal = opts.coverageMaxFiles > 0 ? Math.min(needed, opts.coverageMaxFiles) : needed;
  const candidates = untestedSourceFiles(ctx, Number.MAX_SAFE_INTEGER).map((path) => ({ path, reason: 'This file has no tests yet' }));
  if (candidates.length === 0) throw new Error('Every source file already has tests');
  if (goal < needed) dropped.push(`only ${goal} of the ${needed} files needed for ${threshold}% (limit preflight.coverage.maxFiles = ${opts.coverageMaxFiles})`);
  return { goal, candidates, origin: `the largest source files without tests (${needed} needed to reach ${threshold}%)`, dropped };
}

/** The test file name the estimate recognises for a source file, in the repo's language conventions. */
export function expectedTestName(source: string): string {
  const name = source.split('/').pop()!;
  const ext = /\.([^.]+)$/.exec(name)?.[1] ?? '';
  const stem = name.slice(0, name.length - ext.length - 1);
  switch (ext) {
    case 'py': return `test_${stem}.py`;
    case 'go': return `${stem}_test.go`;
    case 'java': case 'kt': case 'scala': case 'groovy': return `${stem}Test.${ext}`;
    case 'cs': return `${stem}Tests.cs`;
    case 'rb': return `${stem}_spec.rb`;
    case 'php': return `${stem}Test.php`;
    case 'rs': return `${stem}_test.rs`;
    case 'dart': return `${stem}_test.dart`;
    default: return `${stem}.test.${ext}`;
  }
}

/** Files the AI is asked about at the same time. */
const COVERAGE_CONCURRENCY = 3;

async function planCoverage(skill: Skill, pr: PlanPr, opts: PlanOptions): Promise<void> {
  const { ctx } = opts;
  const provider = opts.provider;
  if (!provider) throw new Error("AI isn't available for this fix right now");
  const { goal, candidates, origin, dropped } = await coverageTargets(opts);
  const buildFiles = BUILD_FILES.map((p) => ctx.exists(p)).filter((p): p is string => !!p).slice(0, 3);

  /** Returns true when at least one test file was added for this source. */
  const writeTestsFor = async ({ path: source, reason }: CoverageTarget): Promise<boolean> => {
    const files: { path: string; content: string }[] = [];
    for (const p of [source, ...nearbyTests(ctx, source), ...buildFiles]) {
      const content = await ctx.read(p);
      if (content !== undefined) files.push({ path: p, content });
    }
    const instructions = [
      `Write unit tests for ${source}. ${reason}.`,
      'Use the same test framework, assertion style and location as the existing tests shown. If there are none, use the conventional framework for this stack declared in the build file.',
      `Name the test file after the source file, e.g. ${expectedTestName(source)} (or the equivalent this repository already uses), so it is clear which file it tests.`,
      'Cover the public behaviour and the branches that are currently untested. Mock external I/O.',
      'Only create or modify test files. Do not change production code or build files.',
    ].join('\n');
    const proposal = await provider.generateFix(skill, { repo: ctx, files, instructions }, ctx.signal);
    const tests = proposal.changes.filter((c) => isTestPath(c.path) && c.content !== undefined);
    for (const c of proposal.changes.filter((c) => !tests.includes(c))) dropped.push(`${c.path} (not a test file, dropped)`);
    if (proposal.notes) pr.notes.push(proposal.notes);
    return (await addChanges(pr, tests, skill.id, [], ctx)) > 0;
  };

  // One file failing never stops the batch: keep going, and take the next untested file instead.
  const targets: string[] = [];
  const failed: string[] = [];
  let next = 0;
  let inFlight = 0;
  const worker = async () => {
    while (targets.length + inFlight < goal && next < candidates.length) {
      if (ctx.signal?.aborted) return;
      const candidate = candidates[next++];
      inFlight++;
      opts.onProgress?.(`${ctx.fullName}: writing tests ${Math.min(targets.length + inFlight, goal)} of ${goal}: ${candidate.path}`);
      try {
        if (await writeTestsFor(candidate)) targets.push(candidate.path);
        else failed.push(`${candidate.path} (no test file produced)`);
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        failed.push(`${candidate.path} (${(err as Error).message})`);
      } finally {
        inFlight--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVERAGE_CONCURRENCY, goal) }, worker));
  if (targets.length === 0) throw new Error(`Couldn't generate tests: ${failed.join('; ') || 'no candidate files'}`);

  // Re-run the estimate with the new tests included, so the PR says whether it reaches the threshold.
  const threshold = opts.coverageThreshold ?? 80;
  const allPaths = ctx.files.map((f) => f.path);
  const before = estimateTestCoverage(allPaths, isTestPath);
  const after = estimateTestCoverage([...allPaths, ...pr.files.map((f) => f.path)], isTestPath);
  const unmatched = targets.filter((t) => !after.tested.includes(t));
  pr.notes.unshift(
    `- Targets ${origin}: ${targets.join(', ')}.`,
    `- Estimated coverage: ${before.percent}% → ${after.percent}% (threshold ${threshold}%)${after.percent >= threshold ? '' : '. Still below the threshold; see below'}.`,
  );
  if (failed.length) pr.notes.push(`- Couldn't write tests for: ${failed.join('; ')}${targets.length >= goal ? ' (other untested files were used instead)' : ''}.`);
  if (unmatched.length) pr.notes.push(`- Tests for ${unmatched.join(', ')} aren't named after their source file, so Preflight's estimate won't count them yet.`);
  if (dropped.length) pr.notes.push(`- Skipped: ${dropped.join('; ')}.`);
}
