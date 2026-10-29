// Line diff (Myers) for the fix preview. Shared by host tests and the webview.

export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number };

export function diffLines(before: string, after: string): DiffOp[] {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? 0) < (vd.get(k + 1) ?? 0)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'same', text: a[x - 1], oldNo: x, newNo: y });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: 'add', text: b[y - 1], newNo: y });
      else ops.push({ kind: 'del', text: a[x - 1], oldNo: x });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface Hunk {
  ops: DiffOp[];
}

/** Groups a diff into hunks with `context` unchanged lines around each change. */
export function hunks(ops: DiffOp[], context = 3): Hunk[] {
  const out: Hunk[] = [];
  let current: DiffOp[] | undefined;
  let lastChange = -1;
  const trail = () => {
    if (current) for (let j = lastChange + 1; j < Math.min(ops.length, lastChange + 1 + context); j++) current.push(ops[j]);
  };
  ops.forEach((op, i) => {
    if (op.kind === 'same') return;
    if (current && i - lastChange <= context * 2) {
      for (let j = lastChange + 1; j < i; j++) current.push(ops[j]);
    } else {
      trail();
      current = [];
      out.push({ ops: current });
      for (let j = Math.max(0, i - context); j < i; j++) current.push(ops[j]);
    }
    current.push(op);
    lastChange = i;
  });
  trail();
  return out;
}
