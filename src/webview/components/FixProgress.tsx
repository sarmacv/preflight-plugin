import { useEffect, useState } from 'preact/hooks';
import type { FixTask, PrStep } from '../../shared/protocol';
import { closeFixes, fixProgress, phaseStartedAt, prProgress, type PrProgress, type RepoFixProgress } from '../fixStore';
import { Icon } from './Icon';

const TASK_ICON: Record<FixTask['status'], { icon: string; cls: string; label: string; spin?: boolean }> = {
  queued: { icon: 'circle-outline', cls: 's-queued', label: 'Waiting' },
  running: { icon: 'loading', cls: 's-running', label: 'Working', spin: true },
  done: { icon: 'pass-filled', cls: 's-pass', label: 'Done' },
  failed: { icon: 'error', cls: 's-fail', label: 'Failed' },
  skipped: { icon: 'warning', cls: 's-error', label: 'Not counted' },
};

function Elapsed() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - phaseStartedAt.value) / 1000));
  return (
    <span class="muted elapsed" title="Elapsed">
      <Icon name="watch" /> {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </span>
  );
}

function Bar({ value, max, marker, label }: { value: number; max: number; marker?: number; label: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div class="meter" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span class="meter-fill" style={{ width: `${pct}%` }} />
      {marker !== undefined && <span class="meter-marker" style={{ left: `${marker}%` }} title={`Target ${marker}%`} />}
    </div>
  );
}

function TaskRow({ task }: { task: FixTask }) {
  const s = TASK_ICON[task.status];
  return (
    <li class={`task t-${task.status}`}>
      <span class={`status ${s.cls}`} title={s.label} role="img" aria-label={s.label}>
        <Icon name={s.icon} spin={s.spin} />
      </span>
      <span class={`task-label ellipsis${task.section === 'coverage' ? ' mono' : ''}`} title={task.label}>{task.label}</span>
      {task.replacement && <span class="tag" title="Picked to replace a file that failed">replacement</span>}
      <span class="task-detail ellipsis" title={task.detail ?? task.files?.join(', ')}>
        {task.status === 'done' && task.files?.length ? (
          <span class="mono muted">→ {task.files.join(', ')}</span>
        ) : task.detail ? (
          <span class={task.status === 'failed' ? 'err-text' : 'warn'}>{task.detail}</span>
        ) : null}
      </span>
    </li>
  );
}

const count = (tasks: FixTask[], ...statuses: FixTask['status'][]) => tasks.filter((t) => statuses.includes(t.status)).length;

function RepoProgress({ p }: { p: RepoFixProgress }) {
  const fixTasks = p.tasks.filter((t) => t.section === 'fixes');
  const covTasks = p.tasks.filter((t) => t.section === 'coverage');
  const cov = p.coverage;
  const covDone = count(covTasks, 'done');
  const covGoal = cov?.goal ?? 0;
  const fixFinished = count(fixTasks, 'done', 'failed', 'skipped');
  const total = fixTasks.length + covGoal;
  const finished = fixFinished + Math.min(covDone, covGoal);
  const estimateNow = cov?.source === 'estimate' && cov.total ? Math.round((((cov.tested ?? 0) + covDone) / cov.total) * 100) : undefined;
  const inProgress = count(covTasks, 'running');
  const notCounted = count(covTasks, 'failed', 'skipped');
  const toGo = Math.max(0, covGoal - covDone - inProgress);

  return (
    <section class="card progress-card" aria-label={p.repo}>
      <header class="card-head">
        <span class="indent" />
        <Icon name="repo" />
        <span class="card-title ellipsis">{p.repo}</span>
        <span class="branch muted"><Icon name="git-branch" /> {p.base}</span>
        <span class="spacer" />
        <span class="muted tabular" title={`${finished} of ${total} tasks finished`}>{finished} / {total}</span>
      </header>
      <div class="progress-overall">
        <Bar value={finished} max={total} label={`${finished} of ${total} tasks finished`} />
      </div>

      {fixTasks.length > 0 && (
        <div class="psection">
          <div class="psection-head">
            <Icon name="tools" /> <b>Fixes PR</b>
            <span class="muted">{fixTasks.length} check{fixTasks.length === 1 ? '' : 's'} to fix</span>
            <span class="spacer" />
            <span class="muted tabular">{fixFinished} / {fixTasks.length}</span>
          </div>
          <ul class="tasks">{fixTasks.map((t) => <TaskRow key={t.id} task={t} />)}</ul>
        </div>
      )}

      {cov && (
        <div class="psection">
          <div class="psection-head">
            <Icon name="beaker" /> <b>Coverage PR</b> <span class="tag">Draft</span>
            <span class="muted">
              {cov.source === 'estimate' && cov.total !== undefined
                ? `${covGoal} of ${cov.total} source files need tests to reach ${cov.target}%`
                : `tests for ${covGoal} lowest-coverage files (target ${cov.target}%)`}
            </span>
          </div>
          {estimateNow !== undefined && (
            <div class="cov-meter">
              <span class="muted">Before {cov.before}%</span>
              <Bar value={estimateNow} max={100} marker={cov.target} label={`Estimated coverage ${estimateNow}%, target ${cov.target}%`} />
              <span class={estimateNow >= cov.target ? 'ok' : ''}><b>{estimateNow}%</b> now · target {cov.target}%</span>
            </div>
          )}
          <div class="counts">
            <span class="count-chip ok"><Icon name="pass-filled" /> {covDone} written</span>
            <span class="count-chip"><Icon name="loading" spin={inProgress > 0} /> {inProgress} in progress</span>
            {notCounted > 0 && <span class="count-chip warn" title="Failed or not recognised; another file is used instead"><Icon name="warning" /> {notCounted} replaced</span>}
            <span class="count-chip muted"><Icon name="circle-outline" /> {toGo} to go</span>
          </div>
          <ul class="tasks">{covTasks.map((t) => <TaskRow key={t.id} task={t} />)}</ul>
        </div>
      )}

      {fixTasks.length === 0 && !cov && (
        <div class="psection muted"><Icon name="loading" spin /> Planning</div>
      )}
    </section>
  );
}

