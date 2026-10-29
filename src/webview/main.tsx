import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import './styles.css';
import { AuthGate } from './components/AuthGate';
import { Popovers } from './components/Popovers';
import { RepoList } from './components/RepoList';
import { Results } from './components/Results';
import { FixView } from './components/FixView';
import { closeFixes, fixPhase, handleFixMessage } from './fixStore';
import { StatusStrip } from './components/StatusStrip';
import { TopBar } from './components/TopBar';
import { auth, canScan, cancelScan, handleHostMessage, popover, startScan } from './store';
import { onHostMessage, post } from './vscode';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON');
}

function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (popover.value) return;
      if (fixPhase.value !== 'idle') {
        if (e.key === 'Escape' && !isTyping(e.target) && (fixPhase.value === 'preparing' || fixPhase.value === 'done' || fixPhase.value === 'error')) closeFixes();
        return;
      }
      if (e.key === 'Escape') cancelScan();
      if (e.key === 'Enter' && !isTyping(e.target) && canScan.value) {
        e.preventDefault();
        startScan();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const signedIn = auth.value.status === 'signedIn';
  return (
    <div class="app">
      <TopBar />
      {signedIn ? (
        <div class="body">
          <RepoList />
          <main class="results" aria-label="Results">
            {fixPhase.value === 'idle' ? <Results /> : <FixView />}
          </main>
        </div>
      ) : (
        <AuthGate />
      )}
      <StatusStrip />
      <Popovers />
    </div>
  );
}

onHostMessage((m) => handleFixMessage(m) || handleHostMessage(m));
render(<App />, document.getElementById('app')!);
post({ type: 'ready' });
