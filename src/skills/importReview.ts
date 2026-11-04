// Reviews skills before import: is each one in a usable format and style, and does it duplicate a check
// that already exists? Deterministic checks always run; an AI pass (optional) confirms likely duplicates
// and can rewrite a free-form skill into Preflight's style. No vscode imports.
import type { ModelProvider } from '../ai/provider';
import { parseSkill } from './parser';
import { RULES } from './rules';
import { BUILTINS } from './rules/builtins';
import { unknownRules, type SkillDraft } from './importer';
import type { Rule, Skill } from './types';

export type IssueLevel = 'error' | 'warning';

export interface ReviewIssue {
  level: IssueLevel;
  message: string;
}

export interface DuplicateMatch {
  id: string;
  name: string;
  /** 0-1; 1 means the same ID, name or rules. */
  score: number;
  /** Why it matched, e.g. "same name" or "similar description". */
  reason: string;
  /** The AI agreed this is a duplicate. */
  confirmed?: boolean;
}

export type ReviewStatus = 'ready' | 'style' | 'duplicate' | 'invalid';

export interface DraftReview {
  draft: SkillDraft;
  status: ReviewStatus;
  issues: ReviewIssue[];
  duplicates: DuplicateMatch[];
  /** An AI rewrite into Preflight's style, ready to import instead of the plain conversion. */
  improved?: SkillDraft;
}

/** Scores at or above this are reported as likely duplicates; below SIMILAR they are ignored. */
export const LIKELY_DUPLICATE = 0.6;
const SIMILAR = 0.35;

const STOPWORDS = new Set(
  'a an and are as at be by check checks code does for from has have in into is it its of on or present repo repository should that the their this to uses using with'.split(' '),
);

/** Lower-case word stems, without stop words, for comparing what two checks are about. */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.replace(/(ions|ion|ing|ed|es|s)$/, '') || raw);
  }
  return out;
}

/**
 * Similarity of two term sets, 0-1: the mean of Dice and the overlap coefficient, so a short skill whose
 * terms all appear in a longer check's description still scores high.
 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const dice = (2 * shared) / (a.size + b.size);
  const overlap = shared / Math.min(a.size, b.size);
  return (dice + overlap) / 2;
}

/** Files a check is about (e.g. SECURITY.md), from its rules: two checks on the same files likely overlap. */
function ruleTargets(rules: Rule[] | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string' && /[./]/.test(v)) out.add(v.toLowerCase().replace(/^\.github\/|^docs\//, ''));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  rules?.forEach(walk);
  return out;
}

function draftSummary(draft: SkillDraft): { text: string; rules?: Rule[] } {
  if (draft.kind === 'preflight') {
    try {
      const s = parseSkill(draft.markdown.replace(/^(---\r?\n[\s\S]*?)\bcategory:.*$/m, '$1category: imported'), 'review.md');
      return { text: `${s.name} ${s.sections['What this checks'] ?? ''}`, rules: s.rules };
    } catch {
      return { text: draft.name };
    }
  }
  return { text: `${draft.name} ${draft.description ?? ''}` };
}

export function findDuplicates(draft: SkillDraft, skills: Skill[]): DuplicateMatch[] {
  const summary = draftSummary(draft);
  const mine = terms(summary.text);
  const myTargets = ruleTargets(summary.rules);
  const matches: DuplicateMatch[] = [];
  for (const s of skills) {
    let score = 0;
    let reason = '';
    if (s.id === draft.id) [score, reason] = [1, 'same ID'];
    else if (s.name.trim().toLowerCase() === draft.name.trim().toLowerCase()) [score, reason] = [1, 'same name'];
    else if (summary.rules && s.rules && JSON.stringify(summary.rules) === JSON.stringify(s.rules)) [score, reason] = [1, 'same rules'];
    else {
      score = similarity(mine, terms(`${s.name} ${s.sections['What this checks'] ?? ''}`));
      reason = 'similar purpose';
      const theirs = ruleTargets(s.rules);
      if ([...myTargets].some((t) => theirs.has(t))) {
        score = Math.max(score, 0.7);
        reason = 'checks the same files';
      }
    }
    if (score >= SIMILAR) matches.push({ id: s.id, name: s.name, score: Math.round(score * 100) / 100, reason });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, 3);
}

const PREFLIGHT_KEYS = new Set(['id', 'name', 'category', 'category_name', 'severity', 'evaluation', 'fixable', 'fix_pr', 'applies_to', 'depends_on', 'after', 'rules', 'fix', 'context_files']);

