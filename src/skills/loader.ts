import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseSkill } from './parser';
import type { Skill } from './types';

export interface LoadResult {
  skills: Skill[];
  errors: string[];
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve(e.name.endsWith('.md') ? [join(dir, e.name)] : []))),
  );
  return nested.flat();
}

/** Loads every skills/<category>/<check-id>.md file. Invalid skills are reported, not fatal. */
export async function loadSkills(root: string): Promise<LoadResult> {
  const skills: Skill[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();

  for (const path of (await walk(root)).sort()) {
    const file = relative(root, path).split(sep).join('/');
    try {
      const skill = parseSkill(await readFile(path, 'utf8'), file);
      const folder = file.split('/')[0];
      if (file.includes('/') && folder !== skill.category) {
        errors.push(`${file}: category "${skill.category}" doesn't match folder "${folder}"`);
        continue;
      }
      const dup = seen.get(skill.id);
      if (dup) {
        errors.push(`${file}: duplicate id "${skill.id}" (also in ${dup})`);
        continue;
      }
      seen.set(skill.id, file);
      skills.push(skill);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { skills, errors };
}
