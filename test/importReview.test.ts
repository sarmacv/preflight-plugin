import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { strToU8 } from 'fflate';
import { findSkills, type ImportFile } from '../src/skills/importer';
import { aiReview, findDuplicates, lintDraft, parseAiReview, reviewDraft, similarity, terms } from '../src/skills/importReview';
import { loadSkills } from '../src/skills/loader';
import type { ModelProvider } from '../src/ai/provider';
import type { Skill } from '../src/skills/types';

const f = (path: string, text: string): ImportFile => ({ path, bytes: strToU8(text) });
const draft = (path: string, text: string) => findSkills([f(path, text)])[0];

const SECTIONS = '\n## What this checks\nA security policy exists so people can report problems.\n\n## How to evaluate\nLook for the file.\n\n## Pass criteria\nThe file exists.\n\n## Fail criteria\nThe file is missing.\n\n## How to fix\nAdd the file.\n';
const preflight = (fm: string, body = SECTIONS) => `---\n${fm}\n---\n${body}`;
const SECURITY = preflight('id: security-md-present\nname: SECURITY.md present\ncategory: repo-hygiene\nseverity: medium\nevaluation: deterministic\nfixable: false\nrules:\n  - any_file_exists: [SECURITY.md, .github/SECURITY.md]');

let catalog: Skill[] = [];
beforeAll(async () => {
  catalog = (await loadSkills(join(__dirname, '..', 'skills'))).skills;
});

