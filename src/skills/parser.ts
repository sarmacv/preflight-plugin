import { parse as parseYaml } from 'yaml';
import { FrontmatterSchema, SECTION_TITLES, type SectionTitle, type Skill } from './types';

export class SkillParseError extends Error {
  constructor(readonly file: string, message: string) {
    super(`${file}: ${message}`);
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w === 'ai' || w === 'ci' || w === 'sbom' ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function parseSkill(source: string, file: string): Skill {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new SkillParseError(file, 'missing YAML frontmatter');

  let raw: unknown;
  try {
    raw = parseYaml(match[1]);
  } catch (err) {
    throw new SkillParseError(file, `invalid YAML: ${(err as Error).message}`);
  }

  const parsed = FrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new SkillParseError(file, issues);
  }

  const sections = parseSections(match[2]);
  const missing = SECTION_TITLES.filter((t) => !sections[t]);
  if (missing.length) throw new SkillParseError(file, `missing body sections: ${missing.join(', ')}`);

  return {
    ...parsed.data,
    categoryName: parsed.data.category_name ?? titleCase(parsed.data.category),
    source,
    sections,
    file,
  };
}

/**
 * Splits the body on `##` headings (case-insensitive match against the required titles). Lines inside
 * fenced code blocks are never headings, so examples containing "## …" stay in their section.
 */
export function parseSections(body: string): Partial<Record<SectionTitle, string>> {
  const out: Partial<Record<SectionTitle, string>> = {};
  let current: { heading: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const heading = current.heading.trim().replace(/[*:]/g, '');
    const title = SECTION_TITLES.find((t) => t.toLowerCase() === heading.toLowerCase());
    if (title) out[title] = current.lines.join('\n').trim();
  };
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = !fenced && /^##\s+(.*)$/.exec(line);
    if (m) {
      flush();
      current = { heading: m[1], lines: [] };
    } else current?.lines.push(line);
  }
  flush();
  return out;
}
