/* Elasticsearch 역색인 테스트 — node tests/es.test.js */
'use strict';

const { InvertedIndex, SegmentEngine, analyze, stem } = require('../assets/js/es-index.js');

let pass = 0;
let fail = 0;
function check(cond, label) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ ' + label); }
}

/* ── 1. Analyzer ── */
{
  const a = analyze('<p>The Quick Brown Foxes are RUNNING</p>');
  check(!a.char.includes('<p>'), 'char filter 가 태그를 제거');
  check(a.token.length === 6, `tokenizer 6토큰 (got ${a.token.length})`);
  check(a.lower.every((t) => t === t.toLowerCase()), 'lowercase 적용');
  check(!a.stop.includes('the') && !a.stop.includes('are'), '불용어 the/are 제거');
  check(a.stem.includes('fox'), 'foxes → fox 스테밍');
  check(a.stem.includes('runn') || a.stem.includes('running'), 'running 처리');
  check(stem('searches') === 'search', 'searches → search');
  check(stem('is') === 'is', 'is 는 그대로');
}

/* ── 2. 색인 & posting list ── */
{
  const ix = new InvertedIndex();
  ix.addDocument('Redis is an in-memory database');
  ix.addDocument('Elasticsearch is a search engine built on Lucene');
  ix.addDocument('A database index uses a B+Tree structure');

  check(ix.N === 3, '문서 3개');
  check(ix.terms.has('databas') || ix.terms.has('database'), 'database term 존재');
  const dbTerm = ix.terms.has('databas') ? 'databas' : 'database';
  check(ix.terms.get(dbTerm).size === 2, 'database 가 2개 문서에 등장 (df=2)');
  check(ix.validate().length === 0, '색인 무결성: ' + ix.validate().join(' / '));

  const snap = ix.snapshot();
  const sorted = snap.terms.map((t) => t.term);
  check(sorted.join(',') === sorted.slice().sort().join(','), 'term dictionary 는 정렬 상태');
  check(snap.terms.every((t) => t.df === t.postings.length), 'df == posting list 길이');
  check(snap.terms.every((t) => t.postings.every((p, i, arr) => i === 0 || arr[i - 1].doc < p.doc)),
    'posting list 는 문서 ID 오름차순');
}

/* ── 3. tf / positions ── */
{
  const ix = new InvertedIndex();
  ix.addDocument('cache cache cache miss');
  const p = ix.terms.get('cach') || ix.terms.get('cache');
  const e = p.get(0);
  check(e.tf === 3, `tf = 3 (got ${e.tf})`);
  check(e.positions.length === 3, 'positions 3개');
  check(ix.validate().length === 0, 'tf/positions 무결성');
}

/* ── 4. 검색 (AND / OR) ── */
{
  const ix = new InvertedIndex();
  ix.bulk([
    'redis hash table bucket',
    'redis sorted set skiplist',
    'postgres btree index page',
    'redis cluster hash slot',
  ]);

  const steps = ix.search('redis hash', 'AND');
  const done = steps[steps.length - 1];
  const ranked = done.deco.ranked;
  check(!!ranked, 'AND 검색이 ranked 결과를 낸다');
  check(ranked.length === 2, `redis AND hash → 2건 (got ${ranked && ranked.length})`);
  check(ranked.every((r) => [0, 3].includes(r.doc)), '문서 0, 3 이 매칭');

  const or = ix.search('skiplist btree', 'OR');
  const orDone = or[or.length - 1];
  check(orDone.deco.ranked.length === 2, 'OR 검색 2건');

  const none = ix.search('mongodb', 'AND');
  check(none[none.length - 1].kind === 'miss', '없는 term 은 miss');
}

/* ── 5. BM25 ── */
{
  const ix = new InvertedIndex();
  ix.bulk([
    'redis redis redis',                       // tf 높음, 짧은 문서
    'redis is a database and a very very long document about many other things here',
    'postgres database',
  ]);
  const t = ix.terms.has('redi') ? 'redi' : 'redis';
  const s0 = ix.scoreDoc(0, [t]).score;
  const s1 = ix.scoreDoc(1, [t]).score;
  check(s0 > s1, 'tf 가 높고 짧은 문서가 더 높은 점수 (' + s0.toFixed(3) + ' > ' + s1.toFixed(3) + ')');

  const dbT = ix.terms.has('databas') ? 'databas' : 'database';
  const idfRedis = Math.log(1 + (3 - ix.terms.get(t).size + 0.5) / (ix.terms.get(t).size + 0.5));
  const idfDb = Math.log(1 + (3 - ix.terms.get(dbT).size + 0.5) / (ix.terms.get(dbT).size + 0.5));
  check(Math.abs(idfRedis - idfDb) < 1e-9, '같은 df 면 같은 idf');

  /* 흔한 term 은 idf 가 낮아야 한다 */
  const ix2 = new InvertedIndex();
  ix2.bulk(['x common', 'y common', 'z common', 'w rare']);
  const idfCommon = Math.log(1 + (4 - 3 + 0.5) / (3 + 0.5));
  const idfRare = Math.log(1 + (4 - 1 + 0.5) / (1 + 0.5));
  check(idfRare > idfCommon, '희귀 term 의 idf 가 더 크다');
  check(idfCommon > 0, 'idf 는 항상 양수 (BM25+ 보정식)');
}

/* ── 6. 대량 색인 무결성 ── */
{
  const ix = new InvertedIndex();
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  for (let i = 0; i < 120; i++) {
    const n = 3 + (i % 6);
    const txt = Array.from({ length: n }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ');
    ix.addDocument(txt);
  }
  check(ix.N === 120, '120 문서 색인');
  check(ix.validate().length === 0, '대량 색인 무결성: ' + ix.validate().slice(0, 2).join(' / '));
  const snap = ix.snapshot();
  check(snap.terms.every((t) => t.postings.every((p) => p.tf > 0)), '모든 tf > 0');
  check(Math.abs(snap.avgdl - ix.avgdl) < 1e-9, 'avgdl 계산 일치');
}

/* ── 7. 세그먼트 라이프사이클 ── */
{
  const se = new SegmentEngine();
  se.index(3);
  check(se.buffer.length === 3 && se.segments.length === 0, '색인 직후에는 버퍼에만 있고 세그먼트는 없다');
  se.refresh();
  check(se.buffer.length === 0 && se.segments.length === 1, 'refresh 후 세그먼트 1개');
  check(se.translog.length === 3, 'refresh 는 translog 를 비우지 않는다');
  se.flush();
  check(se.translog.length === 0, 'flush 가 translog 를 비운다');

  se.index(2); se.refresh();
  se.index(2); se.refresh();
  check(se.segments.length === 3, '세그먼트 3개 누적');
  se.deleteDoc();
  check(se.segments[0].deleted.length === 1, '삭제는 .del 표시만');
  const beforeDocs = se.segments.reduce((a, s) => a + s.docs.length, 0);
  se.merge();
  check(se.segments.length === 1, '병합 후 세그먼트 1개');
  check(se.segments[0].docs.length === beforeDocs - 1, '병합 시 삭제 문서가 실제로 제거됨');
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILED'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