describe('lintDraft', () => {
  it('passes a well-formed Preflight skill', () => {
    expect(lintDraft(draft('s.md', SECURITY))).toEqual([]);
  });

  it('reports format errors in a Preflight skill', () => {
    const missingSection = lintDraft(draft('s.md', SECURITY.replace(/## Fail criteria\nThe file is missing.\n\n/, '')));
    expect(missingSection).toEqual([{ level: 'error', message: 'missing body sections: Fail criteria' }]);
    const unknownRule = lintDraft(draft('s.md', SECURITY.replace('any_file_exists: [SECURITY.md, .github/SECURITY.md]', 'builtin: { name: nope }')));
    expect(unknownRule[0]).toEqual({ level: 'error', message: "Uses rules this version of Preflight doesn't have: builtin nope" });
  });

  it('treats a half-written Preflight skill as a general skill, and says so', () => {
    const issues = lintDraft(draft('s.md', SECURITY.replace('severity: medium', 'severity: urgent')));
    expect(issues.map((i) => i.message).join('\n')).toMatch(/Looks like an incomplete Preflight skill/);
  });

  it('flags style problems in a general skill', () => {
    const issues = lintDraft(draft('x/SKILL.md', '---\nname: Thin\n---\nSee `references/missing.md`.')).map((i) => i.message);
    expect(issues).toEqual([
      'No description: add a one-line "description" so people know what the check is for',
      'Instructions are very short (2 words), so the AI has little to judge against',
      'No clear rules or pass/fail conditions; the result may be inconsistent',
      "Mentions references/missing.md, but that file isn't in the import",
    ]);
  });

  it('accepts a well-written general skill', () => {
    const text = '---\nname: Logging standards\ndescription: Services log structured JSON to stdout.\n---\n# Logging\n- Logs must be JSON with timestamp, level and message fields.\n- Services must write logs to stdout, never to local files.\n- Secrets and tokens must never appear in logs, and personal data should be masked before logging.\n';
    expect(lintDraft(draft('log/SKILL.md', text))).toEqual([]);
  });
});

describe('findDuplicates', () => {
  it('matches the same name or ID exactly', () => {
    const d = draft('c/SKILL.md', '---\nname: CODEOWNERS present\ndescription: Something else entirely.\n---\nbody');
    expect(findDuplicates(d, catalog)[0]).toMatchObject({ id: 'codeowners-present', score: 1, reason: expect.stringMatching(/^same (ID|name)$/) });
  });

  it('matches a check on the same files', () => {
    const d = draft('o.md', preflight('id: owners-file\nname: Owners file exists\ncategory: x\nseverity: low\nevaluation: deterministic\nfixable: false\nrules:\n  - file_exists: .github/CODEOWNERS'));
    expect(findDuplicates(d, catalog)[0]).toMatchObject({ id: 'codeowners-present', reason: 'checks the same files' });
  });

  it('matches a differently worded skill with the same purpose', () => {
    const d = draft('b/SKILL.md', '---\nname: Default branch protection\ndescription: The default branch must be protected by branch protection or a ruleset.\n---\nbody');
    const top = findDuplicates(d, catalog)[0];
    expect(top.id).toBe('default-branch-protected');
    expect(top.score).toBeGreaterThanOrEqual(0.6);
  });

  it('does not match an unrelated skill', () => {
    const d = draft('l/SKILL.md', '---\nname: Logging standards\ndescription: Services log structured JSON to stdout.\n---\nbody');
    expect(findDuplicates(d, catalog).filter((m) => m.score >= 0.6)).toEqual([]);
  });

  it('compares word stems without stop words', () => {
    expect([...terms('The checks for protected branches')]).toEqual(['protect', 'branch']);
    expect(similarity(terms('branch protection'), terms('protected branches'))).toBeGreaterThan(0.4);
  });
});

describe('reviewDraft status', () => {
  it('is invalid, duplicate, style or ready', () => {
    expect(reviewDraft(draft('s.md', SECURITY.replace(/## How to fix\nAdd the file.\n/, '')), catalog).status).toBe('invalid');
    expect(reviewDraft(draft('c/SKILL.md', '---\nname: CODEOWNERS present\n---\nx'), catalog).status).toBe('duplicate');
    expect(reviewDraft(draft('t/SKILL.md', '---\nname: Thin rule\n---\nshort'), catalog).status).toBe('style');
    expect(reviewDraft(draft('s.md', SECURITY), catalog).status).toBe('ready');
  });
});

describe('aiReview', () => {
  const fake = (reply: string | Error): ModelProvider => ({
    id: 'fake',
    label: 'Fake',
    evaluate: async () => ({ status: 'pass', evidence: [] }),
    generateFix: async () => ({ changes: [] }),
    complete: async (_prompt, parse) => {
      if (reply instanceof Error) throw reply;
      return parse(reply);
    },
  });
  const rewritten = preflight('id: logging\nname: Logging standards\ncategory: imported\nseverity: medium\nevaluation: ai\nfixable: false\ncontext_files: [README.md]');
  const generic = () => reviewDraft(draft('b/SKILL.md', '---\nname: Default branch protection\ndescription: The default branch must be protected by branch protection or a ruleset.\n---\n- The main branch must require reviews.'), catalog);

  it('confirms a duplicate and keeps it blocking', async () => {
    const r = await aiReview(generic(), catalog, fake('<duplicate of="default-branch-protected">Both check that main is protected.</duplicate>'), 'example');
    expect(r.status).toBe('duplicate');
    expect(r.duplicates[0]).toMatchObject({ id: 'default-branch-protected', confirmed: true, reason: 'Both check that main is protected.' });
  });

  it('downgrades a close match the AI rejects, and offers its rewrite', async () => {
    const r = await aiReview(generic(), catalog, fake(`<duplicate of="none">This checks review rules, not protection.</duplicate>\n<file path="SKILL.md">\n${rewritten}\n</file>`), 'example');
    expect(r.status).not.toBe('duplicate');
    expect(r.improved?.kind).toBe('preflight');
    expect(r.improved?.category).toBeUndefined();
    expect(r.improved?.resources.map((x) => x.path)).toEqual(['original-SKILL.md']);
  });

  it('ignores a rewrite that is not a valid Preflight skill', async () => {
    const r = await aiReview(generic(), catalog, fake('<duplicate of="none"/>\n<file path="SKILL.md">\nnot a skill\n</file>'), 'example');
    expect(r.improved).toBeUndefined();
  });

  it('leaves the review unchanged when the AI fails', async () => {
    const before = generic();
    const after = await aiReview(before, catalog, fake(new Error('down')), 'example');
    expect(after).toBe(before);
  });

  it('parses the reply format', () => {
    expect(parseAiReview('<duplicate of="none"/>')).toEqual({ duplicateOf: undefined, reason: undefined, rewritten: undefined });
    expect(() => parseAiReview('hello')).toThrow();
  });
});
