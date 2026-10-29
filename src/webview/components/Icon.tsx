import type { JSX } from 'preact';

interface IconProps {
  name: string;
  spin?: boolean;
  class?: string;
}

export function Icon({ name, spin, class: cls }: IconProps) {
  return <i aria-hidden="true" class={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}${cls ? ` ${cls}` : ''}`} />;
}

interface IconButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'label' | 'icon'> {
  icon: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}

/** Icon-only button; the label is both the tooltip and the accessible name. */
export function IconButton({ icon, label, primary, class: cls, ...rest }: IconButtonProps) {
  return (
    <button type="button" class={`icon-btn${primary ? ' primary' : ''}${cls ? ` ${cls}` : ''}`} title={label} aria-label={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

interface EmptyProps {
  icon: string;
  label: string;
  detail?: string;
  action?: { label: string; onClick: () => void; primary?: boolean };
  spin?: boolean;
}

export function Empty({ icon, label, detail, action, spin }: EmptyProps) {
  return (
    <div class="empty" role="status" title={detail}>
      <Icon name={icon} spin={spin} />
      <span>{label}</span>
      {action && (
        <button type="button" class={`btn${action.primary ? ' primary' : ''}`} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
