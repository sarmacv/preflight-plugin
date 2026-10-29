import { useState } from 'preact/hooks';
import type { CheckMeta, CheckResult, Severity } from '../../shared/protocol';
import {
  canScan, catalogById, checkCounts, failuresOnly, rerun, runs, scanError, scanning, startScan, type RepoRunView,
} from '../store';
import { post } from '../vscode';
import { Empty, Icon, IconButton } from './Icon';
import { canFix, prepareFixes } from '../fixStore';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

type RowStatus = CheckResult['status'] | 'running' | 'queued';

const STATUS_ICON: Record<RowStatus, { icon: string; label: string; spin?: boolean }> = {
  pass: { icon: 'pass-filled', label: 'Passed' },
  fail: { icon: 'error', label: 'Failed' },
  error: { icon: 'warning', label: 'Could not evaluate' },
  skipped: { icon: 'circle-slash', label: 'Skipped' },
  running: { icon: 'loading', label: 'Running', spin: true },
  queued: { icon: 'circle-outline', label: 'Queued' },
};

export function StatusIcon({ status }: { status: RowStatus }) {
  const s = STATUS_ICON[status];
  return (
    <span class={`status s-${status}`} title={s.label} role="img" aria-label={s.label}>
      <Icon name={s.icon} spin={s.spin} />
    </span>
  );
}

function SeverityTag({ severity }: { severity: Severity }) {
  return <span class={`sev sev-${severity}`}>{severity}</span>;
}

export function Results() {
  const list = runs.value;
  if (list.length === 0) {
    return <Empty icon="checklist" label="Nothing scanned" action={canScan.value ? { label: 'Scan', onClick: startScan } : undefined} />;
  }
  return (
    <div class="cards">
      {scanError.value && (
        <div class="banner error" role="alert" title={scanError.value.detail}>
          <Icon name="error" /> {scanError.value.label}
        </div>
      )}
      {list.map((r) => <RepoCard key={r.repo} run={r} />)}
    </div>
  );
}

function rowStatus(run: RepoRunView, id: string): RowStatus {
  const r = run.results[id];
  if (r) return r.status;
  if (run.running.includes(id)) return 'running';
  return 'queued';
}

function RepoCard({ run }: { run: RepoRunView }) {
  const [open, setOpen] = useState(true);
  const metas = run.checkIds.map((id) => catalogById.value.get(id)).filter((m): m is CheckMeta => !!m);
  const done = metas.filter((m) => run.results[m.id]).length;
  const score = run.score;
  const verdict = run.status === 'done' && score ? score.verdict : undefined;
  const pinned = metas.filter((m) => run.results[m.id]?.status === 'fail' && m.severity === 'critical');
  const pinnedIds = new Set(pinned.map((m) => m.id));
  // Pinned rows are shown once, at the top, but still count towards their category.
  const categories = groupByCategory(metas).map(([c, items]) => [c, items.filter((m) => !pinnedIds.has(m.id)), items] as const);
  const repoUrl = `https://github.com/${run.repo}/tree/${encodeURIComponent(run.branch)}`;
  const fixable = run.status === 'done' ? metas.filter((m) => run.results[m.id]?.status === 'fail' && m.fixable).length : 0;

  return (
    <section class={`card${verdict ? ` v-${verdict}` : ''}`} aria-label={run.repo}>
      <header class="card-head">
        <button type="button" class="twisty" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </button>
        <RunIcon run={run} />
        <span class="card-title ellipsis" title={run.repo}>{run.repo}</span>
        <span class="branch muted" title={`Branch ${run.branch}`}>
          <Icon name="git-branch" /> {run.branch}
        </span>
        {verdict && (
          <span class={`verdict ${verdict}`} title={verdict === 'cleared' ? 'No critical or high severity failures' : 'Has critical or high severity failures'}>
            <Icon name={verdict === 'cleared' ? 'pass-filled' : 'error'} /> {verdict === 'cleared' ? 'Passing' : 'Failing'}
          </span>
        )}
        <span class="spacer" />
        {score && (
          <span class="sev-counts">
            {SEVERITIES.filter((s) => score.failures[s] > 0).map((s) => (
              <span key={s} class={`sev-count sev-${s}`} title={`${score.failures[s]} ${s} failure(s)`}>
                {score.failures[s]} {s}
              </span>
            ))}
          </span>
        )}
        {score && (
          <span class="score" title={`Score ${score.score} of 100 · ${score.passed} passed, ${score.failed} failed, ${score.skipped} skipped, ${score.errored} errors`}>
            {score.score}
            <span class="of">/100</span>
          </span>
        )}
        {fixable > 0 && (
          <button
            type="button"
            class="btn small"
            disabled={!canFix.value}
            title={`Preview fixes for ${fixable} failed check${fixable === 1 ? '' : 's'} in ${run.repo}`}
            onClick={() => prepareFixes([run.repo])}
          >
            <Icon name="wand" /> Fix {fixable}
          </button>
        )}
        <IconButton icon="refresh" label={`Run the ${checkCounts.value.selected} selected checks on this repo`} disabled={scanning.value || checkCounts.value.selected === 0} onClick={() => rerun(run.repo, run.branch)} />
        <IconButton icon="link-external" label="Open on GitHub" onClick={() => post({ type: 'openExternal', url: repoUrl })} />
      </header>

      {(run.status === 'running' || run.status === 'queued') && (
        <div class="progress determinate" role="progressbar" aria-valuemin={0} aria-valuemax={metas.length} aria-valuenow={done} aria-label={`${done} of ${metas.length} checks`}>
          <span style={{ width: `${metas.length ? (done / metas.length) * 100 : 0}%` }} />
        </div>
      )}

      {open && run.error && (
        <div class="banner error" title={run.error.detail}>
          <Icon name="error" /> {run.error.label}
          {run.error.action && (
            <button type="button" class="link" onClick={() => post(run.error!.action!.command)}>{run.error.action.label}</button>
          )}
        </div>
      )}

      {open && !run.error && (
        <div class="card-body">
          {pinned.length > 0 && (
            <div class="group pinned" aria-label="Critical failures">
              {pinned.map((m) => <CheckRow key={m.id} run={run} meta={m} pinned />)}
            </div>
          )}
          {categories.map(([category, shown, all]) => <CategoryGroup key={category} run={run} name={all[0].categoryName} items={shown} all={all} />)}
        </div>
      )}
    </section>
  );
}

