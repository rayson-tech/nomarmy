// Hirschberg's line LCS bounds memory even for large replacements.
// Trim shared edges at each split to keep sparse edits cheap.
export function lineDiff(before, after) {
  const out = [];
  const emit = (prefix, lines) => { for (const text of lines) out.push({ prefix, text }); };
  const scores = (a, b) => {
    let row = new Uint32Array(b.length + 1);
    for (const line of a) {
      const next = new Uint32Array(b.length + 1);
      for (let j = 0; j < b.length; j++) next[j + 1] = line === b[j] ? row[j] + 1 : Math.max(row[j + 1], next[j]);
      row = next;
    }
    return row;
  };
  const visit = (a, b) => {
    let head = 0, tail = 0;
    while (head < Math.min(a.length, b.length) && a[head] === b[head]) head++;
    while (tail < Math.min(a.length, b.length) - head && a[a.length - tail - 1] === b[b.length - tail - 1]) tail++;
    emit(" ", a.slice(0, head));
    const suffix = a.slice(a.length - tail);
    a = a.slice(head, a.length - tail);
    b = b.slice(head, b.length - tail);
    const names = new Set(a);
    if (!a.length || !b.length || !b.some(line => names.has(line))) {
      emit("-", a); emit("+", b);
    } else if (a.length === 1) {
      const at = b.indexOf(a[0]);
      emit("+", b.slice(0, at)); emit(" ", a); emit("+", b.slice(at + 1));
    } else {
      const mid = Math.floor(a.length / 2);
      const left = scores(a.slice(0, mid), b);
      const right = scores(a.slice(mid).reverse(), [...b].reverse());
      let split = 0, best = -1;
      for (let j = 0; j <= b.length; j++) {
        const score = left[j] + right[b.length - j];
        if (score > best) { best = score; split = j; }
      }
      visit(a.slice(0, mid), b.slice(0, split));
      visit(a.slice(mid), b.slice(split));
    }
    emit(" ", suffix);
  };
  visit(before, after);
  return out;
}

