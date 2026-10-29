// Prompt construction and response parsing shared by every model provider. Kept free of vscode
// imports so it can be unit tested.
import type { Evidence, Skill } from '../skills/types';
import { isSafeRepoPath, type EvaluationContext, type Evaluation, type FixProposal } from './provider';

const MAX_TREE_PATHS = 400;

function filesBlock(ctx: EvaluationContext, budget: number): string {
  let used = 0;
  const parts: string[] = [];
  for (const f of ctx.files) {
    const block = `<file path="${f.path}">\n${f.content}\n</file>`;
    if (used + block.length > budget) {
      parts.push(`<file path="${f.path}" omitted="too large for the context window" />`);
      continue;
    }
    used += block.length;
    parts.push(block);
  }
  return parts.join('\n\n') || '(no files provided)';
}

function header(skill: Skill, ctx: EvaluationContext): string {
  const r = ctx.repo;
  const paths = r.files.map((f) => f.path);
  const tree = paths.slice(0, MAX_TREE_PATHS).join('\n') + (paths.length > MAX_TREE_PATHS ? `\n… ${paths.length - MAX_TREE_PATHS} more` : '');
  return [
    `Repository: ${r.fullName}, branch ${r.info.ref} (default branch ${r.info.defaultBranch}).`,
    '',
    'The check definition (a Preflight skill file) is:',
    '<skill>',
    skill.source,
    '</skill>',
    '',
    'Repository file list:',
    '<tree>',
    tree,
    '</tree>',
  ].join('\n');
}

const evidenceText = (e: Evidence[] | undefined) => (e?.length ? e.map((x) => `- ${x.message}`).join('\n') : '');

export function evaluationPrompt(skill: Skill, ctx: EvaluationContext, charBudget: number): string {
  return [
    'You are Preflight, a strict reviewer that checks GitHub repositories against engineering standards.',
    'Evaluate the repository against the check below, using its "How to evaluate", "Pass criteria" and "Fail criteria" sections exactly.',
    'Judge only from the files and file list provided. If something is not shown, treat it as absent.',
    '',
    header(skill, ctx),
    ctx.ruleEvidence?.length ? `\nAutomated rule results already gathered:\n${evidenceText(ctx.ruleEvidence)}` : '',
    '',
    'Files:',
    filesBlock(ctx, charBudget),
    '',
    'Answer with JSON only, no prose and no code fence, in exactly this shape:',
    '{"status": "pass" | "fail", "evidence": [{"message": "one short sentence", "path": "optional/repo/path"}]}',
    'Give 1 to 6 evidence items. For a failure, each item names one unmet criterion and the file it concerns.',
  ].join('\n');
}

export function fixPrompt(skill: Skill, ctx: EvaluationContext, charBudget: number): string {
  return [
    'You are Preflight, generating a minimal, reviewable fix for a failed repository check.',
    'Follow the "How to fix" section of the check exactly. Use only facts visible in the provided files; never invent commands, tools, people or URLs.',
    'Return complete file contents for every file you create or change. Change as few files as possible, and never modify production code unless the check says so.',
    '',
    header(skill, ctx),
    ctx.ruleEvidence?.length ? `\nWhy the check failed:\n${evidenceText(ctx.ruleEvidence)}` : '',
    ctx.instructions ? `\nAdditional instructions:\n${ctx.instructions}` : '',
    '',
    'Current contents of relevant files:',
    filesBlock(ctx, charBudget),
    '',
    'Answer with JSON only, no prose and no code fence, in exactly this shape:',
    '{"files": [{"path": "repo/relative/path", "content": "full new file content"}], "notes": "what the reviewer should verify, as short bullet points"}',
  ].join('\n');
}

/** Pulls the first JSON object out of a model reply, tolerating code fences and stray prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Model reply contained no JSON');
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseEvaluation(text: string): Evaluation {
  const raw = extractJson(text) as { status?: string; evidence?: { message?: string; path?: string }[] };
  if (raw.status !== 'pass' && raw.status !== 'fail') throw new Error('Model reply had no pass/fail status');
  const evidence = (raw.evidence ?? [])
    .filter((e) => typeof e?.message === 'string' && e.message.trim())
    .slice(0, 8)
    .map((e) => ({ message: e.message!.trim(), ...(e.path && isSafeRepoPath(e.path) ? { path: e.path } : {}) }));
  return { status: raw.status, evidence: evidence.length ? evidence : [{ message: raw.status === 'pass' ? 'AI review found no issues' : 'AI review failed this check' }] };
}

export function parseFix(text: string): FixProposal {
  const raw = extractJson(text) as { files?: { path?: string; content?: string }[]; notes?: string };
  const changes = (raw.files ?? [])
    .filter((f) => typeof f?.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ path: f.path!.replace(/^\.\//, ''), content: f.content! }));
  const unsafe = changes.find((c) => !isSafeRepoPath(c.path));
  if (unsafe) throw new Error(`Model proposed an unsafe path: ${unsafe.path}`);
  if (changes.length === 0) throw new Error('Model proposed no file changes');
  return { changes, notes: typeof raw.notes === 'string' ? raw.notes.trim() : undefined };
}
