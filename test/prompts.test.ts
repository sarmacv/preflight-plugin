import { describe, expect, it } from 'vitest';
import { evaluationPrompt, extractJson, fixPrompt, parseEvaluation, parseFix } from '../src/ai/prompts';
import { isSafeRepoPath } from '../src/ai/provider';
import { parseSkill } from '../src/skills/parser';
import { fakeRepo } from './helpers/fakeRepo';

const skill = parseSkill('---\nid: s\nname: S\ncategory: c\nseverity: low\nevaluation: ai\nfixable: false\n---\n## What this checks\nWHAT\n## How to evaluate\nHOW\n## Pass criteria\nP\n## Fail criteria\nF\n## How to fix\nFIX\n', 's.md');

describe('prompts', () => {
  it('embeds the whole skill file, the tree and the files', () => {
    const ctx = { repo: fakeRepo({ 'README.md': 'hello' }), files: [{ path: 'README.md', content: 'hello' }] };
    const p = evaluationPrompt(skill, ctx, 10_000);
    expect(p).toContain(skill.source);
    expect(p).toContain('<file path="README.md">\nhello\n</file>');
    expect(p).toContain('Repository: acme/api, branch main');
  });

  it('omits files beyond the budget', () => {
    const ctx = { repo: fakeRepo({}), files: [{ path: 'big.txt', content: 'x'.repeat(500) }] };
    expect(fixPrompt(skill, ctx, 100)).toContain('<file path="big.txt" omitted="too large for the context window" />');
  });
});

describe('response parsing', () => {
  it('tolerates code fences and prose', () => {
    expect(extractJson('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Result: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json')).toThrow();
  });

  it('parses evaluations and drops unsafe paths', () => {
    const e = parseEvaluation('{"status":"fail","evidence":[{"message":"No tests","path":"../etc/passwd"},{"message":" ok ","path":"src/a.ts"},{"message":""}]}');
    expect(e).toEqual({ status: 'fail', evidence: [{ message: 'No tests' }, { message: 'ok', path: 'src/a.ts' }] });
    expect(() => parseEvaluation('{"status":"maybe"}')).toThrow(/pass\/fail/);
  });

  it('parses fixes and rejects path escapes', () => {
    expect(parseFix('{"files":[{"path":"./AGENTS.md","content":"x"}],"notes":"check"}')).toEqual({ changes: [{ path: 'AGENTS.md', content: 'x' }], notes: 'check' });
    expect(() => parseFix('{"files":[{"path":"../x","content":"y"}]}')).toThrow(/unsafe path/);
    expect(() => parseFix('{"files":[]}')).toThrow(/no file changes/);
  });

  it('validates repo paths', () => {
    expect(isSafeRepoPath('.github/CODEOWNERS')).toBe(true);
    for (const bad of ['/abs', 'a/../b', '.git/config', 'a//b', 'a\\b', '']) expect(isSafeRepoPath(bad)).toBe(false);
  });
});
