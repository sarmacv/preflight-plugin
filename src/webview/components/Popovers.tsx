import { useEffect, useRef, useState } from 'preact/hooks';
import { auth, branches, onlyOrg, orgFilter, owners, popover, provider, providers, repos, selection, setBranch, toggleOrg } from '../store';
import { post } from '../vscode';
import { FilterMenu } from './FilterMenu';
import { Icon } from './Icon';
import { ALL_PROVIDERS, PROVIDER_META } from './providerMeta';

const close = () => (popover.value = undefined);

export function Popovers() {
  const p = popover.value;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!p) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [p]);

  if (!p) return null;
  const maxLeft = window.innerWidth - (p.kind === 'filter' ? 300 : 260);
  const style = { top: `${p.anchor.bottom + 2}px`, left: `${Math.max(4, Math.min(p.anchor.left, maxLeft))}px` };

  return (
    <div class="popover" ref={ref} style={style}>
      {p.kind === 'model' && <ModelMenu />}
      {p.kind === 'connection' && <ConnectionMenu />}
      {p.kind === 'branch' && <BranchMenu repo={p.repo} />}
      {p.kind === 'filter' && <FilterMenu />}
      {p.kind === 'orgs' && <OrgMenu />}
    </div>
  );
}

function ModelMenu() {
  const available = providers.value;
  return (
    <ul role="listbox" aria-label="AI" class="menu">
      {ALL_PROVIDERS.map((id) => {
        const enabled = available.includes(id);
        const selected = provider.value === id;
        return (
          <li
            key={id}
            role="option"
            aria-selected={selected}
            aria-disabled={!enabled}
            tabIndex={enabled ? 0 : -1}
            class={`menu-item${enabled ? '' : ' disabled'}`}
            title={enabled ? PROVIDER_META[id].label : `${PROVIDER_META[id].label} isn't available`}
            onClick={() => enabled && pick(id)}
            onKeyDown={(e) => enabled && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(id))}
          >
            <Icon name={PROVIDER_META[id].icon} />
            <span>{PROVIDER_META[id].label}</span>
            {selected && <Icon name="check" class="trail" />}
          </li>
        );
      })}
    </ul>
  );

  function pick(id: (typeof ALL_PROVIDERS)[number]) {
    provider.value = id;
    post({ type: 'selectProvider', provider: id });
    close();
  }
}

