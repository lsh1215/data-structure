/* ═══════════════════════════════════════════════════════════
   오래된 캐시본 부트스트랩 (starfield.js 안에 있는 이유)
   - 배포된 문서는 <html data-build="..."> 를 갖는다. 그게 없다는 건
     지금 보고 있는 HTML 이 스탬프 도입 이전의 브라우저 캐시본이라는 뜻이다.
   - 그 옛 HTML 에는 version-check.js 참조 자체가 없다. 그래서 옛 페이지도
     반드시 로드하는 이 파일에서 검사기를 끼워 넣는다.
   - 로컬 개발 문서에도 스탬프가 없지만, version.json 이 없으므로
     version-check.js 는 아무 일도 하지 않는다.
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (document.documentElement.dataset.build) return; // 최신 문서 — 이미 참조하고 있다
  if (!/^https?:$/.test(location.protocol)) return;   // file:// 로컬 열람
  if (document.querySelector('script[src*="version-check.js"]')) return;

  const self = document.currentScript;
  if (!self) return;
  const root = self.src.replace(/assets\/js\/starfield\.js.*$/, '');

  const s = document.createElement('script');
  s.src = root + 'assets/js/version-check.js?boot=' + Date.now();
  document.head.appendChild(s);
})();

/* ═══════════════════════════════════════════════════════════
   Ambient star field — shared background canvas
   Usage: <canvas class="star-field" id="starField"
                  data-colors="#00d9c0,#a855f7"></canvas>
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const canvas = document.getElementById('starField');
  if (!canvas) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = canvas.getContext('2d');
  const colors = (canvas.dataset.colors || '#00d9c0,#a855f7')
    .split(',')
    .map((c) => c.trim());

  let w = 0;
  let h = 0;
  let dpr = 1;
  let stars = [];
  let raf = null;

  function hexToRgb(hex) {
    const v = hex.replace('#', '');
    const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const rgbs = colors.map(hexToRgb);

  function build() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const density = Math.min(160, Math.floor((w * h) / 14000));
    stars = new Array(density).fill(0).map(() => {
      const tinted = Math.random() < 0.22;
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.25 + 0.25,
        a: Math.random() * 0.45 + 0.08,
        tw: Math.random() * 0.014 + 0.003,
        phase: Math.random() * Math.PI * 2,
        vy: (Math.random() * 0.12 + 0.02) * -1,
        rgb: tinted ? rgbs[Math.floor(Math.random() * rgbs.length)] : [220, 232, 248],
      };
    });
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const alpha = s.a * (0.55 + 0.45 * Math.sin(t * s.tw + s.phase));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${alpha.toFixed(3)})`;
      ctx.fill();

      s.y += s.vy;
      if (s.y < -2) {
        s.y = h + 2;
        s.x = Math.random() * w;
      }
    }
    raf = requestAnimationFrame(draw);
  }

  function still() {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${s.a.toFixed(3)})`;
      ctx.fill();
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      build();
      if (reduced) still();
    }, 160);
  });

  document.addEventListener('visibilitychange', () => {
    if (reduced) return;
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    } else if (!raf) {
      raf = requestAnimationFrame(draw);
    }
  });

  build();
  if (reduced) still();
  else raf = requestAnimationFrame(draw);
})();