/** Format and style problems, from blocking (error) to advisory (warning). */
export function lintDraft(draft: SkillDraft): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const add = (level: IssueLevel, message: string) => issues.push({ level, message });

  if (draft.kind === 'preflight') {
    try {
      // The category is chosen during import, so any valid placeholder is fine here.
      const s = parseSkill(draft.markdown.replace(/^(---\r?\n[\s\S]*?)\bcategory:.*$/m, '$1category: imported'), draft.sourcePath);
      const unknown = unknownRules(s.rules);
      if (unknown.length) add('error', `Uses rules this version of Preflight doesn't have: ${unknown.join(', ')}`);
      if (s.evaluation !== 'deterministic' && s.context_files.length === 0) add('warning', 'AI-reviewed but lists no context_files, so the AI only sees the file list');
      for (const [title, body] of Object.entries(s.sections)) {
        if ((body ?? '').split(/\s+/).filter(Boolean).length < 3) add('warning', `"${title}" is almost empty`);
      }
    } catch (err) {
      // parseSkill's message is "<file>: <problems>"; keep only the problems.
      add('error', (err as Error).message.replace(/^[^:]+:\s*/, ''));
    }
  } else {
    const body = draft.markdown.replace(/^---[\s\S]*?---\r?\n?/, '');
    const words = body.split(/\s+/).filter(Boolean).length;
    // The importer falls back to the first paragraph, so look for a declared description.
    const declared = /^---\r?\n[\s\S]*?^description:\s*\S/m.test(draft.markdown);
    if (!declared) add('warning', 'No description: add a one-line "description" so people know what the check is for');
    if (words < 25) add('warning', `Instructions are very short (${words} words), so the AI has little to judge against`);
    if (!/^\s*([-*]|\d+\.)\s+\S/m.test(body) && !/\b(must|should|never|always|required?|pass|fail)\b/i.test(body)) {
      add('warning', 'No clear rules or pass/fail conditions; the result may be inconsistent');
    }
    const mentioned = [...body.matchAll(/`([\w./-]+\.(?:md|txt|json|ya?ml|csv))`|\]\(([\w./-]+\.(?:md|txt|json|ya?ml|csv))\)/g)].map((m) => m[1] ?? m[2]);
    const have = new Set(draft.resources.map((r) => r.path));
    for (const ref of new Set(mentioned)) {
      if (!have.has(ref) && !ref.startsWith('http')) add('warning', `Mentions ${ref}, but that file isn't in the import`);
    }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(draft.markdown)?.[1] ?? '';
    const preflightLike = [...fm.matchAll(/^(\w+):/gm)].map((m) => m[1]).filter((k) => PREFLIGHT_KEYS.has(k) && !['name'].includes(k));
    if (preflightLike.length >= 3) add('warning', `Looks like an incomplete Preflight skill (has ${preflightLike.join(', ')}); it will be imported as an AI check`);
  }
  for (const w of draft.warnings) add('warning', w);
  return issues;
}

export function statusOf(issues: ReviewIssue[], duplicates: DuplicateMatch[]): ReviewStatus {
  if (issues.some((i) => i.level === 'error')) return 'invalid';
  if (duplicates.some((d) => d.score >= LIKELY_DUPLICATE && d.confirmed !== false)) return 'duplicate';
  if (issues.length) return 'style';
  return 'ready';
}

export function reviewDraft(draft: SkillDraft, skills: Skill[]): DraftReview {
  const issues = lintDraft(draft);
  const duplicates = findDuplicates(draft, skills);
  return { draft, issues, duplicates, status: statusOf(issues, duplicates) };
}

// ---------------------------------------------------------------------------------------------
// AI review

const RULE_NAMES = Object.keys(RULES).join(', ');
const BUILTIN_NAMES = Object.keys(BUILTINS).join(', ');

