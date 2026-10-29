// Fakes the extension host so the webview can be previewed in a plain browser.
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('theme') === 'light') document.documentElement.classList.add('light');
  const send = (m) => window.postMessage(m, '*');
  const orgs = ['acme', 'acme-platform', 'acme-data'];
  const names = ['api-gateway', 'billing-service', 'checkout-web', 'design-system', 'events-pipeline', 'identity', 'infra-terraform',
    'ml-feature-store', 'mobile-app', 'notifications', 'payments-core', 'search-indexer', 'shared-config', 'docs-site', 'helm-charts'];
  let id = 1;
  const repos = orgs.flatMap((o) => names.map((n) => ({ id: id++, fullName: `${o}/${n}`, owner: o, name: n, private: id % 3 !== 0,
    defaultBranch: id % 4 === 0 ? 'develop' : 'main', pushedAt: null, canPush: true })));

  window.acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState: () => {},
    postMessage: (m) => {
      if (m.type === 'ready') {
        if (params.get('auth') === 'out') return send({ type: 'auth', auth: { status: 'signedOut' } });
        send({ type: 'providers', available: ['copilot', 'claude'], selected: 'copilot' });
        send({ type: 'catalog', checks: window.harnessScan.checks, errors: [] });
        send({ type: 'auth', auth: { status: 'checking' } });
        // Repos sent before the connection is verified must be ignored by the webview.
        send({ type: 'repos', repos: repos.slice(0, 3), done: true, reset: true });
        setTimeout(() => connect(), 800);
      }
      if (m.type === 'scan') window.harnessScan.run(send, m);
      window.harnessFix(send, m);
      if (m.type === 'loadBranches') setTimeout(() => send({ type: 'branches', repo: m.repo, branches: ['main', 'develop', 'release/2.4', 'feature/sso-login'] }), 200);
    },
  });

  function connect() {
        send({ type: 'auth', auth: { status: 'signedIn', user: { login: 'vchunduri', name: 'V Chunduri', avatarUrl: '../../media/icon.png' },
          orgs: orgs.map((o) => ({ login: o, authorized: o !== 'acme-data', ssoUrl: `https://github.com/orgs/${o}/sso` })) } });
        send({ type: 'repos', repos: repos.slice(0, 30), done: false, reset: true });
        setTimeout(() => send({ type: 'repos', repos: repos.slice(30), done: true, reset: false }), 300);
        send({ type: 'rateLimit', rateLimit: { state: 'ok', remaining: 4821, limit: 5000, reset: Date.now() / 1000 + 1800 } });
  }
})();
