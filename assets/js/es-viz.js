/* ═══════════════════════════════════════════════════════════
   Elasticsearch 시각화 — analyzer · 역색인 · 검색 · 세그먼트
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const { InvertedIndex, SegmentEngine, ANALYZER_STAGES } = window.ESLib;

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    if (!$('esIndex')) return;

    /* ══════════ 1. 색인 / 검색 ══════════ */
    const ix = new InvertedIndex();
    let mode = 'AND';

    const PIPE = ANALYZER_STAGES.concat([
      { id: 'index', name: 'inverted index', desc: 'term → posting list 반영' },
      { id: 'query', name: 'query analyze', desc: '검색어에 같은 analyzer 적용' },
      { id: 'dict', name: 'term dictionary', desc: 'FST 로 term 조회' },
      { id: 'merge', name: 'posting merge', desc: 'AND/OR 병합' },
      { id: 'score', name: 'BM25 score', desc: '점수 계산 · 정렬' },
    ]);
    $('esPipe').innerHTML = PIPE.map(
      (s, i) => `<div class="pipe__stage" data-stage="${s.id}"><span class="pipe__num">${String(i).padStart(2, '0')}</span>${s.name}</div>`
    ).join('');
    const pipeEls = [...$('esPipe').querySelectorAll('.pipe__stage')];

    let steps = [];
    let i = -1;
    let playing = false;
    let timer = null;
    let speed = 1.6;
    const queue = [];

    function enqueue(fn) { queue.push(fn); if (!playing && i >= steps.length - 1) drain(); }
    function drain() {
      if (!queue.length) return;   /* 마지막 스텝 화면을 유지한다 */
      const st = queue.shift()();
      if (!st || !st.length) return drain();
      steps = st; i = 0; show(0); play();
    }
    function play() {
      if (i >= steps.length - 1) { playing = false; $('esPlay').textContent = '▶ 재생'; drain(); return; }
      playing = true;
      $('esPlay').textContent = '❚❚ 정지';
      clearTimeout(timer);
      timer = setTimeout(() => { if (!playing) return; i++; show(i); play(); }, Math.round(900 / speed));
    }
    function pause() { playing = false; clearTimeout(timer); $('esPlay').textContent = '▶ 재생'; }
    function show(k) {
      const s = steps[k];
      if (!s) return;
      render(s);
      $('esStep').textContent = `step ${k + 1} / ${steps.length}`;
      $('esBar').style.width = ((k + 1) / steps.length * 100) + '%';
    }
    function renderIdle() {
      render({ kind: 'idle', msg: '문서를 색인하거나 검색해 보세요', detail: '', deco: {}, snap: ix.snapshot() });
    }

    function render(step) {
      const snap = step.snap;
      const deco = step.deco || {};

      pipeEls.forEach((el) => {
        el.classList.toggle('pipe__stage--now', el.dataset.stage === deco.stage);
      });

      $('esKind').textContent = step.kind || 'idle';
      $('esKind').className = 'narr__kind narr__kind--' + (step.kind || 'idle');
      $('esMsg').textContent = step.msg || '';
      $('esDetail').textContent = step.detail || '—';

      /* 토큰 흐름 */
      if (deco.tokens) {
        $('esTokens').innerHTML = deco.tokens
          .map((t) => `<span class="tok ${t.cls === 'gone' ? 'tok--gone' : t.cls === 'changed' ? 'tok--changed' : ''} ${deco.stage === 'raw' || deco.stage === 'char' ? 'tok--raw' : ''}">${esc(t.t)}</span>`)
          .join('');
      } else if (deco.qterms) {
        $('esTokens').innerHTML = deco.qterms
          .map((t) => `<span class="tok tok--changed">${esc(t)}</span>`)
          .join('');
      }

      /* 문서 목록 */
      const ranked = deco.ranked ? new Map(deco.ranked.map((r) => [r.doc, r.score])) : null;
      const maxScore = ranked ? Math.max(...deco.ranked.map((r) => r.score), 0.0001) : 1;
      const matched = new Set(deco.matchDocs || []);
      $('esDocs').innerHTML = snap.docs.length
        ? snap.docs.map((d) => {
          const cls = 'doc-card' +
            (deco.activeDoc === d.id || deco.docId === d.id ? ' doc-card--active' : '') +
            (matched.has(d.id) ? ' doc-card--match' : '');
          const sc = ranked && ranked.has(d.id) ? ranked.get(d.id) : null;
          return `<div class="${cls}">
              <div class="doc-card__h"><span>doc #${d.id}</span><span>${d.len} terms${sc !== null ? '' : ''}</span></div>
              <div class="doc-card__t">${esc(d.text)}</div>
              ${sc !== null ? `<div class="doc-card__h" style="margin-top:5px"><span class="doc-card__score">BM25 ${sc.toFixed(4)}</span></div>
              <div class="doc-card__bar"><i style="width:${(sc / maxScore * 100).toFixed(1)}%"></i></div>` : ''}
            </div>`;
        }).join('')
        : '<p class="muted mono" style="font-size:12px">아직 색인된 문서가 없습니다</p>';

      /* 역색인 */
      const qset = new Set(deco.qterms || []);
      const rows = snap.terms.map((t) => {
        const cls = 'ix-row' +
          (deco.activeTerm === t.term ? ' ix-row--active' : '') +
          (qset.has(t.term) ? ' ix-row--q' : '') +
          (deco.newTerm === t.term ? ' ix-row--new' : '');
        const chips = t.postings.map((p) => {
          const hit = deco.docId === p.doc || matched.has(p.doc) || deco.activeDoc === p.doc;
          return `<span class="post-chip${hit ? ' post-chip--hit' : ''}">#${p.doc}<b>:${p.tf}</b></span>`;
        }).join('');
        return `<div class="${cls}"><span class="ix-term">${esc(t.term)}</span><span class="ix-df">df ${t.df}</span><span class="ix-post">${chips}</span></div>`;
      }).join('');
      $('esIndex').innerHTML =
        '<div class="ix-row ix-row--head"><span>term</span><span>df</span><span>posting list (doc:tf)</span></div>' +
        (rows || '<p class="muted mono" style="font-size:12px">비어 있음</p>');

      /* 통계 */
      $('esN').textContent = snap.N;
      $('esTerms').textContent = snap.terms.length;
      $('esAvgdl').textContent = snap.avgdl.toFixed(1);
      $('esPostings').textContent = snap.terms.reduce((a, t) => a + t.df, 0);
    }

    const SEED = [
      'Redis stores every key in an in-memory hash table',
      'Elasticsearch builds an inverted index for full text search',
      'A relational database index uses a B+Tree on disk',
      'The hash table lookup is O(1) but a tree lookup is logarithmic',
    ];
    let seedIdx = 0;

    $('esAdd').addEventListener('click', () => {
      const v = $('esInput').value.trim();
      if (!v) return;
      $('esInput').value = '';
      enqueue(() => ix.addDocument(v));
    });
    $('esInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('esAdd').click(); });

    $('esSeed').addEventListener('click', () => {
      if (seedIdx >= SEED.length) seedIdx = 0;
      const t = SEED[seedIdx++];
      enqueue(() => ix.addDocument(t));
    });

    $('esSearch').addEventListener('click', () => {
      const q = $('esQuery').value.trim();
      if (!q) return;
      enqueue(() => ix.search(q, mode));
    });
    $('esQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('esSearch').click(); });

    document.querySelectorAll('#esMode button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#esMode button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        mode = b.dataset.mode;
      });
    });

    $('esReset').addEventListener('click', () => {
      pause(); queue.length = 0;
      ix.reset();
      seedIdx = 0;
      steps = []; i = -1;
      $('esTokens').innerHTML = '';
      renderIdle();
      $('esStep').textContent = 'step 0 / 0';
      $('esBar').style.width = '0%';
    });

    $('esPlay').addEventListener('click', () => {
      if (playing) pause();
      else if (i >= steps.length - 1 && steps.length) { i = 0; show(0); play(); }
      else play();
    });
    $('esPrev').addEventListener('click', () => { pause(); if (i > 0) { i--; show(i); } });
    $('esNext').addEventListener('click', () => { pause(); if (i < steps.length - 1) { i++; show(i); } else drain(); });
    $('esSpeed').addEventListener('input', (e) => { speed = parseFloat(e.target.value); });

    ix.bulk(SEED.slice(0, 3));
    seedIdx = 3;
    renderIdle();

    /* ══════════ 2. 세그먼트 ══════════ */
    const seg = new SegmentEngine();
    let segSteps = [];
    let si = -1;
    let segTimer = null;

    function segPlay(list) {
      segSteps = list; si = 0; segShow(0);
      clearInterval(segTimer);
      segTimer = setInterval(() => {
        if (si >= segSteps.length - 1) { clearInterval(segTimer); return; }
        si++; segShow(si);
      }, 900);
    }
    function segShow(k) {
      const s = segSteps[k];
      if (!s) return;
      segRender(s);
    }
    function segRender(step) {
      const snap = step.snap;
      const deco = step.deco || {};
      $('segMsg').textContent = step.msg || '';
      $('segDetail').textContent = step.detail || '—';
      $('segKind').textContent = step.kind || 'idle';
      $('segKind').className = 'narr__kind narr__kind--' + (step.kind || 'idle');

      $('segBuffer').className = 'seg-box' + (deco.hot === 'buffer' ? ' seg-box--hot' : '');
      $('segBuffer').innerHTML = snap.buffer.length
        ? snap.buffer.map((d) => `<span class="doc-chip">${d}</span>`).join('')
        : '<span class="seg-immutable">비어 있음 — refresh 후 초기화됨</span>';

      $('segTranslog').className = 'seg-box' + (deco.hot === 'translog' ? ' seg-box--hot' : '');
      $('segTranslog').innerHTML = snap.translog.length
        ? snap.translog.map((d) => `<span class="doc-chip">${d}</span>`).join('')
        : '<span class="seg-immutable">비어 있음 — flush 로 fsync 완료</span>';

      $('segList').innerHTML = snap.segments.length
        ? snap.segments.map((s) => `
          <div class="segment${deco.hot === s.id ? ' segment--hot' : ''}">
            <div class="segment__h"><b>${s.id}</b><span>${s.docs.length - s.deleted.length} live</span></div>
            <div class="segment__docs">${s.docs.map((d) => `<span class="doc-chip${s.deleted.includes(d) ? ' doc-chip--del' : ''}">${d}</span>`).join('')}</div>
            <div class="seg-immutable" style="margin-top:5px">immutable</div>
          </div>`).join('')
        : '<span class="seg-immutable">세그먼트 없음 — 아직 검색되지 않는다</span>';

      $('segCount').textContent = snap.segments.length;
      $('segLive').textContent = snap.segments.reduce((a, s) => a + s.docs.length - s.deleted.length, 0);
      $('segDel').textContent = snap.segments.reduce((a, s) => a + s.deleted.length, 0);
    }

    $('segIndex').addEventListener('click', () => segPlay(seg.index(3)));
    $('segRefresh').addEventListener('click', () => segPlay(seg.refresh()));
    $('segFlush').addEventListener('click', () => segPlay(seg.flush()));
    $('segMerge').addEventListener('click', () => segPlay(seg.merge()));
    $('segDelete').addEventListener('click', () => segPlay(seg.deleteDoc()));
    $('segReset').addEventListener('click', () => {
      clearInterval(segTimer);
      seg.reset();
      segRender({ kind: 'idle', msg: '색인 요청부터 시작해 보세요', detail: '', deco: {}, snap: seg.snapshot() });
    });

    segRender({ kind: 'idle', msg: '색인 요청부터 시작해 보세요', detail: '', deco: {}, snap: seg.snapshot() });
  });
})();
