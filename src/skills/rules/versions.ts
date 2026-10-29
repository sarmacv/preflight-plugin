// Minimal version comparison for GitHub Advisory DB ranges such as "< 4.17.21" or ">= 1.0.0, < 1.2.3".

function parts(v: string): (number | string)[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    // A numeric part sorts after a pre-release tag (1.0.0 > 1.0.0-beta).
    if (typeof x === 'number') return 1;
    if (typeof y === 'number') return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function inRange(version: string, range: string): boolean {
  return range.split(',').every((clause) => {
    const m = /^\s*(<=|>=|<|>|=)?\s*(\S+)\s*$/.exec(clause);
    if (!m) return false;
    const c = compareVersions(version, m[2]);
    switch (m[1] ?? '=') {
      case '<': return c < 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '>=': return c >= 0;
      default: return c === 0;
    }
  });
}