/** "Preparing fixes": every task for every repo, with live status. */
export function FixProgressView() {
  const repos = fixProgress.value;
  return (
    <div class="fix-shell">
      <div class="fix-toolbar">
        <Icon name="wand" />
        <b>Preparing fixes</b>
        <span class="muted">{repos.length ? `${repos.length} repo${repos.length === 1 ? '' : 's'}` : 'Planning'}</span>
        <Elapsed />
        <span class="spacer" />
        <button type="button" class="btn" onClick={closeFixes}>Cancel</button>
      </div>
      <div class="fix-body">
        {repos.length === 0 && (
          <div class="empty"><Icon name="loading" spin /> <span>Working out what to fix</span></div>
        )}
        {repos.map((p) => <RepoProgress key={p.repo} p={p} />)}
      </div>
    </div>
  );
}

const STEPS: { step: PrStep; label: (p: PrProgress) => string }[] = [
  { step: 'branch', label: (p) => `Create branch ${p.branch}` },
  { step: 'commit', label: (p) => `Commit ${p.files} file${p.files === 1 ? '' : 's'}` },
  { step: 'pr', label: (p) => `Open ${p.draft ? 'draft ' : ''}pull request into ${p.base}` },
  { step: 'label', label: () => 'Add the "preflight" label' },
];

const STEP_ICON = {
  running: { icon: 'loading', cls: 's-running', spin: true },
  done: { icon: 'pass-filled', cls: 's-pass' },
  failed: { icon: 'error', cls: 's-fail' },
  warning: { icon: 'warning', cls: 's-error' },
} as const;

/** "Opening pull requests": each PR's steps with live status. */
export function PrProgressView() {
  const prs = prProgress.value;
  const done = prs.filter((p) => p.steps.label?.status === 'done' || p.steps.label?.status === 'warning').length;
  return (
    <div class="fix-shell">
      <div class="fix-toolbar">
        <Icon name="git-pull-request-create" />
        <b>Opening pull requests</b>
        <span class="muted tabular">{done} / {prs.length}</span>
        <Elapsed />
      </div>
      <div class="fix-body">
        {prs.map((p) => (
          <section key={p.id} class="card progress-card" aria-label={`${p.repo} ${p.kind}`}>
            <header class="card-head">
              <span class="indent" />
              <Icon name={p.kind === 'coverage' ? 'beaker' : 'tools'} />
              <span class="card-title ellipsis">{p.repo}</span>
              <span class="muted">{p.kind === 'coverage' ? 'Coverage PR' : 'Fixes PR'}</span>
              {p.draft && <span class="tag">Draft</span>}
            </header>
            <ul class="tasks steps">
              {STEPS.map(({ step, label }) => {
                const s = p.steps[step];
                const icon = s ? STEP_ICON[s.status] : { icon: 'circle-outline', cls: 's-queued' };
                return (
                  <li key={step} class="task">
                    <span class={`status ${icon.cls}`} role="img" aria-label={s?.status ?? 'waiting'}>
                      <Icon name={icon.icon} spin={'spin' in icon && icon.spin} />
                    </span>
                    <span class="task-label ellipsis">{label(p)}</span>
                    <span class="task-detail ellipsis" title={s?.detail}>
                      {s?.detail && <span class={s.status === 'failed' ? 'err-text' : s.status === 'warning' ? 'warn' : 'muted mono'}>{s.detail}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
