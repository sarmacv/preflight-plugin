import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseSkill } from './parser';
import type { Skill, SkillResource } from './types';
import { dependencyOrder } from '../engine/queue';

export interface LoadResult {
  skills: Skill[];
  errors: string[];
}

export interface SkillRoot {
  dir: string;
  origin: 'bundled' | 'imported';
}

/** Supporting files read per folder skill; matches the importer's limits. */
const MAX_RESOURCE = 200_000;
const MAX_RESOURCES_TOTAL = 1_000_000;
const SKILL_FILE = /^skill\.md$/i;

interface Found {
  path: string;
  /** Set for folder skills: the folder holding SKILL.md and its supporting files. */
  dir?: string;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Single-file skills (*.md), and folder skills (a folder with SKILL.md, whose other files are its resources). */
async function walk(dir: string): Promise<Found[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skillFile = entries.find((e) => e.isFile() && SKILL_FILE.test(e.name));
  if (skillFile) return [{ path: join(dir, skillFile.name), dir }];
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve(e.name.endsWith('.md') ? [{ path: join(dir, e.name) }] : []),
    ),
  );
  return nested.flat();
}

async function readResources(dir: string, skillPath: string): Promise<SkillResource[]> {
  const out: SkillResource[] = [];
  let total = 0;
  const visit = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await visit(full);
      else if (full !== skillPath) {
        const text = await readFile(full, 'utf8');
        if (text.includes('\u0000') || text.length > MAX_RESOURCE || total + text.length > MAX_RESOURCES_TOTAL) continue;
        out.push({ path: relative(dir, full).split(sep).join('/'), content: text });
        total += text.length;
      }
    }
  };
  await visit(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Loads skills from each root in order (bundled first). Invalid skills are reported, not fatal. */
export async function loadSkillRoots(roots: SkillRoot[]): Promise<LoadResult> {
  const skills: Skill[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();

  for (const root of roots) {
    if (!(await exists(root.dir))) continue;
    const found = (await walk(root.dir)).sort((a, b) => a.path.localeCompare(b.path));
    for (const f of found) {
      const file = relative(root.dir, f.path).split(sep).join('/');
      const label = root.origin === 'imported' ? `imported/${file}` : file;
      try {
        const skill = parseSkill(await readFile(f.path, 'utf8'), label);
        const folder = file.split('/')[0];
        if (file.includes('/') && folder !== skill.category) {
          errors.push(`${label}: category "${skill.category}" doesn't match folder "${folder}"`);
          continue;
        }
        const dup = seen.get(skill.id);
        if (dup) {
          errors.push(`${label}: duplicate id "${skill.id}" (also in ${dup})`);
          continue;
        }
        seen.set(skill.id, label);
        skill.origin = root.origin;
        if (f.dir) skill.resources = await readResources(f.dir, f.path);
        skills.push(skill);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }
  // Prerequisites are listed before the checks that depend on them, so results read in order.
  return { skills: dependencyOrder(skills), errors };
}

/** Loads every skills/<category>/<check-id>.md file from one folder. */
export function loadSkills(root: string): Promise<LoadResult> {
  return loadSkillRoots([{ dir: root, origin: 'bundled' }]);
}
