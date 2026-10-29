// Minimal SonarQube Web API client (self-hosted). No vscode imports so it can be unit tested.

export class SonarError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface FileCoverage {
  path: string;
  coverage: number;
  uncoveredLines: number;
}

type Fetch = typeof fetch;

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|Test\.java$|Tests?\.cs$/i;

export class SonarClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly token: string, private readonly fetchImpl: Fetch = fetch) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  projectUrl(key: string, branch?: string): string {
    return `${this.base}/dashboard?id=${encodeURIComponent(key)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`;
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const res = await this.fetchImpl(`${this.base}${path}?${qs}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.token}:`).toString('base64')}`, Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { errors?: { msg: string }[] };
        if (body.errors?.length) message = body.errors.map((e) => e.msg).join('; ');
      } catch {
        // Non-JSON error body.
      }
      if (res.status === 401) message = 'SonarQube rejected the token';
      throw new SonarError(res.status, message);
    }
    return (await res.json()) as T;
  }

  async projectExists(key: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.get('/api/components/show', { component: key }, signal);
      return true;
    } catch (err) {
      if (err instanceof SonarError && (err.status === 404 || err.status === 403)) return false;
      throw err;
    }
  }

  async searchProjects(query: string, signal?: AbortSignal): Promise<{ key: string; name: string }[]> {
    const data = await this.get<{ components: { key: string; name: string }[] }>(
      '/api/components/search',
      { qualifiers: 'TRK', q: query.length >= 2 ? query : undefined, ps: 100 },
      signal,
    );
    return data.components.map((c) => ({ key: c.key, name: c.name }));
  }

  /** Overall line coverage in percent, or undefined when the project has no coverage measure. */
  async coverage(key: string, branch?: string, signal?: AbortSignal): Promise<number | undefined> {
    const data = await this.get<{ component: { measures: { metric: string; value?: string }[] } }>(
      '/api/measures/component',
      { component: key, branch, metricKeys: 'coverage' },
      signal,
    );
    const v = data.component.measures.find((m) => m.metric === 'coverage')?.value;
    return v === undefined ? undefined : Number(v);
  }

  /** Source files with the lowest coverage (test files and fully covered files excluded). */
  async lowestCoverage(key: string, branch: string | undefined, limit: number, signal?: AbortSignal): Promise<FileCoverage[]> {
    const data = await this.get<{
      components: { path?: string; measures: { metric: string; value?: string }[] }[];
    }>(
      '/api/measures/component_tree',
      { component: key, branch, qualifiers: 'FIL', metricKeys: 'coverage,uncovered_lines', s: 'metric', metricSort: 'coverage', metricSortFilter: 'withMeasuresOnly', asc: 'true', ps: Math.min(500, limit * 10) },
      signal,
    );
    const files: FileCoverage[] = [];
    for (const c of data.components) {
      if (!c.path || TEST_PATH.test(c.path)) continue;
      const m = (name: string) => Number(c.measures.find((x) => x.metric === name)?.value ?? NaN);
      const coverage = m('coverage');
      const uncoveredLines = m('uncovered_lines');
      if (Number.isNaN(coverage) || !(uncoveredLines > 0)) continue;
      files.push({ path: c.path, coverage, uncoveredLines });
    }
    // Lowest coverage first; among equals, the most uncovered lines first (most value per test).
    files.sort((a, b) => a.coverage - b.coverage || b.uncoveredLines - a.uncoveredLines);
    return files.slice(0, limit);
  }
}

export function projectKeyFromProperties(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /^\s*sonar\.projectKey\s*[=:]\s*(\S+)\s*$/m.exec(text);
  return m?.[1];
}

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}
