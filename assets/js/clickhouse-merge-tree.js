/* ═══════════════════════════════════════════════════════════
   ClickHouse MergeTree demo model
   - INSERT batch -> sorted data part
   - part -> granules -> sparse primary index marks
   - query -> mark scan -> candidate granules -> exact filter
═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClickHouseLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STAGES = [
    { id: 'insert', name: 'INSERT batch', desc: '들어온 행 묶음' },
    { id: 'sort', name: 'ORDER BY sort', desc: 'part 내부를 정렬' },
    { id: 'part', name: 'data part', desc: '불변 part 생성' },
    { id: 'mark', name: 'marks', desc: 'granule 첫 행의 PK 저장' },
    { id: 'predicate', name: 'predicate', desc: 'WHERE 조건 분석' },
    { id: 'index', name: 'primary index', desc: '읽을 granule 선택' },
    { id: 'read', name: 'read granules', desc: '후보 granule 로드' },
    { id: 'merge', name: 'background merge', desc: 'part 병합' },
  ];

  function cmp(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function keyOf(row) {
    return [String(row.service), String(row.day), Number(row.ts)];
  }

  function compareKey(a, b) {
    return cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]);
  }

  function formatKey(k) {
    return `(${k[0]}, ${k[1]}, ${String(k[2]).padStart(4, '0')})`;
  }

  function cloneRow(r) {
    return {
      id: r.id,
      service: r.service,
      day: r.day,
      ts: r.ts,
      endpoint: r.endpoint,
      status: r.status,
      latency: r.latency,
    };
  }

  function normalizeRow(row, id) {
    return {
      id,
      service: row.service || 'api',
      day: row.day || '2026-09-04',
      ts: Number.isFinite(row.ts) ? row.ts : id,
      endpoint: row.endpoint || '/v1/orders',
      status: Number.isFinite(row.status) ? row.status : 200,
      latency: Number.isFinite(row.latency) ? row.latency : 40 + (id % 9) * 7,
    };
  }

  function primaryMatch(row, pred) {
    if (pred.service && row.service !== pred.service) return false;
    if (pred.fromDay && row.day < pred.fromDay) return false;
    if (pred.toDay && row.day > pred.toDay) return false;
    return true;
  }

  function exactMatch(row, pred) {
    if (!primaryMatch(row, pred)) return false;
    if (Number.isFinite(pred.status) && row.status !== pred.status) return false;
    if (pred.endpoint && row.endpoint !== pred.endpoint) return false;
    return true;
  }

  class ClickHouseMergeTree {
    constructor(opts) {
      opts = opts || {};
      this.granuleSize = opts.granuleSize || 4;
      this.reset();
    }

    reset() {
      this.parts = [];
      this.nextPart = 1;
      this.nextRow = 1;
      this.steps = [];
      this.lastQuery = null;
      this.quiet = false;
    }

    _buildPart(rows, level) {
      const sorted = rows.slice().sort((a, b) => compareKey(keyOf(a), keyOf(b)) || a.id - b.id);
      const granules = [];
      for (let i = 0; i < sorted.length; i += this.granuleSize) {
        const slice = sorted.slice(i, i + this.granuleSize);
        granules.push({
          no: granules.length,
          start: i,
          end: i + slice.length - 1,
          mark: keyOf(slice[0]),
          minKey: keyOf(slice[0]),
          maxKey: keyOf(slice[slice.length - 1]),
          rows: slice,
        });
      }
      return {
        id: 'p' + this.nextPart++,
        level: level || 0,
        rows: sorted,
        granules,
        marks: granules.map((g) => ({ no: g.no, key: g.mark })),
      };
    }

    snapshot() {
      return {
        granuleSize: this.granuleSize,
        parts: this.parts.map((p) => ({
          id: p.id,
          level: p.level,
          rows: p.rows.map(cloneRow),
          granules: p.granules.map((g) => ({
            no: g.no,
            start: g.start,
            end: g.end,
            mark: g.mark.slice(),
            minKey: g.minKey.slice(),
            maxKey: g.maxKey.slice(),
            rows: g.rows.map(cloneRow),
          })),
          marks: p.marks.map((m) => ({ no: m.no, key: m.key.slice() })),
        })),
        lastQuery: this.lastQuery && {
          pred: Object.assign({}, this.lastQuery.pred),
          readGranules: this.lastQuery.readGranules.slice(),
          skippedGranules: this.lastQuery.skippedGranules.slice(),
          matchedRows: this.lastQuery.matchedRows.slice(),
          rowsRead: this.lastQuery.rowsRead,
          totalRows: this.lastQuery.totalRows,
        },
      };
    }

    _push(kind, msg, detail, deco) {
      if (this.quiet) return;
      this.steps.push({ kind, msg, detail: detail || '', deco: deco || {}, snap: this.snapshot() });
    }

    insertRows(rows) {
      this.steps = [];
      const normalized = rows.map((row) => normalizeRow(row, this.nextRow++));
      this._push('insert',
        `INSERT batch — ${normalized.length} rows`,
        'ClickHouse 는 작은 행을 하나씩 B-Tree 에 끼워 넣지 않는다. 들어온 batch 를 정렬한 뒤 새 data part 로 쓴다.',
        { stage: 'insert', incomingRows: normalized.map((r) => r.id) });

      const sortedPreview = normalized.slice().sort((a, b) => compareKey(keyOf(a), keyOf(b)) || a.id - b.id);
      this._push('sort',
        'ORDER BY (service, day, ts) 로 part 내부 정렬',
        sortedPreview.map((r) => `#${r.id} ${formatKey(keyOf(r))}`).join('\n'),
        { stage: 'sort', incomingRows: sortedPreview.map((r) => r.id) });

      const part = this._buildPart(normalized, 0);
      this.parts.push(part);
      this.lastQuery = null;
      this._push('part',
        `${part.id} 생성 — ${part.rows.length} rows, ${part.granules.length} granules`,
        'data part 는 불변 파일 묶음이다. Wide part 에서는 컬럼마다 별도 파일이 생기고, mark 는 각 컬럼 파일의 읽기 위치를 연결한다.',
        { stage: 'part', activePart: part.id });
      this._push('mark',
        `${part.id} primary index — granule ${part.granules.length}개마다 mark ${part.marks.length}개`,
        part.marks.map((m) => `mark ${m.no}: ${formatKey(m.key)}`).join('\n'),
        { stage: 'mark', activePart: part.id, activeMarks: part.marks.map((m) => `${part.id}:${m.no}`) });
      return this.steps;
    }

    bulkInsert(batches) {
      this.quiet = true;
      batches.forEach((batch) => this.insertRows(batch));
      this.quiet = false;
      this.steps = [];
    }

    query(pred) {
      this.steps = [];
      pred = Object.assign({}, pred || {});
      const totalRows = this.parts.reduce((a, p) => a + p.rows.length, 0);
      this._push('predicate',
        `WHERE ${this.describePredicate(pred)}`,
        'primary key prefix 인 service, day 조건은 sparse primary index 로 granule 을 줄인다. status, endpoint 는 읽은 뒤 각 row 에서 다시 검사한다.',
        { stage: 'predicate' });

      const readGranules = [];
      const skippedGranules = [];
      const matchedRows = [];
      let rowsRead = 0;
      this.parts.forEach((part) => {
        part.granules.forEach((g) => {
          const candidate = g.rows.some((r) => primaryMatch(r, pred));
          const gid = `${part.id}:${g.no}`;
          if (candidate) {
            readGranules.push(gid);
            rowsRead += g.rows.length;
            g.rows.forEach((r) => { if (exactMatch(r, pred)) matchedRows.push(r.id); });
          } else {
            skippedGranules.push(gid);
          }
        });
      });

      this.lastQuery = { pred, readGranules, skippedGranules, matchedRows, rowsRead, totalRows };
      this._push('index',
        `primary index scan — ${readGranules.length} granules read, ${skippedGranules.length} granules skipped`,
        'index entry 는 각 granule 의 첫 primary key 값뿐이다. 그래서 정확한 row 위치가 아니라 읽을 가능성이 있는 granule 범위를 찾는다.',
        { stage: 'index', readGranules, skippedGranules, matchedRows });
      this._push('read',
        `${rowsRead}/${totalRows} rows read → ${matchedRows.length} rows matched`,
        matchedRows.length
          ? matchedRows.map((id) => `row #${id}`).join(', ')
          : '후보 granule 은 있었지만 row-level predicate 까지 통과한 행은 없다.',
        { stage: 'read', readGranules, skippedGranules, matchedRows });
      return this.steps;
    }

    mergeParts() {
      this.steps = [];
      if (this.parts.length < 2) {
        this._push('merge', 'background merge 대기 — part 가 2개 미만이다', '', { stage: 'merge' });
        return this.steps;
      }
      const targets = this.parts.slice(0, 2);
      const rest = this.parts.slice(2);
      const rows = targets.flatMap((p) => p.rows.map(cloneRow));
      this._push('merge',
        `merge select — ${targets.map((p) => p.id).join(' + ')}`,
        'MergeTree 는 같은 partition 안의 part 들을 백그라운드에서 합친다. 합쳐진 part 도 ORDER BY 순서를 유지한다.',
        { stage: 'merge', activeParts: targets.map((p) => p.id) });
      const part = this._buildPart(rows, Math.max(...targets.map((p) => p.level)) + 1);
      this.parts = [part].concat(rest);
      this.lastQuery = null;
      this._push('merge',
        `${targets.map((p) => p.id).join(' + ')} → ${part.id} · marks 재작성`,
        part.marks.map((m) => `mark ${m.no}: ${formatKey(m.key)}`).join('\n'),
        { stage: 'merge', activePart: part.id, activeMarks: part.marks.map((m) => `${part.id}:${m.no}`) });
      return this.steps;
    }

    describePredicate(pred) {
      const out = [];
      if (pred.service) out.push(`service = '${pred.service}'`);
      if (pred.fromDay && pred.toDay && pred.fromDay === pred.toDay) out.push(`day = '${pred.fromDay}'`);
      else {
        if (pred.fromDay) out.push(`day >= '${pred.fromDay}'`);
        if (pred.toDay) out.push(`day <= '${pred.toDay}'`);
      }
      if (Number.isFinite(pred.status)) out.push(`status = ${pred.status}`);
      if (pred.endpoint) out.push(`endpoint = '${pred.endpoint}'`);
      return out.join(' AND ') || '1';
    }

    validate() {
      const errs = [];
      this.parts.forEach((p) => {
        for (let i = 1; i < p.rows.length; i++) {
          if (compareKey(keyOf(p.rows[i - 1]), keyOf(p.rows[i])) > 0) errs.push(`${p.id} rows not sorted at ${i}`);
        }
        const expectedGranules = Math.ceil(p.rows.length / this.granuleSize);
        if (p.granules.length !== expectedGranules) errs.push(`${p.id} granule count mismatch`);
        p.granules.forEach((g) => {
          if (formatKey(g.mark) !== formatKey(keyOf(g.rows[0]))) errs.push(`${p.id}:${g.no} mark is not first row`);
          if (g.rows.length > this.granuleSize) errs.push(`${p.id}:${g.no} granule too large`);
        });
      });
      return errs;
    }
  }

  function demoBatches() {
    const endpoints = ['/v1/orders', '/v1/payments', '/v1/search'];
    const services = ['api', 'api', 'worker', 'checkout'];
    const days = ['2026-09-03', '2026-09-04', '2026-09-04', '2026-09-05'];
    const batches = [];
    for (let b = 0; b < 3; b++) {
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const k = b * 10 + i;
        rows.push({
          service: services[(k * 3 + b) % services.length],
          day: days[(k + b) % days.length],
          ts: 1000 + ((k * 37) % 360),
          endpoint: endpoints[(k + b) % endpoints.length],
          status: k % 7 === 0 ? 500 : 200,
          latency: 30 + ((k * 17) % 120),
        });
      }
      batches.push(rows);
    }
    return batches;
  }

  return { ClickHouseMergeTree, STAGES, keyOf, compareKey, formatKey, demoBatches };
});
