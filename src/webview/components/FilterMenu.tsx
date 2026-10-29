import { failuresOnly } from '../store';
import { Icon } from './Icon';

/** Result filtering. Choosing which checks run lives in the Checks tab of the left pane. */
export function FilterMenu() {
  const toggle = () => (failuresOnly.value = !failuresOnly.value);
  return (
    <div class="menu filter-menu">
      <div
        class="menu-item"
        role="menuitemcheckbox"
        aria-checked={failuresOnly.value}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), toggle())}
      >
        <span class={`check${failuresOnly.value ? ' on' : ''}`} aria-hidden="true">{failuresOnly.value && <Icon name="check" />}</span>
        <span>Failures only</span>
      </div>
    </div>
  );
}
