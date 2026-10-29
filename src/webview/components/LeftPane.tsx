import { checkCounts, leftTab, selection } from '../store';
import { ChecksPane } from './ChecksPane';
import { Icon } from './Icon';
import { RepoList } from './RepoList';

/** The left pane: which repos to scan, and which checks to run on them. */
export function LeftPane() {
  const tab = leftTab.value;
  const counts = checkCounts.value;
  const partial = counts.selected < counts.total;

  const select = (t: 'repos' | 'checks') => (leftTab.value = t);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = tab === 'repos' ? 'checks' : 'repos';
      select(next);
      document.getElementById(`tab-${next}`)?.focus();
    }
  };

  return (
    <aside class="repos" aria-label="Scan scope">
      <div class="tabs" role="tablist" aria-label="Scan scope">
        <button
          type="button"
          role="tab"
          id="tab-repos"
          aria-selected={tab === 'repos'}
          aria-controls="pane-repos"
          tabIndex={tab === 'repos' ? 0 : -1}
          class={`tab${tab === 'repos' ? ' on' : ''}`}
          title={`${selection.value.size} repo(s) selected`}
          aria-label={`Repos, ${selection.value.size} selected`}
          onClick={() => select('repos')}
          onKeyDown={onKey}
        >
          <Icon name="repo" /> Repos <span class="tab-count">{selection.value.size}</span>
        </button>
        <button
          type="button"
          role="tab"
          id="tab-checks"
          aria-selected={tab === 'checks'}
          aria-controls="pane-checks"
          tabIndex={tab === 'checks' ? 0 : -1}
          class={`tab${tab === 'checks' ? ' on' : ''}`}
          title={`${counts.selected} of ${counts.total} checks will run`}
          aria-label={`Checks, ${counts.selected} of ${counts.total} selected`}
          onClick={() => select('checks')}
          onKeyDown={onKey}
        >
          <Icon name="checklist" /> Checks{' '}
          <span class={`tab-count${partial ? ' partial' : ''}`}>
            {partial ? `${counts.selected}/${counts.total}` : counts.total}
          </span>
        </button>
      </div>
      {tab === 'repos' ? <RepoList /> : <ChecksPane />}
    </aside>
  );
}
