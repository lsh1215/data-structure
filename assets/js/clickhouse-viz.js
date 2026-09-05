/* ═══════════════════════════════════════════════════════════
   ClickHouse MergeTree visualizer
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const { ClickHouseMergeTree, STAGES, formatKey, demoBatches } = window.ClickHouseLib;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    if (!$('chParts')) return;

    const model = new ClickHouseMergeTree({ granuleSize: 4 });
    const batches = demoBatches();
    let batchCursor = 0;
    let steps = [];
    let idx = -1;
    let playing = false;
    let timer = null;
    let speed = 1.45;

    $('chPipe').innerHTML = STAGES.map(
      (s, i) => `<div class="pipe__stage" data-stage="${s.id}"><span class="pipe__num">${String(i).padStart(2, '0')}</span>${s.name}</div>`
    ).join('');
    const pipeEls = [...$('chPipe').querySelectorAll('.pipe__stage')];

    function idle(msg) {
      return { kind: 'idle', msg, detail: '', deco: {}, snap: model.snapshot() };
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
        $('chPlay').textContent = '▶ 재생';
        return;
      }
      playing = true;
      $('chPlay').textContent = '❚❚ 정지';
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!playing) return;
        idx++;
        show(idx);
        play();
      }, Math.round(900 / speed));
    }

    function pause() {
      playing = false;
      clearTimeout(timer);
      $('chPlay').textContent = '▶ 재생';
    }

    function show(i) {
      const step = steps[i];
      if (!step) return;
      render(step);
      $('chStep').textContent = `step ${i + 1} / ${steps.length}`;
      $('chBar').style.width = ((i + 1) / steps.length * 100) + '%';
    }

    function render(step) {
      const snap = step.snap;
      const deco = step.deco || {};
      const stageIndex = STAGES.findIndex((s) => s.id === deco.stage);
      pipeEls.forEach((el) => {
        const ix = STAGES.findIndex((s) => s.id === el.dataset.stage);
        el.classList.toggle('pipe__stage--now', el.dataset.stage === deco.stage);
        el.classList.toggle('pipe__stage--past', stageIndex >= 0 && ix < stageIndex);
      });

      $('chKind').textContent = step.kind || 'idle';
      $('chKind').className = 'narr__kind narr__kind--' + (step.kind || 'idle');
      $('chMsg').textContent = step.msg || '';
      $('chDetail').textContent = step.detail || '—';

      const readGranules = new Set(deco.readGranules || (snap.lastQuery && snap.lastQuery.readGranules) || []);
      const skippedGranules = new Set(deco.skippedGranules || (snap.lastQuery && snap.lastQuery.skippedGranules) || []);
      const matchedRows = new Set(deco.matchedRows || (snap.lastQuery && snap.lastQuery.matchedRows) || []);
      const activeMarks = new Set(deco.activeMarks || []);
      const activeParts = new Set(deco.activeParts || []);

      $('chParts').innerHTML = snap.parts.length
        ? snap.parts.map((p) => `<div class="part-card${deco.activePart === p.id || activeParts.has(p.id) ? ' part-card--active' : ''}">
            <div class="part-card__head"><b>${p.id}</b><span>level ${p.level} · ${p.rows.length} rows</span></div>
            <div class="part-card__body">
              <div class="part-meta">
                <span>${p.granules.length} granules</span>
                <span>${p.marks.length} marks</span>
                <span>ORDER BY service, day, ts</span>
              </div>
              <div class="marks-list" style="margin-bottom:10px">
                ${p.marks.map((m) => `<span class="mark-pill${activeMarks.has(`${p.id}:${m.no}`) ? ' mark-pill--active' : ''}">m${m.no} ${esc(formatKey(m.key))}</span>`).join('')}
              </div>
              <div class="granule-grid">
                ${p.granules.map((g) => renderGranule(p, g, readGranules, skippedGranules, matchedRows)).join('')}
              </div>
            </div>
          </div>`).join('')
        : '<p class="muted mono" style="font-size:12px">아직 data part 가 없습니다</p>';

      const totalRows = snap.parts.reduce((a, p) => a + p.rows.length, 0);
      const totalMarks = snap.parts.reduce((a, p) => a + p.marks.length, 0);
      const totalGranules = snap.parts.reduce((a, p) => a + p.granules.length, 0);
      const q = snap.lastQuery;
      $('chPartsN').textContent = snap.parts.length;
      $('chRowsN').textContent = totalRows;
      $('chMarksN').textContent = totalMarks;
      $('chReadN').textContent = q ? `${q.rowsRead}/${q.totalRows}` : '—';
      $('chMatchedN').textContent = q ? q.matchedRows.length : '—';
      $('chSkippedN').textContent = q ? `${q.skippedGranules.length}/${totalGranules}` : '—';

      $('chQueryBox').innerHTML = q
        ? `<strong>최근 쿼리</strong><br>${esc(model.describePredicate(q.pred))}<br>읽은 granule: ${q.readGranules.map(esc).join(', ') || '없음'}<br>건너뛴 granule: ${q.skippedGranules.map(esc).join(', ') || '없음'}`
        : '<strong>최근 쿼리</strong><br>아직 실행하지 않았습니다';
    }

    function renderGranule(part, g, readGranules, skippedGranules, matchedRows) {
      const gid = `${part.id}:${g.no}`;
      const cls = 'granule' +
        (readGranules.has(gid) ? ' granule--read' : '') +
        (skippedGranules.has(gid) ? ' granule--skip' : '') +
        (g.rows.some((r) => matchedRows.has(r.id)) ? ' granule--match' : '');
      return `<div class="${cls}">
        <div class="granule__h"><b>g${g.no}</b><span>${esc(formatKey(g.mark))}</span></div>
        ${g.rows.map((r) => `<div class="row-mini${matchedRows.has(r.id) ? ' row-mini--match' : ''}">
          <span>#${r.id} ${esc(r.service)} · ${esc(r.day.slice(5))} · ${esc(r.endpoint)}</span>
          <span>${r.status}</span>
        </div>`).join('')}
      </div>`;
    }

    function nextBatch() {
      return batches[batchCursor++ % batches.length];
    }

    $('chDemo').addEventListener('click', () => {
      model.reset();
      batchCursor = 0;
      const list = [];
      list.push(...model.insertRows(nextBatch()));
      list.push(...model.insertRows(nextBatch()));
      list.push(...model.query({ service: 'api', fromDay: '2026-09-04', toDay: '2026-09-04', status: 200 }));
      list.push(...model.mergeParts());
      list.push(...model.query({ service: 'checkout', fromDay: '2026-09-04', toDay: '2026-09-05' }));
      run(list);
    });

    $('chInsert').addEventListener('click', () => run(model.insertRows(nextBatch())));
    $('chInsert2').addEventListener('click', () => {
      const list = [];
      list.push(...model.insertRows(nextBatch()));
      list.push(...model.insertRows(nextBatch()));
      run(list);
    });
    $('chQueryApi').addEventListener('click', () => run(model.query({ service: 'api', fromDay: '2026-09-04', toDay: '2026-09-04', status: 200 })));
    $('chQueryDateOnly').addEventListener('click', () => run(model.query({ fromDay: '2026-09-04', toDay: '2026-09-04' })));
    $('chMerge').addEventListener('click', () => run(model.mergeParts()));
    $('chReset').addEventListener('click', () => {
      model.reset();
      batchCursor = 0;
      run([idle('초기화 완료 — INSERT batch 를 추가해 보세요')]);
    });
    $('chPlay').addEventListener('click', () => {
      if (playing) pause();
      else if (idx >= steps.length - 1 && steps.length) { idx = 0; show(0); play(); }
      else play();
    });
    $('chPrev').addEventListener('click', () => { pause(); if (idx > 0) { idx--; show(idx); } });
    $('chNext').addEventListener('click', () => { pause(); if (idx < steps.length - 1) { idx++; show(idx); } });
    $('chSpeed').addEventListener('input', (e) => { speed = parseFloat(e.target.value); $('chSpeedVal').textContent = speed.toFixed(1) + '×'; });

    model.bulkInsert([nextBatch()]);
    run([idle('예제 part 하나가 준비되었습니다. 쿼리를 실행해서 granule pruning 을 확인해 보세요')]);
  });
})();
