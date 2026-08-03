/* ═══════════════════════════════════════════════════════════
   B+Tree fanout / height 계산기
   페이지 크기와 엔트리 크기로부터 실제 log의 밑(fanout)과
   트리 높이, 디스크 I/O 횟수를 계산한다.
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    if (!$('cFanout')) return;

    const FIELDS = ['cPage', 'cOverhead', 'cFill', 'cKey', 'cPtr', 'cEntry', 'cRow', 'cRows'];
    const fmt = (n) => Math.round(n).toLocaleString('en-US');

    const PRESETS = {
      innodb: { cPage: 16384, cOverhead: 128, cFill: 69, cKey: 8, cPtr: 6, cEntry: 7, cRow: 128, cRows: 100000000 },
      pg:     { cPage: 8192,  cOverhead: 40,  cFill: 90, cKey: 8, cPtr: 6, cEntry: 8, cRow: 64,  cRows: 100000000 },
      uuid:   { cPage: 16384, cOverhead: 128, cFill: 55, cKey: 16, cPtr: 6, cEntry: 7, cRow: 200, cRows: 100000000 },
    };

    function val(id, min) {
      const v = parseFloat($(id).value);
      return Number.isFinite(v) && v >= (min === undefined ? 1 : min) ? v : (min === undefined ? 1 : min);
    }

    function calc() {
      const page = val('cPage', 64);
      const oh = val('cOverhead', 0);
      const fill = Math.min(100, Math.max(10, val('cFill', 10))) / 100;
      const key = val('cKey', 1);
      const ptr = val('cPtr', 1);
      const eoh = val('cEntry', 0);
      const row = val('cRow', 1);
      const N = Math.max(1, val('cRows', 1));

      const usable = Math.max(16, (page - oh) * fill);
      const internalEntry = key + ptr + eoh;
      const f = Math.max(2, Math.floor(usable / internalEntry));
      const b = Math.max(1, Math.floor(usable / row));

      const leaves = Math.max(1, Math.ceil(N / b));
      const levels = [leaves];
      let cur = leaves;
      let guard = 0;
      while (cur > 1 && guard++ < 64) { cur = Math.ceil(cur / f); levels.push(cur); }
      const h = levels.length;

      const internalNodes = levels.slice(1).reduce((a, c) => a + c, 0);
      const internalMB = (internalNodes * page) / 1048576;
      const binaryIO = Math.ceil(Math.log2(N + 1));
      const logF = Math.log(N) / Math.log(f);

      /* ── 요약 ── */
      $('cFanout').textContent = fmt(f);
      $('cLeafCap').textContent = fmt(b);
      $('cHeight').innerHTML = h + '<small>레벨</small>';
      $('cIO').innerHTML = h + '<small>회 (cold)</small>';

      /* ── 수식 ── */
      $('cFormula').innerHTML = [
        `<b>사용 가능 바이트</b> = (${fmt(page)} − ${fmt(oh)}) × ${Math.round(fill * 100)}% = <span class="r">${fmt(usable)} B</span>`,
        `<b>내부 엔트리</b> = ${fmt(key)}(key) + ${fmt(ptr)}(child ptr) + ${fmt(eoh)}(overhead) = <span class="r">${fmt(internalEntry)} B</span>`,
        `<b>fanout f</b> = ⌊${fmt(usable)} / ${fmt(internalEntry)}⌋ = <span class="r">${fmt(f)}</span>  <span style="color:var(--text-muted)">← log의 밑</span>`,
        `<b>리프 엔트리 b</b> = ⌊${fmt(usable)} / ${fmt(row)}⌋ = <span class="r">${fmt(b)}</span>`,
        `<b>리프 페이지 수</b> = ⌈${fmt(N)} / ${fmt(b)}⌉ = <span class="r">${fmt(leaves)}</span>`,
        `<b>높이 h</b> = ⌈log<sub>${fmt(f)}</sub>(${fmt(leaves)})⌉ + 1 = <span class="r">${h}</span>`,
        `<b>log<sub>f</sub>N</b> = ln(${fmt(N)}) / ln(${fmt(f)}) = <span class="r">${logF.toFixed(2)}</span>`,
      ].join('<br />');

      /* ── 레벨 바 ── */
      const maxLog = Math.log10(Math.max(10, leaves) + 1);
      $('cLevels').innerHTML = levels
        .slice()
        .reverse()
        .map((count, i) => {
          const isLeaf = i === h - 1;
          const label = i === 0 ? 'L0 · root' : isLeaf ? `L${i} · leaf` : `L${i} · internal`;
          const pct = 5 + 95 * (Math.log10(count + 1) / maxLog);
          const capacity = isLeaf ? count * b : count * f;
          return `<div class="level-bar">
            <span>${label}</span>
            <span class="level-bar__track"><span class="level-bar__fill${isLeaf ? ' level-bar__fill--leaf' : ''}" style="width:${pct}%"></span></span>
            <span>${fmt(count)} page · ${fmt(capacity)} entry</span>
          </div>`;
        })
        .join('');

      /* ── 비교 ── */
      $('cCompare').innerHTML = `<span class="callout__t">이진 탐색 트리와 비교</span>
        같은 <span class="mono">${fmt(N)}</span>건을 이진 트리(밑 2)에 넣으면 높이가
        <span class="mono" style="color:var(--hot)">log₂ N ≈ ${binaryIO}</span> → 노드마다 랜덤 I/O 1회씩 <span class="mono">${binaryIO}회</span>.
        B+Tree는 밑이 <span class="mono acc">${fmt(f)}</span> 이므로 <span class="mono acc">${h}회</span>
        — <strong>${(binaryIO / h).toFixed(1)}배</strong> 적습니다.
        게다가 내부 노드 전체 크기가 <span class="mono">${internalMB < 1 ? internalMB.toFixed(2) : fmt(internalMB)} MB</span> 뿐이라
        버퍼 풀에 상주시키면 실제 디스크 접근은 <strong>리프 1회</strong>로 줄어듭니다.`;
    }

    FIELDS.forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', calc);
    });

    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = PRESETS[btn.dataset.preset];
        if (!p) return;
        Object.entries(p).forEach(([k, v]) => { if ($(k)) $(k).value = v; });
        calc();
      });
    });

    calc();
  });
})();