export function aiReviewPrompt(draft: SkillDraft, candidates: Skill[], example: string): string {
  const existing = candidates.map((s) => `- ${s.id}: ${s.name}. ${(s.sections['What this checks'] ?? '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const resources = draft.resources.map((r) => `<skill-resource path="${r.path}">\n${r.content.slice(0, 20_000)}\n</skill-resource>`).join('\n');
  return [
    'You are reviewing a skill that a user is importing into Preflight, a tool that checks GitHub repositories against engineering standards.',
    '',
    'Task 1. Decide whether the imported skill checks the same thing as one of these existing checks. Only call it a duplicate when it would give the same result for the same reason; overlapping topics are not duplicates.',
    existing || '(none)',
    '',
    'Task 2. Rewrite the imported skill as a Preflight check in exactly the format of the example below: YAML frontmatter, then the five sections "What this checks", "How to evaluate", "Pass criteria", "Fail criteria", "How to fix". Keep every requirement and detail from the original; make the pass and fail criteria explicit and testable. Use evaluation: deterministic only if the whole check can be expressed with these rules: ' + RULE_NAMES + ' (builtins: ' + BUILTIN_NAMES + '); otherwise evaluation: ai with sensible context_files. Use category: imported. Use fixable: false.',
    '',
    'Example Preflight skill:',
    '<example>',
    example,
    '</example>',
    '',
    'Imported skill:',
    '<imported>',
    draft.markdown,
    '</imported>',
    resources,
    '',
    'Answer in exactly this format:',
    '<duplicate of="existing-id or none">one sentence why</duplicate>',
    '<file path="SKILL.md">',
    'the rewritten Preflight skill file',
    '</file>',
  ].join('\n');
}

export interface AiReview {
  duplicateOf?: string;
  reason?: string;
  rewritten?: string;
}

export function parseAiReview(reply: string): AiReview {
  const dup = /<duplicate\s+of="([^"]*)"\s*>([\s\S]*?)<\/duplicate>|<duplicate\s+of="([^"]*)"\s*\/>/.exec(reply);
  const file = /<file\s+path="[^"]*"\s*>\r?\n?([\s\S]*?)<\/file>/.exec(reply)?.[1];
  if (!dup && !file) throw new Error('Reply had neither a duplicate verdict nor a rewritten file');
  const of = (dup?.[1] ?? dup?.[3] ?? '').trim();
  return { duplicateOf: of && of !== 'none' ? of : undefined, reason: dup?.[2]?.trim(), rewritten: file?.trim() };
}

/**
 * Asks the AI to confirm duplicates and, for skills not already in Preflight's format, to rewrite them.
 * Any AI failure leaves the deterministic review untouched.
 */
export async function aiReview(review: DraftReview, skills: Skill[], provider: ModelProvider, example: string, signal?: AbortSignal): Promise<DraftReview> {
  if (!provider.complete || review.status === 'invalid') return review;
  const candidates = review.duplicates.length
    ? review.duplicates.map((d) => skills.find((s) => s.id === d.id)).filter((s): s is Skill => !!s)
    : skills.slice(0, 0);
  // Without close matches, and already in Preflight's format, there's nothing for the AI to add.
  if (candidates.length === 0 && review.draft.kind === 'preflight') return review;

  let ai: AiReview;
  try {
    ai = await provider.complete(aiReviewPrompt(review.draft, candidates, example), parseAiReview, signal);
  } catch {
    return review;
  }

  const duplicates = review.duplicates.map((d) => ({ ...d, confirmed: d.id === ai.duplicateOf }));
  if (ai.duplicateOf && !duplicates.some((d) => d.id === ai.duplicateOf)) {
    const s = skills.find((x) => x.id === ai.duplicateOf);
    if (s) duplicates.unshift({ id: s.id, name: s.name, score: LIKELY_DUPLICATE, reason: ai.reason ?? 'the AI judged it a duplicate', confirmed: true });
  }
  for (const d of duplicates) if (d.confirmed && ai.reason) d.reason = ai.reason;

  let improved: SkillDraft | undefined;
  if (review.draft.kind === 'generic' && ai.rewritten) {
    const candidate: SkillDraft = {
      ...review.draft,
      kind: 'preflight',
      // Filed under the category the user picks, not whatever the AI wrote.
      category: undefined,
      categoryName: undefined,
      markdown: ai.rewritten,
      // The original stays with the check, so nothing from it is lost.
      resources: [...review.draft.resources, { path: 'original-SKILL.md', content: review.draft.markdown }],
      warnings: [],
    };
    if (!lintDraft(candidate).some((i) => i.level === 'error')) improved = candidate;
  }

  // Close matches the AI rejected stay listed as "similar", but no longer block the import.
  const effective = duplicates.map((d) => (d.confirmed === false && d.score < 1 ? { ...d, score: Math.min(d.score, LIKELY_DUPLICATE - 0.01) } : d));
  return { ...review, duplicates: effective, improved, status: statusOf(review.issues, effective) };
}
