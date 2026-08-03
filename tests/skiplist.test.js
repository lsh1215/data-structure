const { SkipList } = require('../assets/js/skiplist.js');
let pass=0, fail=0;
const check=(c,l)=>{ if(c) pass++; else { fail++; console.error('  ✗ '+l); } };
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};}

for (const seed of [1,7,42,99]) {
  const sl = new SkipList(mulberry32(seed));
  const set = new Map();
  let bad=null;
  for (let i=0;i<300;i++){
    const s = Math.floor(mulberry32(seed*i+1)()*1000);
    const m = 'm'+i;
    sl.insert(s,m); set.set(m,s);
    const e = sl.validate();
    if (e.length && !bad) bad = `insert ${m}: ${e[0]}`;
  }
  check(!bad, `seed ${seed} 삽입 무결성 — ${bad}`);
  const ord = sl.order().map(n=>n.score);
  check(ord.join(',')===ord.slice().sort((a,b)=>a-b).join(','), `seed ${seed} 정렬 유지`);
  check(sl.length===300, `seed ${seed} 길이 300`);
  // 삭제
  let bad2=null;
  for (let i=0;i<150;i++){ sl.remove('m'+i); const e=sl.validate(); if(e.length&&!bad2) bad2=`remove m${i}: ${e[0]}`; }
  check(!bad2, `seed ${seed} 삭제 무결성 — ${bad2}`);
  check(sl.length===150, `seed ${seed} 삭제 후 길이 150`);
  // 검색
  const rest = sl.order();
  const target = rest[Math.floor(rest.length/2)];
  const steps = sl.search(target.score);
  check(steps[steps.length-1].kind==='done', `seed ${seed} 검색 성공`);
}
// 레벨 분포
{
  const sl = new SkipList(mulberry32(5));
  for (let i=0;i<2000;i++) sl.insert(i, 'x'+i);
  const lv = {};
  sl.order().forEach(n=>lv[n.level]=(lv[n.level]||0)+1);
  const l1 = lv[1]/2000;
  check(l1>0.7 && l1<0.8, `레벨1 비율이 이론값 0.75 근처 (${l1.toFixed(3)})`);
  check(sl.validate().length===0, '대량 삽입 후 무결성');
}
console.log(`\n${fail===0?'✓ ALL PASS':'✗ FAILED'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
