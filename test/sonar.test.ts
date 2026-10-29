import { describe, expect, it } from 'vitest';
import { projectKeyFromProperties, SonarClient } from '../src/sonar/client';
import { createSonarLink } from '../src/sonar/access';
import { fakeRepo } from './helpers/fakeRepo';

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []) {
  return (async (url: string, init?: RequestInit) => {
    seen.push(`${url} ${(init?.headers as Record<string, string>).Authorization}`);
    const path = new URL(url).pathname + new URL(url).search;
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return new Response(JSON.stringify({ errors: [{ msg: 'Component not found' }] }), { status: 404 });
    const body = routes[key];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('SonarClient', () => {
  it('reads coverage with a basic-auth token', async () => {
    const seen: string[] = [];
    const c = new SonarClient('https://sonar.example.com/', 'tok', fakeFetch({ '/api/measures/component?component=api': { component: { measures: [{ metric: 'coverage', value: '61.4' }] } } }, seen));
    expect(await c.coverage('api')).toBe(61.4);
    expect(seen[0]).toBe(`https://sonar.example.com/api/measures/component?component=api&metricKeys=coverage Basic ${Buffer.from('tok:').toString('base64')}`);
  });

  it('returns the lowest-coverage source files, skipping tests and fully covered files', async () => {
    const m = (cov: string, unc: string) => [{ metric: 'coverage', value: cov }, { metric: 'uncovered_lines', value: unc }];
    const c = new SonarClient('https://s', 't', fakeFetch({ '/api/measures/component_tree': { components: [
      { path: 'src/b.ts', measures: m('40', '10') },
      { path: 'src/a.ts', measures: m('10', '50') },
      { path: 'src/a.test.ts', measures: m('0', '5') },
      { path: 'src/c.ts', measures: m('100', '0') },
      { path: 'src/d.ts', measures: m('10', '80') },
    ] } }));
    expect((await c.lowestCoverage('api', undefined, 2)).map((f) => f.path)).toEqual(['src/d.ts', 'src/a.ts']);
  });

  it('explains a rejected token', async () => {
    const c = new SonarClient('https://s', 't', fakeFetch({ '/api/measures': new Response('', { status: 401 }) }));
    await expect(c.coverage('api')).rejects.toThrow('SonarQube rejected the token');
  });

  it('reads the project key from sonar-project.properties', () => {
    expect(projectKeyFromProperties('# x\nsonar.projectKey = acme_api\nsonar.sources=.')).toBe('acme_api');
    expect(projectKeyFromProperties('sonar.sources=.')).toBeUndefined();
  });
});

describe('createSonarLink', () => {
  const coverage = { component: { measures: [{ metric: 'coverage', value: '90' }] } };

  it('prefers sonar-project.properties, then the repo name', async () => {
    const client = new SonarClient('https://s', 't', fakeFetch({ '/api/components/show?component=from-file': {}, '/api/components/show?component=api': {}, '/api/measures/component': coverage }));
    const pick = async () => 'picked';
    const store = { get: () => undefined, set: () => {} };
    const withFile = await createSonarLink(client, store, pick).coverage(fakeRepo({ 'sonar-project.properties': 'sonar.projectKey=from-file' }));
    expect(withFile?.projectKey).toBe('from-file');
    expect((await createSonarLink(client, store, pick).coverage(fakeRepo({})))?.projectKey).toBe('api');
  });

  it('asks the user to pick and remembers the answer', async () => {
    const client = new SonarClient('https://s', 't', fakeFetch({ '/api/measures/component': coverage }));
    const saved: Record<string, string> = {};
    let asked = 0;
    const link = createSonarLink(client, { get: (r) => saved[r], set: (r, k) => void (saved[r] = k) }, async () => (asked++, 'chosen'));
    expect((await link.coverage(fakeRepo({})))?.projectKey).toBe('chosen');
    expect(saved).toEqual({ 'acme/api': 'chosen' });
    await link.coverage(fakeRepo({}));
    expect(asked).toBe(1);
  });

  it('returns undefined when the user skips', async () => {
    const client = new SonarClient('https://s', 't', fakeFetch({}));
    expect(await createSonarLink(client, { get: () => undefined, set: () => {} }, async () => undefined).coverage(fakeRepo({}))).toBeUndefined();
  });
});
