import { auth, checkCounts, leftTab, queueProgress, rateLimit, reposDone, scanning, selection } from '../store';
import { Icon } from './Icon';

const RATE_ICON = { ok: 'pulse', low: 'warning', waiting: 'watch' } as const;

export function StatusStrip() {
  const rl = rateLimit.value;
  const reset = rl?.reset ? new Date(rl.reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const rlLabel = rl
    ? `GitHub API ${rl.state === 'waiting' ? 'rate limited, waiting' : rl.state === 'low' ? 'budget low' : 'OK'} · ${rl.remaining.toLocaleString()} / ${rl.limit.toLocaleString()} · resets ${reset}`
    : 'GitHub API';

  return (
    <footer class="strip">
      {auth.value.status === 'signedIn' && (
      <span class="strip-left">
        <span class="strip-item" title={`${selection.value.size} repo(s) selected`}>
          <Icon name="repo" />
          <span>{selection.value.size}</span>
        </span>
        <button
          type="button"
          class="strip-item strip-btn"
          title={`${checkCounts.value.selected} of ${checkCounts.value.total} checks selected`}
          onClick={() => (leftTab.value = 'checks')}
        >
          <Icon name="checklist" />
          <span>{checkCounts.value.selected}/{checkCounts.value.total}</span>
        </button>
        {queueProgress.value.total > 0 && (
          <span class="strip-item" title={`${queueProgress.value.finished} of ${queueProgress.value.total} repos scanned`}>
            {scanning.value ? <Icon name="loading" spin /> : <Icon name="pass" />}
            <span>{queueProgress.value.finished} / {queueProgress.value.total}</span>
            {scanning.value && (
              <span class="progress determinate small" role="progressbar" aria-valuenow={queueProgress.value.finished} aria-valuemax={queueProgress.value.total} aria-label="Scan progress">
                <span style={{ width: `${(queueProgress.value.finished / queueProgress.value.total) * 100}%` }} />
              </span>
            )}
          </span>
        )}
        {auth.value.status === 'signedIn' && !reposDone.value && <span class="progress indeterminate" role="progressbar" aria-label="Loading repos" />}
      </span>
      )}
      <span class="spacer" />
      <span class={`rate ${rl?.state ?? 'ok'}`} title={rlLabel} aria-label={rlLabel} role="img">
        <Icon name={RATE_ICON[rl?.state ?? 'ok']} />
        {rl && rl.state !== 'ok' && <span>{rl.remaining.toLocaleString()}</span>}
      </span>
    </footer>
  );
}
