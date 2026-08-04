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

    /* ══════════ 데모 시나리오 ══════════ */
    const SCENARIO = [
      {
        title: '문서 하나를 색인한다',
        note: '원문 → 태그 제거 → 토큰 분리 → 소문자 → 불용어 제거 → 어간 추출. 이 여섯 단계를 거쳐 나온 토큰만 역색인에 들어간다.',
        ops: [{ t: 'reset' }, { t: 'doc', text: SEED[0] }],
      },
      {
        title: '문서가 늘면 posting list 가 자란다',
        note: 'term 은 정렬된 채로 유지되고, 각 term 아래에는 그 단어가 등장한 문서 번호와 등장 횟수(tf)가 쌓인다. df 는 그 term 이 나온 문서 수다.',
        ops: [{ t: 'doc', text: SEED[1] }, { t: 'doc', text: SEED[2] }, { t: 'doc', text: SEED[3] }],
      },
      {
        title: '검색어도 똑같은 analyzer 를 거친다',
        note: '"The Hash Tables" 는 색인할 때와 같은 파이프라인을 지나 hash, table 이 된다. 색인과 검색의 analyzer 가 다르면 영원히 매칭되지 않는다.',
        ops: [{ t: 'search', q: 'The Hash Tables', mode: 'AND' }],
      },
      {
        title: 'AND 는 posting list 의 교집합이다',
        note: '문서 번호가 오름차순으로 정렬돼 있어 두 리스트를 한 번씩만 훑으면 교집합이 나온다. 짧은 리스트부터 맞춰야 비교가 줄어든다.',
        ops: [{ t: 'search', q: 'index tree', mode: 'AND' }],
      },
      {
        title: 'OR 는 합집합이다',
        note: '같은 검색어라도 불리언 연산이 달라지면 결과 집합이 달라진다. 실제 Elasticsearch 의 match 쿼리는 기본이 OR 이고, minimum_should_match 로 조절한다.',
        ops: [{ t: 'search', q: 'index tree', mode: 'OR' }],
      },
      {
        title: 'BM25 — 순위는 마법이 아니라 수식이다',
        note: '같은 단어를 담은 두 문서의 점수가 갈리는 이유는 세 가지뿐이다. 흔한 단어인가(idf), 몇 번 나왔는가(tf), 문서가 얼마나 긴가(dl/avgdl).',
        ops: [{ t: 'search', q: 'hash table', mode: 'AND' }],
      },
    ];

    let uiMode = 'demo';
    let chapter = 0;
    let seedIdx = 0;

    function idleSnap(msg) {
      return { kind: 'idle', msg, detail: '', deco: {}, snap: ix.snapshot() };
    }

    function runOp(op) {
      if (op.t === 'reset') { ix.reset(); $('esTokens').innerHTML = ''; return [idleSnap('빈 인덱스에서 시작한다')]; }
      if (op.t === 'doc') return ix.addDocument(op.text);
      if (op.t === 'search') { $('esQuery').value = op.q; setMode(op.mode); return ix.search(op.q, op.mode); }
      return [];
    }

    function applyQuiet(ops) {
      for (const op of ops) {
        if (op.t === 'reset') { ix.reset(); continue; }
        if (op.t === 'doc') { ix.quiet = true; ix.addDocument(op.text); ix.quiet = false; }
      }
    }

    function setChapter(k) {
      chapter = k;
      const act = SCENARIO[k];
      $('esChapNo').textContent = `CHAPTER ${String(k + 1).padStart(2, '0')} / ${String(SCENARIO.length).padStart(2, '0')}`;
      $('esChapTitle').textContent = act.title;
      $('esChapNote').textContent = act.note;
      $('esChapSel').value = String(k);
    }

    function enqueueAct(k) {
      const act = SCENARIO[k];
      enqueue(() => { setChapter(k); return [idleSnap(act.note)]; });
      act.ops.forEach((op) => enqueue(() => runOp(op)));
    }

    function runDemo(from) {
      pause();
      queue.length = 0;
      steps = []; i = -1;
      const start = from || 0;
      ix.reset();
      $('esTokens').innerHTML = '';
      for (let k = 0; k < start; k++) applyQuiet(SCENARIO[k].ops);
      for (let k = start; k < SCENARIO.length; k++) enqueueAct(k);
    }

    $('esChapSel').innerHTML = SCENARIO
      .map((a, k) => `<option value="${k}">${String(k + 1).padStart(2, '0')}. ${a.title}</option>`)
      .join('');
    $('esChapSel').addEventListener('change', (e) => runDemo(parseInt(e.target.value, 10)));
    $('esRestart').addEventListener('click', () => runDemo(0));
    $('esChapPrev').addEventListener('click', () => runDemo(Math.max(0, chapter - 1)));
    $('esChapNext').addEventListener('click', () => runDemo(Math.min(SCENARIO.length - 1, chapter + 1)));

    function setMode(m) {
      mode = m;
      document.querySelectorAll('#esMode button').forEach((x) => {
        x.setAttribute('aria-pressed', String(x.dataset.mode === m));
      });
    }

    function setUiMode(m) {
      uiMode = m;
      document.querySelectorAll('#esUiToggle button').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.ui === m));
      });
      document.querySelectorAll('.es-demo').forEach((el) => { el.hidden = m !== 'demo'; });
      document.querySelectorAll('.es-lab').forEach((el) => { el.hidden = m !== 'lab'; });
      if (m === 'demo') runDemo(0);
      else {
        pause();
        queue.length = 0;
        steps = []; i = -1;
        ix.reset();
        ix.bulk(SEED.slice(0, 3));
        seedIdx = 3;
        $('esTokens').innerHTML = '';
        render(idleSnap('실험실 — 문서를 색인하거나 검색어를 넣어보세요'));
        $('esStep').textContent = 'step 0 / 0';
        $('esBar').style.width = '0%';
      }
    }
    document.querySelectorAll('#esUiToggle button').forEach((b) => {
      b.addEventListener('click', () => setUiMode(b.dataset.ui));
    });

    /* ══════════ 실험실 컨트롤 ══════════ */
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
      b.addEventListener('click', () => setMode(b.dataset.mode));
    });

    $('esReset').addEventListener('click', () => {
      pause(); queue.length = 0;
      ix.reset();
      seedIdx = 0;
      steps = []; i = -1;
      $('esTokens').innerHTML = '';
      render(idleSnap('초기화 완료 — 문서를 색인해 보세요'));
      $('esStep').textContent = 'step 0 / 0';
      $('esBar').style.width = '0%';
    });

    /* ══════════ 재생 컨트롤 (공용) ══════════ */
    $('esPlay').addEventListener('click', () => {
      if (playing) pause();
      else if (i >= steps.length - 1 && steps.length) { i = 0; show(0); play(); }
      else play();
    });
    $('esPrev').addEventListener('click', () => { pause(); if (i > 0) { i--; show(i); } });
    $('esNext').addEventListener('click', () => { pause(); if (i < steps.length - 1) { i++; show(i); } else drain(); });
    $('esSpeed').addEventListener('input', (e) => { speed = parseFloat(e.target.value); });

    setUiMode('demo');

    /* ══════════ 2. 세그먼트 ══════════ */
    const seg = new SegmentEngine();
    let segSteps = [];
    let si = -1;
    let segTimer = null;
    let segQueue = [];

    function segEnqueue(fn) {
      segQueue.push(fn);
      if (segTimer === null && si >= segSteps.length - 1) segDrain();
    }
    function segDrain() {
      if (!segQueue.length) return;
      const list = segQueue.shift()();
      if (!list || !list.length) return segDrain();
      segPlay(list);
    }
    function segPlay(list) {
      segSteps = list; si = 0; segShow(0);
      clearInterval(segTimer);
      segTimer = setInterval(() => {
        if (si >= segSteps.length - 1) { clearInterval(segTimer); segTimer = null; segDrain(); return; }
        si++; segShow(si);
      }, 1000);
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

    function segIdle(msg) {
      return { kind: 'idle', msg, detail: '', deco: {}, snap: seg.snapshot() };
    }

    $('segDemo').addEventListener('click', () => {
      clearInterval(segTimer); segTimer = null;
      segQueue = [];
      seg.reset();
      segRender(segIdle('시나리오 시작 — 색인 요청이 들어온다'));
      segEnqueue(() => seg.index(3));
      segEnqueue(() => seg.refresh());
      segEnqueue(() => seg.index(2));
      segEnqueue(() => seg.refresh());
      segEnqueue(() => seg.deleteDoc());
      segEnqueue(() => seg.index(2));
      segEnqueue(() => seg.refresh());
      segEnqueue(() => seg.merge());
      segEnqueue(() => seg.flush());
    });

    $('segIndex').addEventListener('click', () => segEnqueue(() => seg.index(3)));
    $('segRefresh').addEventListener('click', () => segEnqueue(() => seg.refresh()));
    $('segFlush').addEventListener('click', () => segEnqueue(() => seg.flush()));
    $('segMerge').addEventListener('click', () => segEnqueue(() => seg.merge()));
    $('segDelete').addEventListener('click', () => segEnqueue(() => seg.deleteDoc()));
    $('segReset').addEventListener('click', () => {
      clearInterval(segTimer); segTimer = null;
      segQueue = [];
      seg.reset();
      segSteps = []; si = -1;
      segRender(segIdle('색인 요청부터 시작해 보세요'));
    });

    segRender(segIdle('▶ 시나리오 재생을 누르면 색인 → refresh → 삭제 → merge → flush 가 순서대로 흘러갑니다'));
  });
})();
