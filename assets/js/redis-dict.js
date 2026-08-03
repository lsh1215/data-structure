/* ═══════════════════════════════════════════════════════════
   Redis dict / hashtable 모델
   - dictEntry 체이닝, 헤드 삽입, load factor 기반 확장,
     점진적 리해싱(ht[0] → ht[1])을 실제 동작대로 구현한다.
   - 해시는 데모용 FNV-1a 32bit (실제 Redis는 SipHash-1-2).
═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RedisLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* FNV-1a 32bit */
  function fnv1a(str) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  const hex = (n) => '0x' + n.toString(16).padStart(8, '0');
  const bin = (n, w) => (n >>> 0).toString(2).padStart(w, '0');

  /* 값의 인코딩 결정 (Redis OBJ_ENCODING_*) */
  function encodingOf(val) {
    const s = String(val);
    if (/^-?\d+$/.test(s) && s.length <= 20 && Math.abs(Number(s)) <= 9223372036854775807) {
      return { enc: 'int', why: '64bit 정수로 표현 가능 → 포인터 자리에 값을 그대로 저장 (공유 정수 풀 사용)' };
    }
    if (s.length <= 44) {
      return { enc: 'embstr', why: 'robj와 SDS를 한 번의 malloc으로 붙여 할당 (44바이트 이하, 읽기 전용)' };
    }
    return { enc: 'raw', why: 'robj와 SDS를 따로 할당 (45바이트 이상, 수정 가능)' };
  }

  const STAGES = [
    'RESP 파싱',
    'lookupCommand',
    'db->dict 선택',
    'hash 계산',
    'bucket index',
    '체인 탐색',
    'dictEntry',
    '인코딩',
    'rehash 검사',
  ];

  class RedisDict {
    constructor(size) {
      this.ht = [this.mkTable(size || 4), null];
      this.rehashidx = -1;
      this.steps = [];
      this.seq = 0;
      this.forceRatio = 5;   // dict_force_resize_ratio
      this.canResize = true; // BGSAVE 중이면 false
      this.stats = { collisions: 0, expands: 0, rehashSteps: 0, ops: 0 };
    }

    mkTable(size) {
      return {
        size,
        sizemask: size - 1,
        used: 0,
        buckets: Array.from({ length: size }, () => []),
      };
    }

    get rehashing() { return this.rehashidx !== -1; }

    /* ── 스냅샷 ── */
    snapshot() {
      const t = (h) =>
        h && {
          size: h.size,
          sizemask: h.sizemask,
          used: h.used,
          buckets: h.buckets.map((b) => b.map((e) => ({ key: e.key, val: e.val, hash: e.hash, enc: e.enc }))),
        };
      return {
        ht0: t(this.ht[0]),
        ht1: t(this.ht[1]),
        rehashidx: this.rehashidx,
        load: this.ht[0].used / this.ht[0].size,
      };
    }

    _push(kind, stage, msg, detail, deco) {
      if (this.quiet) return;
      this.steps.push({
        kind,
        stage,
        msg,
        detail: detail || '',
        deco: deco || {},
        snap: this.snapshot(),
        stats: Object.assign({}, this.stats),
      });
    }

    /* ── 조회 헬퍼 ── */
    findEntry(key) {
      const h = fnv1a(key);
      for (let t = 0; t <= 1; t++) {
        const tab = this.ht[t];
        if (!tab) continue;
        const idx = h & tab.sizemask;
        const chain = tab.buckets[idx];
        for (let i = 0; i < chain.length; i++) if (chain[i].key === key) return { t, idx, i, entry: chain[i] };
        if (!this.rehashing) break;
      }
      return null;
    }

    keys() {
      const out = [];
      for (const tab of this.ht) {
        if (!tab) continue;
        for (const b of tab.buckets) for (const e of b) out.push(e.key);
      }
      return out;
    }

    /* ── 점진적 리해싱 1스텝 ── */
    _rehashStep(record) {
      if (!this.rehashing) return false;
      let empties = 0;
      while (this.ht[0].buckets[this.rehashidx].length === 0) {
        this.rehashidx++;
        if (this.rehashidx >= this.ht[0].size) break;
        if (++empties >= 10) {
          if (record) {
            this._push('rehash', 8,
              `빈 버킷을 10개 건너뛰고 중단 — rehashidx = ${this.rehashidx}`,
              '한 번에 오래 붙잡고 있지 않도록 빈 버킷 방문 횟수도 제한한다 (n*10)',
              { rehashCursor: true });
          }
          return true;
        }
      }

      if (this.rehashidx >= this.ht[0].size) { this._finishRehash(record); return false; }

      const idx = this.rehashidx;
      const chain = this.ht[0].buckets[idx];
      const moved = chain.map((e) => e.key);
      while (chain.length) {
        const e = chain.pop();               // 체인 끝부터 옮긴다
        const nidx = e.hash & this.ht[1].sizemask;
        this.ht[1].buckets[nidx].unshift(e); // 새 버킷의 헤드로
        this.ht[0].used--;
        this.ht[1].used++;
      }
      this.rehashidx++;
      this.stats.rehashSteps++;

      if (record) {
        this._push('rehash', 8,
          `ht[0] 버킷 #${idx} 의 ${moved.length}개 엔트리를 ht[1] 로 이주 · rehashidx = ${this.rehashidx}`,
          moved.length
            ? `${moved.join(', ')} → 새 sizemask(${this.ht[1].sizemask}) 로 인덱스를 다시 계산해 옮긴다`
            : '빈 버킷은 그냥 넘어간다',
          { movedKeys: moved, rehashCursor: true, activeBucket: { t: 0, idx } });
      }

      if (this.ht[0].used === 0) this._finishRehash(record);
      return true;
    }

    _finishRehash(record) {
      if (this.rehashidx === -1) return;
      const oldSize = this.ht[0].size;
      this.ht[0] = this.ht[1];
      this.ht[1] = null;
      this.rehashidx = -1;
      if (record) {
        this._push('rehash-done', 8,
          `리해싱 완료 — ht[0](${oldSize}) 해제, ht[1](${this.ht[0].size}) 이 새 ht[0] 이 된다`,
          '이 시점부터 sizemask 는 ' + this.ht[0].sizemask + ' 하나만 쓰인다',
          {});
      }
    }

    rehashAll() {
      let guard = 0;
      while (this.rehashing && guard++ < 10000) this._rehashStep(true);
    }

    /* ── 확장 판단 ── */
    _expandIfNeeded() {
      if (this.rehashing) return false;
      const t0 = this.ht[0];
      const load = t0.used / t0.size;
      if (t0.used < t0.size) {
        this._push('check', 8,
          `load factor = ${t0.used}/${t0.size} = ${load.toFixed(2)} < 1.0 → 확장 없음`,
          'Redis 는 used/size 가 1 이상이면 확장을 검토한다 (BGSAVE 중이면 5 이상일 때만 강제 확장)',
          {});
        return false;
      }
      if (!this.canResize && load < this.forceRatio) {
        this._push('check', 8,
          `load factor ${load.toFixed(2)} ≥ 1.0 이지만 BGSAVE 중 → 확장 보류`,
          'fork 된 자식과 페이지를 공유하는 동안 대규모 복사를 피하기 위해 dict_can_resize=0. ratio 5 를 넘으면 강제 확장',
          {});
        return false;
      }
      let size = 4;
      while (size < t0.used + 1) size <<= 1;
      if (size <= t0.size) size = t0.size * 2;
      this.ht[1] = this.mkTable(size);
      this.rehashidx = 0;
      this.stats.expands++;
      this._push('expand', 8,
        `load factor = ${load.toFixed(2)} ≥ 1.0 → ht[1] 을 size ${size} 로 새로 할당하고 rehashidx = 0`,
        `크기는 항상 2의 거듭제곱이라 나머지 연산(%) 대신 & ${size - 1} 로 인덱스를 구할 수 있다. ` +
        '기존 엔트리는 지금 한꺼번에 옮기지 않고, 이후 명령이 올 때마다 버킷 하나씩 옮긴다 (점진적 리해싱)',
        { newTable: true });
      return true;
    }

    _shrinkIfNeeded() {
      if (this.rehashing) return false;
      const t0 = this.ht[0];
      if (t0.size <= 4) return false;
      const load = t0.used / t0.size;
      if (load >= 0.1) return false;
      let size = 4;
      while (size < t0.used) size <<= 1;
      this.ht[1] = this.mkTable(size);
      this.rehashidx = 0;
      this._push('expand', 8,
        `load factor = ${load.toFixed(2)} < 0.1 → ht[1] 을 size ${size} 로 줄여 축소 리해싱 시작`,
        '삭제가 많아 테이블이 헐거워지면 메모리를 되돌려준다 (htNeedsResize)',
        { newTable: true });
      return true;
    }

    /* ═════════════ SET ═════════════ */
    set(key, val) {
      this.steps = [];
      this.stats.ops++;
      const respLines = ['*3', '$3', 'SET', `$${key.length}`, key, `$${String(val).length}`, String(val)];

      this._push('resp', 0,
        `클라이언트가 보낸 바이트를 RESP 배열로 파싱 → argv = ["SET", "${key}", "${val}"]`,
        respLines.join('\\r\\n') + '\\r\\n',
        {});

      this._push('cmd', 1,
        'server.commands 에서 "set" 을 찾는다 — 이 명령 테이블 자체도 dict 이다',
        'lookupCommand() → setCommand 함수 포인터를 얻는다. 즉 명령 조회도 O(1) 해시 조회',
        {});

      this._push('db', 2,
        'SELECT 한 DB의 redisDb->dict 를 대상으로 삼는다',
        '기본 16개 DB(databases 16). 각 DB는 키 공간 dict 하나 + 만료시간 dict(expires) 하나를 가진다',
        {});

      if (this.rehashing) this._rehashStep(true);

      const h = fnv1a(key);
      this._push('hash', 3,
        `hash("${key}") = ${hex(h)}`,
        `실제 Redis는 SipHash-1-2 를 쓴다 (해시 충돌 공격 방어를 위해 서버 기동 시 랜덤 시드 사용). ` +
        `여기서는 데모용 FNV-1a 32bit.`,
        { hash: h, hashKey: key });

      const tab = this.rehashing ? this.ht[1] : this.ht[0];
      const tIdx = this.rehashing ? 1 : 0;
      const idx = h & tab.sizemask;
      this._push('index', 4,
        `idx = hash & sizemask = ${hex(h)} & ${hex(tab.sizemask)} = ${idx}`,
        `${bin(h & 0xff, 8)} (하위 8bit)\n& ${bin(tab.sizemask, 8)}  ← sizemask = size(${tab.size}) − 1\n= ${bin(idx, 8)} = ${idx}\n\n` +
        `크기가 2의 거듭제곱이라 sizemask 는 항상 0b111…1 형태 → % 연산 없이 비트 AND 한 번이면 끝난다.`,
        { activeBucket: { t: tIdx, idx }, hash: h });

      /* 기존 키 확인: 리해싱 중이면 두 테이블 모두 확인해야 한다 */
      const found = this.findEntry(key);
      const chain = tab.buckets[idx];
      this._push('probe', 5,
        chain.length
          ? `버킷 #${idx} 에 이미 ${chain.length}개 엔트리가 있다 → 체인을 따라가며 키를 비교`
          : `버킷 #${idx} 는 비어 있다 (NULL)`,
        chain.length
          ? '충돌(collision)이다. 해시가 같아서가 아니라 인덱스가 같아서 생긴다. ' +
            '체인 길이가 곧 최악 탐색 비용이므로 load factor 를 1 근처로 유지하는 것이 중요하다.'
          : '체인이 비어 있으면 비교 없이 바로 삽입한다.',
        { activeBucket: { t: tIdx, idx }, compareKeys: chain.map((e) => e.key) });

      if (found) {
        found.entry.val = val;
        const encInfo = encodingOf(val);
        found.entry.enc = encInfo.enc;
        this._push('update', 6,
          `기존 키 발견 → 값만 교체 (dictEntry 재사용, used 는 그대로)`,
          '키가 이미 있으면 새 엔트리를 만들지 않고 value 포인터만 바꾼다. 이전 robj 는 참조 카운트가 줄어 해제된다.',
          { activeBucket: { t: found.t, idx: found.idx }, activeKey: key });
        this._push('encode', 7, `값 인코딩: ${encInfo.enc}`, encInfo.why, { activeKey: key });
        this._push('done', 8, `+OK · 총 엔트리 ${this.ht[0].used + (this.ht[1] ? this.ht[1].used : 0)}개`, '', { activeKey: key });
        return this.steps;
      }

      if (chain.length) this.stats.collisions++;

      const encInfo = encodingOf(val);
      const entry = { key, val, hash: h, enc: encInfo.enc, id: ++this.seq };
      chain.unshift(entry);     // 헤드 삽입 — O(1)
      tab.used++;

      this._push('insert', 6,
        `dictEntry 를 할당해 버킷 #${idx} 체인의 <strong>맨 앞</strong>에 매단다`,
        'dictEntry { void *key; union v; struct dictEntry *next; } — 24바이트.\n' +
        '헤드에 넣는 이유: 꼬리까지 순회할 필요가 없어 O(1). ' +
        '게다가 방금 넣은 키가 곧 다시 조회될 확률이 높다(지역성).',
        { activeBucket: { t: tIdx, idx }, activeKey: key, newKey: key });

      this._push('encode', 7,
        `값 "${val}" 의 인코딩 = ${encInfo.enc}`,
        encInfo.why + '\n\nkey 쪽은 항상 SDS 문자열. value 만 robj 로 감싸 인코딩을 고른다.',
        { activeKey: key });

      if (!this.rehashing) {
        this._expandIfNeeded();
      } else {
        this._push('check', 8,
          `이미 리해싱 중 — 이번 명령에서도 버킷 하나를 옮겼다 (rehashidx = ${this.rehashidx})`,
          '리해싱 중에는 새 엔트리를 항상 ht[1] 에만 넣는다. 그래야 ht[0] 이 단조 감소해서 끝난다.',
          { rehashCursor: true });
      }

      this._push('done', 8,
        `+OK · 총 엔트리 ${this.ht[0].used + (this.ht[1] ? this.ht[1].used : 0)}개`,
        '', { activeKey: key });
      return this.steps;
    }

    /* ═════════════ GET ═════════════ */
    get(key) {
      this.steps = [];
      this.stats.ops++;
      this._push('resp', 0, `argv = ["GET", "${key}"]`, `*2\\r\\n$3\\r\\nGET\\r\\n$${key.length}\\r\\n${key}\\r\\n`, {});
      this._push('cmd', 1, 'lookupCommand("get") → getCommand', '', {});
      this._push('db', 2, 'redisDb->dict 에서 조회', '', {});

      if (this.rehashing) this._rehashStep(true);

      const h = fnv1a(key);
      this._push('hash', 3, `hash("${key}") = ${hex(h)}`, '조회도 삽입과 완전히 같은 해시를 쓴다.', { hash: h, hashKey: key });

      let result = null;
      for (let t = 0; t <= 1; t++) {
        const tab = this.ht[t];
        if (!tab) break;
        const idx = h & tab.sizemask;
        this._push('index', 4,
          `ht[${t}] 에서 idx = ${hex(h)} & ${hex(tab.sizemask)} = ${idx}`,
          this.rehashing
            ? '리해싱 중이면 ht[0] 에 없을 때 ht[1] 도 확인해야 한다. 두 테이블의 sizemask 가 다르므로 인덱스도 다르다.'
            : '',
          { activeBucket: { t, idx }, hash: h });

        const chain = tab.buckets[idx];
        let hit = null;
        for (let i = 0; i < chain.length; i++) {
          this._push('probe', 5,
            `체인 ${i + 1}번째 엔트리 "${chain[i].key}" 와 키 비교`,
            '해시가 같아도 키가 다를 수 있으므로 반드시 문자열 비교까지 한다.',
            { activeBucket: { t, idx }, activeKey: chain[i].key, compareKeys: [chain[i].key] });
          if (chain[i].key === key) { hit = chain[i]; break; }
        }
        if (hit) { result = hit; break; }
        if (!this.rehashing) break;
      }

      if (result) {
        this._push('done', 7,
          `HIT → "${result.val}" (인코딩 ${result.enc})`,
          '체인 길이가 짧으면 사실상 상수 시간. 이것이 Redis 가 O(1)인 이유다.',
          { activeKey: result.key });
      } else {
        this._push('miss', 7, `MISS → (nil)`, '해당 버킷 체인을 끝까지 봤지만 키가 없다.', {});
      }
      return this.steps;
    }

    /* ═════════════ DEL ═════════════ */
    del(key) {
      this.steps = [];
      this.stats.ops++;
      this._push('resp', 0, `argv = ["DEL", "${key}"]`, '', {});
      this._push('cmd', 1, 'lookupCommand("del") → delCommand', '', {});
      this._push('db', 2, 'redisDb->dict 에서 삭제', '', {});

      if (this.rehashing) this._rehashStep(true);

      const h = fnv1a(key);
      this._push('hash', 3, `hash("${key}") = ${hex(h)}`, '', { hash: h, hashKey: key });

      const found = this.findEntry(key);
      if (!found) {
        this._push('miss', 5, `${key} 없음 → (integer) 0`, '', {});
        return this.steps;
      }
      this._push('index', 4, `ht[${found.t}] 버킷 #${found.idx} 에서 발견`, '', {
        activeBucket: { t: found.t, idx: found.idx }, activeKey: key,
      });
      this._push('probe', 5,
        `체인에서 "${key}" 앞 엔트리의 next 포인터를 뒤 엔트리로 연결하고 dictEntry 를 해제`,
        '단일 연결 리스트라서 삭제하려면 앞 엔트리를 알아야 한다. ' +
        'Redis 는 체인을 순회하며 prev 를 들고 다니는 방식으로 처리한다.',
        { activeBucket: { t: found.t, idx: found.idx }, activeKey: key, dying: [key] });

      this.ht[found.t].buckets[found.idx].splice(found.i, 1);
      this.ht[found.t].used--;

      this._push('delete', 6, `삭제 완료 → (integer) 1`, '', { activeBucket: { t: found.t, idx: found.idx } });
      this._shrinkIfNeeded();
      this._push('done', 8, `총 엔트리 ${this.ht[0].used + (this.ht[1] ? this.ht[1].used : 0)}개`, '', {});
      return this.steps;
    }

    reset(size) {
      this.ht = [this.mkTable(size || 4), null];
      this.rehashidx = -1;
      this.steps = [];
      this.stats = { collisions: 0, expands: 0, rehashSteps: 0, ops: 0 };
    }

    bulkSet(pairs) {
      this.quiet = true;
      for (const [k, v] of pairs) this.set(k, v);
      this.quiet = false;
      this.steps = [];
    }

    /* 검증용 */
    validate() {
      const errs = [];
      for (let t = 0; t <= 1; t++) {
        const tab = this.ht[t];
        if (!tab) continue;
        if ((tab.size & (tab.size - 1)) !== 0) errs.push(`ht[${t}].size ${tab.size} is not power of 2`);
        if (tab.sizemask !== tab.size - 1) errs.push(`ht[${t}].sizemask mismatch`);
        let used = 0;
        tab.buckets.forEach((b, i) => {
          used += b.length;
          for (const e of b) {
            if ((e.hash & tab.sizemask) !== i) errs.push(`ht[${t}] entry ${e.key} in wrong bucket ${i}`);
          }
        });
        if (used !== tab.used) errs.push(`ht[${t}].used ${tab.used} != actual ${used}`);
      }
      const ks = this.keys();
      if (new Set(ks).size !== ks.length) errs.push('duplicate keys across tables');
      if (this.rehashing) {
        for (let i = 0; i < this.rehashidx; i++) {
          if (this.ht[0].buckets[i].length) errs.push(`bucket ${i} < rehashidx but not empty`);
        }
      }
      return errs;
    }
  }

  return { RedisDict, fnv1a, hex, bin, encodingOf, STAGES };
});
