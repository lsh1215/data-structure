/* ═══════════════════════════════════════════════════════════
   Redis dict 시각화 — 명령 파이프라인 + 해시 테이블 + 리해싱
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const { RedisDict, STAGES } = window.RedisLib;

  const COL = 98;        // 버킷 열 간격
  const SLOT_W = 88;
  const SLOT_H = 34;
  const ENTRY_W = 88;
  const ENTRY_H = 54;
  const ENTRY_GAP = 17;
  const LABEL_H = 30;
  const TABLE_GAP = 34;

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const stage = $('htStage');
    if (!stage) return;

    const world = $('htWorld');
    const dict = new RedisDict(4);

    /* ── 파이프라인 DOM ── */
    const pipeEl = $('pipe');
    pipeEl.innerHTML = STAGES.map(
      (s, i) => `<div class="pipe__stage" data-stage="${i}"><span class="pipe__num">${String(i).padStart(2, '0')}</span>${s}</div>`
    ).join('');
    const pipeStages = [...pipeEl.querySelectorAll('.pipe__stage')];

    /* ── 뷰 상태 ── */
    const views = new Map();   // key -> {el}
    const bucketEls = new Map();
    const nullEls = new Map();
    const labelEls = new Map();

    let steps = [];
    let idx = -1;
    let playing = false;
    let timer = null;
    let speed = 1.4;
    const queue = [];

    const delay = () => Math.round(900 / speed);

    function enqueue(fn) {
      queue.push(fn);
      if (!playing && idx >= steps.length - 1) drain();
    }
    function drain() {
      if (!queue.length) return;   /* 마지막 스텝 화면을 유지한다 */
      const s = queue.shift();
      const st = s();
      if (!st || !st.length) return drain();
      steps = st; idx = 0; show(0); play();
    }
    function play() {
      if (idx >= steps.length - 1) { playing = false; $('rPlay').textContent = '▶ 재생'; drain(); return; }
      playing = true;
      $('rPlay').textContent = '❚❚ 일시정지';
      clearTimeout(timer);
      timer = setTimeout(() => { if (!playing) return; idx++; show(idx); play(); }, delay());
    }
    function pause() { playing = false; clearTimeout(timer); $('rPlay').textContent = '▶ 재생'; }
    function show(i) {
      const st = steps[i];
      if (!st) return;
      render(st);
      $('rStep').textContent = `step ${i + 1} / ${steps.length}`;
      $('rBar').style.width = ((i + 1) / steps.length * 100) + '%';
    }
    function renderIdle() {
      render({ kind: 'idle', stage: -1, msg: '명령을 실행해 보세요', detail: '', deco: {}, snap: dict.snapshot() });
    }

    /* ── 렌더 ── */
    function render(step) {
      const snap = step.snap;
      const deco = step.deco || {};

      /* 파이프라인 */
      pipeStages.forEach((el, i) => {
        el.classList.toggle('pipe__stage--now', i === step.stage);
        el.classList.toggle('pipe__stage--past', step.stage >= 0 && i < step.stage);
      });

      /* 내레이션 */
      $('rKind').textContent = step.kind || 'idle';
      $('rKind').className = 'narr__kind narr__kind--' + (step.kind || 'idle');
      $('rMsg').innerHTML = step.msg || '';
      $('rDetail').innerHTML = step.detail
        ? step.detail.replace(/</g, '&lt;').replace(/&lt;strong&gt;/g, '<strong>').replace(/&lt;\/strong&gt;/g, '</strong>')
        : '<span class="muted">—</span>';

      /* 통계 */
      const t0 = snap.ht0;
      const t1 = snap.ht1;
      $('rSize').textContent = t0.size;
      $('rUsed').textContent = t0.used + (t1 ? t1.used : 0);
      $('rLoad').textContent = ((t0.used + (t1 ? t1.used : 0)) / (t1 ? t1.size : t0.size)).toFixed(2);
      $('rHt1').textContent = t1 ? t1.size : '—';
      $('rIdx').textContent = snap.rehashidx >= 0 ? snap.rehashidx : '—';
      $('rColl').textContent = (step.stats || dict.stats).collisions;

      /* 테이블 배치 계산 */
      const tables = [];
      let y = 0;
      [t0, t1].forEach((t, ti) => {
        if (!t) return;
        const maxChain = t.buckets.reduce((m, b) => Math.max(m, b.length), 0);
        tables.push({ t, ti, y, maxChain });
        y += LABEL_H + SLOT_H + maxChain * (ENTRY_H + ENTRY_GAP) + 26 + TABLE_GAP;
      });
      const totalW = Math.max(...tables.map((x) => x.t.size * COL)) - (COL - SLOT_W);
      const totalH = y;

      const avail = Math.max(240, stage.clientWidth - 32);
      let scale = Math.min(1, avail / Math.max(1, totalW));
      scale = Math.max(scale, 0.4);
      world.style.width = totalW + 'px';
      world.style.height = totalH + 'px';
      world.style.transform = `translateX(${Math.max(0, (avail - totalW * scale) / 2)}px) scale(${scale})`;
      world.parentElement.style.height = (totalH * scale + 20) + 'px';

      const aliveB = new Set();
      const aliveE = new Set();
      const aliveN = new Set();
      const aliveL = new Set();

      for (const { t, ti, y: ty } of tables) {
        /* 라벨 */
        const lk = 'L' + ti;
        aliveL.add(lk);
        let lab = labelEls.get(lk);
        if (!lab) {
          lab = document.createElement('div');
          lab.className = 'tbl-label';
          world.appendChild(lab);
          labelEls.set(lk, lab);
        }
        const isNew = ti === 1;
        lab.innerHTML =
          `<b>ht[${ti}]</b>` +
          `<span class="tag${isNew ? ' tag--new' : ''}">size ${t.size}</span>` +
          `<span class="tag">sizemask 0b${(t.size - 1).toString(2)}</span>` +
          `<span class="tag">used ${t.used}</span>` +
          `<span class="tag">load ${(t.used / t.size).toFixed(2)}</span>` +
          (ti === 0 && snap.rehashidx >= 0 ? `<span class="tag" style="color:var(--warn)">rehashidx ${snap.rehashidx}</span>` : '');
        lab.style.transform = `translate(0px, ${ty}px)`;

        /* 버킷 */
        t.buckets.forEach((chain, bi) => {
          const bk = `B${ti}-${bi}`;
          aliveB.add(bk);
          let el = bucketEls.get(bk);
          if (!el) {
            el = document.createElement('div');
            el.className = 'bucket';
            el.style.width = SLOT_W + 'px';
            world.appendChild(el);
            bucketEls.set(bk, el);
          }
          const active = deco.activeBucket && deco.activeBucket.t === ti && deco.activeBucket.idx === bi;
          const migrated = ti === 0 && snap.rehashidx >= 0 && bi < snap.rehashidx;
          const cursor = ti === 0 && snap.rehashidx === bi;
          el.className = 'bucket' +
            (active ? ' bucket--active' : '') +
            (chain.length ? ' bucket--filled' : '') +
            (migrated ? ' bucket--migrated' : '') +
            (cursor ? ' bucket--cursor' : '');
          el.innerHTML = `<span class="bucket__i">[${bi}]</span>` +
            (chain.length ? '' : '<span style="margin-left:6px;opacity:.5">NULL</span>');
          el.style.transform = `translate(${bi * COL}px, ${ty + LABEL_H}px)`;

          /* 체인 엔트리 */
          chain.forEach((e, ci) => {
            aliveE.add(e.key);
            let ev = views.get(e.key);
            const ex = bi * COL;
            const ey = ty + LABEL_H + SLOT_H + 14 + ci * (ENTRY_H + ENTRY_GAP);
            if (!ev) {
              const el2 = document.createElement('div');
              el2.className = 'entry entry--enter';
              el2.style.width = ENTRY_W + 'px';
              el2.style.height = ENTRY_H + 'px';
              el2.style.transform = `translate(${ex}px, ${ey}px)`;
              world.appendChild(el2);
              ev = { el: el2 };
              views.set(e.key, ev);
            }
            ev.el.innerHTML =
              `<div class="entry__k">${esc(e.key)}</div>` +
              `<div class="entry__v">${esc(String(e.val))}</div>` +
              `<div class="entry__h"><span>${('0x' + (e.hash >>> 0).toString(16)).slice(0, 8)}</span><span class="entry__enc">${e.enc || ''}</span></div>`;
            ev.el.className = 'entry' +
              (deco.activeKey === e.key ? ' entry--active' : '') +
              (deco.newKey === e.key ? ' entry--new' : '') +
              ((deco.compareKeys || []).includes(e.key) ? ' entry--compare' : '') +
              ((deco.movedKeys || []).includes(e.key) ? ' entry--moving' : '') +
              ((deco.dying || []).includes(e.key) ? ' entry--dying' : '');
            ev.el.style.transform = `translate(${ex}px, ${ey}px)`;
          });

          /* NULL 종단 표시 */
          if (chain.length) {
            const nk = `N${ti}-${bi}`;
            aliveN.add(nk);
            let nel = nullEls.get(nk);
            if (!nel) {
              nel = document.createElement('div');
              nel.className = 'chain-null';
              nel.textContent = '↓ NULL';
              world.appendChild(nel);
              nullEls.set(nk, nel);
            }
            nel.style.transform =
              `translate(${bi * COL + 8}px, ${ty + LABEL_H + SLOT_H + 14 + chain.length * (ENTRY_H + ENTRY_GAP) - 4}px)`;
          }
        });
      }

      cleanup(bucketEls, aliveB);
      cleanup(views, aliveE, true);
      cleanup(nullEls, aliveN);
      cleanup(labelEls, aliveL);

      requestAnimationFrame(() => {
        for (const v of views.values()) v.el.classList.remove('entry--enter');
      });
    }

    function cleanup(map, alive, isView) {
      for (const [k, v] of map) {
        if (alive.has(k)) continue;
        const el = isView ? v.el : v;
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 320);
        map.delete(k);
      }
    }

    function esc(s) {
      return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    }

    /* ── 명령 실행 ── */
    function runCommand(raw) {
      const parts = String(raw).trim().split(/\s+/);
      if (!parts[0]) return;
      const cmd = parts[0].toUpperCase();
      if (cmd === 'SET' && parts.length >= 3) {
        const k = parts[1];
        const v = parts.slice(2).join(' ');
        enqueue(() => dict.set(k, v));
      } else if (cmd === 'GET' && parts.length >= 2) {
        enqueue(() => dict.get(parts[1]));
      } else if (cmd === 'DEL' && parts.length >= 2) {
        enqueue(() => dict.del(parts[1]));
      } else {
        $('rMsg').textContent = `지원하지 않는 형식입니다 — SET key value / GET key / DEL key`;
      }
    }

    const SAMPLE = [
      ['user:1', 'sanghun'], ['user:2', 'jieun'], ['user:3', 'minsu'],
      ['session:ab12', 'active'], ['cart:1001', '3'], ['rank:global', '42'],
      ['post:777', 'hello world'], ['token:x9', 'expired'], ['user:4', 'yuna'],
      ['color:bg', '#060810'], ['count:visit', '12345'], ['flag:beta', '1'],
    ];
    let sampleIdx = 0;

    $('rRun').addEventListener('click', () => {
      const v = $('rCmd').value.trim();
      if (v) { runCommand(v); $('rCmd').value = ''; }
    });
    $('rCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('rRun').click(); });

    $('rSet').addEventListener('click', () => {
      const [k, v] = SAMPLE[sampleIdx++ % SAMPLE.length];
      const key = dict.findEntry(k) ? k + ':' + Math.floor(Math.random() * 900 + 100) : k;
      runCommand(`SET ${key} ${v}`);
    });
    $('rSet5').addEventListener('click', () => { for (let i = 0; i < 5; i++) $('rSet').click(); });
    $('rGet').addEventListener('click', () => {
      const ks = dict.keys();
      if (!ks.length) return;
      runCommand(`GET ${ks[Math.floor(Math.random() * ks.length)]}`);
    });
    $('rDel').addEventListener('click', () => {
      const ks = dict.keys();
      if (!ks.length) return;
      runCommand(`DEL ${ks[Math.floor(Math.random() * ks.length)]}`);
    });

    $('rFinish').addEventListener('click', () => {
      enqueue(() => { dict.steps = []; dict.rehashAll(); return dict.steps; });
    });

    $('rBgsave').addEventListener('change', (e) => { dict.canResize = !e.target.checked; });

    $('rReset').addEventListener('click', () => {
      pause();
      queue.length = 0;
      dict.reset(4);
      dict.canResize = !$('rBgsave').checked;
      views.forEach((v) => v.el.remove()); views.clear();
      bucketEls.forEach((v) => v.remove()); bucketEls.clear();
      nullEls.forEach((v) => v.remove()); nullEls.clear();
      labelEls.forEach((v) => v.remove()); labelEls.clear();
      sampleIdx = 0;
      steps = []; idx = -1;
      renderIdle();
      $('rStep').textContent = 'step 0 / 0';
      $('rBar').style.width = '0%';
    });

    $('rPlay').addEventListener('click', () => {
      if (playing) pause();
      else if (idx >= steps.length - 1 && steps.length) { idx = 0; show(0); play(); }
      else play();
    });
    $('rPrev').addEventListener('click', () => { pause(); if (idx > 0) { idx--; show(idx); } });
    $('rNext').addEventListener('click', () => { pause(); if (idx < steps.length - 1) { idx++; show(idx); } else drain(); });
    $('rSpeed').addEventListener('input', (e) => {
      speed = parseFloat(e.target.value);
      $('rSpeedVal').textContent = speed.toFixed(1) + '×';
    });

    window.addEventListener('resize', () => { if (steps[idx]) render(steps[idx]); else renderIdle(); });

    /* 초기: 몇 개 채워두고 시작 */
    dict.bulkSet([['user:1', 'sanghun'], ['user:2', 'jieun'], ['cart:1001', '3']]);
    sampleIdx = 3;
    renderIdle();
  });
})();
