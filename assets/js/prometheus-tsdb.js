/* ═══════════════════════════════════════════════════════════
   Prometheus TSDB demo model
   - metric + labels -> series id
   - label postings -> series references
   - WAL + head chunks -> persistent blocks -> compaction
═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrometheusLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STAGES = [
    { id: 'scrape', name: 'scrape', desc: 'exporter 에서 샘플 수집' },
    { id: 'series', name: 'series lookup', desc: 'metric + labels 로 series 찾기' },
    { id: 'wal', name: 'WAL append', desc: '장애 복구용 append-only 로그' },
    { id: 'chunk', name: 'head chunk', desc: '최근 샘플을 XOR chunk 에 추가' },
    { id: 'postings', name: 'label postings', desc: 'label pair -> series ref' },
    { id: 'block', name: '2h block', desc: 'head 를 불변 block 으로 저장' },
    { id: 'compact', name: 'compaction', desc: '작은 block 을 큰 block 으로 병합' },
    { id: 'query', name: 'query', desc: 'postings 와 시간 범위로 chunk 선택' },
  ];

  const pad = (n) => String(n).padStart(2, '0');

  function sortedEntries(labels) {
    return Object.entries(labels || {}).sort((a, b) => {
      if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
      return a[0] < b[0] ? -1 : 1;
    });
  }

  function labelKey(name, value) {
    return `${name}=${value}`;
  }

  function seriesKey(metric, labels) {
    return `__name__=${metric},` + sortedEntries(labels).map(([k, v]) => labelKey(k, v)).join(',');
  }

  function formatLabels(metric, labels) {
    const rest = sortedEntries(labels).map(([k, v]) => `${k}="${v}"`).join(', ');
    return `${metric}{${rest}}`;
  }

  function estimateXorBits(samples) {
    if (!samples.length) return 0;
    let bits = 80; // first timestamp + value, simplified
    if (samples.length === 1) return bits;
    bits += 36;
    let prevDelta = samples[1].t - samples[0].t;
    for (let i = 2; i < samples.length; i++) {
      const delta = samples[i].t - samples[i - 1].t;
      const dod = delta - prevDelta;
      bits += dod === 0 ? 1 : Math.abs(dod) < 64 ? 14 : 32;
      const valueDelta = Math.abs(samples[i].v - samples[i - 1].v);
      bits += valueDelta === 0 ? 1 : valueDelta < 1 ? 12 : 24;
      prevDelta = delta;
    }
    return bits;
  }

  function chunkSummary(chunk) {
    const samples = chunk.samples.slice();
    return {
      id: chunk.id,
      mint: samples.length ? samples[0].t : 0,
      maxt: samples.length ? samples[samples.length - 1].t : 0,
      count: samples.length,
      bits: estimateXorBits(samples),
      samples: samples.map((s) => ({ t: s.t, v: s.v })),
    };
  }

  class PrometheusTSDB {
    constructor(opts) {
      opts = opts || {};
      this.chunkSize = opts.chunkSize || 6;
      this.reset();
    }

    reset() {
      this.series = new Map();
      this.postings = new Map();
      this.blocks = [];
      this.wal = [];
      this.nextSeries = 1;
      this.nextBlock = 1;
      this.nextChunk = 1;
      this.clock = 0;
      this.steps = [];
      this.quiet = false;
    }

    snapshot() {
      const series = [...this.series.values()]
        .sort((a, b) => a.id - b.id)
        .map((s) => ({
          id: s.id,
          metric: s.metric,
          labels: Object.assign({}, s.labels),
          labelSet: s.labelSet,
          active: s.active ? chunkSummary(s.active) : null,
          chunks: s.chunks.map(chunkSummary),
          samples: s.samples,
        }));
      const postings = [...this.postings.entries()]
        .sort((a, b) => a[0] < b[0] ? -1 : 1)
        .map(([key, ids]) => ({ key, ids: [...ids].sort((a, b) => a - b) }));
      return {
        series,
        postings,
        wal: this.wal.slice(-12).map((r) => Object.assign({}, r)),
        blocks: this.blocks.map((b) => ({
          id: b.id,
          mint: b.mint,
          maxt: b.maxt,
          level: b.level,
          seriesCount: b.seriesCount,
          sampleCount: b.sampleCount,
          chunkCount: b.chunks.length,
          chunks: b.chunks.map((c) => Object.assign({}, c, { samples: c.samples.map((s) => ({ t: s.t, v: s.v })) })),
        })),
        chunkSize: this.chunkSize,
      };
    }

    _push(kind, msg, detail, deco) {
      if (this.quiet) return;
      this.steps.push({ kind, msg, detail: detail || '', deco: deco || {}, snap: this.snapshot() });
    }

    _post(label, id) {
      if (!this.postings.has(label)) this.postings.set(label, new Set());
      this.postings.get(label).add(id);
    }

    _ensureSeries(metric, labels) {
      const key = seriesKey(metric, labels);
      let s = this.series.get(key);
      if (s) return { series: s, created: false, key };

      const normalized = {};
      sortedEntries(labels).forEach(([k, v]) => { normalized[k] = String(v); });
      s = {
        id: this.nextSeries++,
        key,
        metric,
        labels: normalized,
        labelSet: formatLabels(metric, normalized),
        active: null,
        chunks: [],
        samples: 0,
      };
      this.series.set(key, s);
      this._post(labelKey('__name__', metric), s.id);
      sortedEntries(normalized).forEach(([k, v]) => this._post(labelKey(k, v), s.id));
      return { series: s, created: true, key };
    }

    _newChunk(series) {
      series.active = { id: 'c' + this.nextChunk++, samples: [] };
      return series.active;
    }

    ingest(sample) {
      this.steps = [];
      const metric = sample.metric || 'http_requests_total';
      const labels = sample.labels || {};
      const t = Number.isFinite(sample.t) ? sample.t : (this.clock += 15);
      const v = Number.isFinite(sample.v) ? sample.v : 1;
      this.clock = Math.max(this.clock, t);

      this._push('scrape',
        `scrape — ${formatLabels(metric, labels)} @ ${t}s = ${v}`,
        'Prometheus 는 pull 방식으로 exporter 를 긁어오고, 한 줄마다 timestamp/value 샘플을 만든다.',
        { stage: 'scrape' });

      const found = this._ensureSeries(metric, labels);
      this._push('series',
        found.created
          ? `새 series #${found.series.id} 생성 — metric name 과 label set 전체가 identity`
          : `기존 series #${found.series.id} 발견 — 같은 label set 이면 같은 시간축에 append`,
        found.series.labelSet,
        { stage: 'series', activeSeries: found.series.id });

      if (found.created) {
        this.wal.push({ type: 'series', series: found.series.id, text: found.series.labelSet });
      }
      this.wal.push({ type: 'sample', series: found.series.id, t, v });
      this._push('wal',
        `WAL append — series #${found.series.id}, t=${t}, v=${v}`,
        '샘플은 먼저 write-ahead log 에 append 된다. 프로세스가 죽어도 WAL 을 replay 해서 head 를 복원한다.',
        { stage: 'wal', activeSeries: found.series.id });

      const chunk = found.series.active || this._newChunk(found.series);
      chunk.samples.push({ t, v });
      found.series.samples++;
      this._push('chunk',
        `${chunk.id} 에 샘플 append — ${chunk.samples.length}/${this.chunkSize}`,
        `XOR chunk 는 첫 timestamp/value 를 기준으로 이후 timestamp delta-of-delta 와 value XOR 를 비트 단위로 압축한다. 현재 추정 ${estimateXorBits(chunk.samples)} bits.`,
        { stage: 'chunk', activeSeries: found.series.id, activeChunk: chunk.id, newSample: { t, v } });

      if (found.created) {
        const labelsAdded = [labelKey('__name__', metric)].concat(sortedEntries(labels).map(([k, val]) => labelKey(k, val)));
        this._push('postings',
          `label postings 갱신 — ${labelsAdded.length}개 label pair 가 series #${found.series.id} 를 가리킨다`,
          labelsAdded.join('\n'),
          { stage: 'postings', activeSeries: found.series.id, activePostings: labelsAdded });
      } else {
        this._push('postings',
          'label postings 는 그대로 — 샘플 append 는 series 목록을 바꾸지 않는다',
          '카디널리티를 늘리는 것은 샘플 수가 아니라 새로운 label set 이다.',
          { stage: 'postings', activeSeries: found.series.id });
      }

      if (chunk.samples.length >= this.chunkSize) {
        found.series.chunks.push(chunk);
        found.series.active = null;
        this._push('chunk',
          `${chunk.id} 가 가득 차서 head 의 오래된 chunk 로 넘어간다`,
          '실제 Prometheus 에서는 head 의 오래된 chunk 가 memory-mapped 파일로 내려가고, 다음 샘플은 새 active chunk 에 append 된다.',
          { stage: 'chunk', activeSeries: found.series.id, activeChunk: chunk.id, closedChunk: chunk.id });
      }

      return this.steps;
    }

    bulk(samples) {
      this.quiet = true;
      samples.forEach((s) => this.ingest(s));
      this.quiet = false;
      this.steps = [];
    }

    allHeadChunks() {
      const out = [];
      for (const s of this.series.values()) {
        s.chunks.forEach((c) => out.push({ series: s, chunk: c }));
        if (s.active && s.active.samples.length) out.push({ series: s, chunk: s.active });
      }
      return out;
    }

    cutBlock() {
      this.steps = [];
      const headChunks = this.allHeadChunks();
      if (!headChunks.length) {
        this._push('block', 'block 생성 없음 — head 에 샘플이 없다', '', { stage: 'block' });
        return this.steps;
      }

      const chunks = [];
      let mint = Infinity;
      let maxt = -Infinity;
      let sampleCount = 0;
      headChunks.forEach(({ series, chunk }) => {
        const sum = chunkSummary(chunk);
        if (!sum.count) return;
        mint = Math.min(mint, sum.mint);
        maxt = Math.max(maxt, sum.maxt);
        sampleCount += sum.count;
        chunks.push({
          series: series.id,
          labelSet: series.labelSet,
          chunk: sum.id,
          mint: sum.mint,
          maxt: sum.maxt,
          count: sum.count,
          bits: sum.bits,
          samples: sum.samples,
        });
      });

      const block = {
        id: 'b' + this.nextBlock++,
        mint,
        maxt,
        level: 1,
        chunks,
        seriesCount: new Set(chunks.map((c) => c.series)).size,
        sampleCount,
      };
      this.blocks.push(block);
      this._push('block',
        `${block.id} 생성 — ${block.seriesCount} series, ${block.chunkCount || chunks.length} chunks, ${sampleCount} samples`,
        'Prometheus 의 초기 persistent block 은 보통 2시간 범위를 담는다. block 안에는 chunks/, index, tombstones, meta.json 이 함께 있다.',
        { stage: 'block', activeBlock: block.id });

      for (const s of this.series.values()) {
        s.chunks = [];
        s.active = null;
      }
      this.wal = [{ type: 'checkpoint', series: 0, text: `${block.id} persisted` }];
      this._push('wal',
        `checkpoint — ${block.id} 이전 head 내용은 block 으로 굳었으므로 WAL 을 줄인다`,
        '운영 환경에서는 checkpoint 와 WAL segment 가 함께 관리된다. 여기서는 block 생성 뒤 복구 로그가 작아지는 흐름만 모델링한다.',
        { stage: 'wal', activeBlock: block.id });

      return this.steps;
    }

    compactBlocks() {
      this.steps = [];
      if (this.blocks.length < 2) {
        this._push('compact', 'compaction 대기 — 병합할 block 이 2개 미만이다', '', { stage: 'compact' });
        return this.steps;
      }
      const targets = this.blocks.slice(0, 2);
      const rest = this.blocks.slice(2);
      const chunks = targets.flatMap((b) => b.chunks.map((c) => Object.assign({}, c, { samples: c.samples.map((s) => ({ t: s.t, v: s.v })) })));
      const block = {
        id: 'b' + this.nextBlock++,
        mint: Math.min(...targets.map((b) => b.mint)),
        maxt: Math.max(...targets.map((b) => b.maxt)),
        level: Math.max(...targets.map((b) => b.level)) + 1,
        chunks,
        seriesCount: new Set(chunks.map((c) => c.series)).size,
        sampleCount: chunks.reduce((a, c) => a + c.count, 0),
      };
      this.blocks = [block].concat(rest);
      this._push('compact',
        `compaction — ${targets.map((b) => b.id).join(' + ')} → ${block.id}`,
        '작은 block 여러 개를 더 긴 시간 범위의 block 으로 합치면 쿼리가 열어야 할 index/chunk 파일 수가 줄어든다. block 은 불변이라 새 block 을 만들고 옛 block 을 나중에 지운다.',
        { stage: 'compact', activeBlock: block.id, compacted: targets.map((b) => b.id) });
      return this.steps;
    }

    query(matchers, start, end) {
      this.steps = [];
      matchers = matchers || {};
      start = Number.isFinite(start) ? start : 0;
      end = Number.isFinite(end) ? end : Infinity;
      const matcherKeys = sortedEntries(matchers).map(([k, v]) => labelKey(k, v));

      this._push('query',
        `query — {${matcherKeys.join(', ') || 'all series'}} [${start}s, ${end === Infinity ? '∞' : end + 's'}]`,
        'PromQL 의 selector 는 먼저 label matcher 로 series 후보를 찾고, 그 다음 시간 범위와 겹치는 chunk 만 읽는다.',
        { stage: 'query', queryPostings: matcherKeys });

      let candidates = null;
      matcherKeys.forEach((key) => {
        const ids = this.postings.get(key) || new Set();
        const set = new Set(ids);
        candidates = candidates === null ? set : new Set([...candidates].filter((id) => set.has(id)));
        this._push('postings',
          `${key} postings → [${[...ids].sort((a, b) => a - b).map((id) => '#' + id).join(', ') || 'empty'}]`,
          '여러 matcher 는 postings list 교집합으로 좁힌다. label 카디널리티가 높으면 이 목록과 index 가 커진다.',
          { stage: 'postings', queryPostings: [key], hitSeries: [...(candidates || [])] });
      });
      if (candidates === null) candidates = new Set([...this.series.values()].map((s) => s.id));

      const hitSeries = [...candidates].sort((a, b) => a - b);
      const chunks = [];
      this.allHeadChunks().forEach(({ series, chunk }) => {
        const sum = chunkSummary(chunk);
        if (candidates.has(series.id) && sum.maxt >= start && sum.mint <= end) {
          chunks.push({ where: 'head', series: series.id, chunk: sum.id, samples: sum.samples.filter((s) => s.t >= start && s.t <= end) });
        }
      });
      this.blocks.forEach((b) => {
        b.chunks.forEach((c) => {
          if (candidates.has(c.series) && c.maxt >= start && c.mint <= end) {
            chunks.push({ where: b.id, series: c.series, chunk: c.chunk, samples: c.samples.filter((s) => s.t >= start && s.t <= end) });
          }
        });
      });

      const sampleCount = chunks.reduce((a, c) => a + c.samples.length, 0);
      this._push('query',
        `선택된 series ${hitSeries.length}개, 읽을 chunk ${chunks.length}개, 반환 샘플 ${sampleCount}개`,
        chunks.map((c) => `${c.where}/${c.chunk} series #${c.series}: ${c.samples.length} samples`).join('\n') || '조건에 맞는 chunk 없음',
        { stage: 'query', hitSeries, hitChunks: chunks.map((c) => c.chunk) });
      return this.steps;
    }

    validate() {
      const errs = [];
      for (const s of this.series.values()) {
        const expected = [labelKey('__name__', s.metric)].concat(sortedEntries(s.labels).map(([k, v]) => labelKey(k, v)));
        expected.forEach((key) => {
          if (!this.postings.has(key) || !this.postings.get(key).has(s.id)) {
            errs.push(`series #${s.id} missing posting ${key}`);
          }
        });
        const chunks = s.chunks.concat(s.active ? [s.active] : []);
        chunks.forEach((c) => {
          for (let i = 1; i < c.samples.length; i++) {
            if (c.samples[i - 1].t > c.samples[i].t) errs.push(`${c.id} timestamps not sorted`);
          }
        });
      }
      this.blocks.forEach((b) => {
        const count = b.chunks.reduce((a, c) => a + c.count, 0);
        if (count !== b.sampleCount) errs.push(`${b.id} sample count mismatch`);
        if (b.mint > b.maxt) errs.push(`${b.id} invalid time range`);
      });
      return errs;
    }
  }

  function demoSamples() {
    const out = [];
    const services = [
      { job: 'api', instance: '10.0.0.1:9100', base: 0.38 },
      { job: 'api', instance: '10.0.0.2:9100', base: 0.45 },
      { job: 'worker', instance: '10.0.1.5:9100', base: 0.71 },
    ];
    for (let i = 0; i < 9; i++) {
      services.forEach((s, j) => {
        out.push({
          metric: i % 3 === 0 ? 'http_requests_total' : 'process_cpu_seconds_total',
          labels: { job: s.job, instance: s.instance },
          t: i * 15 + j,
          v: Number((s.base + i * 0.07 + j * 0.03).toFixed(2)),
        });
      });
    }
    return out;
  }

  return { PrometheusTSDB, STAGES, estimateXorBits, formatLabels, seriesKey, labelKey, demoSamples };
});
