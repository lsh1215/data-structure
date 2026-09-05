/* ═══════════════════════════════════════════════════════════
   Prometheus TSDB visualizer
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const { PrometheusTSDB, STAGES, demoSamples } = window.PrometheusLib;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    if (!$('promSeries')) return;

    const db = new PrometheusTSDB({ chunkSize: 5 });
    const samples = demoSamples();
    let sampleCursor = 0;
    let steps = [];
    let idx = -1;
    let playing = false;
    let timer = null;
    let speed = 1.5;

    $('promPipe').innerHTML = STAGES.map(
      (s, i) => `<div class="pipe__stage" data-stage="${s.id}"><span class="pipe__num">${String(i).padStart(2, '0')}</span>${s.name}</div>`
    ).join('');
    const pipeEls = [...$('promPipe').querySelectorAll('.pipe__stage')];

    function idle(msg) {
      return { kind: 'idle', msg, detail: '', deco: {}, snap: db.snapshot() };
    }

    function run(list) {
      pause();
      steps = list && list.length ? list : [idle('보여줄 단계가 없습니다')];
      idx = 0;
      show(0);
      if (steps.length > 1) play();
    }

    function play() {
      if (!steps.length) return;
      if (idx >= steps.length - 1) {
        playing = false;
        $('promPlay').textContent = '▶ 재생';
        return;
      }
      playing = true;
      $('promPlay').textContent = '❚❚ 정지';
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!playing) return;
        idx++;
        show(idx);
        play();
      }, Math.round(850 / speed));
    }

    function pause() {
      playing = false;
      clearTimeout(timer);
      $('promPlay').textContent = '▶ 재생';
    }

    function show(i) {
      const step = steps[i];
      if (!step) return;
      render(step);
      $('promStep').textContent = `step ${i + 1} / ${steps.length}`;
      $('promBar').style.width = ((i + 1) / steps.length * 100) + '%';
    }

    function render(step) {
      const snap = step.snap;
      const deco = step.deco || {};
      pipeEls.forEach((el) => {
        el.classList.toggle('pipe__stage--now', el.dataset.stage === deco.stage);
        el.classList.toggle('pipe__stage--past', STAGES.findIndex((s) => s.id === el.dataset.stage) < STAGES.findIndex((s) => s.id === deco.stage));
      });

      $('promKind').textContent = step.kind || 'idle';
      $('promKind').className = 'narr__kind narr__kind--' + (step.kind || 'idle');
      $('promMsg').textContent = step.msg || '';
      $('promDetail').textContent = step.detail || '—';

      const hitSeries = new Set(deco.hitSeries || []);
      const activePostings = new Set(deco.activePostings || deco.queryPostings || []);
      const hitChunks = new Set(deco.hitChunks || []);

      $('promSeries').innerHTML = snap.series.length
        ? snap.series.map((s) => {
          const chunks = [];
          s.chunks.forEach((c) => chunks.push(renderChunk(c, hitChunks, deco, 'mmap')));
          if (s.active) chunks.push(renderChunk(s.active, hitChunks, deco, 'active'));
          return `<div class="metric-card${deco.activeSeries === s.id || hitSeries.has(s.id) ? ' metric-card--active' : ''}">
              <div class="metric-card__head"><b>series #${s.id}</b><span>${s.samples} samples</span></div>
              <div class="metric-card__body">
                <div class="labelset">${esc(s.labelSet)}</div>
                <div class="chunk-line">${chunks.join('') || '<span class="muted mono" style="font-size:11px">head chunk 없음</span>'}</div>
              </div>
            </div>`;
        }).join('')
        : '<p class="muted mono" style="font-size:12px">아직 series 가 없습니다</p>';

      $('promPostings').innerHTML = snap.postings.length
        ? snap.postings.map((p) => `<div class="posting-row${activePostings.has(p.key) ? ' posting-row--active' : ''}">
            <span class="posting-row__k">${esc(p.key)}</span>
            <span class="posting-row__ids">${p.ids.map((id) => `<span class="sid-chip${hitSeries.has(id) ? ' sid-chip--hit' : ''}">#${id}</span>`).join('')}</span>
          </div>`).join('')
        : '<p class="muted mono" style="font-size:12px">label postings 비어 있음</p>';

      const maxBlockSamples = Math.max(1, ...snap.blocks.map((b) => b.sampleCount));
      $('promBlocks').innerHTML = snap.blocks.length
        ? snap.blocks.map((b) => `<div class="block-card${deco.activeBlock === b.id ? ' block-card--active' : ''}">
            <div class="block-card__head"><b>${b.id}</b><span>level ${b.level}</span></div>
            <div class="block-card__body">
              <span>${b.mint}s → ${b.maxt}s</span>
              <span>${b.seriesCount} series · ${b.chunkCount} chunks</span>
              <span>${b.sampleCount} samples</span>
              <div class="block-card__bar"><i style="width:${(b.sampleCount / maxBlockSamples * 100).toFixed(1)}%"></i></div>
            </div>
          </div>`).join('')
        : '<p class="muted mono" style="font-size:12px">persistent block 없음</p>';

      $('promWal').innerHTML = snap.wal.length
        ? snap.wal.slice().reverse().map((r) => `<div class="wal-record"><b>${esc(r.type)}</b><span>${r.type === 'sample' ? `#${r.series} t=${r.t} v=${r.v}` : esc(r.text || ('#' + r.series))}</span></div>`).join('')
        : '<p class="muted mono" style="font-size:12px">WAL 비어 있음</p>';

      const headChunks = snap.series.reduce((a, s) => a + s.chunks.length + (s.active ? 1 : 0), 0);
      const totalSamples = snap.series.reduce((a, s) => a + s.samples, 0);
      $('promSeriesN').textContent = snap.series.length;
      $('promSamplesN').textContent = totalSamples;
      $('promHeadChunksN').textContent = headChunks;
      $('promBlocksN').textContent = snap.blocks.length;
    }

    function renderChunk(c, hitChunks, deco, tag) {
      const active = deco.activeChunk === c.id || hitChunks.has(c.id);
      return `<div class="chunk-card${active ? ' chunk-card--active' : ''}">
        <div class="chunk-card__h"><b>${esc(c.id)} · ${tag}</b><span>${c.count}/${db.chunkSize} · ${c.bits} bits</span></div>
        <div class="sample-strip">${c.samples.map((s) => {
          const isNew = deco.newSample && deco.newSample.t === s.t && deco.newSample.v === s.v;
          return `<span class="sample-dot${isNew ? ' sample-dot--new' : active ? ' sample-dot--hit' : ''}">${s.t}:${s.v}</span>`;
        }).join('')}</div>
      </div>`;
    }

    function nextSample(metric) {
      let s = samples[sampleCursor++ % samples.length];
      if (metric) s = Object.assign({}, s, { metric });
      return s;
    }

    function appendMany(n, metric) {
      const list = [];
      for (let i = 0; i < n; i++) list.push(...db.ingest(nextSample(metric)));
      return list;
    }

    $('promDemo').addEventListener('click', () => {
      db.reset();
      sampleCursor = 0;
      const list = [];
      list.push(...appendMany(8));
      list.push(...db.query({ job: 'api' }, 0, 120));
      list.push(...db.cutBlock());
      list.push(...appendMany(6, 'http_requests_total'));
      list.push(...db.cutBlock());
      list.push(...db.compactBlocks());
      run(list);
    });

    $('promAddCpu').addEventListener('click', () => run(db.ingest(nextSample('process_cpu_seconds_total'))));
    $('promAddHttp').addEventListener('click', () => run(db.ingest(nextSample('http_requests_total'))));
    $('promBurst').addEventListener('click', () => run(appendMany(7)));
    $('promQuery').addEventListener('click', () => run(db.query({ job: 'api' }, 0, 9999)));
    $('promCut').addEventListener('click', () => run(db.cutBlock()));
    $('promCompact').addEventListener('click', () => run(db.compactBlocks()));
    $('promReset').addEventListener('click', () => {
      db.reset();
      sampleCursor = 0;
      run([idle('초기화 완료 — scrape 샘플을 추가해 보세요')]);
    });
    $('promPlay').addEventListener('click', () => {
      if (playing) pause();
      else if (idx >= steps.length - 1 && steps.length) { idx = 0; show(0); play(); }
      else play();
    });
    $('promPrev').addEventListener('click', () => { pause(); if (idx > 0) { idx--; show(idx); } });
    $('promNext').addEventListener('click', () => { pause(); if (idx < steps.length - 1) { idx++; show(idx); } });
    $('promSpeed').addEventListener('input', (e) => { speed = parseFloat(e.target.value); $('promSpeedVal').textContent = speed.toFixed(1) + '×'; });

    db.bulk(samples.slice(0, 6));
    sampleCursor = 6;
    run([idle('예제 series 가 준비되었습니다. 샘플을 더 넣거나 job="api" 쿼리를 실행해 보세요')]);
  });
})();
