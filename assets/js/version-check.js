/* ═══════════════════════════════════════════════════════════
   새 배포 감지 · 오래된 캐시본 자가 치유

   GitHub Pages 는 HTML 을 Cache-Control: max-age=600 으로 내려주고
   헤더를 바꿀 수 없다. CSS/JS 는 배포 때 내용 해시를 URL 에 붙여
   (scripts/stamp-assets.js) 확실히 갱신되지만, HTML 은 URL 이 고정이라
   브라우저가 옛 문서를 계속 보여줄 수 있다.

   판정 기준은 딱 하나다. version.json 의 build 와
   <html data-build> 가 같은가.
     · version.json 이 없다        → 배포본이 아니다(로컬 개발). 아무것도 안 한다.
     · data-build 가 없다          → 스탬프 이전의 캐시본. 치유 대상.
     · data-build 가 다르다        → 새 배포가 올라왔다. 치유 대상.

   치유는 문서 URL 을 cache: 'reload' 로 다시 받아 HTTP 캐시 항목
   자체를 갈아끼운 뒤 새로고침한다. 쿼리스트링으로 돌아가는 방식과 달리
   썩은 캐시 항목이 실제로 사라지고 주소도 더러워지지 않는다.
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (!/^https?:$/.test(location.protocol)) return; // file:// 로컬 열람

  const tag =
    document.currentScript ||
    document.querySelector('script[src*="version-check.js"]');
  if (!tag || !tag.src) return;

  const root = tag.src.replace(/assets\/js\/version-check\.js.*$/, '');
  const versionUrl = root + 'version.json';

  const HEAL_KEY = 'ds:heal-attempt';
  const AUTO_WINDOW = 15000; // 로드 직후 15초 안이면 배너 없이 바로 갱신
  const docEl = document.documentElement;
  const openedAt = Date.now();

  let banner = null;
  let lastCheck = 0;
  let healing = false;
  let touched = false;

  ['pointerdown', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, () => { touched = true; }, { once: true, passive: true })
  );

  /* ── sessionStorage 는 차단된 환경이 있어 항상 감싼다 ── */
  function store(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch (_) { /* 무시 */ }
    return null;
  }

  /* ── 캐시 항목 교체 후 새로고침. 이미 시도한 빌드면 false ── */
  function heal(newBuild) {
    if (healing) return true;
    if (store(HEAL_KEY) === newBuild) return false; // 한 번 시도했는데도 그대로다
    store(HEAL_KEY, newBuild);
    healing = true;

    fetch(location.href, { cache: 'reload', credentials: 'same-origin' })
      .then(() => location.reload())
      .catch(() => {
        /* 캐시 갱신이 막힌 환경이면 URL 을 바꿔서라도 새 문서를 받는다 */
        const u = new URL(location.href);
        u.searchParams.set('v', newBuild);
        location.replace(u.toString());
      });
    return true;
  }

  /* ── 치유가 통했으면 흔적을 지운다 ── */
  function settle() {
    store(HEAL_KEY, null);
    const u = new URL(location.href);
    if (u.searchParams.has('v')) {
      u.searchParams.delete('v');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  }

  function showBanner(newBuild) {
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.innerHTML =
      '<span class="update-banner__dot" aria-hidden="true"></span>' +
      '<span class="update-banner__t">새 버전이 배포되었습니다</span>' +
      '<button type="button" class="update-banner__btn">새로고침</button>' +
      '<button type="button" class="update-banner__close" aria-label="닫기">✕</button>';

    banner.querySelector('.update-banner__btn').addEventListener('click', () => {
      store(HEAL_KEY, null); // 사용자가 직접 눌렀으면 재시도 제한을 푼다
      heal(newBuild);
    });
    banner.querySelector('.update-banner__close').addEventListener('click', () => {
      banner.remove();
      banner = null;
      lastCheck = Date.now() + 10 * 60 * 1000; // 10분간 다시 묻지 않는다
    });

    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('update-banner--in'));
  }

  function onStale(newBuild) {
    /* 방금 열린 페이지는 조용히 갈아끼우고, 쓰는 중이면 물어본다 */
    const quiet = !touched && Date.now() - openedAt < AUTO_WINDOW;
    if (quiet && heal(newBuild)) return;
    if (document.body) showBanner(newBuild);
  }

  function check() {
    const now = Date.now();
    if (healing || now - lastCheck < 60 * 1000) return;
    lastCheck = now;

    fetch(versionUrl, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.build) return; // 배포본이 아니다 — 로컬 개발
        if (data.build === docEl.dataset.build) settle();
        else onStale(data.build);
      })
      .catch(() => {});
  }

  if (document.readyState === 'complete') check();
  else window.addEventListener('load', check);

  /* 뒤로가기 캐시(bfcache)로 복원된 페이지는 load 가 다시 뛰지 않는다 */
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    lastCheck = 0;
    check();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
})();
