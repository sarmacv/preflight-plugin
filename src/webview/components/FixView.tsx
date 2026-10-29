import { useMemo, useState } from 'preact/hooks';
import type { PlanFile, PlanPr, RepoPlan } from '../../shared/protocol';
import { diffLines, hunks } from '../../shared/diff';
import {
  branchProblem, canCreate, closeFixes, createPrs, fixError, fixLabel, fixPhase, fixRepos, prEdits, prResults, prTotal, submissions, updateEdit,
} from '../fixStore';
import { post } from '../vscode';
import { Empty, Icon, IconButton } from './Icon';

const MAX_NEW_LINES = 300;

export function FixView() {
  const phase = fixPhase.value;

  if (phase === 'preparing') {
    return (
      <div class="fix-shell">
        <Toolbar />
        <Empty icon="loading" spin label={fixLabel.value || 'Preparing fixes'} action={{ label: 'Cancel', onClick: closeFixes }} />
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <div class="fix-shell">
        <Toolbar />
        <Empty icon="error" label={fixError.value?.label ?? 'Fixes failed'} detail={fixError.value?.detail} action={{ label: 'Back', onClick: closeFixes }} />
      </div>
    );
  }
  if (phase === 'creating') {
    return (
      <div class="fix-shell">
        <Toolbar />
        <Empty icon="loading" spin label={`Opening ${prTotal.value} PR${prTotal.value === 1 ? '' : 's'}`} />
      </div>
    );
  }
  if (phase === 'done') return <Done />;

  const repos = fixRepos.value;
  const nothing = repos.every((r) => r.prs.length === 0);
  return (
    <div class="fix-shell">
      <Toolbar />
      {fixError.value && (
        <div class="banner error" role="alert" title={fixError.value.detail}>
          <Icon name="error" /> {fixError.value.label}
          {fixError.value.detail && <span class="muted ellipsis">{fixError.value.detail}</span>}
        </div>
      )}
      <div class="fix-body">
        {nothing && <Empty icon="circle-slash" label="No fixes to propose" action={{ label: 'Back', onClick: closeFixes }} />}
        {repos.map((r) => <RepoFixes key={r.repo} plan={r} />)}
      </div>
    </div>
  );
}

function Toolbar() {
  const subs = submissions.value;
  const files = subs.reduce((n, s) => n + s.files.length, 0);
  const reviewing = fixPhase.value === 'review' || fixPhase.value === 'confirming';
  return (
    <div class="fix-toolbar">
      <IconButton icon="arrow-left" label="Back to results" onClick={closeFixes} disabled={fixPhase.value === 'creating' || fixPhase.value === 'confirming'} />
      {reviewing && (
        <span class="muted" title={`${subs.length} pull request(s), ${files} file(s)`}>
          <Icon name="git-pull-request" /> {subs.length} · <Icon name="file" /> {files}
        </span>
      )}
      <span class="spacer" />
      {reviewing && (
        <button type="button" class="btn primary" disabled={!canCreate.value || fixPhase.value === 'confirming'} onClick={createPrs}>
          {fixPhase.value === 'confirming' ? <Icon name="loading" spin /> : <Icon name="git-pull-request-create" />}
          Create PRs
        </button>
      )}
    </div>
  );
}

function RepoFixes({ plan }: { plan: RepoPlan }) {
  return (
    <section class="card fix-repo" aria-label={plan.repo}>
      <header class="card-head">
        <span class="indent" />
        <Icon name="repo" />
        <span class="card-title ellipsis">{plan.repo}</span>
        <span class="branch muted" title={`PRs target ${plan.base}`}>
          <Icon name="git-branch" /> {plan.base}
        </span>
      </header>
      <div class="card-body">
        {plan.prs.map((pr) => <PrBlock key={pr.id} pr={pr} />)}
        {plan.problems.length > 0 && <Problems plan={plan} />}
      </div>
    </section>
  );
}

