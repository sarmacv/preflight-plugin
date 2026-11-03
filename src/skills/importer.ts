// Turns an imported .md file or .zip into Preflight skills. Two kinds are accepted:
// - Preflight skills (Preflight frontmatter), validated and kept as they are;
// - general agent skills (a SKILL.md with name/description and free-form instructions, plus optional
//   reference files), which become AI-reviewed checks whose rubric is the original instructions.
// No vscode imports, so the whole pipeline is unit-testable. Nothing here executes imported content.
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseSkill, parseSections, titleCase } from './parser';
import { RULES } from './rules';
import { BUILTINS } from './rules/builtins';
import { FrontmatterSchema, SECTION_TITLES, type Rule, type Severity, type SkillResource } from './types';

export interface ImportFile {
  /** Path inside the zip, or the file name for a single .md. */
  path: string;
  bytes: Uint8Array;
}

export interface SkillDraft {
  kind: 'preflight' | 'generic';
  /** Where the skill file sits in the import, for messages. */
  sourcePath: string;
  id: string;
  name: string;
  description?: string;
  /** Category declared by a Preflight skill. */
  category?: string;
  categoryName?: string;
  severity?: Severity;
  markdown: string;
  resources: SkillResource[];
  warnings: string[];
}

export interface ImportChoices {
  id: string;
  category: string;
  categoryName: string;
  /** Used for general skills; Preflight skills keep their own. */
  severity: Severity;
}

/** Text that can usefully go to a model. Anything else in a zip is skipped. */
const TEXT_EXT = /\.(md|mdx|txt|rst|adoc|json|jsonc|ya?ml|toml|ini|cfg|csv|tsv|xml|html?|css|sh|bash|ps1|py|js|mjs|cjs|ts|tsx|jsx|java|kt|go|rb|php|cs|rs|swift|sql|graphql|proto|tf|hcl|env\.example|properties|gradle|dockerfile)$|(^|\/)(Dockerfile|Makefile|LICENSE|README)$/i;
const MAX_RESOURCE = 200_000;
const MAX_RESOURCES_TOTAL = 1_000_000;
const SKILL_FILE = /(^|\/)skill\.md$/i;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Default files an imported general skill looks at; editable in the generated skill file. */
export const GENERIC_CONTEXT_FILES = [
  'README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'package.json', 'pyproject.toml', 'pom.xml', 'build.gradle', 'go.mod', 'Cargo.toml', '*.csproj',
  '.github/workflows/*.yml', '.github/workflows/*.yaml', 'Dockerfile',
];

export const slug = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'imported-skill';

/** Rejects absolute paths, parent references and zip metadata. */
export function safeImportPath(path: string): string | undefined {
  const p = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p)) return undefined;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.git')) return undefined;
  if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store') return undefined;
  return p;
}

