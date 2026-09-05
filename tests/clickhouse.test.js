/* ClickHouse MergeTree 모델 테스트 — node tests/clickhouse.test.js */
'use strict';

const { ClickHouseMergeTree, compareKey, keyOf, demoBatches } = require('../assets/js/clickhouse-merge-tree.js');

let pass = 0;
let fail = 0;
function check(cond, label) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ ' + label); }
}

/* ── 1. INSERT batch -> sorted part + marks ── */
{
  const ch = new ClickHouseMergeTree({ granuleSize: 3 });
  ch.insertRows([
    { service: 'worker', day: '2026-09-04', ts: 3, endpoint: '/b', status: 200 },
    { service: 'api', day: '2026-09-04', ts: 2, endpoint: '/a', status: 200 },
    { service: 'api', day: '2026-09-03', ts: 9, endpoint: '/a', status: 500 },
    { service: 'api', day: '2026-09-04', ts: 1, endpoint: '/c', status: 200 },
  ]);
  const p = ch.snapshot().parts[0];
  check(p.rows.length === 4, 'part rows 4개');
  check(p.granules.length === 2, 'granuleSize 3 -> granule 2개');
  check(p.marks[0].key.join('|') === keyOf(p.rows[0]).join('|'), 'mark 는 granule 첫 row key');
  check(p.rows.every((r, i, arr) => i === 0 || compareKey(keyOf(arr[i - 1]), keyOf(r)) <= 0), 'part 내부 정렬');
  check(ch.validate().length === 0, 'part 무결성');
}

/* ── 2. primary key predicate prunes granules ── */
{
  const ch = new ClickHouseMergeTree({ granuleSize: 4 });
  ch.bulkInsert([demoBatches()[0], demoBatches()[1]]);
  const steps = ch.query({ service: 'api', fromDay: '2026-09-04', toDay: '2026-09-04', status: 200 });
  const done = steps[steps.length - 1].snap.lastQuery;
  check(done.rowsRead < done.totalRows, `primary key prefix 로 rowsRead 감소 (${done.rowsRead}/${done.totalRows})`);
  check(done.skippedGranules.length > 0, '건너뛴 granule 존재');
  check(done.matchedRows.length > 0, '매칭 row 존재');
}

/* ── 3. date-only predicate is weaker than service+date ── */
{
  const ch = new ClickHouseMergeTree({ granuleSize: 4 });
  ch.bulkInsert([demoBatches()[0], demoBatches()[1]]);
  ch.query({ service: 'api', fromDay: '2026-09-04', toDay: '2026-09-04' });
  const apiRead = ch.snapshot().lastQuery.rowsRead;
  ch.query({ fromDay: '2026-09-04', toDay: '2026-09-04' });
  const dateRead = ch.snapshot().lastQuery.rowsRead;
  check(dateRead >= apiRead, `정렬 키 prefix 없는 날짜 단독 조건은 더 많이 읽음 (${dateRead} >= ${apiRead})`);
}

/* ── 4. background merge keeps sorted order and rewrites marks ── */
{
  const ch = new ClickHouseMergeTree({ granuleSize: 4 });
  ch.bulkInsert([demoBatches()[0], demoBatches()[1]]);
  check(ch.snapshot().parts.length === 2, 'merge 전 part 2개');
  ch.mergeParts();
  const snap = ch.snapshot();
  check(snap.parts.length === 1, 'merge 후 part 1개');
  check(snap.parts[0].level === 1, 'merged part level 1');
  check(snap.parts[0].rows.length === 20, 'row 수 유지');
  check(ch.validate().length === 0, 'merge 후 무결성');
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILED'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
