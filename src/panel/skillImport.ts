// Importing and removing user skills. Imported skills live in the extension's global storage, so they
// survive extension updates, as <root>/<category>/<id>/SKILL.md plus their supporting files.
import * as vscode from 'vscode';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { findSkills, slug, toSkillFile, type ImportFile, type SkillDraft } from '../skills/importer';
import { titleCase } from '../skills/parser';
import { SEVERITIES, type Severity, type Skill } from '../skills/types';
import type { ModelProvider } from '../ai/provider';
import { aiReview, LIKELY_DUPLICATE, reviewDraft, type DraftReview, type ReviewStatus } from '../skills/importReview';

const STATUS: Record<ReviewStatus, { icon: string; label: string }> = {
  ready: { icon: '$(pass)', label: 'Ready' },
  style: { icon: '$(warning)', label: 'Style issues' },
  duplicate: { icon: '$(copy)', label: 'Likely duplicate' },
  invalid: { icon: '$(error)', label: "Invalid: can't import" },
};

/** One line describing a review, for the review list. */
function reviewDetail(r: DraftReview): string {
  const parts: string[] = [];
  const dup = r.duplicates[0];
  if (dup && dup.score >= LIKELY_DUPLICATE) parts.push(`Duplicate of "${dup.name}" (${dup.reason})`);
  else if (dup) parts.push(`Similar to "${dup.name}"`);
  parts.push(...r.issues.map((i) => i.message));
  if (r.improved) parts.push('AI rewrite into Preflight style available');
  return parts.join(' · ') || (r.draft.kind === 'preflight' ? 'Preflight check, valid' : 'Agent skill, becomes an AI check');
}

/** Lets the user see each skill's review and choose what to import; duplicates and invalid skills start unticked. */
async function pickReviewed(reviews: DraftReview[]): Promise<DraftReview[] | undefined> {
  const picked = await vscode.window.showQuickPick(
    reviews.map((r) => ({
      label: `${STATUS[r.status].icon} ${r.draft.name}`,
      description: STATUS[r.status].label,
      detail: reviewDetail(r),
      picked: r.status === 'ready' || r.status === 'style',
      review: r,
    })),
    { title: 'Import skills: review', placeHolder: 'Preflight checked each skill. Choose the ones to import.', canPickMany: true, ignoreFocusOut: true },
  );
  if (!picked) return undefined;
  const invalid = picked.filter((p) => p.review.status === 'invalid');
  if (invalid.length) {
    void vscode.window.showWarningMessage(`Preflight: skipped ${invalid.map((i) => `"${i.review.draft.name}" (${i.review.issues[0]?.message})`).join(', ')}.`);
  }
  return picked.filter((p) => p.review.status !== 'invalid').map((p) => p.review);
}

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
export interface ImportOptions {
  /** The provider selected in the top bar, created only if the review needs AI. */
  provider?: () => Promise<ModelProvider | undefined>;
  /** A bundled skill file, shown to the AI as the target format. */
  example?: string;
}

export async function importSkills(root: string, skills: Skill[], log: (m: string) => void, opts: ImportOptions = {}): Promise<ImportOutcome | undefined> {
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

  // Review every skill: format, style and duplicates, then an AI pass where it can help.
  let reviews = drafts.map((d) => reviewDraft(d, skills));
  const wantsAi = reviews.some((r) => r.status !== 'invalid' && (r.draft.kind === 'generic' || r.duplicates.length > 0));
  const provider = wantsAi && opts.provider ? await opts.provider() : undefined;
  if (provider && opts.example) {
    reviews = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Preflight: reviewing skills', cancellable: true },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        const out: DraftReview[] = [];
        for (const [i, r] of reviews.entries()) {
          if (ac.signal.aborted) {
            out.push(r);
            continue;
          }
          progress.report({ message: `${r.draft.name} (${i + 1} of ${reviews.length})`, increment: 100 / reviews.length });
          out.push(await aiReview(r, skills, provider, opts.example!, ac.signal));
        }
        return out;
      },
    );
  }
  for (const r of reviews) log(`Review ${r.draft.name}: ${r.status}; ${reviewDetail(r)}`);

  const chosen = await pickReviewed(reviews);
  if (!chosen?.length) return undefined;

  // Offer the AI's rewrite into Preflight's five-section style for free-form skills.
  const improvable = chosen.filter((r) => r.improved);
  let useImproved = false;
  if (improvable.length) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Use the AI rewrite in Preflight's style", description: 'Recommended', detail: 'Explicit pass and fail criteria; the original stays attached to the check', use: true },
        { label: 'Import as written', detail: "Wraps the original instructions as they are", use: false },
      ],
      { title: `Import skills: ${improvable.length === 1 ? `"${improvable[0].draft.name}"` : `${improvable.length} skills`} can be improved`, ignoreFocusOut: true },
    );
    if (!pick) return undefined;
    useImproved = pick.use;
  }

  // Likely duplicates the user still ticked: skip, replace an earlier import, or keep both.
  const replace = new Set<string>();
  const final: DraftReview[] = [];
  for (const r of chosen) {
    const dup = r.duplicates.find((d) => d.score >= LIKELY_DUPLICATE);
    if (!dup) {
      final.push(r);
      continue;
    }
    const existing = skills.find((s) => s.id === dup.id);
    const options = [
      ...(existing?.origin === 'imported' ? [{ label: `Replace "${dup.name}"`, description: 'Remove the earlier import and use this one', action: 'replace' as const }] : []),
      { label: 'Import anyway', description: 'Keep both checks', action: 'keep' as const },
      { label: 'Skip', action: 'skip' as const },
    ];
    const pick = await vscode.window.showQuickPick(options, {
      title: `"${r.draft.name}" looks like a duplicate of ${existing?.origin === 'bundled' ? 'the built-in check' : 'the check'} "${dup.name}"`,
      placeHolder: dup.reason,
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    if (pick.action === 'skip') continue;
    if (pick.action === 'replace') replace.add(dup.id);
    final.push(r);
  }
  if (final.length === 0) return { imported: [], problems: [] };
  for (const id of replace) {
    const old = skills.find((s) => s.id === id);
    const dir = old && importedDir(root, old);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  skills = skills.filter((s) => !replace.has(s.id));
  drafts = final.map((r) => (useImproved && r.improved ? r.improved : r.draft));

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