function ConnectionMenu() {
  const a = auth.value;
  if (a.status !== 'signedIn') return null;
  const count = (login: string) => owners.value.find((o) => o.login === login)?.repos ?? 0;
  const show = (login: string) => {
    onlyOrg(login);
    close();
  };
  return (
    <div class="menu" role="dialog" aria-label="GitHub connection">
      <div class="menu-head">
        <img src={a.user.avatarUrl} alt="" width={20} height={20} />
        <span>{a.user.name ?? a.user.login}</span>
        <span class="muted">{a.user.login}</span>
      </div>
      {a.orgs.map((o) => (
        <div
          class="menu-item"
          key={o.login}
          role="button"
          tabIndex={0}
          title={o.restricted ? `${o.login} hasn't approved VS Code's GitHub sign-in, so its private repos are hidden` : o.authorized ? `Show ${o.login} repos` : 'SSO authorization needed before its repos are visible'}
          onClick={() => show(o.login)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), show(o.login))}
        >
          <Icon name={o.restricted ? 'shield' : o.authorized ? 'pass-filled' : 'warning'} class={o.authorized && !o.restricted ? 'ok' : 'warn'} />
          <span class="ellipsis">{o.login}</span>
          {o.restricted && o.requestUrl ? (
            <button
              type="button"
              class="link trail"
              title="Opens your authorized apps on GitHub: choose Visual Studio Code and request access for this organization"
              onClick={(e) => {
                e.stopPropagation();
                post({ type: 'openExternal', url: o.requestUrl! });
              }}
            >
              Request access
            </button>
          ) : !o.authorized && o.ssoUrl ? (
            <button
              type="button"
              class="link trail"
              onClick={(e) => {
                e.stopPropagation();
                post({ type: 'openExternal', url: o.ssoUrl! });
              }}
            >
              Authorize
            </button>
          ) : (
            <span class="muted trail tabular">{count(o.login)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Multi-select organization filter for the repo list. */
function OrgMenu() {
  const [q, setQ] = useState('');
  const picked = orgFilter.value;
  const all = owners.value;
  const shown = all.filter((o) => o.login.toLowerCase().includes(q.toLowerCase()));
  return (
    <div class="menu org-menu" role="dialog" aria-label="Organizations">
      {all.length > 6 && (
        <div class="search small">
          <Icon name="search" />
          <input autoFocus aria-label="Filter organizations" placeholder="Organization" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
      )}
      <div
        class="menu-item"
        role="menuitemcheckbox"
        aria-checked={picked.size === 0}
        tabIndex={0}
        onClick={() => (orgFilter.value = new Set())}
        onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), (orgFilter.value = new Set()))}
      >
        <span class={`check${picked.size === 0 ? ' on' : ''}`} aria-hidden="true">{picked.size === 0 && <Icon name="check" />}</span>
        <span>All</span>
        <span class="muted trail tabular">{repos.value.length}</span>
      </div>
      <div class="menu-sep" />
      <div class="org-list">
        {shown.map((o) => {
          const on = picked.has(o.login);
          return (
            <div
              key={o.login}
              class="menu-item"
              role="menuitemcheckbox"
              aria-checked={on}
              tabIndex={0}
              title={o.restricted ? `${o.login} hasn't approved VS Code's GitHub sign-in, so only its public repos are listed` : o.ssoUrl ? 'SSO authorization needed before its repos are visible' : o.login}
              onClick={() => toggleOrg(o.login)}
              onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), toggleOrg(o.login))}
            >
              <span class={`check${on ? ' on' : ''}`} aria-hidden="true">{on && <Icon name="check" />}</span>
              <Icon name={o.personal ? 'account' : 'organization'} class="muted" />
              <span class="ellipsis">{o.login}</span>
              {o.restricted && o.requestUrl ? (
                <button
                  type="button"
                  class="link trail"
                  title="Opens your authorized apps on GitHub: choose Visual Studio Code and request access for this organization"
                  onClick={(e) => {
                    e.stopPropagation();
                    post({ type: 'openExternal', url: o.requestUrl! });
                  }}
                >
                  Request access
                </button>
              ) : o.ssoUrl ? (
                <button
                  type="button"
                  class="link trail"
                  onClick={(e) => {
                    e.stopPropagation();
                    post({ type: 'openExternal', url: o.ssoUrl! });
                  }}
                >
                  Authorize
                </button>
              ) : (
                <span class="muted trail tabular">{o.repos}</span>
              )}
            </div>
          );
        })}
        {shown.length === 0 && (
          <div class="menu-item static muted">
            <Icon name="circle-slash" /> No match
          </div>
        )}
      </div>
    </div>
  );
}

function BranchMenu({ repo }: { repo: string }) {
  const [q, setQ] = useState('');
  const list = branches.value[repo];
  const current = selection.value.get(repo);
  const shown = Array.isArray(list) ? list.filter((b) => b.toLowerCase().includes(q.toLowerCase())).slice(0, 200) : [];

  return (
    <div class="menu branch-menu">
      <div class="search small">
        <Icon name="git-branch" />
        <input
          autoFocus
          aria-label="Filter branches"
          placeholder="Branch"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) {
              e.preventDefault();
              e.stopPropagation();
              choose(shown[0]);
            }
          }}
        />
      </div>
      {list === 'loading' || !list ? (
        <div class="menu-item static">
          <Icon name="loading" spin />
        </div>
      ) : (
        <ul role="listbox" aria-label="Branches" class="branch-list">
          {shown.map((b) => (
            <li
              key={b}
              role="option"
              aria-selected={b === current}
              tabIndex={0}
              class="menu-item"
              onClick={() => choose(b)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), e.stopPropagation(), choose(b))}
            >
              <span class="ellipsis">{b}</span>
              {b === current && <Icon name="check" class="trail" />}
            </li>
          ))}
          {shown.length === 0 && (
            <li class="menu-item static muted">
              <Icon name="circle-slash" /> No match
            </li>
          )}
        </ul>
      )}
    </div>
  );

  function choose(b: string) {
    setBranch(repo, b);
    close();
  }
}
