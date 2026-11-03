// Importing and removing user skills. Imported skills live in the extension's global storage, so they
// survive extension updates, as <root>/<category>/<id>/SKILL.md plus their supporting files.
import * as vscode from 'vscode';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { findSkills, slug, toSkillFile, type ImportFile, type SkillDraft } from '../skills/importer';
import { titleCase } from '../skills/parser';
import { SEVERITIES, type Severity, type Skill } from '../skills/types';

interface CategoryChoice {
  category: string;
  categoryName: string;
  /** Keep each Preflight skill's own declared category. */
  keepOwn?: boolean;
}

/** Imported skills' folder, given the label the loader gave them ("imported/<category>/<id>/SKILL.md"). */
function importedDir(root: string, skill: Skill): string | undefined {
  if (skill.origin !== 'imported' || !skill.file.startsWith('imported/')) return undefined;
  return dirname(join(root, ...skill.file.slice('imported/'.length).split('/')));
}

async function readImport(uri: vscode.Uri): Promise<ImportFile[]> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (/\.zip$/i.test(uri.path)) {
    const entries = unzipSync(bytes);
    return Object.entries(entries).map(([path, data]) => ({ path, bytes: data }));
  }
  return [{ path: uri.path.split('/').pop() ?? 'skill.md', bytes }];
}

async function pickCategory(skills: Skill[], drafts: SkillDraft[]): Promise<CategoryChoice | undefined> {
  type Item = vscode.QuickPickItem & { choice?: CategoryChoice; create?: boolean };
  const categories = new Map<string, { name: string; count: number }>();
  for (const s of skills) categories.set(s.category, { name: s.categoryName, count: (categories.get(s.category)?.count ?? 0) + 1 });
  const items: Item[] = [];
  const own = drafts.filter((d) => d.kind === 'preflight' && d.category);
  if (own.length === drafts.length) {
    const names = [...new Set(own.map((d) => d.categoryName ?? titleCase(d.category!)))];
    items.push({ label: `$(check) Keep the skill's own category`, description: names.join(', '), choice: { category: '', categoryName: '', keepOwn: true } });
  }
  items.push(
    ...[...categories].map(([category, c]) => ({
      label: c.name,
      description: `${c.count} check${c.count === 1 ? '' : 's'}`,
      choice: { category, categoryName: c.name },
    })),
    { label: '$(add) New category…', create: true },
  );
  const picked = await vscode.window.showQuickPick(items, { title: 'Import skills: category', placeHolder: 'Which category should the imported checks go under?', ignoreFocusOut: true });
  if (!picked) return undefined;
  if (!picked.create) return picked.choice;
  const name = await vscode.window.showInputBox({
    title: 'Import skills: new category',
    prompt: 'Category name, as shown in the Checks list',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
  });
  if (!name?.trim()) return undefined;
  return { category: slug(name), categoryName: name.trim() };
}

async function pickSeverity(drafts: SkillDraft[]): Promise<Severity | undefined> {
  const generic = drafts.filter((d) => d.kind === 'generic');
  if (generic.length === 0) return 'medium';
  const picked = await vscode.window.showQuickPick(
    SEVERITIES.map((s) => ({ label: titleCase(s), description: s === 'medium' ? 'Default' : undefined, severity: s })),
    {
      title: 'Import skills: severity',
      placeHolder: generic.length === 1 ? `How severe is a failure of "${generic[0].name}"?` : `How severe is a failure of these ${generic.length} checks?`,
      ignoreFocusOut: true,
    },
  );
  return picked?.severity;
}

function freeId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export interface ImportOutcome {
  imported: { id: string; name: string }[];
  problems: string[];
}

/** The whole import conversation: file, which skills, category, severity, clashes. Undefined if cancelled. */
export async function importSkills(root: string, skills: Skill[], log: (m: string) => void): Promise<ImportOutcome | undefined> {
  const [uri] =
    (await vscode.window.showOpenDialog({
      title: 'Import skills',
      openLabel: 'Import',
      canSelectMany: false,
      filters: { 'Skills (.md, .zip)': ['md', 'zip'] },
    })) ?? [];
  if (!uri) return undefined;

  let drafts: SkillDraft[];
  try {
    drafts = findSkills(await readImport(uri));
  } catch (err) {
    void vscode.window.showErrorMessage(`Preflight: couldn't read ${uri.path.split('/').pop()}: ${(err as Error).message}`);
    return undefined;
  }
  if (drafts.length === 0) {
    void vscode.window.showErrorMessage(`Preflight: no skill found in ${uri.path.split('/').pop()}. Add a SKILL.md or a Markdown skill file.`);
    return undefined;
  }

  if (drafts.length > 1) {
    const picked = await vscode.window.showQuickPick(
      drafts.map((d) => ({ label: d.name, description: d.kind === 'preflight' ? 'Preflight check' : 'Agent skill → AI check', detail: d.sourcePath, picked: true, draft: d })),
      { title: 'Import skills', placeHolder: 'Choose the skills to import', canPickMany: true, ignoreFocusOut: true },
    );
    if (!picked?.length) return undefined;
    drafts = picked.map((p) => p.draft);
  }

  const category = await pickCategory(skills, drafts);
  if (!category) return undefined;
  const severity = await pickSeverity(drafts);
  if (!severity) return undefined;

  const taken = new Set(skills.map((s) => s.id));
  const outcome: ImportOutcome = { imported: [], problems: [] };
  for (const draft of drafts) {
    let id = slug(draft.id);
    const existing = skills.find((s) => s.id === id);
    if (existing?.origin === 'imported') {
      const action = await vscode.window.showQuickPick(
        [
          { label: 'Replace', description: `Overwrite the imported "${existing.name}"`, action: 'replace' as const },
          { label: 'Import as a copy', description: `Keep both; the new one gets a different ID`, action: 'copy' as const },
          { label: 'Skip', action: 'skip' as const },
        ],
        { title: `"${draft.name}" is already imported`, ignoreFocusOut: true },
      );
      if (!action || action.action === 'skip') continue;
      if (action.action === 'copy') id = freeId(id, taken);
      else {
        const old = importedDir(root, existing);
        if (old) await rm(old, { recursive: true, force: true });
        taken.delete(id);
      }
    } else if (existing) {
      // Built-in checks are never overwritten.
      id = freeId(id, taken);
      outcome.problems.push(`"${draft.name}" has the same ID as a built-in check, so it was imported as ${id}`);
    }

    const cat = category.keepOwn ? { category: slug(draft.category ?? 'imported'), categoryName: draft.categoryName ?? titleCase(draft.category ?? 'imported') } : category;
    try {
      const file = toSkillFile(draft, { id, category: cat.category, categoryName: cat.categoryName, severity });
      const dir = join(root, cat.category, id);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), file, 'utf8');
      for (const r of draft.resources) {
        const target = join(dir, ...r.path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, r.content, 'utf8');
      }
      taken.add(id);
      outcome.imported.push({ id, name: draft.name });
      for (const w of draft.warnings) log(`Import ${draft.name}: ${w}`);
      log(`Imported ${draft.name} as ${cat.category}/${id} (${draft.resources.length} supporting files)`);
    } catch (err) {
      outcome.problems.push(`${draft.name}: ${(err as Error).message}`);
    }
  }
  return outcome;
}

export async function removeImportedSkill(root: string, skill: Skill): Promise<boolean> {
  const dir = importedDir(root, skill);
  if (!dir) return false;
  const choice = await vscode.window.showWarningMessage(`Remove the imported check "${skill.name}"?`, 'Remove');
  if (choice !== 'Remove') return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}
