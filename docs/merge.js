// 두 기기가 같은 메모를 따로 고쳤을 때 '충돌 사본'을 만들지 않고 한 메모로 합친다 (오너 2026-11-15)
// 3-way 병합: 공통 원본(base)에서 각자 바뀐 부분만 합친다.
//  - 문단(최상위 블록) 단위로 먼저 합치고, 같은 문단을 둘 다 고쳤으면 그 문단 안에서 낱말·태그 단위로 다시 합친다.
//  - 그래도 겹치면(같은 낱말을 서로 다르게 고침) 두 문단을 차례로 다 남긴다 → 어떤 경우에도 내용이 사라지지 않는다.
//  - 공통 원본을 모르면(base == null) 양쪽 내용을 순서대로 모두 남긴다(합집합).
const Merge = (() => {
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

  // x 의 각 항목이 y 의 몇 번째와 짝인지 (최장 공통 부분열). 앞뒤 공통 부분은 잘라 내고 가운데만 계산한다.
  function lcsMap(x, y) {
    const m = new Array(x.length).fill(-1);
    let s = 0;
    while (s < x.length && s < y.length && x[s] === y[s]) { m[s] = s; s++; }
    let ex = x.length, ey = y.length;
    while (ex > s && ey > s && x[ex - 1] === y[ey - 1]) { ex--; ey--; m[ex] = ey; }
    const n = ex - s, k = ey - s;
    if (!n || !k || n * k > 4e6) return m; // 너무 크면 가운데는 짝 없음(→ 양쪽 다 남김)
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(k + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--)
      L[i][j] = x[s + i] === y[s + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    for (let i = 0, j = 0; i < n && j < k;) {
      if (x[s + i] === y[s + j]) { m[s + i] = s + j; i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
    }
    return m;
  }

  // 공통 원본 없이 두 목록을 순서대로 합친다 (공통 항목은 한 번만)
  function union(a, b) {
    const m = lcsMap(a, b), out = [];
    let j = 0;
    a.forEach((v, i) => { if (m[i] >= 0) { while (j < m[i]) out.push(b[j++]); j++; } out.push(v); });
    while (j < b.length) out.push(b[j++]);
    return out;
  }

  // 3-way 병합. resolve(a구간, b구간, base구간) 이 null 이면 겹침.
  function merge3(base, a, b, resolve) {
    const ma = lcsMap(base, a), mb = lcsMap(base, b), out = [];
    let i = 0, ja = 0, jb = 0, clean = true;
    for (;;) {
      let k = i;
      while (k < base.length && !(ma[k] >= ja && mb[k] >= jb)) k++;
      const ea = k < base.length ? ma[k] : a.length, eb = k < base.length ? mb[k] : b.length;
      const A = a.slice(ja, ea), B = b.slice(jb, eb), O = base.slice(i, k);
      if (same(A, B) || same(B, O)) out.push(...A);
      else if (same(A, O)) out.push(...B);
      else {
        const r = resolve && resolve(A, B, O);
        if (r) out.push(...r); else { clean = false; out.push(...union(A, B)); }
      }
      if (k >= base.length) break;
      out.push(base[k]);
      i = k + 1; ja = ea + 1; jb = eb + 1;
    }
    return { out, clean };
  }

  function blocks(html) {
    const t = document.createElement('template');
    t.innerHTML = html || '';
    const d = document.createElement('div');
    return [...t.content.childNodes].map(n => { d.replaceChildren(n.cloneNode(true)); return d.innerHTML; }).filter(Boolean);
  }
  const tokens = s => s.match(/<[^>]*>|[^<\s]+|\s+/g) || [];

  // 같은 문단(들)을 둘 다 고쳤을 때: 그 구간 안에서 낱말·태그 단위로 합쳐 본다 (문단 수가 달라져도)
  function inBlock(A, B, O) {
    // 같은 자리에 둘 다 '덧붙이기'만 했으면 이긴 쪽 다음에 다른 쪽을 이어 붙인다 (예: 같은 줄 끝에 각자 추가)
    const m = merge3(tokens(O.join('')), tokens(A.join('')), tokens(B.join('')), (a, b, o) => (o.length ? null : [...a, ...b]));
    return m.clean ? [m.out.join('')] : null;
  }

  // a = 이긴 쪽(더 최근), b = 다른 쪽. base 는 둘이 갈라진 원본 html (모르면 null)
  function html(base, a, b) {
    a = a || ''; b = b || '';
    if (a === b) return a;
    const A = blocks(a), B = blocks(b);
    if (base == null) return union(A, B).join('');
    return merge3(blocks(base), A, B, inBlock).out.join('');
  }
  return { html, _test: { merge3, union, tokens } };
})();
