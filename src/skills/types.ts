import { z } from 'zod';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SECTION_TITLES = ['What this checks', 'How to evaluate', 'Pass criteria', 'Fail criteria', 'How to fix'] as const;
export type SectionTitle = (typeof SECTION_TITLES)[number];

/**
 * A rule is a single-key object, e.g. `{ any_file_exists: [...] }` or `{ all_of: [rule, ...] }`.
 * Rule names and their parameters are validated by the rule registry, not here, so new rule
 * types don't require schema changes.
 */
export const RuleSchema: z.ZodType<Rule> = z.lazy(() =>
  z.record(z.string(), z.unknown()).refine((r) => Object.keys(r).length === 1, 'A rule must have exactly one key'),
);
export type Rule = Record<string, unknown>;

export const FixSchema = z.object({
  kind: z.enum(['builtin', 'template', 'ai']),
  /** Builtin fix generator name (kind: builtin). */
  name: z.string().optional(),
  /** Repo path the fix writes (kind: template or ai). */
  path: z.string().optional(),
  /** File content with {placeholders} (kind: template). */
  template: z.string().optional(),
});
export type FixSpec = z.infer<typeof FixSchema>;

export const AppliesToSchema = z
  .object({
    /** The check only applies when at least one file matches one of these globs. */
    any_file: z.array(z.string()).optional(),
  })
  .strict();

export const FrontmatterSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case'),
    name: z.string().min(1),
    category: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'category must be kebab-case'),
    category_name: z.string().optional(),
    severity: z.enum(SEVERITIES),
    evaluation: z.enum(['deterministic', 'ai', 'hybrid']),
    fixable: z.boolean(),
    fix_pr: z.enum(['fixes', 'coverage']).default('fixes'),
    applies_to: AppliesToSchema.optional(),
    /** Checks that must pass first; if one fails, this check is skipped instead of failing for the same reason. */
    depends_on: z.array(z.string()).default([]),
    rules: z.array(RuleSchema).optional(),
    fix: FixSchema.optional(),
    /** Globs of files handed to the model for ai/hybrid evaluation and ai fixes. */
    context_files: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((fm, ctx) => {
    if (fm.evaluation !== 'ai' && (!fm.rules || fm.rules.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['rules'], message: `${fm.evaluation} checks need at least one rule` });
    }
    if (fm.fixable && !fm.fix) {
      ctx.addIssue({ code: 'custom', path: ['fix'], message: 'fixable checks need a fix block' });
    }
  });
export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface Skill extends Frontmatter {
  categoryName: string;
  /** The full markdown file, as handed to models. */
  source: string;
  sections: Partial<Record<SectionTitle, string>>;
  /** Path relative to the skills root, for diagnostics. */
  file: string;
}

export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'error';

export interface Evidence {
  message: string;
  path?: string;
  url?: string;
}

export interface CheckResult {
  checkId: string;
  name: string;
  category: string;
  categoryName: string;
  severity: Severity;
  status: CheckStatus;
  evidence: Evidence[];
  fixable: boolean;
  fixPr: 'fixes' | 'coverage';
  durationMs: number;
}
