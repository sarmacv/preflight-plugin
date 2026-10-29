import type { CheckMeta } from '../../shared/protocol';
import { catalog, excludedChecks, failuresOnly } from '../store';
import { Icon } from './Icon';

function setExcluded(ids: string[], exclude: boolean) {
  const next = new Set(excludedChecks.value);
  for (const id of ids) (exclude ? next.add(id) : next.delete(id));
  excludedChecks.value = next;
}

function Box({ state }: { state: 'on' | 'off' | 'mixed' }) {
  return (
    <span class={`check${state === 'off' ? '' : ' on'}`} aria-hidden="true">
      {state === 'on' && <Icon name="check" />}
      {state === 'mixed' && <Icon name="dash" />}
    </span>
  );
}

/** Which checks the next scan runs, and whether results show failures only. */
export function FilterMenu() {
  const groups = new Map<string, CheckMeta[]>();
  for (const c of catalog.value) groups.set(c.category, [...(groups.get(c.category) ?? []), c]);
  const excluded = excludedChecks.value;

  return (
    <div class="menu filter-menu">
      <div
        class="menu-item"
        role="menuitemcheckbox"
        aria-checked={failuresOnly.value}
        tabIndex={0}
        onClick={() => (failuresOnly.value = !failuresOnly.value)}
        onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), (failuresOnly.value = !failuresOnly.value))}
      >
        <Box state={failuresOnly.value ? 'on' : 'off'} />
        <span>Failures only</span>
      </div>
      <div class="menu-sep" />
      <div class="menu-head small">
        <span>Checks</span>
        <button type="button" class="link trail" disabled={excluded.size === 0} onClick={() => (excludedChecks.value = new Set())}>All</button>
      </div>
      <div class="filter-list" role="group" aria-label="Checks to run">
        {[...groups].map(([category, items]) => {
          const off = items.filter((c) => excluded.has(c.id)).length;
          const state = off === 0 ? 'on' : off === items.length ? 'off' : 'mixed';
          return (
            <div key={category}>
              <div
                class="menu-item cat"
                role="menuitemcheckbox"
                aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
                tabIndex={0}
                onClick={() => setExcluded(items.map((c) => c.id), state !== 'off')}
                onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), setExcluded(items.map((c) => c.id), state !== 'off'))}
              >
                <Box state={state} />
                <span class="ellipsis">{items[0].categoryName}</span>
              </div>
              {items.map((c) => (
                <div
                  key={c.id}
                  class="menu-item sub"
                  role="menuitemcheckbox"
                  aria-checked={!excluded.has(c.id)}
                  tabIndex={0}
                  title={c.name}
                  onClick={() => setExcluded([c.id], !excluded.has(c.id))}
                  onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), setExcluded([c.id], !excluded.has(c.id)))}
                >
                  <Box state={excluded.has(c.id) ? 'off' : 'on'} />
                  <span class="ellipsis">{c.name}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
