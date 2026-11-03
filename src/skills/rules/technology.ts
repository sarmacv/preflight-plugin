// Classifies a repository's files by technology, to decide whether code coverage applies.
import type { RepoContext } from '../../engine/context';

/** Languages where line coverage is meaningful and SonarQube can import a coverage report. */
export const COVERAGE_LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', vue: 'JavaScript', svelte: 'JavaScript',
  py: 'Python',
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', groovy: 'Groovy',
  go: 'Go',
  cs: 'C#', vb: 'VB.NET', fs: 'F#',
  rb: 'Ruby', php: 'PHP',
  swift: 'Swift', m: 'Objective-C', mm: 'Objective-C',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++',
  rs: 'Rust', dart: 'Dart',
};

/** Content that never needs coverage, reported in the evidence when coverage isn't required. */
const OTHER_KINDS: [RegExp, string][] = [
  [/\.(md|mdx|rst|adoc|txt)$/i, 'Docs'],
  [/\.(tf|tfvars|hcl|bicep)$/i, 'Terraform/IaC'],
  [/(^|\/)(Chart\.yaml|values[^/]*\.ya?ml)$|(^|\/)templates\/[^/]+\.ya?ml$/i, 'Helm'],
  [/(^|\/)Dockerfile[^/]*$|\.Dockerfile$/i, 'Docker'],
  [/\.(ya?ml|json|toml|ini|cfg|conf|properties|xml)$/i, 'Config'],
  [/\.(sh|bash|zsh|ps1)$/i, 'Scripts'],
  [/\.sql$/i, 'SQL'],
  [/\.(html?|css|scss|sass|less)$/i, 'Static web'],
];

/** Vendored, generated and build output. */
const IGNORED_DIR = /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|bin|obj|\.next|\.nuxt|coverage|generated|__generated__|docs?\/_build)\//i;

/** Tests, and tool configuration written in a programming language. */
/** Folders that hold tests (case-insensitive). */
const TEST_DIRS = /(^|\/)(tests?|__tests__|specs?|e2e)\//i;
/** Test file names by convention. Case matters for the CamelCase forms, so Latest.java is not a test. */
const TEST_NAMES = /\.(test|spec)\.[^/]+$|_(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|[a-z0-9_](Test|Tests|Spec|IT)\.(java|kt|kts|scala|groovy|cs|vb|fs|swift|php|m|mm)$/;

/** Whether a path is a test file, in any of the supported languages' conventions. */
export function isTestPath(path: string): boolean {
  return TEST_DIRS.test(path) || TEST_NAMES.test(path);
}

/** Tool configuration written in a programming language, and generated or minified code. */
const NOT_SOURCE = /(^|\/)[^/]+\.config\.[cm]?[jt]s$|(^|\/)\.[^/]+rc\.[cm]?js$|(^|\/)(conftest|setup|noxfile|fabfile)\.py$|\.d\.ts$|\.min\.js$/i;

/** The coverage language of an application source file, or undefined for tests, config, vendored code and non-code. */
export function sourceLanguage(path: string): string | undefined {
  if (IGNORED_DIR.test(path) || NOT_SOURCE.test(path) || isTestPath(path)) return undefined;
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext ? COVERAGE_LANGUAGES[ext] : undefined;
}

export interface TechnologyProfile {
  /** Application source files per coverage language. */
  source: Record<string, number>;
  sourceFiles: number;
  /** Everything else, by kind. */
  other: Record<string, number>;
}

export function technologyProfile(paths: readonly string[]): TechnologyProfile {
  const source: Record<string, number> = {};
  const other: Record<string, number> = {};
  let sourceFiles = 0;
  for (const path of paths) {
    if (IGNORED_DIR.test(path)) continue;
    const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
    const language = ext ? COVERAGE_LANGUAGES[ext] : undefined;
    if (language && !NOT_SOURCE.test(path) && !isTestPath(path)) {
      source[language] = (source[language] ?? 0) + 1;
      sourceFiles++;
      continue;
    }
    const kind = OTHER_KINDS.find(([re]) => re.test(path))?.[1];
    if (kind) other[kind] = (other[kind] ?? 0) + 1;
  }
  return { source, sourceFiles, other };
}

export const describeCounts = (counts: Record<string, number>, limit = 4) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');

export function profileOf(ctx: RepoContext): TechnologyProfile {
  return technologyProfile(ctx.files.map((f) => f.path));
}

/** File names too generic to identify what a test covers; their folder name is used instead. */
const GENERIC_STEMS = new Set(['index', 'main', 'mod', '__init__', 'app', 'lib']);

const TEST_DIR = /^(tests?|__tests__|spec|specs)$/i;

/**
 * Names a source file can be tested under. Generic names (index, main, ...) are qualified by their
 * folder: src/core/index.ts is tested by core/index.test.ts or core.test.ts, not by any index.test.ts.
 */
function sourceKeys(path: string): string[] {
  const parts = path.split('/');
  const name = parts.pop()!.replace(/\.[^.]+$/, '').toLowerCase();
  const folder = parts.pop()?.toLowerCase();
  return GENERIC_STEMS.has(name) && folder ? [`${folder}/${name}`, folder] : [name];
}

/** What a test file covers: its name without test markers (user.service.spec.ts → user.service, test_parser.py → parser). */
function testKeys(path: string): string[] {
  const parts = path.split('/');
  const name = parts
    .pop()!
    .replace(/\.[^.]+$/, '')
    .replace(/[._-](test|spec)s?$/i, '')
    .replace(/^(test|spec)[._-]/i, '')
    .replace(/(Tests?|Spec|IT)$/, '')
    .toLowerCase();
  const folder = parts.filter((d) => !TEST_DIR.test(d)).pop()?.toLowerCase();
  return GENERIC_STEMS.has(name) && folder ? [`${folder}/${name}`] : [name];
}

export interface TestEstimate {
  tested: string[];
  untested: string[];
  /** Share of application source files with a matching test file, 0-100. */
  percent: number;
}

/** How many more source files need tests for the estimate to reach the threshold. */
export function filesNeeded(est: TestEstimate, threshold: number): number {
  const total = est.tested.length + est.untested.length;
  return Math.max(0, Math.ceil((threshold / 100) * total - 1e-9) - est.tested.length);
}

/** Static estimate of test coverage: which source files have a test file named after them. */
export function estimateTestCoverage(paths: readonly string[], isTest: (path: string) => boolean): TestEstimate {
  const covered = new Set(paths.filter((p) => isTest(p) && !IGNORED_DIR.test(p)).flatMap(testKeys));
  const tested: string[] = [];
  const untested: string[] = [];
  for (const p of paths) {
    if (!sourceLanguage(p)) continue;
    (sourceKeys(p).some((k) => covered.has(k)) ? tested : untested).push(p);
  }
  const total = tested.length + untested.length;
  return { tested, untested, percent: total ? Math.round((tested.length / total) * 100) : 100 };
}

/** Whether these test files would make the estimate count `source` as tested. */
export function testsRecognised(source: string, tests: readonly string[], isTest: (path: string) => boolean): boolean {
  return estimateTestCoverage([source, ...tests], isTest).tested.includes(source);
}
