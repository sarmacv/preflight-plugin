// Simulated catalog and scan events for the harness.
window.harnessScan = (() => {
  const C = (id, name, category, categoryName, severity, evaluation = 'deterministic', fixable = true) => ({ id, name, category, categoryName, severity, evaluation, fixable, fixPr: id === 'test-coverage' ? 'coverage' : 'fixes' });
  const checks = [
    C('codeowners-present', 'CODEOWNERS present', 'ai-readiness', 'AI Readiness', 'high'),
    C('agent-instructions-present', 'Agent instructions present', 'ai-readiness', 'AI Readiness', 'medium'),
    C('agent-instructions-quality', 'Agent instructions have real content', 'ai-readiness', 'AI Readiness', 'medium', 'hybrid'),
    C('sonar-onboarded', 'Sonar onboarded', 'code-quality', 'Code Quality', 'high'),
    C('test-coverage', 'Test coverage meets threshold', 'code-quality', 'Code Quality', 'high'),
    C('readme-contributing', 'README and CONTRIBUTING present', 'repo-hygiene', 'Repo Hygiene', 'medium'),
    C('stale-branches', 'Stale branches', 'repo-hygiene', 'Repo Hygiene', 'low', 'deterministic', false),
    C('default-branch-protected', 'Default branch protected', 'branching-protection', 'Branching and Protection', 'critical', 'deterministic', false),
    C('vulnerable-dependencies', 'Vulnerable dependencies', 'dependencies-sbom', 'Dependencies and SBOM', 'high', 'deterministic', false),
    C('tech-standards', 'Engineering standards', 'tech-standards', 'Tech Standards', 'medium', 'ai', false),
    C('ci-pipeline-exists', 'CI pipeline exists', 'delivery', 'Delivery', 'high'),
  ];
  const outcome = {
    'codeowners-present': ['fail', 'None of CODEOWNERS, .github/CODEOWNERS, docs/CODEOWNERS found'],
    'agent-instructions-present': ['pass', 'Found AGENTS.md'],
    'agent-instructions-quality': ['fail', 'AGENTS.md: 212 characters (needs 400); 1 headings (needs 2)'],
    'sonar-onboarded': ['pass', 'Found sonar-project.properties'],
    'test-coverage': ['fail', 'Coverage 61.4% is below 80%'],
    'readme-contributing': ['fail', 'None of CONTRIBUTING.md, CONTRIBUTING, .github/CONTRIBUTING.md, docs/CONTRIBUTING.md found'],
    'stale-branches': ['pass', '2 of 14 branches have no commits in 90 days'],
    'default-branch-protected': ['fail', 'main has no branch protection or ruleset'],
    'vulnerable-dependencies': ['fail', '3 known vulnerabilities across 212 packages (from dependency graph)'],
    'tech-standards': ['skipped', 'Needs a model'],
    'ci-pipeline-exists': ['pass', 'Found .github/workflows/ci.yml'],
  };
  const W = { critical: 10, high: 5, medium: 2, low: 1 };
  function run(send, m) {
    const ids = m.checkIds ?? checks.map((c) => c.id);
    send({ type: 'scanStarted', targets: m.targets, checkIds: ids, rerun: !!m.rerun });
    let t = 100;
    m.targets.forEach((target, ri) => {
      const results = [];
      setTimeout(() => send({ type: 'repoStarted', repo: target.repo, branch: target.branch, checkIds: ids }), t);
      for (const id of ids) {
        const c = checks.find((x) => x.id === id);
        t += 60;
        setTimeout(() => send({ type: 'checkStarted', repo: target.repo, checkId: id }), t);
        t += 90;
        setTimeout(() => {
          let [status, msg] = outcome[id];
          if (ri > 0 && status === 'fail' && c.severity !== 'critical') status = 'pass';
          const r = { checkId: id, name: c.name, category: c.category, categoryName: c.categoryName, severity: c.severity, status, evidence: [{ message: msg, url: 'https://github.com/' + target.repo }, { message: 'Second evidence line with more detail.' }], fixable: c.fixable, fixPr: c.fixPr, durationMs: 40 };
          results.push(r);
          send({ type: 'checkDone', repo: target.repo, result: r });
        }, t);
      }
      t += 50;
      setTimeout(() => {
        const failures = { critical: 0, high: 0, medium: 0, low: 0 };
        let e = 0, p = 0;
        const cnt = { passed: 0, failed: 0, skipped: 0, errored: 0 };
        for (const r of results) {
          if (r.status === 'pass') { e += W[r.severity]; p += W[r.severity]; cnt.passed++; }
          else if (r.status === 'fail') { p += W[r.severity]; failures[r.severity]++; cnt.failed++; }
          else cnt.skipped++;
        }
        send({ type: 'repoDone', repo: target.repo, score: { score: p ? Math.round((e / p) * 100) : 100, verdict: failures.critical + failures.high ? 'grounded' : 'cleared', failures, ...cnt } });
      }, t);
    });
    setTimeout(() => send({ type: 'scanFinished', cancelled: false }), t + 50);
  }
  return { checks, run };
})();
