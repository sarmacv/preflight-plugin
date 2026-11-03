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
const NOT_SOURCE = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|Tests?\.(java|kt|cs)$|(^|\/)[^/]+\.config\.[cm]?[jt]s$|(^|\/)\.[^/]+rc\.[cm]?js$|(^|\/)(conftest|setup|noxfile|fabfile)\.py$|\.d\.ts$|\.min\.js$/i;

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
    if (language && !NOT_SOURCE.test(path)) {
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
