import type { ModelProvider } from '../ai/provider';
import { evaluateRules } from '../skills/rules';
import type { RuleOutcome } from '../skills/rules/types';
import type { CheckResult, Skill } from '../skills/types';
import type { RepoContext } from './context';

export interface RunOptions {
  /** Fixed for the whole scan. Without it, AI evaluation is skipped. */
  provider?: ModelProvider;
  /** Results of this skill's depends_on checks, when they ran in the same scan. */
  prerequisites?: CheckResult[];
}

/** Context files over this size aren't sent to the model. */
const MAX_CONTEXT_FILE = 100_000;
const MAX_CONTEXT_FILES = 20;
/** Never sent to a model, whatever a skill asks for. */
const DENY_CONTEXT = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|.*secrets?\.(json|ya?ml))$/i;

export class ScanCancelled extends Error {
  constructor() {
    super('Scan cancelled');
  }
}

export async function runCheck(skill: Skill, ctx: RepoContext, opts: RunOptions = {}): Promise<CheckResult> {
  const started = Date.now();
  const result = (o: RuleOutcome): CheckResult => ({
    checkId: skill.id,
    name: skill.name,
    category: skill.category,
    categoryName: skill.categoryName,
    severity: skill.severity,
    status: o.status,
    evidence: o.evidence,
    fixable: skill.fixable,
    fixPr: skill.fix_pr,
    durationMs: Date.now() - started,
  });

  if (ctx.signal?.aborted) throw new ScanCancelled();
  const blocker = opts.prerequisites?.find((p) => p.status === 'fail');
  if (blocker) return result({ status: 'skipped', evidence: [{ message: `Needs "${blocker.name}" to pass first` }] });
  try {
    const applies = skill.applies_to?.any_file;
    if (applies && ctx.match(applies).length === 0) {
      return result({ status: 'skipped', evidence: [{ message: `Not applicable: no ${applies.join(', ')}` }] });
    }

    let outcome: RuleOutcome | undefined;
    if (skill.evaluation !== 'ai') {
      outcome = await evaluateRules(skill.rules ?? [], ctx);
      if (skill.evaluation === 'deterministic' || outcome.status !== 'pass') return result(outcome);
    }

    if (!opts.provider) {
      return result(
        outcome
          ? { status: outcome.status, evidence: [...outcome.evidence, { message: 'AI review unavailable; result is from the rules only' }] }
          : { status: 'skipped', evidence: [{ message: 'AI review unavailable' }] },
      );
    }

    const files = await contextFiles(skill, ctx);
    const evaluation = await opts.provider.evaluate(skill, { repo: ctx, files, ruleEvidence: outcome?.evidence }, ctx.signal);
    return result({ status: evaluation.status, evidence: [...(outcome?.evidence ?? []), ...evaluation.evidence] });
  } catch (err) {
    if (ctx.signal?.aborted) throw new ScanCancelled();
    return result({ status: 'error', evidence: [{ message: describe(err) }] });
  }
}

export async function contextFiles(skill: Skill, ctx: RepoContext): Promise<{ path: string; content: string }[]> {
  const paths = ctx
    .match(skill.context_files)
    .filter((p) => !DENY_CONTEXT.test(p) && (ctx.size(p) ?? 0) <= MAX_CONTEXT_FILE)
    .slice(0, MAX_CONTEXT_FILES);
  const out: { path: string; content: string }[] = [];
  for (const path of paths) {
    const content = await ctx.read(path);
    if (content !== undefined) out.push({ path, content });
  }
  return out;
}

function describe(err: unknown): string {
  const e = err as { status?: number; message?: string };
  if (e.status === 403) return `Permission denied: ${e.message ?? 'forbidden'}`;
  if (e.status === 404) return `Not found: ${e.message ?? ''}`.trim();
  return e.message ?? String(err);
}
