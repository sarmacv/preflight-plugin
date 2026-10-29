// The declarative rule language used in skill frontmatter. Each rule is `{ <name>: <params> }`.
import { z } from 'zod';
import type { RepoContext } from '../../engine/context';
import type { Rule } from '../types';
import { BUILTINS } from './builtins';
import { CI_GLOBS } from './ciGlobs';
import { errored, fail, pass, RuleConfigError, type RuleFn, type RuleOutcome } from './types';

const paths = z.array(z.string()).min(1);
const globs = z.union([z.string(), z.array(z.string()).min(1)]).transform((g) => (Array.isArray(g) ? g : [g]));

function parse<T>(schema: z.ZodType<T>, params: unknown, rule: string): T {
  const r = schema.safeParse(params);
  if (!r.success) throw new RuleConfigError(`${rule}: ${r.error.issues.map((i) => i.message).join('; ')}`);
  return r.data;
}

async function fileContains(ctx: RepoContext, files: string[], pattern: RegExp): Promise<string | undefined> {
  for (const f of files) {
    const text = await ctx.read(f);
    if (text !== undefined && pattern.test(text)) return f;
  }
  return undefined;
}

const containsSchema = z.object({
  paths: z.array(z.string()).optional(),
  globs: globs.optional(),
  pattern: z.string(),
  flags: z.string().default('i'),
  description: z.string().optional(),
});

