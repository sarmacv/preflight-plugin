import { useState } from 'preact/hooks';
import type { CheckMeta } from '../../shared/protocol';
import { catalog, checkCounts, excludedChecks, setChecksExcluded, startScan } from '../store';

/** Checkbox convention: Space toggles, Enter scans (as everywhere else in the panel). */
const enterScans = (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    startScan();
  }
};
import { Empty, Icon, IconButton } from './Icon';

type BoxState = 'on' | 'off' | 'mixed';

function Box({ state }: { state: BoxState }) {
  return (
    <span class={`check${state === 'off' ? '' : ' on'}`} aria-hidden="true">
      {state === 'on' && <Icon name="check" />}
      {state === 'mixed' && <Icon name="dash" />}
    </span>
  );
}

/** Choose which checks the next scan (and card re-runs) execute. */
export function ChecksPane() {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const excluded = excludedChecks.value;
  const counts = checkCounts.value;
  const q = query.trim().toLowerCase();

  const groups = new Map<string, CheckMeta[]>();
  for (const c of catalog.value) {
    if (q && !`${c.name} ${c.categoryName} ${c.id} ${c.severity}`.toLowerCase().includes(q)) continue;
    groups.set(c.category, [...(groups.get(c.category) ?? []), c]);
  }
  const shownIds = [...groups.values()].flat().map((c) => c.id);

  const toggleCollapse = (category: string) => {
    const next = new Set(collapsed);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    setCollapsed(next);
  };

  return (
    <div class="pane" role="tabpanel" id="pane-checks" aria-labelledby="tab-checks">
      <div class="repos-tools">
        <div class="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search checks"
            placeholder="Search"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
        </div>
      </div>
      <div class="repos-sub">
        <IconButton icon="check-all" label={q ? 'Select all shown checks' : 'Select all checks'} disabled={shownIds.every((id) => !excluded.has(id))} onClick={() => setChecksExcluded(shownIds, false)} />
        <IconButton icon="clear-all" label={q ? 'Clear shown checks' : 'Clear all checks'} disabled={shownIds.every((id) => excluded.has(id))} onClick={() => setChecksExcluded(shownIds, true)} />
        <span class="count" title={`${counts.selected} of ${counts.total} checks will run`}>
          <b>{counts.selected}</b> / {counts.total}
        </span>
      </div>

      {shownIds.length === 0 ? (
        <Empty icon="search" label="No match" action={{ label: 'Clear', onClick: () => setQuery('') }} />
      ) : (
        <div class="check-scroll" role="tree" aria-label="Checks to run" aria-multiselectable="true">
          {[...groups].map(([category, items]) => {
            const off = items.filter((c) => excluded.has(c.id)).length;
            const state: BoxState = off === 0 ? 'on' : off === items.length ? 'off' : 'mixed';
            const open = q !== '' || !collapsed.has(category);
            const ids = items.map((c) => c.id);
            return (
              <div key={category} role="group">
                <div class="pick-row cat" role="treeitem" aria-expanded={open} aria-selected={state === 'on'}>
                  <button type="button" class="pick-twisty" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => toggleCollapse(category)}>
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                  </button>
                  <button
                    type="button"
                    class="pick"
                    role="checkbox"
                    aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
                    onClick={() => setChecksExcluded(ids, state !== 'off')}
                    onKeyDown={enterScans}
                  >
                    <Box state={state} />
                    <span class="ellipsis">{items[0].categoryName}</span>
                    <span class="muted count-pair">{items.length - off}/{items.length}</span>
                  </button>
                </div>
                {open &&
                  items.map((c) => {
                    const on = !excluded.has(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        class="pick pick-row sub"
                        role="checkbox"
                        aria-checked={on}
                        title={c.name}
                        onClick={() => setChecksExcluded([c.id], on)}
                        onKeyDown={enterScans}
                      >
                        <Box state={on ? 'on' : 'off'} />
                        <span class="ellipsis">{c.name}</span>
                        {c.evaluation !== 'deterministic' && (
                          <span class="ai-tag" title={c.evaluation === 'ai' ? 'Reviewed by AI' : 'Rules, then AI review'}>
                            <Icon name="sparkle" />
                          </span>
                        )}
                        <span class={`sev sev-${c.severity}`}>{c.severity}</span>
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
