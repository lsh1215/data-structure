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
     페이지 컨트롤러
  ═══════════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const stage = $('btStage');
    if (!stage) return;

    let tree = new BTree({ order: 4, mode: 'bplus' });

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

    /* ── 조작 ── */
    function usedKeys() { return new Set(tree.keysInOrder()); }

    function doInsert(k) {
      viz.enqueue(() => tree.insert(k).steps);
    }
    function doDelete(k) {
      viz.enqueue(() => tree.remove(k).steps);
    }

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

    $('btnRandom').addEventListener('click', () => {
      const used = usedKeys();
      const pool = [];
      for (let i = 1; i <= 99; i++) if (!used.has(i)) pool.push(i);
      if (!pool.length) return;
      doInsert(pool[Math.floor(Math.random() * pool.length)]);
    });

    $('btnRandom5').addEventListener('click', () => {
      const used = usedKeys();
      const pool = [];
      for (let i = 1; i <= 99; i++) if (!used.has(i)) pool.push(i);
      for (let n = 0; n < 5 && pool.length; n++) {
        const idx = Math.floor(Math.random() * pool.length);
        doInsert(pool.splice(idx, 1)[0]);
      }
    });

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

    function rebuild(keys) {
      viz.pause();
      viz.opQueue.length = 0;
      tree.reset(tree.order, tree.mode);
      viz.views.forEach((v) => v.el.remove());
      viz.views.clear();
      viz.edges.forEach((e) => e.remove()); viz.edges.clear();
      viz.links.forEach((e) => e.remove()); viz.links.clear();
      if (keys && keys.length) tree.bulkLoad(keys);
      viz.steps = [{ kind: 'idle', msg: '준비 완료 — 값을 넣어보세요', deco: {}, tree: tree.snapshot(), last: { reads: 0, cmp: 0, splits: 0, merges: 0 } }];
      viz.i = 0;
      viz.show(0, true);
    }

    $('btnReset').addEventListener('click', () => rebuild([]));
    $('btnSeed').addEventListener('click', () => {
      rebuild([]);
      [50, 20, 80, 10, 35, 65, 95].forEach(doInsert);
    });

    /* 모드 / 차수 */
    document.querySelectorAll('#modeToggle button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#modeToggle button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        const keys = tree.keysInOrder();
        tree.mode = b.dataset.mode;
        document.body.dataset.treeMode = tree.mode;
        rebuild(keys);
        document.querySelectorAll('[data-bplus-only]').forEach((el) => {
          el.style.opacity = tree.mode === 'bplus' ? '' : '.4';
          el.querySelectorAll('button, input').forEach((c) => { c.disabled = tree.mode !== 'bplus'; });
        });
      });
    });

    $('orderSel').addEventListener('change', (e) => {
      const keys = tree.keysInOrder();
      tree.order = parseInt(e.target.value, 10);
      $('orderInfo').textContent =
        `노드당 키 ${tree.minKeys}~${tree.maxKeys}개 · 자식 ${Math.ceil(tree.order / 2)}~${tree.order}개`;
      rebuild(keys);
    });

    /* 재생 컨트롤 */
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

    /* 초기 상태 */
    $('orderInfo').textContent = `노드당 키 ${tree.minKeys}~${tree.maxKeys}개 · 자식 ${Math.ceil(tree.order / 2)}~${tree.order}개`;
    document.body.dataset.treeMode = tree.mode;
    rebuild([50, 20, 80, 10, 35, 65, 95]);
    $('narrMsg').textContent = '예제 키 7개가 들어 있습니다 — 값을 넣거나 지워보세요';
  });
})();
