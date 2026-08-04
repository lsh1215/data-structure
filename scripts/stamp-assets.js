#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   배포용 캐시 버스팅 스탬프

   GitHub Pages 는 정적 파일을 Cache-Control: max-age=600 으로 내려주고
   헤더를 바꿀 수 없다. 그대로 두면 새 HTML 과 10분 묵은 CSS/JS 가
   섞여서 화면이 깨질 수 있다.

   그래서 배포 직전에 CSS/JS 참조 URL 뒤에 파일 내용 해시를 붙인다.
   내용이 바뀐 파일만 URL 이 바뀌므로 바뀐 것만 새로 받고 나머지는
   캐시를 그대로 쓴다. 저장소의 HTML 은 건드리지 않고 배포 아티팩트
   에서만 치환되므로 소스는 깨끗하게 남는다.

   사용: node scripts/stamp-assets.js
═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.cwd();

/* ── 대상 HTML 수집 ── */
const htmlFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'scripts') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.html')) htmlFiles.push(p);
  }
})(ROOT);

/* ── 파일 내용 해시 ── */
const hashCache = new Map();
function hashOf(file) {
  if (hashCache.has(file)) return hashCache.get(file);
  const h = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  hashCache.set(file, h);
  return h;
}

let stamped = 0;
for (const file of htmlFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);

  /* 로컬 css/js 참조에만 ?v=<hash> 부착 (외부 CDN 제외, 멱등) */
  const out = src.replace(/(href|src)="([^"?#]+\.(?:css|js))"/g, (m, attr, url) => {
    if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) return m;
    const target = path.resolve(dir, url);
    if (!fs.existsSync(target)) return m;
    stamped++;
    return `${attr}="${url}?v=${hashOf(target)}"`;
  });

  if (out !== src) fs.writeFileSync(file, out);
}

console.log(`stamped ${stamped} asset refs in ${htmlFiles.length} html files`);