export const RULES: Record<string, RuleFn> = {
  async file_exists(params, ctx) {
    const p = parse(z.string(), params, 'file_exists');
    const found = ctx.exists(p);
    return found ? pass({ message: `Found ${found}`, path: found, url: ctx.htmlUrl(found) }) : fail({ message: `${p} not found` });
  },

  async any_file_exists(params, ctx) {
    const list = parse(paths, params, 'any_file_exists');
    for (const p of list) {
      const found = ctx.exists(p);
      if (found) return pass({ message: `Found ${found}`, path: found, url: ctx.htmlUrl(found) });
    }
    return fail({ message: `None of ${list.join(', ')} found` });
  },

  async glob_present(params, ctx) {
    const g = parse(globs, params, 'glob_present');
    const hits = ctx.match(g);
    return hits.length
      ? pass({ message: `Found ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ` (+${hits.length - 3} more)` : ''}`, path: hits[0], url: ctx.htmlUrl(hits[0]) })
      : fail({ message: `No files match ${g.join(', ')}` });
  },

  async glob_absent(params, ctx) {
    const g = parse(globs, params, 'glob_absent');
    const hits = ctx.match(g);
    return hits.length
      ? fail(...hits.slice(0, 10).map((h) => ({ message: `Unexpected file ${h}`, path: h, url: ctx.htmlUrl(h) })))
      : pass({ message: `No files match ${g.join(', ')}` });
  },

  async file_min_content(params, ctx) {
    const p = parse(
      z.object({
        paths,
        min_chars: z.number().int().nonnegative().default(0),
        min_lines: z.number().int().nonnegative().default(0),
        min_headings: z.number().int().nonnegative().default(0),
        reject: z.array(z.string()).default([]),
      }),
      params,
      'file_min_content',
    );
    const path = p.paths.map((x) => ctx.exists(x)).find((x) => x !== undefined);
    if (!path) return fail({ message: `None of ${p.paths.join(', ')} found` });
    const text = (await ctx.read(path)) ?? '';
    const body = text.replace(/<!--[\s\S]*?-->/g, '').trim();
    const lines = body.split('\n').filter((l) => l.trim()).length;
    const headings = (body.match(/^#{1,6}\s+\S/gm) ?? []).length;
    const problems: string[] = [];
    if (body.length < p.min_chars) problems.push(`${body.length} characters (needs ${p.min_chars})`);
    if (lines < p.min_lines) problems.push(`${lines} non-empty lines (needs ${p.min_lines})`);
    if (headings < p.min_headings) problems.push(`${headings} headings (needs ${p.min_headings})`);
    for (const r of p.reject) {
      const m = new RegExp(r, 'im').exec(body);
      if (m) problems.push(`contains placeholder text "${m[0].trim().slice(0, 40)}"`);
    }
    const ev = { path, url: ctx.htmlUrl(path) };
    return problems.length ? fail({ message: `${path}: ${problems.join('; ')}`, ...ev }) : pass({ message: `${path} has substantive content`, ...ev });
  },

  async file_contains(params, ctx) {
    const p = parse(containsSchema, params, 'file_contains');
    const files = [...(p.paths ?? []).map((x) => ctx.exists(x)).filter((x): x is string => !!x), ...(p.globs ? ctx.match(p.globs) : [])];
    const what = p.description ?? `/${p.pattern}/`;
    if (files.length === 0) return fail({ message: `No files to search for ${what}` });
    const hit = await fileContains(ctx, files, new RegExp(p.pattern, p.flags));
    return hit ? pass({ message: `${hit} matches ${what}`, path: hit, url: ctx.htmlUrl(hit) }) : fail({ message: `No match for ${what} in ${files.length} file(s)` });
  },

  async workflow_contains(params, ctx) {
    const p = parse(z.union([z.string(), containsSchema.omit({ paths: true, globs: true })]), params, 'workflow_contains');
    const spec = typeof p === 'string' ? { pattern: p, flags: 'i' } : p;
    const files = ctx.match(CI_GLOBS);
    const what = ('description' in spec && spec.description) || `/${spec.pattern}/`;
    if (files.length === 0) return fail({ message: 'No CI configuration found' });
    const hit = await fileContains(ctx, files, new RegExp(spec.pattern, spec.flags));
    return hit ? pass({ message: `${hit} runs ${what}`, path: hit, url: ctx.htmlUrl(hit) }) : fail({ message: `CI doesn't run ${what}` });
  },

  async api_field(params, ctx) {
    const p = parse(
      z.object({
        endpoint: z.string().regex(/^GET \//, 'only GET endpoints are allowed'),
        field: z.string(),
        equals: z.unknown().optional(),
        exists: z.boolean().optional(),
        gte: z.number().optional(),
      }),
      params,
      'api_field',
    );
    const { data } = await ctx.gh.request(p.endpoint, { owner: ctx.info.owner, repo: ctx.info.repo, branch: ctx.info.ref, request: { signal: ctx.signal } });
    const value = p.field.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), data);
    const label = `${p.field} = ${JSON.stringify(value)}`;
    let ok = value !== undefined && value !== null;
    if (p.exists === false) ok = !ok;
    if ('equals' in p && p.equals !== undefined) ok = JSON.stringify(value) === JSON.stringify(p.equals);
    if (p.gte !== undefined) ok = typeof value === 'number' && value >= p.gte;
    return ok ? pass({ message: label }) : fail({ message: label });
  },

  async builtin(params, ctx) {
    const p = parse(z.object({ name: z.string(), params: z.record(z.string(), z.unknown()).default({}) }), params, 'builtin');
    const fn = BUILTINS[p.name];
    if (!fn) throw new RuleConfigError(`unknown builtin "${p.name}"`);
    return fn(p.params, ctx);
  },

  async all_of(params, ctx) {
    const outcomes = await Promise.all(parse(z.array(z.unknown()).min(1), params, 'all_of').map((r) => evaluateRule(r as Rule, ctx)));
    return combine(outcomes, 'all');
  },

  async any_of(params, ctx) {
    const outcomes: RuleOutcome[] = [];
    for (const r of parse(z.array(z.unknown()).min(1), params, 'any_of')) {
      const o = await evaluateRule(r as Rule, ctx);
      if (o.status === 'pass') return o;
      outcomes.push(o);
    }
    return combine(outcomes, 'any');
  },

  async not(params, ctx) {
    const o = await evaluateRule(params as Rule, ctx);
    if (o.status === 'pass') return { status: 'fail', evidence: o.evidence };
    if (o.status === 'fail') return { status: 'pass', evidence: o.evidence };
    return o;
  },
};

function combine(outcomes: RuleOutcome[], mode: 'all' | 'any'): RuleOutcome {
  const evidence = outcomes.flatMap((o) => o.evidence);
  const has = (s: RuleOutcome['status']) => outcomes.some((o) => o.status === s);
  if (mode === 'all') {
    if (has('fail')) return { status: 'fail', evidence: outcomes.filter((o) => o.status === 'fail').flatMap((o) => o.evidence) };
    if (has('error')) return { status: 'error', evidence };
    if (outcomes.every((o) => o.status === 'skipped')) return { status: 'skipped', evidence };
    return { status: 'pass', evidence };
  }
  if (has('error') && !has('fail')) return { status: 'error', evidence };
  if (outcomes.every((o) => o.status === 'skipped')) return { status: 'skipped', evidence };
  return { status: 'fail', evidence };
}

export async function evaluateRule(rule: Rule, ctx: RepoContext): Promise<RuleOutcome> {
  const keys = Object.keys(rule ?? {});
  if (keys.length !== 1) throw new RuleConfigError(`a rule must have exactly one key, got ${keys.join(', ') || 'none'}`);
  const fn = RULES[keys[0]];
  if (!fn) throw new RuleConfigError(`unknown rule "${keys[0]}"`);
  return fn(rule[keys[0]], ctx);
}

/** All top-level rules must pass. */
export async function evaluateRules(rules: Rule[], ctx: RepoContext): Promise<RuleOutcome> {
  try {
    return await RULES.all_of(rules, ctx);
  } catch (err) {
    if (err instanceof RuleConfigError) return errored(`Skill misconfigured: ${err.message}`);
    throw err;
  }
}

export { pass, fail };
