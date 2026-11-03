// Turns a repo's failed, fixable checks into at most two PRs: a Fixes PR and a draft Coverage PR.
import type { ModelProvider } from '../ai/provider';
import type { RepoContext } from '../engine/context';
import { contextFiles } from '../engine/engine';
import type { CheckResult, Skill } from '../skills/types';
import type { SonarLink } from '../sonar/access';
import { isTestPath } from '../sonar/client';
import { estimateTestCoverage, filesNeeded, testsRecognised } from '../skills/rules/technology';
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

export type FixTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

/** One unit of fix work shown on the progress screen: a check to fix, or a source file to write tests for. */
export interface FixTask {
  id: string;
  section: 'fixes' | 'coverage';
  label: string;
  status: FixTaskStatus;
  /** Why it failed or was skipped. */
  detail?: string;
  /** Files produced. */
  files?: string[];
  /** Picked to replace a file that failed. */
  replacement?: boolean;
}

export interface CoverageProgress {
  source: 'estimate' | 'sonar';
  /** Percentage before any new tests. */
  before: number;
  target: number;
  /** Source files that need tests in this PR. */
  goal: number;
  /** For estimates: all application source files, and how many already had tests. */
  total?: number;
  tested?: number;
}

export type FixEvent =
  | { kind: 'repo'; repo: string; base: string; tasks: FixTask[]; coverage?: CoverageProgress }
  | { kind: 'task'; repo: string; task: FixTask };

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
  /** Structured progress for the "Preparing fixes" screen. */
  onEvent?: (event: FixEvent) => void;
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
  const report = (task: FixTask) => opts.onEvent?.({ kind: 'task', repo: ctx.fullName, task });

  // Work out the whole job first, so the progress screen can list every task from the start.
  const fixResults = failed.filter((r) => r.fixPr === 'fixes');
  const coverageResult = failed.find((r) => r.fixPr === 'coverage');
  let goal: CoverageGoal | undefined;
  let goalError: string | undefined;
  if (coverageResult) {
    try {
      if (!opts.provider) throw new Error("AI isn't available for this fix right now");
      goal = await coverageTargets(opts);
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      goalError = (err as Error).message;
    }
  }
  const fixTask = (r: CheckResult): FixTask => ({ id: r.checkId, section: 'fixes', label: byId.get(r.checkId)!.name, status: 'queued' });
  opts.onEvent?.({
    kind: 'repo',
    repo: ctx.fullName,
    base,
    tasks: [
      ...fixResults.map(fixTask),
      ...(goal ? goal.candidates.slice(0, goal.goal).map((c): FixTask => ({ id: c.path, section: 'coverage', label: c.path, status: 'queued' })) : []),
    ],
    coverage: goal?.progress,
  });

  for (const result of fixResults) {
    const skill = byId.get(result.checkId)!;
    report({ ...fixTask(result), status: 'running' });
    try {
      const proposal = await proposalFor(skill, result, opts);
      const added = await addChanges(fixes, proposal.changes, skill.id, proposal.editable ?? [], ctx);
      if (added === 0) {
        problems.push({ checkId: skill.id, name: skill.name, reason: 'No file changes were needed' });
        report({ ...fixTask(result), status: 'skipped', detail: 'No file changes were needed' });
        continue;
      }
      fixes.checks.push({ id: skill.id, name: skill.name, category: skill.category, severity: skill.severity });
      if (proposal.notes) fixes.notes.push(proposal.notes);
      report({ ...fixTask(result), status: 'done', files: fixes.files.filter((f) => f.checkIds.includes(skill.id)).map((f) => f.path) });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      problems.push({ checkId: skill.id, name: skill.name, reason: (err as Error).message });
      report({ ...fixTask(result), status: 'failed', detail: (err as Error).message });
    }
  }

  if (coverageResult) {
    const skill = byId.get(coverageResult.checkId)!;
    try {
      if (!goal) throw new Error(goalError ?? 'Nothing to do');
      await planCoverage(skill, coverage, goal, opts, report);
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
  progress: CoverageProgress;
}

async function coverageTargets(opts: PlanOptions): Promise<CoverageGoal> {
  const { ctx } = opts;
  const dropped: string[] = [];
  if (opts.sonar) {
    // No project or no analysis yet: fall through to the untested-files heuristic.
    const lowest = await opts.sonar.lowestCoverage(ctx, opts.coverageMaxFiles > 0 ? opts.coverageMaxFiles : 50).catch(() => undefined);
    if (lowest && lowest.files.length) {
      const targets: CoverageTarget[] = [];
      for (const f of lowest.files) {
        const path = locate(ctx, f.path);
        if (path) targets.push({ path, reason: `Sonar reports ${f.coverage}% line coverage with ${f.uncoveredLines} uncovered lines` });
        else dropped.push(`${f.path} (not found in the repository)`);
      }
      if (targets.length) {
        // The current figure is only for the progress screen; never let it block the PR.
        const measured = await Promise.resolve()
          .then(() => opts.sonar!.coverage(ctx))
          .catch(() => undefined);
        return {
          goal: targets.length,
          candidates: targets,
          origin: `the lowest-coverage files in Sonar project \`${lowest.projectKey}\``,
          dropped,
          progress: { source: 'sonar', before: Math.round(measured?.coverage ?? 0), target: opts.coverageThreshold ?? 80, goal: targets.length },
        };
      }
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
  return {
    goal,
    candidates,
    origin: `the largest source files without tests (${needed} needed to reach ${threshold}%)`,
    dropped,
    progress: { source: 'estimate', before: est.percent, target: threshold, goal, total: est.tested.length + est.untested.length, tested: est.tested.length },
  };
}

/** A test path next to the source that the estimate recognises (keeps the folder, which generic names like index need). */
export function expectedTestPath(source: string): string {
  const dir = source.slice(0, source.lastIndexOf('/') + 1);
  return `${dir}${expectedTestName(source)}`;
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

async function planCoverage(skill: Skill, pr: PlanPr, plan: CoverageGoal, opts: PlanOptions, report: (t: FixTask) => void): Promise<void> {
  const { ctx } = opts;
  const provider = opts.provider;
  if (!provider) throw new Error("AI isn't available for this fix right now");
  const { goal, candidates, origin, dropped } = plan;
  const buildFiles = BUILD_FILES.map((p) => ctx.exists(p)).filter((p): p is string => !!p).slice(0, 3);

  /** Returns the test files added for this source (empty when none). */
  const writeTestsFor = async ({ path: source, reason }: CoverageTarget): Promise<string[]> => {
    const files: { path: string; content: string }[] = [];
    for (const p of [source, ...nearbyTests(ctx, source), ...buildFiles]) {
      const content = await ctx.read(p);
      if (content !== undefined) files.push({ path: p, content });
    }
    const instructions = [
      `Write unit tests for ${source}. ${reason}.`,
      'Use the same test framework, assertion style and location as the existing tests shown. If there are none, use the conventional framework for this stack declared in the build file.',
      `Name the test file after the source file so it is clear which file it tests: put it at ${expectedTestPath(source)}, or if this repository keeps tests in a separate folder, mirror the source folders there with the same file name (e.g. tests/${expectedTestPath(source).split('/').slice(-2).join('/')}).`,
      'Cover the public behaviour and the branches that are currently untested. Mock external I/O.',
      'Only create or modify test files. Do not change production code or build files.',
    ].join('\n');
    const proposal = await provider.generateFix(skill, { repo: ctx, files, instructions }, ctx.signal);
    const tests = proposal.changes.filter((c) => isTestPath(c.path) && c.content !== undefined);
    for (const c of proposal.changes.filter((c) => !tests.includes(c))) dropped.push(`${c.path} (not a test file, dropped)`);
    if (proposal.notes) pr.notes.push(proposal.notes);
    const existing = new Set(pr.files.map((f) => f.path));
    await addChanges(pr, tests, skill.id, [], ctx);
    return pr.files.map((f) => f.path).filter((p) => !existing.has(p));
  };

  // One file failing never stops the batch: keep going, and take the next untested file instead.
  const targets: string[] = [];
  const failed: string[] = [];
  const unrecognised: string[] = [];
  let next = 0;
  let inFlight = 0;
  const worker = async () => {
    while (targets.length + inFlight < goal && next < candidates.length) {
      if (ctx.signal?.aborted) return;
      const index = next++;
      const candidate = candidates[index];
      inFlight++;
      const task: FixTask = { id: candidate.path, section: 'coverage', label: candidate.path, status: 'running', replacement: index >= goal };
      report(task);
      try {
        const written = await writeTestsFor(candidate);
        // Only count a file once the estimate itself recognises its test; otherwise the PR could
        // look finished and still leave the next scan below the threshold.
        if (written.length && testsRecognised(candidate.path, written, isTestPath)) {
          targets.push(candidate.path);
          report({ ...task, status: 'done', files: written });
        } else if (written.length) {
          unrecognised.push(`${candidate.path} (test written as ${written.join(', ')})`);
          report({ ...task, status: 'skipped', files: written, detail: "Test isn't named after this file, so it won't count; trying another file" });
        } else {
          failed.push(`${candidate.path} (no test file produced)`);
          report({ ...task, status: 'failed', detail: 'No test file produced' });
        }
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        failed.push(`${candidate.path} (${(err as Error).message})`);
        report({ ...task, status: 'failed', detail: (err as Error).message });
      } finally {
        inFlight--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVERAGE_CONCURRENCY, goal) }, worker));
  if (pr.files.length === 0) throw new Error(`Couldn't generate tests: ${failed.join('; ') || 'no candidate files'}`);

  // Re-run the estimate with the new tests included, so the PR says whether it reaches the threshold.
  const threshold = opts.coverageThreshold ?? 80;
  const allPaths = ctx.files.map((f) => f.path);
  const before = estimateTestCoverage(allPaths, isTestPath);
  const after = estimateTestCoverage([...allPaths, ...pr.files.map((f) => f.path)], isTestPath);
  pr.notes.unshift(
    `- Targets ${origin}: ${targets.join(', ') || 'none recognised yet'}.`,
    `- Estimated coverage: ${before.percent}% → ${after.percent}% (threshold ${threshold}%)${after.percent >= threshold ? '' : '. Still below the threshold; see below'}.`,
  );
  if (failed.length) pr.notes.push(`- Couldn't write tests for: ${failed.join('; ')}${targets.length >= goal ? ' (other untested files were used instead)' : ''}.`);
  if (unrecognised.length) {
    pr.notes.push(`- Kept, but not counted towards the estimate because they aren't named after their source file: ${unrecognised.join('; ')}.`);
  }
  if (dropped.length) pr.notes.push(`- Skipped: ${dropped.join('; ')}.`);
}
