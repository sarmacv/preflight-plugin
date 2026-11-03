import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { demoteHeadings, findSkills, safeImportPath, toSkillFile, unknownRules, type ImportFile } from '../src/skills/importer';
import { parseSkill } from '../src/skills/parser';
import { loadSkillRoots } from '../src/skills/loader';
import { evaluationPrompt } from '../src/ai/prompts';
import { fakeRepo } from './helpers/fakeRepo';

const f = (path: string, text: string): ImportFile => ({ path, bytes: strToU8(text) });
const unzip = async (entries: Record<string, string>) => {
  const { unzipSync } = await import('fflate');
  const zip = zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));
  return Object.entries(unzipSync(zip)).map(([path, bytes]) => ({ path, bytes }));
};

const PREFLIGHT = `---
id: security-md-present
name: SECURITY.md present
category: repo-hygiene
severity: medium
evaluation: deterministic
fixable: false
rules:
  - any_file_exists: [SECURITY.md, .github/SECURITY.md]
---

## What this checks
A security policy.

## How to evaluate
Look for it.

## Pass criteria
Found.

## Fail criteria
Missing.

## How to fix
Add one.
`;

const GENERIC = `---
name: API design review
description: Checks REST endpoints follow our API guidelines.
---

# API design review

## Rules
- Use plural nouns. See references/guidelines.md.

\`\`\`md
## Not a heading inside code
\`\`\`
`;

describe('findSkills', () => {
  it('reads a single Preflight skill file as-is', () => {
    const [d] = findSkills([f('security.md', PREFLIGHT)]);
    expect(d).toMatchObject({ kind: 'preflight', id: 'security-md-present', category: 'repo-hygiene', severity: 'medium', resources: [] });
  });

  it('turns a general agent skill folder into a draft with its supporting files', async () => {
    const files = await unzip({ 'api-review/SKILL.md': GENERIC, 'api-review/references/guidelines.md': '# Guidelines', 'api-review/logo.png': '\u0000\u0001binary' });
    const [d] = findSkills(files);
    expect(d).toMatchObject({ kind: 'generic', id: 'api-design-review', name: 'API design review', description: 'Checks REST endpoints follow our API guidelines.' });
    expect(d.resources.map((r) => r.path)).toEqual(['references/guidelines.md']);
    expect(d.warnings.join()).toMatch(/Skipped logo\.png: not a text file/);
  });

  it('finds every skill folder in one zip, keeping each one\'s files apart', async () => {
    const files = await unzip({ 'pack/a/SKILL.md': '---\nname: A\n---\nDo A', 'pack/a/notes.md': 'a', 'pack/b/SKILL.md': '---\nname: B\n---\nDo B', 'pack/b/notes.md': 'b' });
    const drafts = findSkills(files);
    expect(drafts.map((d) => [d.name, d.resources.map((r) => r.content)])).toEqual([['A', ['a']], ['B', ['b']]]);
  });

  it('falls back to a heading and the file name when there is no frontmatter', () => {
    const [d] = findSkills([f('naming-rules.md', '# Naming rules\n\nUse kebab-case.')]);
    expect(d).toMatchObject({ kind: 'generic', name: 'Naming rules', description: 'Use kebab-case.' });
  });

  it('rejects unsafe paths', () => {
    expect(safeImportPath('../etc/passwd')).toBeUndefined();
    expect(safeImportPath('/abs/x.md')).toBeUndefined();
    expect(safeImportPath('C:/x.md')).toBeUndefined();
    expect(safeImportPath('__MACOSX/a/SKILL.md')).toBeUndefined();
    expect(safeImportPath('./a/SKILL.md')).toBe('a/SKILL.md');
    const drafts = findSkills([f('../SKILL.md', GENERIC), f('ok/SKILL.md', GENERIC)]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].warnings.join()).toMatch(/unsafe path \.\.\/SKILL\.md/);
  });
});

