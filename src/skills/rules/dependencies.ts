// Dependency inventory for the SBOM, vulnerability, pinning and licence checks, built from GitHub's
// dependency graph when it reflects the scanned branch, otherwise from manifests fetched over the API.
import type { RepoContext } from '../../engine/context';

export type Ecosystem = 'npm' | 'pypi' | 'maven' | 'golang' | 'cargo' | 'nuget' | 'gem' | 'composer' | 'github-actions';

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version?: string;
  license?: string;
  /** Manifest the dependency was read from, when known. */
  source?: string;
}

export interface Inventory {
  dependencies: Dependency[];
  origin: 'dependency-graph' | 'manifests';
}

const PURL = /^pkg:([a-z-]+)\/(.+?)@([^?#]+)/;

export function fromPurl(purl: string): Dependency | undefined {
  const m = PURL.exec(purl);
  if (!m) return undefined;
  const type = m[1];
  const name = decodeURIComponent(m[2]).replace(/^(maven)\//, '');
  const map: Record<string, Ecosystem> = {
    npm: 'npm', pypi: 'pypi', maven: 'maven', golang: 'golang', cargo: 'cargo', nuget: 'nuget', gem: 'gem', composer: 'composer', githubactions: 'github-actions', github: 'github-actions',
  };
  const ecosystem = map[type];
  if (!ecosystem) return undefined;
  return { ecosystem, name: ecosystem === 'maven' ? name.replace('/', ':') : name, version: decodeURIComponent(m[3]) };
}

interface SpdxPackage {
  name?: string;
  versionInfo?: string;
  licenseConcluded?: string;
  licenseDeclared?: string;
  externalRefs?: { referenceType?: string; referenceLocator?: string }[];
}

export function fromSpdx(packages: SpdxPackage[]): Dependency[] {
  const out: Dependency[] = [];
  for (const p of packages) {
    const purl = p.externalRefs?.find((r) => r.referenceType === 'purl')?.referenceLocator;
    const dep = purl ? fromPurl(purl) : undefined;
    if (!dep) continue;
    const license = [p.licenseConcluded, p.licenseDeclared].find((l) => l && l !== 'NOASSERTION');
    out.push({ ...dep, license });
  }
  return out;
}

export const MANIFEST_GLOBS = [
  '**/package-lock.json', '**/package.json', '**/requirements*.txt', '**/go.mod', '**/pom.xml', '**/Cargo.lock', '**/Cargo.toml',
];

const IGNORED = /(^|\/)(node_modules|vendor|dist|build|\.git)\//;

export function parseManifest(path: string, text: string): Dependency[] {
  const file = path.split('/').pop()!.toLowerCase();
  const deps: Dependency[] = [];
  const add = (ecosystem: Ecosystem, name: string, version?: string) => deps.push({ ecosystem, name, version, source: path });
  try {
    if (file === 'package-lock.json') {
      const lock = JSON.parse(text) as { packages?: Record<string, { version?: string; license?: string }>; dependencies?: Record<string, { version?: string }> };
      for (const [key, v] of Object.entries(lock.packages ?? {})) {
        if (!key) continue;
        const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
        deps.push({ ecosystem: 'npm', name, version: v.version, license: v.license, source: path });
      }
      if (!lock.packages) for (const [name, v] of Object.entries(lock.dependencies ?? {})) add('npm', name, v.version);
    } else if (file === 'package.json') {
      const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, range] of Object.entries(pkg[section] ?? {})) add('npm', name, range);
      }
    } else if (/^requirements.*\.txt$/.test(file)) {
      for (const line of text.split('\n')) {
        const m = /^\s*([A-Za-z0-9_.\-[\]]+)\s*(==|>=|~=|<=|>|<)?\s*([^\s;#]+)?/.exec(line);
        if (m && !line.trim().startsWith('#') && !line.trim().startsWith('-')) add('pypi', m[1].replace(/\[.*\]/, ''), m[2] ? `${m[2] === '==' ? '' : m[2]}${m[3] ?? ''}` : undefined);
      }
    } else if (file === 'go.mod') {
      for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.\-/]+\.[\w.\-/]+)\s+(v[\w.\-+]+)/gm)) add('golang', m[1], m[2]);
    } else if (file === 'pom.xml') {
      for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
        const g = /<groupId>([^<]+)<\/groupId>/.exec(m[1])?.[1];
        const a = /<artifactId>([^<]+)<\/artifactId>/.exec(m[1])?.[1];
        const v = /<version>([^<]+)<\/version>/.exec(m[1])?.[1];
        if (g && a) add('maven', `${g}:${a}`, v);
      }
    } else if (file === 'cargo.lock') {
      for (const m of text.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) add('cargo', m[1], m[2]);
    } else if (file === 'cargo.toml') {
      const section = /\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(text)?.[1] ?? '';
      for (const m of section.matchAll(/^\s*([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) add('cargo', m[1], m[2] ?? m[3]);
    }
  } catch {
    // Unparseable manifest: contributes nothing.
  }
  return deps;
}

/** Lockfiles that pin an ecosystem's full dependency tree. */
export const LOCKFILES: Record<string, string[]> = {
  'package.json': ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'],
  'pyproject.toml': ['poetry.lock', 'uv.lock', 'pdm.lock', 'Pipfile.lock'],
  Pipfile: ['Pipfile.lock'],
  'Cargo.toml': ['Cargo.lock'],
  'go.mod': ['go.sum'],
  Gemfile: ['Gemfile.lock'],
  'composer.json': ['composer.lock'],
};

export function manifestFiles(ctx: RepoContext): string[] {
  return ctx.match(MANIFEST_GLOBS).filter((p) => !IGNORED.test(p));
}

export async function readManifests(ctx: RepoContext): Promise<Dependency[]> {
  const files = manifestFiles(ctx);
  // Prefer the lockfile over package.json in the same folder: it has resolved versions.
  const lockDirs = new Set(files.filter((f) => f.endsWith('package-lock.json')).map((f) => f.slice(0, f.lastIndexOf('/') + 1)));
  const chosen = files.filter((f) => !(f.endsWith('package.json') && lockDirs.has(f.slice(0, f.lastIndexOf('/') + 1))));
  const parsed = await Promise.all(chosen.map(async (f) => parseManifest(f, (await ctx.read(f)) ?? '')));
  return dedupe(parsed.flat());
}

function dedupe(deps: Dependency[]): Dependency[] {
  const seen = new Map<string, Dependency>();
  for (const d of deps) seen.set(`${d.ecosystem}:${d.name}@${d.version ?? ''}`, d);
  return [...seen.values()];
}

export interface SbomExport {
  sbom: { packages?: SpdxPackage[] } & Record<string, unknown>;
}

const SBOM_POLL_MS = 2000;
const SBOM_POLL_ATTEMPTS = 15;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });

