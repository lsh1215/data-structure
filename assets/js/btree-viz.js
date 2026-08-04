/* ═══════════════════════════════════════════════════════════
   B-Tree / B+Tree visualizer
   - 스냅샷 기반 렌더 + 자체 rAF 트윈(노드/간선 동기화)
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const { BTree } = window.BTreeLib;

  const PTR_W = 14;
  const PAD = 5;
  const NODE_H = 42;
  const LEVEL_H = 98;
  const GAP = 22;

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  /* ── 레이아웃 계산 ── */
  function layout(snap) {
    const byId = new Map(snap.nodes.map((n) => [n.id, n]));
    let maxLen = 1;
    for (const n of snap.nodes) for (const k of n.keys) maxLen = Math.max(maxLen, String(k).length);
    const KEY_W = Math.max(34, 12 + maxLen * 9);

    const nodeW = (n) =>
      n.leaf
        ? Math.max(46, PAD * 2 + Math.max(1, n.keys.length) * KEY_W)
        : PAD * 2 + (n.keys.length + 1) * PTR_W + n.keys.length * KEY_W;

    const sw = new Map();
    const measure = (n) => {
      const w = nodeW(n);
      if (!n.childIds.length) { sw.set(n.id, w); return w; }
      let cw = 0;
      n.childIds.forEach((cid, i) => { cw += measure(byId.get(cid)); if (i) cw += GAP; });
      const total = Math.max(w, cw);
      sw.set(n.id, total);
      return total;
    };
    const rootNode = byId.get(snap.rootId);
    measure(rootNode);

    const pos = new Map();
    const assign = (n, left) => {
      const band = sw.get(n.id);
      const w = nodeW(n);
      if (!n.childIds.length) {
        pos.set(n.id, { x: left + band / 2, y: n.depth * LEVEL_H, w, keyW: KEY_W });
        return;
      }
      let cw = 0;
      n.childIds.forEach((cid, i) => { cw += sw.get(cid); if (i) cw += GAP; });
      let cx = left + (band - cw) / 2;
      n.childIds.forEach((cid) => { assign(byId.get(cid), cx); cx += sw.get(cid) + GAP; });
      const a = pos.get(n.childIds[0]);
      const b = pos.get(n.childIds[n.childIds.length - 1]);
      pos.set(n.id, { x: (a.x + b.x) / 2, y: n.depth * LEVEL_H, w, keyW: KEY_W });
    };
    assign(rootNode, 0);

    return {
      pos,
      keyW: KEY_W,
      totalW: sw.get(snap.rootId),
      totalH: (snap.height - 1) * LEVEL_H + NODE_H,
    };
  }

  const SVGNS = 'http://www.w3.org/2000/svg';

  class TreeViz {
    constructor(opts) {
      this.stage = opts.stage;
      this.world = opts.world;
      this.svg = opts.svg;
      this.nodesLayer = opts.nodesLayer;
      this.onStep = opts.onStep || (() => {});
      this.onIdle = opts.onIdle || (() => {});

      this.views = new Map();   // id -> view
      this.edges = new Map();   // key -> path el
      this.links = new Map();
      this.steps = [];
      this.i = -1;
      this.playing = false;
      this.timer = null;
      this.speed = 1.4;
      this.opQueue = [];
      this.rafId = null;
      this.tween = null;

      window.addEventListener('resize', () => this.reflow());
    }

    get delay() { return Math.round(760 / this.speed); }
    get moveMs() { return Math.min(this.delay * 0.8, 520); }

    /* ── 조작 큐 ── */
    enqueue(fn) {
      this.opQueue.push(fn);
      if (!this.playing && this.i >= this.steps.length - 1) this.drain();
    }

    drain() {
      if (!this.opQueue.length) { this.onIdle(); return; }
      const fn = this.opQueue.shift();
      const steps = fn();
      if (!steps || !steps.length) { this.drain(); return; }
      this.load(steps, true);
    }

    load(steps, autoplay) {
      this.steps = steps;
      this.i = 0;
      this.show(0);
      if (autoplay) this.play();
      else this.onStep(this.steps[0], 0, this.steps.length);
    }

    play() {
      if (this.i >= this.steps.length - 1) {
        this.playing = false;
        this.drain();
        return;
      }
      this.playing = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (!this.playing) return;
        this.next();
        this.play();
      }, this.delay);
      this.onStep(this.steps[this.i], this.i, this.steps.length);
    }

    pause() { this.playing = false; clearTimeout(this.timer); }

    toggle() {
      if (this.playing) this.pause();
      else if (this.i >= this.steps.length - 1 && this.steps.length) { this.i = 0; this.show(0); this.play(); }
      else this.play();
    }

    next() {
      if (this.i < this.steps.length - 1) { this.i++; this.show(this.i); }
      else { this.playing = false; this.drain(); }
    }

    prev() {
      this.pause();
      if (this.i > 0) { this.i--; this.show(this.i, true); }
    }

    jumpEnd() {
      this.pause();
      if (this.steps.length) { this.i = this.steps.length - 1; this.show(this.i, true); }
    }

    show(i, instant) {
      const step = this.steps[i];
      if (!step) return;
      this.render(step, instant);
      this.onStep(step, i, this.steps.length);
    }

    /* ── 렌더 ── */
    renderSnapshot(snap) {
      this.render({ tree: snap, deco: {}, kind: 'idle', msg: '' }, true);
    }

    reflow() {
      if (this.lastStep) this.render(this.lastStep, true);
    }

    render(step, instant) {
      this.lastStep = step;
      const snap = step.tree;
      const deco = step.deco || {};
      const L = layout(snap);
      this.layoutInfo = L;

      /* 스케일 & 중앙 정렬 */
      const availW = Math.max(200, this.stage.clientWidth - 32);
      let scale = Math.min(1, availW / Math.max(1, L.totalW));
      scale = Math.max(scale, 0.42);
      const dispW = L.totalW * scale;
      this.world.style.width = L.totalW + 'px';
      this.world.style.height = (L.totalH + 26) + 'px';
      this.world.style.transformOrigin = 'top left';
      this.world.style.transform = `translateX(${Math.max(0, (availW - dispW) / 2)}px) scale(${scale})`;
      this.world.parentElement.style.height = (L.totalH * scale + 44) + 'px';
      this.svg.setAttribute('viewBox', `0 0 ${L.totalW} ${L.totalH + 26}`);
      this.svg.style.width = L.totalW + 'px';
      this.svg.style.height = (L.totalH + 26) + 'px';

      const byId = new Map(snap.nodes.map((n) => [n.id, n]));
      const alive = new Set();
      const dying = new Set(deco.dying || []);

      for (const n of snap.nodes) {
        alive.add(n.id);
        const p = L.pos.get(n.id);
        const tx = p.x - p.w / 2;
        const ty = p.y + 18;

        let v = this.views.get(n.id);
        if (!v) {
          const el = document.createElement('div');
          el.className = 'bt-node bt-node--enter';
          el.innerHTML = '<div class="bt-node__tag"></div><div class="bt-node__cells"></div>';
          this.nodesLayer.appendChild(el);
          v = { el, cells: el.lastChild, tag: el.firstChild, x: tx, y: ty };
          /* 새 노드는 "태어난 자리"(분할된 원본 노드 또는 부모)에서 출발한다 */
          const bornId = (deco.bornFrom && deco.bornFrom[n.id]) != null
            ? deco.bornFrom[n.id]
            : n.parentId;
          const srcV = bornId != null ? this.views.get(bornId) : null;
          if (srcV) { v.x = srcV.x; v.y = srcV.y; }
          this.views.set(n.id, v);
        }
        v.meta = { keys: n.keys, leaf: n.leaf, w: p.w, keyW: L.keyW };
        v.fx = v.x; v.fy = v.y;
        v.tx = tx; v.ty = ty;

        /* 셀 내용 */
        const keyHi = (deco.keyHi && deco.keyHi[n.id]) || [];
        const keyNew = (deco.keyNew && deco.keyNew[n.id]) || [];
        const ptrHi = (deco.ptrHi && deco.ptrHi[n.id]) || [];
        const sig = JSON.stringify([n.keys, keyHi, keyNew, ptrHi, n.leaf, L.keyW]);
        if (v.sig !== sig) {
          v.sig = sig;
          let html = '';
          if (n.leaf) {
            if (!n.keys.length) html = `<span class="bt-key" style="width:${p.w - PAD * 2}px">·</span>`;
            n.keys.forEach((k, i) => {
              const cls = 'bt-key' + (keyNew.includes(i) ? ' bt-key--new' : keyHi.includes(i) ? ' bt-key--hi' : '');
              html += `<span class="${cls}" style="width:${L.keyW}px">${k}</span>`;
            });
          } else {
            for (let i = 0; i <= n.keys.length; i++) {
              html += `<span class="bt-ptr${ptrHi.includes(i) ? ' bt-ptr--hi' : ''}" style="width:${PTR_W}px"></span>`;
              if (i < n.keys.length) {
                const cls = 'bt-key' + (keyNew.includes(i) ? ' bt-key--new' : keyHi.includes(i) ? ' bt-key--hi' : '');
                html += `<span class="${cls}" style="width:${L.keyW}px">${n.keys[i]}</span>`;
              }
            }
          }
          v.cells.innerHTML = html;
          v.cells.style.paddingLeft = PAD + 'px';
          v.cells.style.paddingRight = PAD + 'px';
        }
        v.tag.textContent = `#${n.id}` + (n.id === snap.rootId ? ' root' : '') + (n.leaf ? ' leaf' : '');

        /* 상태 클래스 */
        const state = (deco.state && deco.state[n.id]) || null;
        const cls = ['bt-node'];
        if (v.el.classList.contains('bt-node--enter')) cls.push('bt-node--enter');
        if (deco.active && deco.active.includes(n.id)) cls.push('bt-node--active');
        else if (deco.path && deco.path.includes(n.id)) cls.push('bt-node--path');
        if (deco.scanned && deco.scanned.includes(n.id)) cls.push('bt-node--scanned');
        if (state) cls.push('bt-node--' + state);
        if (dying.has(n.id)) cls.push('bt-node--dying');
        v.el.className = cls.join(' ');
      }

      /* 사라진 노드 */
      for (const [id, v] of this.views) {
        if (alive.has(id)) continue;
        v.el.classList.add('bt-node--exit');
        const el = v.el;
        setTimeout(() => el.remove(), 320);
        this.views.delete(id);
      }

      /* 간선 정의 (좌표는 트윈 루프에서 갱신) */
      this.edgeDefs = [];
      for (const n of snap.nodes) {
        n.childIds.forEach((cid, i) => {
          const hi = (deco.edge || []).some((e) => e[0] === n.id && e[1] === i);
          this.edgeDefs.push({ key: `${n.id}-${i}`, from: n.id, to: cid, idx: i, hi });
        });
      }
      this.linkDefs = [];
      if (snap.mode === 'bplus') {
        for (const n of snap.nodes) {
          if (!n.leaf || n.nextId == null || !byId.has(n.nextId)) continue;
          const hi = deco.leafLink && deco.leafLink[0] === n.id;
          this.linkDefs.push({ key: `L${n.id}`, from: n.id, to: n.nextId, hi });
        }
      }
      this.syncSvgElements();

      /* 트윈 시작 */
      const dur = instant ? 0 : this.moveMs;
      this.tween = { t0: performance.now(), dur };
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.tick();

      requestAnimationFrame(() => {
        for (const v of this.views.values()) v.el.classList.remove('bt-node--enter');
      });
    }

    syncSvgElements() {
      const wanted = new Set(this.edgeDefs.map((e) => e.key));
      for (const [k, el] of this.edges) {
        if (!wanted.has(k)) { el.remove(); this.edges.delete(k); }
      }
      for (const d of this.edgeDefs) {
        let el = this.edges.get(d.key);
        if (!el) {
          el = document.createElementNS(SVGNS, 'path');
          this.svg.appendChild(el);
          this.edges.set(d.key, el);
        }
        el.setAttribute('class', 'bt-edge' + (d.hi ? ' bt-edge--hi' : ''));
      }
      const wantedL = new Set(this.linkDefs.map((e) => e.key));
      for (const [k, el] of this.links) {
        if (!wantedL.has(k)) { el.remove(); this.links.delete(k); }
      }
      for (const d of this.linkDefs) {
        let el = this.links.get(d.key);
        if (!el) {
          el = document.createElementNS(SVGNS, 'path');
          this.svg.appendChild(el);
          this.links.set(d.key, el);
        }
        el.setAttribute('class', 'bt-link' + (d.hi ? ' bt-link--hi' : ''));
      }
    }

    ptrX(v, i) {
      const m = v.meta;
      if (m.leaf) return m.w / 2;
      return PAD + i * (PTR_W + m.keyW) + PTR_W / 2;
    }

    tick() {
      const now = performance.now();
      const tw = this.tween;
      const k = !tw || tw.dur === 0 ? 1 : Math.min(1, (now - tw.t0) / tw.dur);
      const e = easeOut(k);

      for (const v of this.views.values()) {
        if (v.tx == null) continue;
        v.x = v.fx + (v.tx - v.fx) * e;
        v.y = v.fy + (v.ty - v.fy) * e;
        v.el.style.transform = `translate(${v.x.toFixed(1)}px, ${v.y.toFixed(1)}px)`;
      }

      for (const d of this.edgeDefs || []) {
        const a = this.views.get(d.from);
        const b = this.views.get(d.to);
        const el = this.edges.get(d.key);
        if (!a || !b || !el) continue;
        const x1 = a.x + this.ptrX(a, d.idx);
        const y1 = a.y + NODE_H;
        const x2 = b.x + b.meta.w / 2;
        const y2 = b.y;
        const dy = Math.max(14, (y2 - y1) * 0.45);
        el.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`);
      }

      for (const d of this.linkDefs || []) {
        const a = this.views.get(d.from);
        const b = this.views.get(d.to);
        const el = this.links.get(d.key);
        if (!a || !b || !el) continue;
        const x1 = a.x + a.meta.w;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const mid = (y1 + y2) / 2 + 16;
        el.setAttribute('d', `M ${x1 + 3} ${y1} C ${x1 + 16} ${mid}, ${x2 - 16} ${mid}, ${x2 - 3} ${y2}`);
      }

      if (k < 1) this.rafId = requestAnimationFrame(() => this.tick());
      else this.rafId = null;
    }
  }

  /* ═══════════════════════════════════════════════════
     시연 시나리오 — 기본 모드에서 자동 재생된다
  ═══════════════════════════════════════════════════ */
  const SCENARIO = [
    {
      title: '빈 트리에서 시작한다',
      note: '리프 하나가 곧 루트다. 차수 m=4 이므로 한 페이지에는 키를 최대 3개까지 정렬된 채로 담는다.',
      ops: [{ t: 'reset', order: 4, mode: 'bplus' }, { t: 'insert', v: 50 }, { t: 'insert', v: 20 }, { t: 'insert', v: 80 }],
    },
    {
      title: '첫 오버플로 — 페이지가 터진다',
      note: '4번째 키가 들어오면 최대치 3개를 넘는다. 절반으로 쪼갠 뒤 오른쪽 리프의 첫 키를 부모로 복사(copy-up)하고, 그 부모가 새 루트가 된다.',
      ops: [{ t: 'insert', v: 10 }],
    },
    {
      title: '리프는 옆으로 넓어진다',
      note: '분할은 꽉 찬 페이지에서만 일어난다. 부모에 자리가 남아 있는 동안 트리는 높아지지 않고 옆으로만 넓어진다.',
      ops: [{ t: 'insert', v: 35 }, { t: 'insert', v: 65 }, { t: 'insert', v: 95 }],
    },
    {
      title: '루트가 갈라질 때만 높이가 는다',
      note: '리프 분할이 부모를 채우고, 부모까지 꽉 차면 분할이 위로 전파된다. 루트가 갈라지는 순간에만 트리 높이가 1 증가한다.',
      ops: [{ t: 'insert', v: 5 }, { t: 'insert', v: 15 }, { t: 'insert', v: 27 }, { t: 'insert', v: 42 }],
    },
    {
      title: '탐색은 항상 리프까지 내려간다',
      note: 'B+Tree의 내부 노드에는 값이 없고 이정표만 있다. 그래서 어떤 키든 루트에서 리프까지 h번 페이지를 읽어야 존재 여부가 결정된다.',
      ops: [{ t: 'search', v: 42 }],
    },
    {
      title: '범위 스캔은 리프 링크를 탄다',
      note: '20~65를 읽을 때 루트로 되돌아가지 않는다. 리프끼리 이어진 점선을 따라 순차로 읽는다. RDB가 B-Tree 대신 B+Tree를 쓰는 가장 큰 이유다.',
      ops: [{ t: 'range', lo: 20, hi: 65 }],
    },
    {
      title: '삭제는 분할의 정확한 반대다',
      note: '키가 최소치 아래로 내려가면(언더플로) 형제에게 한 개 빌려오거나, 빌릴 게 없으면 형제와 통째로 합친다.',
      ops: [{ t: 'delete', v: 5 }, { t: 'delete', v: 10 }],
    },
    {
      title: '같은 키를 B-Tree에 넣으면',
      note: '값이 내부 노드에도 올라온다. 운이 좋으면 루트에서 탐색이 끝나지만, 리프 링크가 없어 범위 스캔은 트리를 위아래로 오가야 한다.',
      ops: [{ t: 'mode', mode: 'btree' }, { t: 'search', v: 50 }],
    },
  ];

  /* ═══════════════════════════════════════════════════
     페이지 컨트롤러
  ═══════════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const stage = $('btStage');
    if (!stage) return;

    const tree = new BTree({ order: 4, mode: 'bplus' });

    const viz = new TreeViz({
      stage,
      world: $('btWorld'),
      svg: $('btEdges'),
      nodesLayer: $('btNodes'),
      onStep: (step, i, n) => {
        const kind = step.kind || 'idle';
        $('narrKind').textContent = kind;
        $('narrKind').className = 'narr__kind narr__kind--' + kind;
        $('narrMsg').textContent = step.msg || '';
        $('progText').textContent = `step ${i + 1} / ${n}`;
        $('progFill').style.width = ((i + 1) / n * 100) + '%';
        if (step.last) {
          $('stReads').textContent = step.last.reads;
          $('stCmp').textContent = step.last.cmp;
          $('stSplits').textContent = step.last.splits + step.last.merges;
        }
        updateTreeStats(step.tree);
      },
      onIdle: () => { updateTreeStats(tree.snapshot()); },
    });

    function updateTreeStats(snap) {
      $('stHeight').textContent = snap.height;
      $('stNodes').textContent = snap.nodeCount;
      $('stKeys').textContent = snap.keyCount;
      const m = snap.order;
      const t = Math.ceil(m / 2);
      const N = snap.keyCount;
      const lo = N > 0 ? Math.log(N + 1) / Math.log(m) : 0;
      const hi = N > 0 ? Math.log((N + 1) / 2) / Math.log(t) + 1 : 0;
      $('stBound').textContent = N > 0 ? `${lo.toFixed(2)} ≤ h ≤ ${hi.toFixed(2)}` : '—';
    }

    /* ── 뷰 초기화 ── */
    function clearView() {
      viz.views.forEach((v) => v.el.remove()); viz.views.clear();
      viz.edges.forEach((e) => e.remove()); viz.edges.clear();
      viz.links.forEach((e) => e.remove()); viz.links.clear();
    }

    function idleStep(msg) {
      return {
        kind: 'idle', msg, deco: {}, tree: tree.snapshot(),
        last: { reads: 0, cmp: 0, splits: 0, merges: 0 },
      };
    }

    function showState(msg) {
      viz.steps = [idleStep(msg)];
      viz.i = 0;
      viz.show(0, true);
    }

    function rebuild(keys, opts) {
      opts = opts || {};
      viz.pause();
      if (!opts.keepQueue) viz.opQueue.length = 0;
      tree.reset(tree.order, tree.mode);
      clearView();
      if (keys && keys.length) tree.bulkLoad(keys);
      showState(opts.msg || '준비 완료 — 값을 넣어보세요');
      syncParamUI();
    }

    function syncParamUI() {
      $('orderSel').value = String(tree.order);
      $('orderInfo').textContent =
        `노드당 키 ${tree.minKeys}~${tree.maxKeys}개 · 자식 ${Math.ceil(tree.order / 2)}~${tree.order}개`;
      document.querySelectorAll('#modeToggle button').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.mode === tree.mode));
      });
      document.querySelectorAll('[data-bplus-only]').forEach((el) => {
        el.style.opacity = tree.mode === 'bplus' ? '' : '.4';
        el.querySelectorAll('button, input').forEach((c) => { c.disabled = tree.mode !== 'bplus'; });
      });
      document.body.dataset.treeMode = tree.mode;
    }

    /* ── 조작 ── */
    const doInsert = (k) => viz.enqueue(() => tree.insert(k).steps);
    const doDelete = (k) => viz.enqueue(() => tree.remove(k).steps);

    /* ══════════ 데모 모드 ══════════ */
    let uiMode = 'demo';
    let chapter = 0;

    function structural(op) {
      if (op.t === 'reset') {
        tree.order = op.order || tree.order;
        tree.mode = op.mode || tree.mode;
        tree.reset(tree.order, tree.mode);
        clearView();
      } else if (op.t === 'mode') {
        const keys = tree.keysInOrder();
        tree.mode = op.mode;
        tree.reset(tree.order, tree.mode);
        clearView();
        tree.bulkLoad(keys);
      } else if (op.t === 'order') {
        const keys = tree.keysInOrder();
        tree.order = op.order;
        tree.reset(tree.order, tree.mode);
        clearView();
        tree.bulkLoad(keys);
      }
      syncParamUI();
    }

    function applyQuiet(ops) {
      for (const op of ops) {
        if (op.t === 'reset' || op.t === 'mode' || op.t === 'order') { structural(op); continue; }
        tree.quiet = true;
        if (op.t === 'insert') tree.insert(op.v);
        else if (op.t === 'delete') tree.remove(op.v);
        tree.quiet = false;
      }
    }

    function runOp(op) {
      if (op.t === 'reset' || op.t === 'mode' || op.t === 'order') {
        structural(op);
        const label = op.t === 'mode'
          ? `${op.mode === 'btree' ? 'B-Tree' : 'B+Tree'} 로 같은 키를 다시 넣었다`
          : op.t === 'order' ? `차수를 ${op.order} 로 바꿔 다시 만들었다` : '빈 트리에서 시작한다';
        return [idleStep(label)];
      }
      if (op.t === 'insert') return tree.insert(op.v).steps;
      if (op.t === 'delete') return tree.remove(op.v).steps;
      if (op.t === 'search') return tree.search(op.v).steps;
      if (op.t === 'range') return tree.rangeScan(op.lo, op.hi).steps;
      return [];
    }

    function setChapter(i) {
      chapter = i;
      const act = SCENARIO[i];
      $('chapNo').textContent = `CHAPTER ${String(i + 1).padStart(2, '0')} / ${String(SCENARIO.length).padStart(2, '0')}`;
      $('chapTitle').textContent = act.title;
      $('chapNote').textContent = act.note;
      $('chapSel').value = String(i);
    }

    function enqueueAct(i) {
      const act = SCENARIO[i];
      viz.enqueue(() => { setChapter(i); return [idleStep(act.note)]; });
      act.ops.forEach((op) => viz.enqueue(() => runOp(op)));
    }

    function runDemo(from) {
      viz.pause();
      viz.opQueue.length = 0;
      viz.steps = [];
      viz.i = -1;
      const start = from || 0;
      tree.reset(tree.order, tree.mode);
      clearView();
      for (let i = 0; i < start; i++) applyQuiet(SCENARIO[i].ops);
      /* 첫 enqueue 가 자동으로 drain 을 시작한다 */
      for (let i = start; i < SCENARIO.length; i++) enqueueAct(i);
      $('btnPlay').textContent = '❚❚ 일시정지';
    }

    $('chapSel').innerHTML = SCENARIO
      .map((a, i) => `<option value="${i}">${String(i + 1).padStart(2, '0')}. ${a.title}</option>`)
      .join('');
    $('chapSel').addEventListener('change', (e) => runDemo(parseInt(e.target.value, 10)));
    $('btnRestart').addEventListener('click', () => runDemo(0));
    $('btnChapPrev').addEventListener('click', () => runDemo(Math.max(0, chapter - 1)));
    $('btnChapNext').addEventListener('click', () => runDemo(Math.min(SCENARIO.length - 1, chapter + 1)));

    /* ══════════ 실험실 모드 ══════════ */
    function setUiMode(m) {
      uiMode = m;
      document.querySelectorAll('#uiToggle button').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.ui === m));
      });
      document.querySelectorAll('.ui-demo').forEach((el) => { el.hidden = m !== 'demo'; });
      document.querySelectorAll('.ui-lab').forEach((el) => { el.hidden = m !== 'lab'; });
      if (m === 'demo') runDemo(0);
      else {
        viz.pause();
        viz.opQueue.length = 0;
        $('btnPlay').textContent = '▶ 재생';
        tree.order = 4;
        tree.mode = 'bplus';
        rebuild([50, 20, 80, 10, 35, 65, 95], { msg: '실험실 — 예제 키 7개로 시작합니다. 마음대로 넣고 지워보세요' });
      }
    }
    document.querySelectorAll('#uiToggle button').forEach((b) => {
      b.addEventListener('click', () => setUiMode(b.dataset.ui));
    });

    $('btnInsert').addEventListener('click', () => {
      const raw = $('keyInput').value.trim();
      if (!raw) return;
      raw.split(/[,\s]+/).filter(Boolean).forEach((s) => {
        const k = parseInt(s, 10);
        if (!Number.isNaN(k)) doInsert(k);
      });
      $('keyInput').value = '';
    });
    $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnInsert').click(); });

    function freeKeys(n) {
      const used = new Set(tree.keysInOrder());
      const pool = [];
      for (let i = 1; i <= 99; i++) if (!used.has(i)) pool.push(i);
      const out = [];
      for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      return out;
    }
    $('btnRandom').addEventListener('click', () => freeKeys(1).forEach(doInsert));
    $('btnRandom5').addEventListener('click', () => freeKeys(5).forEach(doInsert));

    $('btnDelete').addEventListener('click', () => {
      const raw = $('keyInput').value.trim();
      const keys = tree.keysInOrder();
      if (!raw) {
        if (keys.length) doDelete(keys[Math.floor(Math.random() * keys.length)]);
        return;
      }
      raw.split(/[,\s]+/).filter(Boolean).forEach((s) => {
        const k = parseInt(s, 10);
        if (!Number.isNaN(k)) doDelete(k);
      });
      $('keyInput').value = '';
    });

    $('btnSearch').addEventListener('click', () => {
      const k = parseInt($('keyInput').value.trim(), 10);
      if (Number.isNaN(k)) return;
      viz.enqueue(() => tree.search(k).steps);
      $('keyInput').value = '';
    });

    $('btnRange').addEventListener('click', () => {
      const lo = parseInt($('rangeLo').value, 10);
      const hi = parseInt($('rangeHi').value, 10);
      if (Number.isNaN(lo) || Number.isNaN(hi)) return;
      viz.enqueue(() => tree.rangeScan(Math.min(lo, hi), Math.max(lo, hi)).steps);
    });

    $('btnReset').addEventListener('click', () => rebuild([], { msg: '초기화 완료 — 값을 넣어보세요' }));
    $('btnSeed').addEventListener('click', () => {
      rebuild([]);
      [50, 20, 80, 10, 35, 65, 95].forEach(doInsert);
    });

    document.querySelectorAll('#modeToggle button').forEach((b) => {
      b.addEventListener('click', () => {
        const keys = tree.keysInOrder();
        tree.mode = b.dataset.mode;
        rebuild(keys, { msg: `${tree.mode === 'bplus' ? 'B+Tree' : 'B-Tree'} 로 다시 만들었습니다` });
      });
    });

    $('orderSel').addEventListener('change', (e) => {
      const keys = tree.keysInOrder();
      tree.order = parseInt(e.target.value, 10);
      rebuild(keys, { msg: `차수 m=${tree.order} 로 다시 만들었습니다` });
    });

    /* ── 재생 컨트롤 (두 모드 공용) ── */
    $('btnPlay').addEventListener('click', () => {
      viz.toggle();
      $('btnPlay').textContent = viz.playing ? '❚❚ 일시정지' : '▶ 재생';
    });
    $('btnPrev').addEventListener('click', () => { viz.prev(); $('btnPlay').textContent = '▶ 재생'; });
    $('btnNext').addEventListener('click', () => { viz.pause(); viz.next(); $('btnPlay').textContent = '▶ 재생'; });
    $('btnEnd').addEventListener('click', () => { viz.jumpEnd(); $('btnPlay').textContent = '▶ 재생'; });
    $('speed').addEventListener('input', (e) => {
      viz.speed = parseFloat(e.target.value);
      $('speedVal').textContent = viz.speed.toFixed(1) + '×';
    });

    /* ── 시작 ── */
    syncParamUI();
    setUiMode('demo');
  });
})();
