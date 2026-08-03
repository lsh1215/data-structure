/* Redis dict 무결성 테스트 — node tests/redis.test.js */
'use strict';

const { RedisDict, fnv1a, encodingOf } = require('../assets/js/redis-dict.js');

let pass = 0;
let fail = 0;
function check(cond, label) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ ' + label); }
}

/* ── 1. 기본 SET/GET/DEL ── */
{
  const d = new RedisDict(4);
  d.set('user:1', 'sanghun');
  d.set('user:2', 'kim');
  check(d.findEntry('user:1').entry.val === 'sanghun', 'SET 후 조회 가능');
  d.set('user:1', 'lee');
  check(d.findEntry('user:1').entry.val === 'lee', '같은 키 SET 은 값만 교체');
  check(d.ht[0].used + (d.ht[1] ? d.ht[1].used : 0) === 2, '중복 SET 은 used 를 늘리지 않음');
  d.del('user:2');
  check(d.findEntry('user:2') === null, 'DEL 후 조회 불가');
  check(d.validate().length === 0, '기본 연산 후 무결성: ' + d.validate().join(' / '));
}

/* ── 2. 확장 & 점진적 리해싱 ── */
{
  const d = new RedisDict(4);
  let bad = null;
  for (let i = 0; i < 200; i++) {
    d.set('k' + i, 'v' + i);
    const errs = d.validate();
    if (errs.length && !bad) bad = `set k${i}: ${errs[0]}`;
  }
  check(!bad, '연속 삽입 중 매 단계 무결성 — ' + bad);
  check(d.stats.expands > 0, '확장이 실제로 발생함 (expands=' + d.stats.expands + ')');

  d.rehashAll();
  check(!d.rehashing, 'rehashAll 후 리해싱 종료');
  check(d.ht[1] === null, '리해싱 종료 후 ht[1] 해제');
  check(d.ht[0].used === 200, '모든 엔트리 보존 (used=' + d.ht[0].used + ')');

  let allFound = true;
  for (let i = 0; i < 200; i++) if (!d.findEntry('k' + i)) allFound = false;
  check(allFound, '리해싱 후에도 모든 키 조회 가능');
  check((d.ht[0].size & (d.ht[0].size - 1)) === 0, '테이블 크기는 2의 거듭제곱 (' + d.ht[0].size + ')');
  check(d.ht[0].size >= 200, '테이블이 충분히 커짐');
}

/* ── 3. 리해싱 도중 조회/삽입/삭제 ── */
{
  const d = new RedisDict(4);
  for (let i = 0; i < 40; i++) d.set('a' + i, i);
  check(d.rehashing, '점진적 리해싱이 진행 중인 상태를 만들 수 있음');

  let ok = true;
  for (let i = 0; i < 40; i++) if (!d.findEntry('a' + i)) ok = false;
  check(ok, '리해싱 중에도 두 테이블을 모두 뒤져 조회 성공');

  d.get('a5');
  d.set('mid', 'x');
  const f = d.findEntry('mid');
  check(f && f.t === 1, '리해싱 중 새 엔트리는 ht[1] 에만 삽입된다');

  d.del('a0');
  check(d.findEntry('a0') === null, '리해싱 중 삭제 동작');
  check(d.validate().length === 0, '리해싱 중 연산 후 무결성: ' + d.validate().join(' / '));
}

/* ── 4. 삭제로 인한 축소 ── */
{
  const d = new RedisDict(4);
  for (let i = 0; i < 300; i++) d.set('s' + i, i);
  d.rehashAll();
  const bigSize = d.ht[0].size;
  for (let i = 0; i < 295; i++) { d.del('s' + i); d.rehashAll(); }
  check(d.ht[0].size < bigSize, `삭제가 누적되면 축소된다 (${bigSize} → ${d.ht[0].size})`);
  check(d.validate().length === 0, '축소 후 무결성');
  check(d.keys().length === 5, '남은 키 5개');
}

/* ── 5. 버킷 인덱스가 항상 hash & sizemask ── */
{
  const d = new RedisDict(8);
  for (let i = 0; i < 60; i++) d.set('key:' + i, i);
  let ok = true;
  for (let t = 0; t <= 1; t++) {
    const tab = d.ht[t];
    if (!tab) continue;
    tab.buckets.forEach((b, i) => b.forEach((e) => {
      if ((fnv1a(e.key) & tab.sizemask) !== i) ok = false;
    }));
  }
  check(ok, '모든 엔트리가 hash & sizemask 위치에 있음');
}

/* ── 6. 인코딩 판정 ── */
{
  check(encodingOf('12345').enc === 'int', 'int 인코딩');
  check(encodingOf('hello').enc === 'embstr', 'embstr 인코딩 (44B 이하)');
  check(encodingOf('x'.repeat(45)).enc === 'raw', 'raw 인코딩 (45B 이상)');
  check(encodingOf('x'.repeat(44)).enc === 'embstr', '경계값 44B 는 embstr');
}

/* ── 7. 스텝 기록 ── */
{
  const d = new RedisDict(4);
  const steps = d.set('hello', 'world');
  check(steps.length >= 8, 'SET 은 파이프라인 스텝을 모두 기록');
  check(steps[0].stage === 0 && steps[steps.length - 1].kind === 'done', '첫 스텝 RESP, 마지막 done');
  check(steps.every((s) => s.snap && s.snap.ht0), '모든 스텝에 스냅샷 존재');
  const gs = d.get('hello');
  check(gs.some((s) => s.kind === 'done'), 'GET HIT 기록');
  const ms = d.get('nope');
  check(ms.some((s) => s.kind === 'miss'), 'GET MISS 기록');
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILED'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
