// Branch names for Preflight PRs, built from the user's template and validated against git's
// ref rules and the optional org regex. Shared by the extension host and the webview.

export type PrKind = 'fixes' | 'coverage';

export interface BranchVars {
  user: string;
  repo: string;
  checkOrCategory: string;
  type: PrKind;
  date?: Date;
  shortid?: string;
}

export const DEFAULT_TEMPLATE = 'preflight/{type}/{date}-{shortid}';

export function shortId(): string {
  return Math.random().toString(16).slice(2, 8).padEnd(6, '0');
}

const pad = (n: number) => String(n).padStart(2, '0');
export const formatDate = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/** Makes one template value safe inside a ref segment. */
function slug(value: string): string {
  return value
    .trim()
    .replace(/[\s~^:?*[\]\\@{}]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

export function renderBranchName(template: string, vars: BranchVars): string {
  const values: Record<string, string> = {
    user: slug(vars.user),
    repo: slug(vars.repo),
    'check-or-category': slug(vars.checkOrCategory),
    type: vars.type,
    date: formatDate(vars.date ?? new Date()),
    shortid: vars.shortid ?? shortId(),
  };
  return (template.trim() || DEFAULT_TEMPLATE).replace(/\{([a-z-]+)\}/g, (m, key: string) => values[key] ?? m);
}

/** Returns a problem description, or undefined when the name is usable. */
export function validateBranchName(name: string, pattern?: string): string | undefined {
  if (!name) return 'Branch name is empty';
  if (/\{[a-z-]+\}/.test(name)) return 'Unknown placeholder in template';
  if (/[\s~^:?*[\\]|[\x00-\x1f\x7f]/.test(name)) return 'Contains characters git does not allow';
  if (name.includes('..') || name.includes('@{') || name === '@') return 'Contains ".." or "@{"';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'Has an empty path segment';
  if (name.startsWith('-')) return 'Starts with "-"';
  if (name.endsWith('.') || name.endsWith('.lock') || name.split('/').some((s) => s.startsWith('.') || s.endsWith('.lock'))) {
    return 'A segment starts with "." or ends with ".lock"';
  }
  if (pattern) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return 'The branch pattern setting is not a valid regular expression';
    }
    if (!re.test(name)) return `Doesn't match the required pattern ${pattern}`;
  }
  return undefined;
}

/** Appends -2, -3, … until the name is free. */
export async function resolveCollision(name: string, exists: (candidate: string) => Promise<boolean>): Promise<string> {
  if (!(await exists(name))) return name;
  for (let i = 2; i < 100; i++) {
    const candidate = `${name}-${i}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free branch name based on ${name}`);
}

/** {check-or-category}: the single check id, the shared category, or "multi". */
export function checkOrCategory(checks: { id: string; category: string }[]): string {
  if (checks.length === 1) return checks[0].id;
  const cats = new Set(checks.map((c) => c.category));
  return cats.size === 1 ? [...cats][0] : 'multi';
}
