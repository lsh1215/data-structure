/* ═══════════════════════════════════════════════════════════
   새 배포 감지
   - GitHub Pages 는 HTML 도 10분간 캐시된다. 그래서 배포 직후에는
     브라우저가 옛 HTML 을 그대로 보여줄 수 있다.
   - version.json 을 캐시 없이 읽어 지금 문서의 빌드와 비교하고,
     다르면 배너를 띄운다. 새로고침은 쿼리스트링을 바꿔
     캐시를 확실히 우회한 뒤 이동한다.
   - file:// 이나 version.json 이 없는 환경에서는 조용히 아무것도 안 한다.
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (location.protocol === 'file:') return;

  const build = document.documentElement.dataset.build;
  if (!build) return; // 스탬프되지 않은(로컬 개발) 문서

  /* 이 스크립트 위치로부터 사이트 루트를 구한다 */
  const self = document.currentScript;
  if (!self) return;
  const root = self.src.replace(/assets\/js\/version-check\.js.*$/, '');
  const versionUrl = root + 'version.json';

  let banner = null;
  let lastCheck = 0;

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
      /* 같은 URL 로 reload 하면 캐시된 HTML 이 다시 나올 수 있어
         쿼리스트링을 바꿔 완전히 새로 받게 한다 */
      const u = new URL(location.href);
      u.searchParams.set('v', newBuild);
      location.replace(u.toString());
    });
    banner.querySelector('.update-banner__close').addEventListener('click', () => {
      banner.remove();
      banner = null;
      lastCheck = Date.now() + 10 * 60 * 1000; // 10분간 다시 묻지 않는다
    });

    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('update-banner--in'));
  }

  function check() {
    const now = Date.now();
    if (now - lastCheck < 60 * 1000) return;
    lastCheck = now;
    fetch(versionUrl, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.build && data.build !== build) showBanner(data.build);
      })
      .catch(() => {});
  }

  window.addEventListener('load', check);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
})();