/**
 * GitHub's SPDX export of the dependency graph, which always reflects the default branch. Uses the
 * asynchronous report API (the synchronous /dependency-graph/sbom endpoint is removed on 2026-11-13):
 * generate-report returns an sbom_url that answers 202 until the report is ready, then redirects to it.
 */
export function exportSbom(ctx: RepoContext, pollMs = SBOM_POLL_MS): Promise<SbomExport | undefined> {
  return ctx.memo('sbom', async () => {
    const request = { signal: ctx.signal };
    try {
      const { data: report } = await ctx.gh.request('GET /repos/{owner}/{repo}/dependency-graph/sbom/generate-report', {
        owner: ctx.info.owner,
        repo: ctx.info.repo,
        request,
      });
      const url = (report as { sbom_url?: string }).sbom_url;
      if (!url) return undefined;
      for (let attempt = 0; attempt < SBOM_POLL_ATTEMPTS; attempt++) {
        const res = await ctx.gh.request(`GET ${url}`, { request });
        if (res.status !== 202 && res.data) {
          const doc = res.data as Record<string, unknown>;
          return (doc.sbom ? doc : { sbom: doc }) as unknown as SbomExport;
        }
        await sleep(pollMs, ctx.signal);
      }
      return undefined;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 403) return undefined;
      throw err;
    }
  });
}

export function inventory(ctx: RepoContext): Promise<Inventory> {
  return ctx.memo('inventory', async () => {
    if (ctx.isDefaultBranch) {
      const sbom = await exportSbom(ctx);
      const deps = fromSpdx(sbom?.sbom.packages ?? []).filter((d) => d.ecosystem !== 'github-actions');
      if (deps.length) return { dependencies: deps, origin: 'dependency-graph' };
    }
    return { dependencies: await readManifests(ctx), origin: 'manifests' };
  });
}
