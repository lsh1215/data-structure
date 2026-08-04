/* ═══════════════════════════════════════════════════════════
   Skiplist 시각화 — 레벨 격자 + forward 포인터
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const { SkipList, MAXLEVEL } = window.SkipLib;

  const CELL_W = 62;
  const CELL_H = 22;
  const COL = 78;
  const ROW = 30;
  const LABEL_H = 44;
  const HEAD_X = 0;

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const stage = $('slStage');
    if (!stage) return;
    const world = $('slWorld');

    const sl = new SkipList();
    const cellEls = new Map();
    const labelEls = new Map();
    const arrowEls = new Map();
    const lvlEls = new Map();

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
      if (i >= steps.length - 1) { playing = false; $('slPlay').textContent = '▶ 재생'; drain(); return; }
      playing = true;
      $('slPlay').textContent = '❚❚ 정지';
      clearTimeout(timer);
      timer = setTimeout(() => { if (!playing) return; i++; show(i); play(); }, Math.round(820 / speed));
    }
    function pause() { playing = false; clearTimeout(timer); $('slPlay').textContent = '▶ 재생'; }
    function show(k) {
      const s = steps[k];
      if (!s) return;
      render(s);
      $('slStep').textContent = `step ${k + 1} / ${steps.length}`;
    }
    function renderIdle() {
      render({ kind: 'idle', msg: 'ZADD 로 원소를 넣어보세요', detail: '', deco: {}, snap: sl.snapshot() });
    }

    function render(step) {
      const snap = step.snap;
      const deco = step.deco || {};
      const n = snap.nodes.length;
      const levels = Math.max(1, snap.level);
      const totalW = (n + 1) * COL + 20;
      const totalH = levels * ROW + LABEL_H + 16;

      const avail = Math.max(240, stage.clientWidth - 40);
      const scale = Math.max(0.4, Math.min(1, avail / totalW));
      world.style.width = totalW + 'px';
      world.style.height = totalH + 'px';
      world.style.transformOrigin = 'top left';
      world.style.transform = `scale(${scale})`;
      world.parentElement.style.height = (totalH * scale + 12) + 'px';

      $('slKind').textContent = step.kind || 'idle';
      $('slKind').className = 'narr__kind narr__kind--' + (step.kind || 'idle');
      $('slMsg').textContent = step.msg || '';
      $('slDetail').textContent = step.detail || '—';
      $('slLen').textContent = snap.length;
      $('slLevel').textContent = snap.level;
      $('slPtr').textContent = snap.nodes.reduce((a, x) => a + x.level, 0);

      if (deco.rolls) {
        $('slDice').innerHTML = deco.rolls
          .map((r, k) => `<i class="${r ? 'ok' : 'no'}">${r ? `#${k + 1} < 0.25 ✓ 레벨+1` : '실패 → 중단'}</i>`)
          .join('');
      }

      const yOf = (lvl) => (levels - lvl) * ROW;      // lvl: 1-based
      const xOf = (idx) => (idx + 1) * COL + 10;      // idx: node index, head = -1
      const aliveC = new Set(); const aliveL = new Set(); const aliveA = new Set(); const aliveV = new Set();

      /* 레벨 라벨 */
      for (let l = 1; l <= levels; l++) {
        const k = 'lv' + l;
        aliveV.add(k);
        let el = lvlEls.get(k);
        if (!el) { el = document.createElement('div'); el.className = 'sl-lvl'; world.appendChild(el); lvlEls.set(k, el); }
        el.textContent = 'L' + l;
        el.style.transform = `translate(0px, ${yOf(l) + 5}px)`;
      }

      /* HEAD */
      for (let l = 1; l <= levels; l++) {
        const k = `c-1-${l}`;
        aliveC.add(k);
        let el = cellEls.get(k);
        if (!el) { el = document.createElement('div'); el.className = 'sl-cell sl-head'; world.appendChild(el); cellEls.set(k, el); }
        el.className = 'sl-cell sl-head' + (deco.cursor === 'HEAD' && deco.level === l - 1 ? ' sl-cell--hi' : '');
        el.style.width = CELL_W + 'px';
        el.style.height = CELL_H + 'px';
        el.style.transform = `translate(${HEAD_X + 10}px, ${yOf(l)}px)`;
        el.textContent = 'head';
      }
      {
        const k = 'lab--1';
        aliveL.add(k);
        let el = labelEls.get(k);
        if (!el) { el = document.createElement('div'); el.className = 'sl-label'; world.appendChild(el); labelEls.set(k, el); }
        el.style.width = CELL_W + 'px';
        el.style.height = '34px';
        el.style.transform = `translate(${HEAD_X + 10}px, ${levels * ROW + 6}px)`;
        el.innerHTML = '<b>HEAD</b><span>−∞</span>';
      }

      /* 노드 */
      snap.nodes.forEach((nd, ni) => {
        for (let l = 1; l <= nd.level; l++) {
          const k = `c${ni}-${l}`;
          aliveC.add(k);
          let el = cellEls.get(k);
          if (!el) { el = document.createElement('div'); el.className = 'sl-cell'; world.appendChild(el); cellEls.set(k, el); }
          const hi = deco.cursor === nd.member && deco.level === l - 1;
          el.className = 'sl-cell' + (hi ? ' sl-cell--hi' : '');
          el.style.width = CELL_W + 'px';
          el.style.height = CELL_H + 'px';
          el.style.transform = `translate(${xOf(ni)}px, ${yOf(l)}px)`;
          el.textContent = 'span ' + (nd.spans[l - 1] || 0);
        }
        const lk = 'lab' + ni;
        aliveL.add(lk);
        let lab = labelEls.get(lk);
        if (!lab) { lab = document.createElement('div'); lab.className = 'sl-label'; world.appendChild(lab); labelEls.set(lk, lab); }
        lab.className = 'sl-label' +
          (deco.newMember === nd.member ? ' sl-label--new' : '') +
          (deco.cursor === nd.member || deco.found === nd.member ? ' sl-label--hi' : '');
        lab.style.width = CELL_W + 'px';
        lab.style.height = '34px';
        lab.style.transform = `translate(${xOf(ni)}px, ${levels * ROW + 6}px)`;
        lab.innerHTML = `<b>${nd.score}</b><span>${nd.member}</span>`;
      });

      /* forward 화살표 */
      const drawArrow = (fromIdx, lvl, toIdx) => {
        const k = `a${fromIdx}-${lvl}`;
        aliveA.add(k);
        let el = arrowEls.get(k);
        if (!el) { el = document.createElement('div'); el.className = 'sl-arrow'; world.appendChild(el); arrowEls.set(k, el); }
        const x1 = (fromIdx === -1 ? HEAD_X + 10 : xOf(fromIdx)) + CELL_W;
        const x2 = toIdx === null ? x1 + 16 : xOf(toIdx);
        const active = (deco.path || []).some((p) => p.level === lvl - 1 &&
          ((p.from.member === 'HEAD' && fromIdx === -1) || (snap.nodes[fromIdx] && snap.nodes[fromIdx].member === p.from.member)));
        el.className = 'sl-arrow' + (active ? ' sl-arrow--hi' : '');
        el.style.width = Math.max(6, x2 - x1 - 4) + 'px';
        el.style.opacity = toIdx === null ? '.25' : '1';
        el.style.transform = `translate(${x1 + 2}px, ${yOf(lvl) + CELL_H / 2}px)`;
      };

      for (let l = 1; l <= levels; l++) drawArrow(-1, l, snap.head.forwards[l - 1]);
      snap.nodes.forEach((nd, ni) => {
        for (let l = 1; l <= nd.level; l++) drawArrow(ni, l, nd.forwards[l - 1]);
      });

      clean(cellEls, aliveC); clean(labelEls, aliveL); clean(arrowEls, aliveA); clean(lvlEls, aliveV);
    }

    function clean(map, alive) {
      for (const [k, el] of map) {
        if (alive.has(k)) continue;
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
        map.delete(k);
      }
    }

    /* ══════════ 데모 시나리오 ══════════ */
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const DEMO_SEED = 12; /* 레벨이 1,2,1,3,1,1 로 나와 설명하기 좋은 시드 */

    const SCENARIO = [
      {
        title: '연결 리스트 한 줄에서 시작한다',
        note: '가장 아래층(L1)에는 모든 원소가 정렬된 채로 들어간다. 여기까지는 그냥 정렬된 연결 리스트다.',
        ops: [{ t: 'reset' }, { t: 'add', s: 10, m: 'alice' }],
      },
      {
        title: '정렬 위치를 찾아 끼워 넣는다',
        note: 'HEAD 에서 오른쪽으로 달리다가 다음 원소가 더 크면 멈춘다. 그 자리가 새 원소가 들어갈 곳이다. 회전(rotation)도 재균형도 없다.',
        ops: [{ t: 'add', s: 25, m: 'bob' }, { t: 'add', s: 40, m: 'carol' }],
      },
      {
        title: '동전을 던져 층을 정한다',
        note: '1/4 확률로 계속 올라간다. 운 좋게 높은 층이 나온 노드는 아래층 원소들을 건너뛰는 고속도로가 된다. 평균 레벨은 1/(1−0.25) = 1.33 이다.',
        ops: [{ t: 'add', s: 55, m: 'dave' }],
      },
      {
        title: '원소가 늘어나도 규칙은 같다',
        note: '층이 높은 노드가 드문드문 생기면서 자연스럽게 이진 탐색과 비슷한 모양이 만들어진다. 아무도 균형을 맞춰주지 않는데 기대값으로 균형이 잡힌다.',
        ops: [{ t: 'add', s: 70, m: 'erin' }, { t: 'add', s: 85, m: 'frank' }],
      },
      {
        title: '탐색 — 위층에서 건너뛰고 막히면 내려온다',
        note: '최상위 층에서 오른쪽으로 달리다가 더 못 가면 한 층 내려간다. 이 과정이 O(log₄ N) 이고, 탐색은 항상 모든 원소가 있는 L1 에서 끝난다.',
        ops: [{ t: 'find', s: 70 }],
      },
      {
        title: 'span — 몇 칸을 건너뛰었는지 센다',
        note: '각 포인터에는 건너뛴 칸 수(span)가 함께 저장된다. 탐색하며 span 을 더하면 그 원소가 몇 번째인지 바로 나온다. ZRANK 와 ZRANGE 가 빠른 이유다.',
        ops: [{ t: 'find', s: 85 }],
      },
      {
        title: '삭제 — 층마다 포인터만 이어준다',
        note: '지울 노드가 속한 층마다 앞 노드의 forward 를 뒤 노드로 연결하고 span 을 합친다. 트리처럼 구조를 다시 맞출 일이 없다.',
        ops: [{ t: 'del', m: 'carol' }],
      },
    ];

    let uiMode = 'demo';
    let chapter = 0;

    function idleSnap(msg) {
      return { kind: 'idle', msg, detail: '', deco: {}, snap: sl.snapshot() };
    }

    function resetList(seeded) {
      const fresh = new SkipList(seeded ? mulberry32(DEMO_SEED) : Math.random);
      Object.assign(sl, fresh);
      cellEls.forEach((e) => e.remove()); cellEls.clear();
      labelEls.forEach((e) => e.remove()); labelEls.clear();
      arrowEls.forEach((e) => e.remove()); arrowEls.clear();
      lvlEls.forEach((e) => e.remove()); lvlEls.clear();
      $('slDice').innerHTML = '';
    }

    function runOp(op) {
      if (op.t === 'reset') { resetList(true); return [idleSnap('빈 skiplist — HEAD 만 있다')]; }
      if (op.t === 'add') return sl.insert(op.s, op.m);
      if (op.t === 'find') return sl.search(op.s);
      if (op.t === 'del') return sl.remove(op.m);
      return [];
    }

    function applyQuiet(ops) {
      for (const op of ops) {
        if (op.t === 'reset') { resetList(true); continue; }
        sl.quiet = true;
        if (op.t === 'add') sl.insert(op.s, op.m);
        else if (op.t === 'del') sl.remove(op.m);
        sl.quiet = false;
      }
    }

    function setChapter(k) {
      chapter = k;
      const act = SCENARIO[k];
      $('slChapNo').textContent = `CHAPTER ${String(k + 1).padStart(2, '0')} / ${String(SCENARIO.length).padStart(2, '0')}`;
      $('slChapTitle').textContent = act.title;
      $('slChapNote').textContent = act.note;
      $('slChapSel').value = String(k);
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
      resetList(true);
      for (let k = 0; k < start; k++) applyQuiet(SCENARIO[k].ops);
      for (let k = start; k < SCENARIO.length; k++) enqueueAct(k);
    }

    $('slChapSel').innerHTML = SCENARIO
      .map((a, k) => `<option value="${k}">${String(k + 1).padStart(2, '0')}. ${a.title}</option>`)
      .join('');
    $('slChapSel').addEventListener('change', (e) => runDemo(parseInt(e.target.value, 10)));
    $('slRestart').addEventListener('click', () => runDemo(0));
    $('slChapPrev').addEventListener('click', () => runDemo(Math.max(0, chapter - 1)));
    $('slChapNext').addEventListener('click', () => runDemo(Math.min(SCENARIO.length - 1, chapter + 1)));

    function setUiMode(m) {
      uiMode = m;
      document.querySelectorAll('#slUiToggle button').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.ui === m));
      });
      document.querySelectorAll('.sl-demo').forEach((el) => { el.hidden = m !== 'demo'; });
      document.querySelectorAll('.sl-lab').forEach((el) => { el.hidden = m !== 'lab'; });
      if (m === 'demo') runDemo(0);
      else {
        pause();
        queue.length = 0;
        steps = []; i = -1;
        resetList(false);
        mi = 4;
        sl.bulk([[10, 'alice'], [25, 'bob'], [40, 'carol'], [55, 'dave']]);
        render(idleSnap('실험실 — score 와 member 를 넣어보세요'));
      }
    }
    document.querySelectorAll('#slUiToggle button').forEach((b) => {
      b.addEventListener('click', () => setUiMode(b.dataset.ui));
    });

    /* ══════════ 실험실 컨트롤 ══════════ */
    const MEMBERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'ken', 'lily'];
    let mi = 0;

    $('slAdd').addEventListener('click', () => {
      const raw = $('slInput').value.trim();
      let score;
      let member;
      if (raw) {
        const p = raw.split(/\s+/);
        score = parseInt(p[0], 10);
        member = p[1] || 'u' + Math.floor(Math.random() * 900 + 100);
      } else {
        score = Math.floor(Math.random() * 99) + 1;
        member = MEMBERS[mi++ % MEMBERS.length] + (mi > MEMBERS.length ? mi : '');
      }
      if (Number.isNaN(score)) return;
      $('slInput').value = '';
      enqueue(() => sl.insert(score, member));
    });
    $('slInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('slAdd').click(); });

    $('slFind').addEventListener('click', () => {
      const nodes = sl.order();
      if (!nodes.length) return;
      const raw = parseInt($('slInput').value.trim(), 10);
      const target = Number.isNaN(raw) ? nodes[Math.floor(Math.random() * nodes.length)].score : raw;
      $('slInput').value = '';
      enqueue(() => sl.search(target));
    });

    $('slDel').addEventListener('click', () => {
      const nodes = sl.order();
      if (!nodes.length) return;
      const t = nodes[Math.floor(Math.random() * nodes.length)];
      enqueue(() => sl.remove(t.member));
    });

    $('slReset').addEventListener('click', () => {
      pause();
      queue.length = 0;
      resetList(false);
      mi = 0; steps = []; i = -1;
      render(idleSnap('초기화 완료 — ZADD 로 원소를 넣어보세요'));
    });

    /* ══════════ 재생 컨트롤 (공용) ══════════ */
    $('slPlay').addEventListener('click', () => {
      if (playing) pause();
      else if (i >= steps.length - 1 && steps.length) { i = 0; show(0); play(); }
      else play();
    });
    $('slPrev').addEventListener('click', () => { pause(); if (i > 0) { i--; show(i); } });
    $('slNext').addEventListener('click', () => { pause(); if (i < steps.length - 1) { i++; show(i); } else drain(); });
    $('slSpeed').addEventListener('input', (e) => { speed = parseFloat(e.target.value); });

    window.addEventListener('resize', () => { if (steps[i]) render(steps[i]); else renderIdle(); });

    setUiMode('demo');
  });
})();
