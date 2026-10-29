import { useEffect, useRef, useState } from 'preact/hooks';
import type { RepoSummary } from '../../shared/protocol';
import {
  branchesEditable, clearSelection, orgFilter, owners, popover, repos, reposDone, reposError, requestBranches,
  search, selectAllVisible, selection, ssoBlockedOrgs, toggle, visibleRepos,
} from '../store';
import { post } from '../vscode';
import { Empty, Icon, IconButton } from './Icon';

const ROW = 22;
const OVERSCAN = 8;

export function RepoList() {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [active, setActive] = useState(0);
  const list = visibleRepos.value;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => setActive((i) => Math.min(i, Math.max(0, list.length - 1))), [list.length]);

  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(list.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);

  function focusRow(i: number) {
    const el = scroller.current;
    if (!el) return;
    setActive(i);
    const top = i * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }

  function onKeyDown(e: KeyboardEvent) {
    const r = list[active];
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(Math.min(list.length - 1, active + 1)); break;
      case 'ArrowUp': e.preventDefault(); focusRow(Math.max(0, active - 1)); break;
      case 'Home': e.preventDefault(); focusRow(0); break;
      case 'End': e.preventDefault(); focusRow(list.length - 1); break;
      case ' ': e.preventDefault(); if (r) toggle(r); break;
      case 'a':
        if (e.metaKey || e.ctrlKey) { e.preventDefault(); selectAllVisible(); }
        break;
    }
  }

  const loading = !reposDone.value;
  const selectedCount = selection.value.size;

  return (
    <aside class="repos" aria-label="Repositories">
      <div class="repos-tools">
        <div class="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search repos"
            placeholder="Search"
            value={search.value}
            onInput={(e) => (search.value = e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); scroller.current?.focus(); focusRow(0); }
              if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; }
            }}
          />
        </div>
        <select class="org" aria-label="Organization" title="Organization" value={orgFilter.value} onChange={(e) => (orgFilter.value = e.currentTarget.value)}>
          <option value="">All</option>
          {owners.value.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
      <div class="repos-sub">
        <IconButton icon="check-all" label="Select all shown" onClick={selectAllVisible} disabled={list.length === 0} />
        <IconButton icon="clear-all" label="Clear selection" onClick={clearSelection} disabled={selectedCount === 0} />
        <span class="count" title={`${selectedCount} selected of ${repos.value.length}`}>
          {selectedCount > 0 && <><b>{selectedCount}</b> / </>}
          {list.length}
        </span>
        {loading && <Icon name="loading" spin class="muted" />}
        {ssoBlockedOrgs.value.length > 0 && (
          <button
            type="button"
            class="link warn-chip"
            title={`SSO not authorized: ${ssoBlockedOrgs.value.map((o) => o.login).join(', ')}`}
            onClick={(e) => (popover.value = { kind: 'connection', anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
          >
            <Icon name="warning" /> {ssoBlockedOrgs.value.length}
          </button>
        )}
      </div>

      {reposError.value ? (
        <Empty icon="error" label={reposError.value.label} detail={reposError.value.detail}
          action={{ label: reposError.value.action?.label ?? 'Retry', onClick: () => post(reposError.value?.action?.command ?? { type: 'refresh' }) }} />
      ) : list.length === 0 && reposDone.value ? (
        <Empty icon="search" label={repos.value.length ? 'No match' : 'No repos'}
          action={repos.value.length ? { label: 'Clear', onClick: () => { search.value = ''; orgFilter.value = ''; } } : { label: 'Refresh', onClick: () => post({ type: 'refresh' }) }} />
      ) : (
        <div
          class="repo-scroll"
          ref={scroller}
          tabIndex={0}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Repositories"
          aria-activedescendant={list[active] ? `repo-${list[active].id}` : undefined}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onKeyDown={onKeyDown}
        >
          <div style={{ height: `${list.length * ROW}px`, position: 'relative' }}>
            {list.slice(start, end).map((r, i) => (
              <Row key={r.id} repo={r} index={start + i} active={start + i === active} onFocus={() => setActive(start + i)} />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function Row({ repo, index, active, onFocus }: { repo: RepoSummary; index: number; active: boolean; onFocus: () => void }) {
  const branch = selection.value.get(repo.fullName);
  const selected = branch !== undefined;
  const editable = selected && branchesEditable.value;
  const showOwner = !orgFilter.value;

  return (
    <div
      id={`repo-${repo.id}`}
      role="option"
      aria-selected={selected}
      class={`repo-row${selected ? ' selected' : ''}${active ? ' active' : ''}`}
      style={{ top: `${index * ROW}px` }}
      onClick={() => { onFocus(); toggle(repo); }}
      title={repo.fullName}
    >
      <span class={`check${selected ? ' on' : ''}`} aria-hidden="true">{selected && <Icon name="check" />}</span>
      <span class="name ellipsis">
        {showOwner && <span class="owner">{repo.owner}/</span>}
        {repo.name}
      </span>
      {repo.private && <Icon name="lock" class="muted small" />}
      {selected && (
        <button
          type="button"
          class={`chip${editable ? '' : ' locked'}`}
          disabled={!editable}
          title={editable ? `Branch: ${branch}` : `Branch: ${branch} (default)`}
          aria-label={`Branch for ${repo.fullName}: ${branch}`}
          onClick={(e) => {
            e.stopPropagation();
            requestBranches(repo.fullName);
            popover.value = { kind: 'branch', repo: repo.fullName, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() };
          }}
        >
          <Icon name="git-branch" />
          <span class="ellipsis">{branch}</span>
        </button>
      )}
    </div>
  );
}
