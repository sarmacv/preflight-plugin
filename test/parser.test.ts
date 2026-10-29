import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { parseSections, parseSkill, titleCase } from '../src/skills/parser';
import { loadSkills } from '../src/skills/loader';

const BODY = `
## What this checks
Something.

## How to evaluate
Look.

## Pass criteria
Found.

## Fail criteria
Not found.

## How to fix
Add it.
`;

const skill = (fm: string, body = BODY) => `---\n${fm}\n---\n${body}`;
const BASE = `id: readme
name: README present
category: repo-hygiene
severity: medium
evaluation: deterministic
fixable: false
rules:
  - file_exists: README.md`;

describe('parseSkill', () => {
  it('parses frontmatter, defaults and sections', () => {
    const s = parseSkill(skill(BASE), 'repo-hygiene/readme.md');
    expect(s.id).toBe('readme');
    expect(s.categoryName).toBe('Repo Hygiene');
    expect(s.fix_pr).toBe('fixes');
    expect(s.context_files).toEqual([]);
    expect(s.sections['How to fix']).toBe('Add it.');
    expect(s.source).toContain('## What this checks');
  });

  it('rejects files without frontmatter', () => {
    expect(() => parseSkill(BODY, 'x.md')).toThrow(/missing YAML frontmatter/);
  });

  it('rejects an unknown severity', () => {
    expect(() => parseSkill(skill(BASE.replace('medium', 'urgent')), 'x.md')).toThrow(/severity/);
  });

  it('rejects unknown frontmatter keys', () => {
    expect(() => parseSkill(skill(`${BASE}\nowner: me`), 'x.md')).toThrow(/owner|Unrecognized/i);
  });

  it('requires rules for deterministic and hybrid checks', () => {
    const noRules = BASE.replace(/rules:[\s\S]*$/, '');
    expect(() => parseSkill(skill(noRules), 'x.md')).toThrow(/rules/);
    expect(() => parseSkill(skill(noRules.replace('deterministic', 'ai')), 'x.md')).not.toThrow();
  });

  it('requires a fix block for fixable checks', () => {
    expect(() => parseSkill(skill(BASE.replace('fixable: false', 'fixable: true')), 'x.md')).toThrow(/fix/);
  });

  it('requires all five body sections', () => {
    expect(() => parseSkill(skill(BASE, BODY.replace('## How to fix\nAdd it.', '')), 'x.md')).toThrow(/How to fix/);
  });

  it('matches section headings case-insensitively', () => {
    expect(parseSections('## what THIS checks\nhi\n## Other\nx')).toEqual({ 'What this checks': 'hi' });
  });

  it('title-cases category slugs', () => {
    expect(titleCase('ai-readiness')).toBe('AI Readiness');
    expect(titleCase('dependencies-sbom')).toBe('Dependencies SBOM');
  });
});

describe('bundled skills', () => {
  it('all load without errors', async () => {
    const { skills, errors } = await loadSkills(join(__dirname, '..', 'skills'));
    expect(errors).toEqual([]);
    expect(skills.length).toBeGreaterThanOrEqual(21);
    expect(new Set(skills.map((s) => s.category))).toEqual(
      new Set(['ai-readiness', 'code-quality', 'repo-hygiene', 'branching-protection', 'dependencies-sbom', 'tech-standards', 'delivery']),
    );
  });
});