function Problems({ plan }: { plan: RepoPlan }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="group">
      <div class="group-head">
        <button type="button" class="group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span class="status s-error"><Icon name="warning" /></span>
          <span>Not fixed</span>
          <span class="muted count-pair">{plan.problems.length}</span>
        </button>
      </div>
      {open && (
        <ul class="evidence">
          {plan.problems.map((p) => (
            <li key={p.checkId}>
              <b>{p.name}</b> <span class="muted">{p.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PrBlock({ pr }: { pr: PlanPr }) {
  const edit = prEdits.value[pr.id];
  if (!edit) return null;
  const problem = branchProblem(pr.id);
  const kindLabel = pr.kind === 'coverage' ? 'Coverage' : 'Fixes';
  return (
    <div class={`pr${edit.include ? '' : ' excluded'}`}>
      <div class="pr-head">
        <button
          type="button"
          class={`check${edit.include ? ' on' : ''}`}
          role="checkbox"
          aria-checked={edit.include}
          aria-label={`Include ${kindLabel} PR`}
          onClick={() => updateEdit(pr.id, (e) => ({ ...e, include: !e.include }))}
        >
          {edit.include && <Icon name="check" />}
        </button>
        <Icon name={pr.kind === 'coverage' ? 'beaker' : 'tools'} />
        <span class="pr-kind">{kindLabel}</span>
        {pr.draft && <span class="tag">Draft</span>}
        <label class={`branch-input${problem ? ' invalid' : ''}`} title={problem ?? 'New branch for this PR'}>
          <Icon name="git-branch" />
          <input
            aria-label={`${kindLabel} PR branch`}
            aria-invalid={!!problem}
            value={edit.branch}
            disabled={!edit.include}
            spellcheck={false}
            onInput={(e) => {
              const branch = e.currentTarget.value;
              updateEdit(pr.id, (x) => ({ ...x, branch }));
            }}
          />
          {problem && <Icon name="error" class="err" />}
        </label>
        <Icon name="arrow-right" class="muted" />
        <span class="muted">{pr.base}</span>
      </div>
      {problem && edit.include && <div class="field-error">{problem}</div>}
      <div class="pr-checks">
        {pr.checks.map((c) => (
          <span key={c.id} class="chip-static" title={`${c.id} · ${c.severity}`}>
            <span class={`dot-sev sev-${c.severity}`} /> {c.name}
          </span>
        ))}
      </div>
      <div class="pr-files">
        {pr.files.map((f) => <FileRow key={f.path} pr={pr} file={f} />)}
      </div>
      {pr.notes.length > 0 && <Notes notes={pr.notes} />}
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  const [open, setOpen] = useState(false);
  const lines = notes.flatMap((n) => n.split('\n')).map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
  return (
    <div class="notes">
      <button type="button" class="group-toggle small" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <Icon name="eye" /> <span>Reviewer notes</span> <span class="muted count-pair">{lines.length}</span>
      </button>
      {open && (
        <ul class="evidence">
          {lines.map((l, i) => <li key={i}>{l.replace(/`/g, '')}</li>)}
        </ul>
      )}
    </div>
  );
}

function FileRow({ pr, file }: { pr: PlanPr; file: PlanFile }) {
  const edit = prEdits.value[pr.id];
  const state = edit.files[file.path];
  const [open, setOpen] = useState(file.editable);
  const [editing, setEditing] = useState(file.editable);
  const after = state?.content ?? file.after;
  const ops = useMemo(() => (file.before === undefined || after === null ? undefined : diffLines(file.before, after)), [file.before, after]);
  const added = ops ? ops.filter((o) => o.kind === 'add').length : after === null ? 0 : after.split('\n').length;
  const removed = ops ? ops.filter((o) => o.kind === 'del').length : after === null && file.before ? file.before.split('\n').length : 0;
  const status = file.before === undefined ? 'A' : after === null ? 'D' : 'M';
  const setFile = (patch: { include?: boolean; content?: string }) =>
    updateEdit(pr.id, (e) => ({ ...e, files: { ...e.files, [file.path]: { ...e.files[file.path], ...patch } } }));

  return (
    <div class={`file${state?.include ? '' : ' excluded'}`}>
      <div class="file-row">
        <button type="button" class={`check${state?.include ? ' on' : ''}`} role="checkbox" aria-checked={!!state?.include} aria-label={`Include ${file.path}`} disabled={!edit.include} onClick={() => setFile({ include: !state?.include })}>
          {state?.include && <Icon name="check" />}
        </button>
        <button type="button" class="file-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span class={`fstat f-${status}`} title={{ A: 'Added', M: 'Modified', D: 'Deleted' }[status]}>{status}</span>
          <span class="ellipsis mono">{file.path}</span>
          {file.editable && <span class="tag warn" title="Review and edit before creating the PR">Review</span>}
          <span class="add">+{added}</span>
          <span class="del">−{removed}</span>
        </button>
        {after !== null && (
          <IconButton icon={editing ? 'diff' : 'edit'} label={editing ? 'Show diff' : 'Edit file'} onClick={() => { setOpen(true); setEditing(!editing); }} />
        )}
      </div>
      {open && (editing && after !== null ? (
        <textarea class="editor mono" spellcheck={false} aria-label={`Contents of ${file.path}`} value={after} rows={Math.min(24, Math.max(6, after.split('\n').length + 1))} onInput={(e) => setFile({ content: e.currentTarget.value })} />
      ) : (
        <Diff before={file.before} after={after} ops={ops} />
      ))}
    </div>
  );
}

function Diff({ before, after, ops }: { before?: string; after: string | null; ops?: ReturnType<typeof diffLines> }) {
  if (!ops) {
    const lines = (after ?? before ?? '').split('\n');
    const kind = after === null ? 'del' : 'add';
    return (
      <pre class="diff mono">
        {lines.slice(0, MAX_NEW_LINES).map((l, i) => (
          <div key={i} class={`dl ${kind}`}><span class="ln">{i + 1}</span><span class="sig">{kind === 'add' ? '+' : '−'}</span>{l}</div>
        ))}
        {lines.length > MAX_NEW_LINES && <div class="dl more">… {lines.length - MAX_NEW_LINES} more lines</div>}
      </pre>
    );
  }
  return (
    <pre class="diff mono">
      {hunks(ops).map((h, i) => (
        <div key={i} class="hunk">
          {i > 0 && <div class="dl gap">⋯</div>}
          {h.ops.map((o, j) => (
            <div key={j} class={`dl ${o.kind}`}>
              <span class="ln">{o.kind === 'del' ? o.oldNo : o.newNo}</span>
              <span class="sig">{o.kind === 'add' ? '+' : o.kind === 'del' ? '−' : ' '}</span>
              {o.text}
            </div>
          ))}
        </div>
      ))}
    </pre>
  );
}

function Done() {
  const results = prResults.value;
  const opened = results.filter((r) => r.url).length;
  return (
    <div class="fix-shell">
      <div class="fix-toolbar">
        <IconButton icon="arrow-left" label="Back to results" onClick={closeFixes} />
        <span class="muted"><Icon name="git-pull-request" /> {opened} / {results.length}</span>
      </div>
      <div class="fix-body">
        {results.map((r) => (
          <div key={r.id} class="result-row">
            <span class={`status ${r.url ? 's-pass' : 's-fail'}`}><Icon name={r.url ? 'pass-filled' : 'error'} /></span>
            <span class="ellipsis"><b>{r.repo}</b> <span class="muted">{r.kind === 'coverage' ? 'Coverage' : 'Fixes'}</span></span>
            {r.url ? (
              <button type="button" class="link" onClick={() => post({ type: 'openExternal', url: r.url! })}>
                #{r.number} <Icon name="link-external" />
              </button>
            ) : (
              <span class="err-text">{r.error}</span>
            )}
            {r.warnings.map((w, i) => (
              <div key={i} class="warn-line"><Icon name="warning" /> {w}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
