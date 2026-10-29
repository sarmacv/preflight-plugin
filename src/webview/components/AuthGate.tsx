import { auth } from '../store';
import { post } from '../vscode';
import { Empty } from './Icon';

const logo = document.getElementById('app')?.dataset.logo;

export function AuthGate() {
  const a = auth.value;
  return (
    <main class="gate">
      {logo && <img class="gate-logo" src={logo} alt="Preflight" width={72} height={72} />}
      {a.status === 'checking' && <Empty icon="loading" spin label="Connecting" />}
      {a.status === 'signedOut' && (
        <button type="button" class="btn primary large" onClick={() => post({ type: 'signIn' })} autoFocus>
          <i class="codicon codicon-github" aria-hidden="true" /> Sign in to GitHub
        </button>
      )}
      {a.status === 'error' && (
        <Empty
          icon="error"
          label={a.error.label}
          detail={a.error.detail}
          action={a.error.action && { label: a.error.action.label, onClick: () => post(a.error.action!.command), primary: true }}
        />
      )}
    </main>
  );
}
