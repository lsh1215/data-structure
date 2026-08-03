/* B-Tree / B+Tree 무결성 테스트 — node tests/btree.test.js */
'use strict';

const { BTree } = require('../assets/js/btree.js');

let pass = 0;
let fail = 0;

function check(cond, label) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ ' + label); }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const MODES = ['btree', 'bplus'];
const ORDERS = [3, 4, 5, 6, 7, 8];

/* ── 1. 랜덤 삽입 후 매 단계 무결성 ── */
for (const mode of MODES) {
  for (const order of ORDERS) {
    const rnd = mulberry32(order * 7919 + mode.length);
    const t = new BTree({ order, mode });
    const keys = shuffle([...Array(200).keys()].map((i) => i + 1), rnd);
    const seen = [];
    let bad = null;
    for (const k of keys) {
      t.insert(k);
      seen.push(k);
      const errs = t.validate();
      if (errs.length && !bad) bad = `insert ${k}: ${errs[0]}`;
    }
    check(!bad, `[${mode} m=${order}] 삽입 무결성 — ${bad}`);
    check(
      t.keysInOrder().join(',') === seen.slice().sort((a, b) => a - b).join(','),
      `[${mode} m=${order}] 삽입 후 정렬 순서 일치`
    );
    check(t.countKeys() === 200, `[${mode} m=${order}] 키 개수 200`);
  }
}

/* ── 2. 오름차순/내림차순 삽입 (분할 편향 최악 케이스) ── */
for (const mode of MODES) {
  for (const order of ORDERS) {
    for (const dir of ['asc', 'desc']) {
      const t = new BTree({ order, mode });
      const keys = [...Array(120).keys()].map((i) => i + 1);
      if (dir === 'desc') keys.reverse();
      let bad = null;
      for (const k of keys) {
        t.insert(k);
        const errs = t.validate();
        if (errs.length && !bad) bad = `${k}: ${errs[0]}`;
      }
      check(!bad, `[${mode} m=${order}] ${dir} 순차 삽입 무결성 — ${bad}`);
    }
  }
}

/* ── 3. 랜덤 삽입 + 삭제 혼합 ── */
for (const mode of MODES) {
  for (const order of ORDERS) {
    const rnd = mulberry32(order * 104729 + (mode === 'btree' ? 1 : 2));
    const t = new BTree({ order, mode });
    const set = new Set();
    let bad = null;
    for (let step = 0; step < 1200 && !bad; step++) {
      const k = 1 + Math.floor(rnd() * 150);
      if (rnd() < 0.55) {
        const r = t.insert(k);
        if (r.ok) set.add(k);
        else if (!set.has(k)) bad = `insert ${k} 가 이유 없이 거부됨`;
      } else {
        const r = t.remove(k);
        if (r.ok) {
          if (!set.has(k)) bad = `remove ${k} 가 없는 키를 지웠다고 보고`;
          set.delete(k);
        } else if (set.has(k)) bad = `remove ${k} 실패했지만 실제로는 존재`;
      }
      const errs = t.validate();
      if (errs.length && !bad) bad = `after ${k}: ${errs[0]}`;
      const expect = [...set].sort((a, b) => a - b).join(',');
      if (!bad && t.keysInOrder().join(',') !== expect) bad = `내용 불일치 (step ${step}, key ${k})`;
    }
    check(!bad, `[${mode} m=${order}] 삽입/삭제 혼합 1200회 — ${bad}`);
  }
}

/* ── 4. 검색 ── */
for (const mode of MODES) {
  const t = new BTree({ order: 4, mode });
  t.bulkLoad([...Array(80).keys()].map((i) => (i + 1) * 2)); // 짝수만
  let ok = true;
  for (let k = 1; k <= 160; k++) {
    const r = t.search(k);
    if (r.found !== (k % 2 === 0)) ok = false;
  }
  check(ok, `[${mode}] search 정확도 (짝수만 존재)`);
}

/* ── 5. B+Tree 범위 스캔 ── */
{
  const t = new BTree({ order: 5, mode: 'bplus' });
  const rnd = mulberry32(42);
  const keys = shuffle([...Array(300).keys()].map((i) => i + 1), rnd);
  t.bulkLoad(keys);
  let ok = true;
  for (const [lo, hi] of [[1, 300], [50, 90], [299, 400], [0, 3], [120, 120], [400, 500]]) {
    const r = t.rangeScan(lo, hi);
    const expect = keys.filter((k) => k >= lo && k <= hi).sort((a, b) => a - b);
    if (r.found.join(',') !== expect.join(',')) {
      ok = false;
      console.error(`   range ${lo}~${hi}: got ${r.found.length}, want ${expect.length}`);
    }
  }
  check(ok, '[bplus] rangeScan 결과 정확도');
}

/* ── 6. 스텝 스냅샷 일관성 ── */
{
  const t = new BTree({ order: 4, mode: 'bplus' });
  t.bulkLoad([10, 20, 30, 40, 50, 60, 70]);
  const r = t.insert(35);
  check(r.steps.length > 3, '[steps] 삽입 시 스텝이 여러 개 기록됨');
  check(r.steps.every((s) => s.tree && s.tree.nodes.length > 0), '[steps] 모든 스텝에 트리 스냅샷 존재');
  check(r.steps[r.steps.length - 1].kind === 'done', '[steps] 마지막 스텝은 done');
  const last = r.steps[r.steps.length - 1].tree;
  const ids = new Set(last.nodes.map((n) => n.id));
  check(last.nodes.every((n) => n.childIds.every((c) => ids.has(c))), '[steps] 자식 id 가 모두 스냅샷 안에 존재');
  check(last.nodes.every((n) => n.nextId === null || ids.has(n.nextId)), '[steps] next id 유효');
}

/* ── 7. 높이 이론 상·하한 검증 ──
   log_m(N+1) ≤ h ≤ log_t((N+1)/2) + 1,  t = ceil(m/2)          */
{
  let ok = true;
  for (const order of [3, 4, 6, 10]) {
    const t = new BTree({ order, mode: 'bplus' });
    const rnd = mulberry32(order);
    t.bulkLoad(shuffle([...Array(500).keys()].map((i) => i + 1), rnd));
    const N = t.countKeys();
    const h = t.height();
    const lower = Math.log(N + 1) / Math.log(order);
    const upper = Math.log((N + 1) / 2) / Math.log(Math.ceil(order / 2)) + 1;
    if (h < Math.floor(lower) || h > Math.ceil(upper) + 1) {
      ok = false;
      console.error(`   m=${order}: h=${h}, bounds [${lower.toFixed(2)}, ${upper.toFixed(2)}]`);
    }
  }
  check(ok, '[theory] 실제 높이가 이론 상·하한 안에 있음');
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILED'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