describe('toSkillFile', () => {
  it('re-files a Preflight skill under the chosen category and ID', () => {
    const [d] = findSkills([f('security.md', PREFLIGHT)]);
    const file = toSkillFile(d, { id: 'security-policy', category: 'compliance', categoryName: 'Compliance', severity: 'low' });
    const s = parseSkill(file, 'compliance/security-policy/SKILL.md');
    expect(s).toMatchObject({ id: 'security-policy', category: 'compliance', categoryName: 'Compliance', severity: 'medium', evaluation: 'deterministic' });
  });

  it('wraps a general skill as an AI check, keeping all of its instructions', () => {
    const [d] = findSkills([f('api/SKILL.md', GENERIC)]);
    const file = toSkillFile(d, { id: d.id, category: 'api', categoryName: 'API Standards', severity: 'high' });
    const s = parseSkill(file, 'api/x/SKILL.md');
    expect(s).toMatchObject({ evaluation: 'ai', severity: 'high', fixable: false, categoryName: 'API Standards' });
    expect(s.sections['How to evaluate']).toContain('#### Rules');
    expect(s.sections['How to evaluate']).toContain('Use plural nouns');
    expect(s.sections['How to evaluate']).toContain('## Not a heading inside code');
    expect(s.context_files.length).toBeGreaterThan(0);
  });

  it('refuses a Preflight skill that uses rules this version does not have', () => {
    const [d] = findSkills([f('x.md', PREFLIGHT.replace('any_file_exists: [SECURITY.md, .github/SECURITY.md]', 'builtin: { name: does_not_exist }'))]);
    expect(() => toSkillFile(d, { id: 'x', category: 'c', categoryName: 'C', severity: 'low' })).toThrow(/builtin does_not_exist/);
    expect(unknownRules([{ all_of: [{ file_exists: 'a' }, { bogus: 1 }] }])).toEqual(['bogus']);
  });

  it('demotes headings outside code fences only', () => {
    expect(demoteHeadings('# A\n## B\n```\n# code\n```\n###### F')).toBe('### A\n#### B\n```\n# code\n```\n###### F');
  });
});

describe('loading imported skills', () => {
  it('loads folder skills with their resources, marks them imported, and puts them in prompts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pf-skills-'));
    const bundled = join(root, 'bundled');
    const imported = join(root, 'imported');
    await mkdir(join(bundled, 'repo-hygiene'), { recursive: true });
    await writeFile(join(bundled, 'repo-hygiene', 'security.md'), PREFLIGHT);
    const [d] = findSkills([f('api/SKILL.md', GENERIC)]);
    await mkdir(join(imported, 'api', d.id, 'references'), { recursive: true });
    await writeFile(join(imported, 'api', d.id, 'SKILL.md'), toSkillFile(d, { id: d.id, category: 'api', categoryName: 'API', severity: 'high' }));
    await writeFile(join(imported, 'api', d.id, 'references', 'guidelines.md'), '# Guidelines\nPlural nouns.');

    const { skills, errors } = await loadSkillRoots([{ dir: bundled, origin: 'bundled' }, { dir: imported, origin: 'imported' }, { dir: join(root, 'missing'), origin: 'imported' }]);
    expect(errors).toEqual([]);
    const api = skills.find((s) => s.id === d.id)!;
    expect(api.origin).toBe('imported');
    expect(api.file).toBe(`imported/api/${d.id}/SKILL.md`);
    expect(api.resources).toEqual([{ path: 'references/guidelines.md', content: '# Guidelines\nPlural nouns.' }]);
    expect(skills.find((s) => s.id === 'security-md-present')?.origin).toBe('bundled');

    const prompt = evaluationPrompt(api, { repo: fakeRepo({}), files: [] }, 10_000);
    expect(prompt).toContain('<skill-resource path="references/guidelines.md">\n# Guidelines\nPlural nouns.\n</skill-resource>');
  });

  it('reports an imported skill that duplicates a bundled ID instead of loading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pf-skills-'));
    await mkdir(join(root, 'b', 'repo-hygiene'), { recursive: true });
    await writeFile(join(root, 'b', 'repo-hygiene', 'security.md'), PREFLIGHT);
    await mkdir(join(root, 'i', 'repo-hygiene', 'security-md-present'), { recursive: true });
    await writeFile(join(root, 'i', 'repo-hygiene', 'security-md-present', 'SKILL.md'), PREFLIGHT);
    const { skills, errors } = await loadSkillRoots([{ dir: join(root, 'b'), origin: 'bundled' }, { dir: join(root, 'i'), origin: 'imported' }]);
    expect(skills.filter((s) => s.id === 'security-md-present')).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicate id "security-md-present"/);
  });
});
