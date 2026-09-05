/* Prometheus TSDB 모델 테스트 — node tests/prometheus.test.js */
'use strict';

const { PrometheusTSDB, estimateXorBits, demoSamples } = require('../assets/js/prometheus-tsdb.js');

let pass = 0;
let fail = 0;
function check(cond, label) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ ' + label); }
}

/* ── 1. series identity + label postings ── */
{
  const db = new PrometheusTSDB({ chunkSize: 3 });
  db.ingest({ metric: 'up', labels: { job: 'api', instance: 'a' }, t: 0, v: 1 });
  db.ingest({ metric: 'up', labels: { instance: 'a', job: 'api' }, t: 15, v: 1 });
  db.ingest({ metric: 'up', labels: { job: 'api', instance: 'b' }, t: 0, v: 1 });

  const snap = db.snapshot();
  check(snap.series.length === 2, `label 순서가 달라도 같은 series (got ${snap.series.length})`);
  const job = snap.postings.find((p) => p.key === 'job=api');
  check(job && job.ids.length === 2, 'job=api postings 가 두 series 를 가리킨다');
  const metric = snap.postings.find((p) => p.key === '__name__=up');
  check(metric && metric.ids.join(',') === '1,2', '__name__ postings 정렬');
  check(db.validate().length === 0, 'postings 무결성');
}

/* ── 2. head chunk rollover ── */
{
  const db = new PrometheusTSDB({ chunkSize: 3 });
  for (let i = 0; i < 4; i++) {
    db.ingest({ metric: 'cpu', labels: { job: 'api', instance: 'a' }, t: i * 15, v: i });
  }
  const s = db.snapshot().series[0];
  check(s.chunks.length === 1, '3개 샘플 후 chunk 하나가 closed 됨');
  check(s.chunks[0].count === 3, 'closed chunk sample count = 3');
  check(s.active && s.active.count === 1, '4번째 샘플은 새 active chunk 로 들어감');
  check(estimateXorBits(s.chunks[0].samples) < 80 * 3, 'XOR 추정 비트가 raw 보다 작음');
}

/* ── 3. query postings + time range ── */
{
  const db = new PrometheusTSDB({ chunkSize: 4 });
  db.bulk(demoSamples().slice(0, 12));
  const steps = db.query({ job: 'api' }, 0, 40);
  const done = steps[steps.length - 1];
  check(done.deco.hitSeries.length === 4, `job=api series 4개 (metric별 series 포함, got ${done.deco.hitSeries.length})`);
  check(done.deco.hitChunks.length > 0, '시간 범위와 겹치는 chunk 선택');
  check(done.detail.includes('samples'), '쿼리 detail 에 샘플 수 포함');
}

/* ── 4. block cut + WAL checkpoint ── */
{
  const db = new PrometheusTSDB({ chunkSize: 3 });
  db.bulk(demoSamples().slice(0, 9));
  const before = db.snapshot().series.reduce((a, s) => a + s.samples, 0);
  db.cutBlock();
  const snap = db.snapshot();
  check(snap.blocks.length === 1, 'persistent block 1개 생성');
  check(snap.blocks[0].sampleCount === before, 'block sample count 가 head sample 수와 일치');
  check(snap.series.every((s) => !s.active && s.chunks.length === 0), 'block cut 후 head chunks 비움');
  check(snap.wal.length === 1 && snap.wal[0].type === 'checkpoint', 'WAL checkpoint 로 축소');
  check(db.validate().length === 0, 'block 생성 후 무결성');
}

/* ── 5. block compaction ── */
{
  const db = new PrometheusTSDB({ chunkSize: 3 });
  db.bulk(demoSamples().slice(0, 6));
  db.cutBlock();
  db.bulk(demoSamples().slice(6, 12));
  db.cutBlock();
  check(db.snapshot().blocks.length === 2, 'compaction 전 block 2개');
  db.compactBlocks();
  const snap = db.snapshot();
  check(snap.blocks.length === 1, 'compaction 후 block 1개');
  check(snap.blocks[0].level === 2, 'compacted block level 증가');
  check(snap.blocks[0].sampleCount === 12, 'compacted block sample count 유지');
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILED'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
