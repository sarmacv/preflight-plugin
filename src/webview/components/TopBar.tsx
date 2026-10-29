import { auth, checkCounts, selection, canScan, cancelScan, failuresOnly, popover, provider, providers, rateLimit, scanning, ssoBlockedOrgs, startScan } from '../store';
import { post } from '../vscode';
import { Icon, IconButton } from './Icon';
import { PROVIDER_META } from './providerMeta';
import { canFix, fixPhase, prepareFixes, primaryAction } from '../fixStore';

function openPopover(kind: 'model' | 'connection' | 'filter', e: MouseEvent) {
  const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
  popover.value = popover.value?.kind === kind ? undefined : { kind, anchor };
}

export function TopBar() {
  const a = auth.value;
  const signedIn = a.status === 'signedIn';
  const degraded = ssoBlockedOrgs.value.length > 0 || rateLimit.value?.state === 'waiting';
  const connLabel = signedIn
    ? `${a.user.login} · ${degraded ? 'Connected with limited org access' : 'Connected'}`
    : 'Not connected';
  const meta = PROVIDER_META[provider.value];

  return (
    <header class="topbar" role="toolbar" aria-label="Preflight">
      <button type="button" class="conn" title={connLabel} aria-label={connLabel} onClick={(e) => openPopover('connection', e)} disabled={!signedIn}>
        {signedIn ? <img src={a.user.avatarUrl} alt="" width={18} height={18} /> : <Icon name="account" />}
        <span class={`dot ${signedIn ? (degraded ? 'warn' : 'ok') : 'off'}`} />
      </button>

      <button
        type="button"
        class="model"
        title={`AI: ${meta.label}`}
        aria-label={`AI: ${meta.label}`}
        aria-haspopup="listbox"
        disabled={scanning.value || fixPhase.value !== 'idle' || providers.value.length === 0}
        onClick={(e) => openPopover('model', e)}
      >
        <Icon name={meta.icon} />
        <Icon name="chevron-down" class="chev" />
      </button>

      <span class="sep" />
      <IconButton
        icon="play"
        label={`Scan ${selection.value.size} repo${selection.value.size === 1 ? '' : 's'} · ${checkCounts.value.selected} of ${checkCounts.value.total} checks (Enter)`} primary={primaryAction.value === 'scan'} disabled={!canScan.value || fixPhase.value !== 'idle'} onClick={startScan} />
      <IconButton icon="debug-stop" label="Stop (Esc)" disabled={!scanning.value} onClick={cancelScan} />
      <IconButton icon="wand" label="Fix failed checks" primary={primaryAction.value === 'fix'} disabled={!canFix.value} onClick={() => prepareFixes()} />
      <span class="sep" />
      <IconButton icon="refresh" label="Refresh" disabled={a.status === 'checking' || scanning.value || fixPhase.value !== 'idle'} onClick={() => post({ type: 'refresh' })} />
      <IconButton
        icon={failuresOnly.value ? 'filter-filled' : 'filter'}
        label={failuresOnly.value ? 'Showing failures only' : 'Filter results'}
        class={failuresOnly.value ? 'active' : undefined}
        disabled={!signedIn}
        onClick={(e) => openPopover('filter', e)}
      />
      <span class="spacer" />
      <IconButton icon="settings-gear" label="Settings" onClick={() => post({ type: 'openSettings' })} />
    </header>
  );
}