function RunIcon({ run }: { run: RepoRunView }) {
  if (run.status === 'running') return <StatusIcon status="running" />;
  if (run.status === 'queued') return <StatusIcon status="queued" />;
  if (run.status === 'failed') return <StatusIcon status="error" />;
  if (run.status === 'cancelled') {
    return (
      <span class="status s-skipped" title="Stopped" role="img" aria-label="Stopped">
        <Icon name="debug-stop" />
      </span>
    );
  }
  return <StatusIcon status={run.score && run.score.verdict === 'grounded' ? 'fail' : 'pass'} />;
}

function groupByCategory(metas: CheckMeta[]): [string, CheckMeta[]][] {
  const groups = new Map<string, CheckMeta[]>();
  for (const m of metas) groups.set(m.category, [...(groups.get(m.category) ?? []), m]);
  return [...groups];
}

function CategoryGroup({ run, name, items, all }: { run: RepoRunView; name: string; items: CheckMeta[]; all: CheckMeta[] }) {
  const statuses = all.map((m) => rowStatus(run, m.id));
  const failing = statuses.filter((s) => s === 'fail').length;
  const passing = statuses.filter((s) => s === 'pass').length;
  const attention = statuses.some((s) => s === 'fail' || s === 'error');
  const [override, setOverride] = useState<boolean | undefined>(undefined);
  const open = override ?? attention;
  const visible = failuresOnly.value ? items.filter((m) => ['fail', 'error'].includes(rowStatus(run, m.id))) : items;
  if (items.length === 0 || (failuresOnly.value && visible.length === 0)) return null;
  const groupStatus: RowStatus = statuses.some((s) => s === 'running') ? 'running' : failing ? 'fail' : statuses.includes('error') ? 'error' : statuses.every((s) => s === 'queued') ? 'queued' : passing ? 'pass' : 'skipped';

  return (
    <div class="group">
      <div class="group-head">
        <button type="button" class="group-toggle" aria-expanded={open} onClick={() => setOverride(!open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <StatusIcon status={groupStatus} />
          <span class="ellipsis">{name}</span>
          <span class="muted count-pair" title={`${passing} passed, ${failing} failed of ${all.length}`}>
            {passing}/{all.length}
          </span>
        </button>
        <IconButton icon="refresh" label={`Re-run ${name}`} class="hover-action" disabled={scanning.value} onClick={() => rerun(run.repo, run.branch, all.map((m) => m.id))} />
      </div>
      {open && visible.map((m) => <CheckRow key={m.id} run={run} meta={m} />)}
    </div>
  );
}

function CheckRow({ run, meta, pinned }: { run: RepoRunView; meta: CheckMeta; pinned?: boolean }) {
  const result = run.results[meta.id];
  const status = rowStatus(run, meta.id);
  const [open, setOpen] = useState(false);
  const summary = result?.evidence[0]?.message;
  const expandable = !!result && result.evidence.length > 0;

  return (
    <div class={`crow${open ? ' open' : ''}${pinned ? ' pinned' : ''}`}>
      <div class="check-row">
        <button type="button" class="check-main" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => setOpen(!open)}>
          {pinned ? <Icon name="pinned" class="pin" /> : <span class="indent" />}
          <StatusIcon status={status} />
          <span class="check-name ellipsis">{meta.name}</span>
          <SeverityTag severity={meta.severity} />
          {meta.evaluation !== 'deterministic' && (
            <span class="ai-tag" title={meta.evaluation === 'ai' ? 'Reviewed by AI' : 'Rules, then AI review'}>
              <Icon name="sparkle" />
            </span>
          )}
          {status === 'fail' && meta.fixable && (
            <span class="fix-tag" title="Preflight can fix this">
              <Icon name="wand" />
            </span>
          )}
          {summary && !open && <span class="summary muted ellipsis">{summary}</span>}
        </button>
        <IconButton icon="refresh" label={`Re-run ${meta.name}`} class="hover-action" disabled={scanning.value} onClick={() => rerun(run.repo, run.branch, [meta.id])} />
      </div>
      {open && result && (
        <ul class="evidence">
          {result.evidence.map((e, i) => (
            <li key={i}>
              {e.url ? (
                <button type="button" class="link" onClick={() => post({ type: 'openExternal', url: e.url! })}>{e.message}</button>
              ) : (
                <span>{e.message}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
