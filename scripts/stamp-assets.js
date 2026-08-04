#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   배포용 캐시 버스팅 스탬프
   - GitHub Pages 는 HTML/CSS/JS 를 모두 Cache-Control: max-age=600
     으로 내려주고 헤더를 바꿀 수 없다.
   - 그래서 배포 직전에 CSS/JS 참조 URL 뒤에 파일 내용 해시를 붙인다.
     내용이 바뀐 파일만 URL 이 바뀌므로, 바뀐 것만 새로 받고
     안 바뀐 것은 캐시를 그대로 쓴다.
   - HTML 자체는 URL 을 바꿀 수 없으므로 version.json 을 남겨
     클라이언트가 새 빌드를 감지할 수 있게 한다.

   사용: node scripts/stamp-assets.js [buildId]
═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.cwd();
const BUILD = String(process.argv[2] || Date.now()).slice(0, 12);

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
  let src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);

  /* 로컬 css/js 참조에만 ?v=<hash> 부착 (외부 CDN 제외, 멱등) */
  src = src.replace(/(href|src)="([^"?#]+\.(?:css|js))"/g, (m, attr, url) => {
    if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) return m;
    const target = path.resolve(dir, url);
    if (!fs.existsSync(target)) return m;
    stamped++;
    return `${attr}="${url}?v=${hashOf(target)}"`;
  });

  /* 이 문서가 어느 빌드인지 표시. 이게 빠지면 클라이언트가 옛 캐시본을
     감지할 수 없으므로 조용히 넘어가지 않고 배포를 실패시킨다. */
  if (!/<html\b[^>]*>/.test(src)) {
    console.error(`no <html> tag to stamp: ${path.relative(ROOT, file)}`);
    process.exitCode = 1;
    continue;
  }
  src = src.replace(/<html\b[^>]*>/, `<html lang="ko" data-build="${BUILD}">`);

  fs.writeFileSync(file, src);
  if (!/<html[^>]*\bdata-build=/.test(fs.readFileSync(file, 'utf8'))) {
    console.error(`stamp verification failed: ${path.relative(ROOT, file)}`);
    process.exitCode = 1;
  }
}

if (!htmlFiles.length) {
  console.error('no html files found — 배포 아티팩트가 비어 있다');
  process.exitCode = 1;
}
if (process.exitCode) process.exit(process.exitCode);

fs.writeFileSync(
  path.join(ROOT, 'version.json'),
  JSON.stringify({ build: BUILD, time: new Date().toISOString() }, null, 2) + '\n'
);

console.log(`stamped ${stamped} asset refs in ${htmlFiles.length} html files · build=${BUILD}`);