function decode(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

function frontmatterOf(markdown: string): { data: Record<string, unknown>; body: string } {
  const m = FRONTMATTER.exec(markdown);
  if (!m) return { data: {}, body: markdown };
  try {
    const data = parseYaml(m[1]);
    return { data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {}, body: m[2] };
  } catch {
    return { data: {}, body: m[2] };
  }
}

/** True when the frontmatter is a complete Preflight skill (apart from where it will be filed). */
function isPreflight(data: Record<string, unknown>): boolean {
  return FrontmatterSchema.safeParse({ category: 'imported', ...data }).success && 'evaluation' in data && 'severity' in data;
}

/** Rule and builtin names that this version of Preflight doesn't know, so the check would always error. */
export function unknownRules(rules: Rule[] | undefined): string[] {
  const out: string[] = [];
  const walk = (rule: unknown) => {
    if (!rule || typeof rule !== 'object') return;
    for (const [name, params] of Object.entries(rule as Record<string, unknown>)) {
      if (!(name in RULES)) out.push(name);
      else if (name === 'builtin') {
        const b = (params as { name?: string } | undefined)?.name;
        if (b && !(b in BUILTINS)) out.push(`builtin ${b}`);
      } else if (name === 'all_of' || name === 'any_of') (params as unknown[] | undefined)?.forEach(walk);
      else if (name === 'not') walk(params);
    }
  };
  rules?.forEach(walk);
  return [...new Set(out)];
}

/** Finds every skill in an import: SKILL.md folders first, otherwise the Markdown files themselves. */
export function findSkills(files: ImportFile[]): SkillDraft[] {
  const warnings: string[] = [];
  const usable: { path: string; bytes: Uint8Array }[] = [];
  for (const f of files) {
    const path = safeImportPath(f.path);
    if (!path) {
      if (!/(^|\/)(__MACOSX|\.DS_Store)/.test(f.path)) warnings.push(`Skipped unsafe path ${f.path}`);
      continue;
    }
    if (path.endsWith('/')) continue;
    usable.push({ path, bytes: f.bytes });
  }

  // A folder with SKILL.md is one skill; other Markdown files only count when there are none.
  let skillFiles = usable.filter((f) => SKILL_FILE.test(f.path));
  if (skillFiles.length === 0) skillFiles = usable.filter((f) => /\.md$/i.test(f.path) && FRONTMATTER.test(decode(f.bytes) ?? ''));
  if (skillFiles.length === 0) skillFiles = usable.filter((f) => /\.md$/i.test(f.path)).slice(0, 1);
  const skillDirs = skillFiles.filter((f) => SKILL_FILE.test(f.path)).map((f) => dirOf(f.path));

  return skillFiles.map((file) => {
    const own: string[] = [...warnings];
    const markdown = decode(file.bytes);
    if (markdown === undefined) throw new Error(`${file.path} is not a UTF-8 text file`);
    const { data, body } = frontmatterOf(markdown);
    const dir = SKILL_FILE.test(file.path) ? dirOf(file.path) : null;

    // Supporting files: everything else in this skill's folder that isn't another skill's folder.
    const resources: SkillResource[] = [];
    let total = 0;
    if (dir !== null) {
      for (const f of usable) {
        if (f === file || !f.path.startsWith(dir)) continue;
        if (skillDirs.some((d) => d !== dir && d.startsWith(dir) && f.path.startsWith(d))) continue;
        const rel = f.path.slice(dir.length);
        const text = TEXT_EXT.test(rel) ? decode(f.bytes) : undefined;
        if (text === undefined) {
          own.push(`Skipped ${rel}: not a text file`);
        } else if (text.length > MAX_RESOURCE || total + text.length > MAX_RESOURCES_TOTAL) {
          own.push(`Skipped ${rel}: too large`);
        } else {
          resources.push({ path: rel, content: text });
          total += text.length;
        }
      }
    }

    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    const fileStem = file.path.split('/').filter(Boolean).slice(dir !== null ? -2 : -1)[0].replace(/\.md$/i, '');
    if (isPreflight(data)) {
      return {
        kind: 'preflight',
        sourcePath: file.path,
        id: String(data.id),
        name: String(data.name),
        category: typeof data.category === 'string' ? data.category : undefined,
        categoryName: typeof data.category_name === 'string' ? data.category_name : undefined,
        severity: data.severity as Severity,
        markdown,
        resources,
        warnings: own,
      };
    }
    const name = String(data.name ?? heading ?? titleCase(slug(fileStem)));
    const description = typeof data.description === 'string' ? data.description.trim() : firstParagraph(body);
    return { kind: 'generic', sourcePath: file.path, id: slug(name), name, description, markdown, resources, warnings: own };
  });
}

function firstParagraph(body: string): string | undefined {
  const para = body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#') && !p.startsWith('```'));
  return para?.replace(/\s+/g, ' ').slice(0, 300);
}

/** Pushes every heading down two levels so imported "## …" sections can't break Preflight's own sections. */
export function demoteHeadings(markdown: string): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/^(#{1,6})(\s)/, (_m, hashes: string, space: string) => `${'#'.repeat(Math.min(6, hashes.length + 2))}${space}`);
    })
    .join('\n');
}

/** Produces the Preflight skill file to store, and validates it the same way the loader will. */
export function toSkillFile(draft: SkillDraft, choices: ImportChoices): string {
  let file: string;
  if (draft.kind === 'preflight') {
    const { data, body } = frontmatterOf(draft.markdown);
    const fm: Record<string, unknown> = { ...data, id: choices.id, category: choices.category, category_name: choices.categoryName };
    file = `---\n${stringifyYaml(fm).trimEnd()}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
    const unknown = unknownRules(fm.rules as Rule[] | undefined);
    if (unknown.length) throw new Error(`${draft.name} uses rules this version of Preflight doesn't have: ${unknown.join(', ')}`);
  } else {
    const { body } = frontmatterOf(draft.markdown);
    const fm = {
      id: choices.id,
      name: draft.name,
      category: choices.category,
      category_name: choices.categoryName,
      severity: choices.severity,
      evaluation: 'ai',
      fixable: false,
      context_files: GENERIC_CONTEXT_FILES,
    };
    const refs = draft.resources.length
      ? `\n\nThe skill's supporting files (${draft.resources.map((r) => `\`${r.path}\``).join(', ')}) are provided alongside it.`
      : '';
    const sections = [
      `## What this checks\n${draft.description ?? `Whether the repository follows the "${draft.name}" skill.`}\n\nImported from \`${draft.sourcePath}\`.`,
      `## How to evaluate\nApply the imported skill below to this repository, using the files and file list provided.${refs}\n\n${demoteHeadings(body.trim())}`,
      `## Pass criteria\nThe repository meets every requirement the imported skill sets out.`,
      `## Fail criteria\nAny requirement in the imported skill is not met. List each unmet requirement with the file it concerns.`,
      `## How to fix\nFollow the imported skill's guidance for each unmet requirement. Preflight doesn't fix this check automatically.`,
    ];
    file = `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${sections.join('\n\n')}\n`;
  }

  const skill = parseSkill(file, `${choices.category}/${choices.id}/SKILL.md`);
  const missing = SECTION_TITLES.filter((t) => !parseSections(file.slice(file.indexOf('\n---', 3) + 4))[t]);
  if (missing.length) throw new Error(`${skill.name} is missing sections: ${missing.join(', ')}`);
  return file;
}
