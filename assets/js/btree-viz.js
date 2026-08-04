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
      }, Math.round(this.delay * ((this.steps[this.i] && this.steps[this.i].hold) || 1)));
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
        const gLeft = (deco.groupLeft && deco.groupLeft[n.id]) || [];
        const gRight = (deco.groupRight && deco.groupRight[n.id]) || [];
        const median = deco.medianKey && deco.medianKey[n.id] != null ? deco.medianKey[n.id] : -1;
        const incoming = (deco.incoming && deco.incoming[n.id]) || [];
        const over = (deco.overflowKeys && deco.overflowKeys[n.id]) || [];

        const keyCls = (i) => {
          let c = 'bt-key';
          if (i === median) c += ' bt-key--median';
          else if (gLeft.includes(i)) c += ' bt-key--left';
          else if (gRight.includes(i)) c += ' bt-key--right';
          else if (keyNew.includes(i)) c += ' bt-key--new';
          else if (incoming.includes(i)) c += ' bt-key--incoming';
          else if (keyHi.includes(i)) c += ' bt-key--hi';
          else if (over.includes(i)) c += ' bt-key--over';
          return c;
        };

        const sig = JSON.stringify([n.keys, keyHi, keyNew, ptrHi, gLeft, gRight, median, incoming, over, n.leaf, L.keyW]);
        if (v.sig !== sig) {
          v.sig = sig;
          let html = '';
          if (n.leaf) {
            if (!n.keys.length) html = `<span class="bt-key" style="width:${p.w - PAD * 2}px">·</span>`;
            n.keys.forEach((k, i) => {
              html += `<span class="${keyCls(i)}" style="width:${L.keyW}px">${k}</span>`;
            });
          } else {
            for (let i = 0; i <= n.keys.length; i++) {
              html += `<span class="bt-ptr${ptrHi.includes(i) ? ' bt-ptr--hi' : ''}" style="width:${PTR_W}px"></span>`;
              if (i < n.keys.length) {
                html += `<span class="${keyCls(i)}" style="width:${L.keyW}px">${n.keys[i]}</span>`;
              }
            }
          }
          v.cells.innerHTML = html;
          v.cells.style.paddingLeft = PAD + 'px';
          v.cells.style.paddingRight = PAD + 'px';
        }
        v.tag.textContent = `#${n.id}` + (n.id === snap.rootId ? ' root' : '') + (n.leaf ? ' leaf' : '');

        /* 승진 마커 (셀 밖에 띄운다) */
        if (median >= 0) {
          if (!v.mark) {
            v.mark = document.createElement('div');
            v.mark.className = 'bt-promote-mark';
            v.el.appendChild(v.mark);
          }
          v.mark.textContent = '↑ 승진';
          v.mark.style.left = (PAD + (n.leaf ? median * L.keyW + L.keyW / 2 : PTR_W + median * (L.keyW + PTR_W) + L.keyW / 2)) + 'px';
          v.mark.hidden = false;
        } else if (v.mark) {
          v.mark.hidden = true;
        }

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

      /* 승진 키 애니메이션: 올라갈 키의 위치를 기억했다가 부모 자리로 날려보낸다 */
      if (deco.promoteFrom) {
        const src = this.views.get(deco.promoteFrom.node);
        if (src && src.meta) {
          this.promoteOrigin = {
            x: src.tx + this.keyX(src, deco.promoteFrom.idx),
            y: src.ty + NODE_H / 2,
            text: (src.meta.keys[deco.promoteFrom.idx] != null ? src.meta.keys[deco.promoteFrom.idx] : ''),
            w: src.meta.keyW,
          };
        }
      }
      if (deco.promoteTo && this.promoteOrigin && !instant) {
        const dst = this.views.get(deco.promoteTo.node);
        if (dst && dst.meta) {
          this.flyGhost(this.promoteOrigin, {
            x: dst.tx + this.keyX(dst, deco.promoteTo.idx),
            y: dst.ty + NODE_H / 2,
          });
        }
        this.promoteOrigin = null;
      }

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

    keyX(v, i) {
      const m = v.meta;
      if (m.leaf) return PAD + i * m.keyW + m.keyW / 2;
      return PAD + PTR_W + i * (m.keyW + PTR_W) + m.keyW / 2;
    }

    /* 승진하는 키를 복제해 부모 자리까지 날려 보낸다 */
    flyGhost(from, to) {
      if (this.ghostEl) this.ghostEl.remove();
      const el = document.createElement('div');
      el.className = 'bt-ghost';
      el.textContent = from.text;
      el.style.width = Math.max(34, from.w) + 'px';
      this.nodesLayer.appendChild(el);
      this.ghostEl = el;
      this.ghost = {
        el,
        x0: from.x, y0: from.y,
        x1: to.x, y1: to.y,
        t0: performance.now(),
        dur: Math.max(420, this.moveMs * 1.25),
      };
      const w = Math.max(34, from.w);
      el.style.transform = `translate(${from.x - w / 2}px, ${from.y - NODE_H / 2}px)`;
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

      /* 승진 키 고스트 */
      let ghostBusy = false;
      if (this.ghost) {
        const g = this.ghost;
        const gk = Math.min(1, (now - g.t0) / g.dur);
        const ge = easeOut(gk);
        const w = parseFloat(g.el.style.width) || 34;
        const x = g.x0 + (g.x1 - g.x0) * ge;
        /* 살짝 위로 솟았다가 내려앉는 곡선 */
        const arc = Math.sin(Math.PI * gk) * 16;
        const y = g.y0 + (g.y1 - g.y0) * ge - arc;
        g.el.style.transform = `translate(${(x - w / 2).toFixed(1)}px, ${(y - NODE_H / 2).toFixed(1)}px) scale(${(1 + 0.12 * Math.sin(Math.PI * gk)).toFixed(3)})`;
        if (gk >= 1) {
          g.el.classList.add('bt-ghost--done');
          const el = g.el;
          setTimeout(() => { if (el.parentNode) el.remove(); }, 240);
          if (this.ghostEl === el) this.ghostEl = null;
          this.ghost = null;
        } else {
          ghostBusy = true;
        }
      }

      if (k < 1 || ghostBusy) this.rafId = requestAnimationFrame(() => this.tick());
      else this.rafId = null;
    }
  }

  /* ═══════════════════════════════════════════════════
     정적 비교 렌더러 — B-Tree vs B+Tree 대조도
  ═══════════════════════════════════════════════════ */
  function renderStatic(host, snap, opts) {
    opts = opts || {};
    host.innerHTML = '';
    const L = layout(snap);
    const byId = new Map(snap.nodes.map((n) => [n.id, n]));

    const world = document.createElement('div');
    world.className = 'cmp-world';
    world.style.width = L.totalW + 'px';
    world.style.height = (L.totalH + 34) + 'px';
    host.appendChild(world);

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'viz__edges');
    svg.setAttribute('viewBox', `0 0 ${L.totalW} ${L.totalH + 34}`);
    svg.style.width = L.totalW + 'px';
    svg.style.height = (L.totalH + 34) + 'px';
    world.appendChild(svg);

    const pos = (id) => L.pos.get(id);
    const nodeLeft = (id) => pos(id).x - pos(id).w / 2;
    const nodeTop = (id) => pos(id).y + 20;
    const ptrOffset = (n, i) => (n.leaf ? pos(n.id).w / 2 : PAD + i * (PTR_W + L.keyW) + PTR_W / 2);

    /* 간선 */
    for (const n of snap.nodes) {
      n.childIds.forEach((cid, i) => {
        const x1 = nodeLeft(n.id) + ptrOffset(n, i);
        const y1 = nodeTop(n.id) + NODE_H;
        const x2 = pos(cid).x;
        const y2 = nodeTop(cid);
        const dy = Math.max(14, (y2 - y1) * 0.45);
        const path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('class', 'bt-edge');
        path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`);
        svg.appendChild(path);
      });
    }

    /* 리프 링크 */
    if (snap.mode === 'bplus') {
      for (const n of snap.nodes) {
        if (!n.leaf || n.nextId == null || !byId.has(n.nextId)) continue;
        const x1 = nodeLeft(n.id) + pos(n.id).w;
        const y1 = nodeTop(n.id) + NODE_H / 2;
        const x2 = nodeLeft(n.nextId);
        const y2 = nodeTop(n.nextId) + NODE_H / 2;
        const mid = (y1 + y2) / 2 + 16;
        const path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('class', 'bt-link');
        path.setAttribute('data-diff', '3');
        path.setAttribute('d', `M ${x1 + 3} ${y1} C ${x1 + 16} ${mid}, ${x2 - 16} ${mid}, ${x2 - 3} ${y2}`);
        svg.appendChild(path);
      }
    }

    /* 노드 */
    for (const n of snap.nodes) {
      const el = document.createElement('div');
      el.className = 'bt-node';
      el.style.transform = `translate(${nodeLeft(n.id)}px, ${nodeTop(n.id)}px)`;

      const diff = opts.diffOf ? opts.diffOf(n) : null;
      if (diff) el.dataset.diff = diff;

      const tag = document.createElement('div');
      tag.className = 'bt-node__tag';
      tag.textContent = n.depth === 0 ? 'root' : 'leaf';
      el.appendChild(tag);

      const cells = document.createElement('div');
      cells.className = 'bt-node__cells';
      cells.style.paddingLeft = PAD + 'px';
      cells.style.paddingRight = PAD + 'px';
      let html = '';
      if (n.leaf) {
        n.keys.forEach((k) => {
          const cls = opts.keyClass ? opts.keyClass(n, k) : '';
          html += `<span class="bt-key ${cls}" style="width:${L.keyW}px">${k}</span>`;
        });
      } else {
        for (let i = 0; i <= n.keys.length; i++) {
          html += `<span class="bt-ptr" style="width:${PTR_W}px"></span>`;
          if (i < n.keys.length) {
            const cls = opts.keyClass ? opts.keyClass(n, n.keys[i]) : '';
            html += `<span class="bt-key ${cls}" style="width:${L.keyW}px">${n.keys[i]}</span>`;
          }
        }
      }
      cells.innerHTML = html;
      el.appendChild(cells);
      world.appendChild(el);
    }

    /* 컨테이너 폭에 맞춰 축소 */
    const fit = () => {
      const avail = Math.max(160, host.clientWidth - 8);
      const s = Math.min(1, avail / L.totalW);
      world.style.transformOrigin = 'top left';
      world.style.transform = `translateX(${Math.max(0, (avail - L.totalW * s) / 2)}px) scale(${s})`;
      host.style.height = ((L.totalH + 34) * s) + 'px';
    };
    fit();
    return fit;
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

    /* ══════════ B-Tree vs B+Tree 대조도 ══════════ */
    (function comparison() {
      const hostB = $('cmpBtree');
      const hostP = $('cmpBplus');
      if (!hostB || !hostP) return;

      const KEYS = [10, 20, 30, 40, 50, 60, 70];
      const build = (mode) => {
        const t = new BTree({ order: 4, mode });
        t.bulkLoad(KEYS);
        return t.snapshot();
      };

      /* diff 1 = 내부 노드, 2 = 리프, 3 = 리프 링크, 4/5 = 내부 노드 키 */
      const opts = (mode) => ({
        diffOf: (n) => (n.depth === 0 ? '1' : '2'),
        keyClass: (n, k) => {
          if (n.depth !== 0) return '';
          return mode === 'btree' ? 'bt-key--data' : 'bt-key--sep';
        },
      });

      const fitB = renderStatic(hostB, build('btree'), opts('btree'));
      const fitP = renderStatic(hostP, build('bplus'), opts('bplus'));
      /* 링크 없음 배지는 렌더 후 다시 붙인다 */
      const none = document.createElement('span');
      none.className = 'cmp-none';
      none.dataset.diff = '3';
      none.textContent = '리프 링크 없음';
      hostB.appendChild(none);

      let rt = null;
      window.addEventListener('resize', () => {
        clearTimeout(rt);
        rt = setTimeout(() => { fitB(); fitP(); }, 150);
      });

      const MAP = { 1: ['1'], 2: ['2'], 3: ['3'], 4: ['1'], 5: ['1'] };
      const setOn = (targets, on) => {
        (targets || []).forEach((d) => {
          document.querySelectorAll(`.cmp [data-diff="${d}"], .cmp-none[data-diff="${d}"]`)
            .forEach((el) => el.classList.toggle('diff-on', on));
        });
      };
      document.querySelectorAll('.cmp-note').forEach((note) => {
        const targets = MAP[note.dataset.target] || [];
        const on = () => setOn(targets, true);
        const off = () => setOn(targets, false);
        note.addEventListener('mouseenter', on);
        note.addEventListener('mouseleave', off);
        note.addEventListener('focus', on);
        note.addEventListener('blur', off);
      });
    })();
  });
})();
