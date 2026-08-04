/* ═══════════════════════════════════════════════════════════
   B-Tree / B+Tree engine
   - 실제 알고리즘을 그대로 구현하고, 모든 중간 상태를
     step 스냅샷으로 기록해 애니메이션 재생에 사용한다.
   - 브라우저 전역(BTreeLib) / Node(module.exports) 양쪽 지원.
═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BTreeLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 노드 안에서의 이진 탐색 (비교 횟수까지 계측) ── */
  function binarySearch(keys, key, counter) {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      counter.cmp++;
      if (keys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    return lo; // 첫 번째 keys[i] >= key
  }

  /* B+Tree 라우팅: key >= separator 이면 오른쪽으로 */
  function routeBPlus(keys, key, counter) {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      counter.cmp++;
      if (keys[mid] <= key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  class BTree {
    constructor(opts) {
      opts = opts || {};
      this.order = opts.order || 4;      // m = 최대 자식 수
      this.mode = opts.mode || 'bplus';  // 'btree' | 'bplus'
      this.seq = 0;
      this.root = this._mk(true);
      this.steps = [];
      this.total = { cmp: 0, reads: 0, splits: 0, merges: 0, keys: 0, ops: 0 };
      this.last = { cmp: 0, reads: 0, splits: 0, merges: 0 };
    }

    /* ── 파라미터 ── */
    get maxKeys() { return this.order - 1; }
    get minKeys() { return Math.ceil(this.order / 2) - 1; }        // 내부 노드 최소 키
    get leafMax() { return this.order - 1; }
    get leafMin() {
      return this.mode === 'bplus'
        ? Math.ceil((this.order - 1) / 2)
        : this.minKeys;
    }

    _mk(leaf) {
      return { id: ++this.seq, keys: [], children: [], leaf: !!leaf, next: null };
    }

    /* ── 스냅샷 ── */
    snapshot() {
      const nodes = [];
      let height = 0;
      const visit = (n, depth, parentId, childIdx) => {
        height = Math.max(height, depth + 1);
        nodes.push({
          id: n.id,
          keys: n.keys.slice(),
          childIds: n.children.map((c) => c.id),
          leaf: n.leaf,
          depth,
          parentId,
          childIdx,
          nextId: n.next ? n.next.id : null,
        });
        n.children.forEach((c, i) => visit(c, depth + 1, n.id, i));
      };
      visit(this.root, 0, null, 0);
      return {
        rootId: this.root.id,
        nodes,
        height,
        order: this.order,
        mode: this.mode,
        keyCount: this.countKeys(),
        nodeCount: nodes.length,
      };
    }

    countKeys() {
      let n = 0;
      const walk = (x) => {
        if (this.mode === 'bplus') { if (x.leaf) n += x.keys.length; }
        else n += x.keys.length;
        x.children.forEach(walk);
      };
      walk(this.root);
      return n;
    }

    keysInOrder() {
      const out = [];
      const walk = (x) => {
        if (x.leaf) { out.push(...x.keys); return; }
        if (this.mode === 'bplus') { x.children.forEach(walk); return; }
        for (let i = 0; i < x.keys.length; i++) { walk(x.children[i]); out.push(x.keys[i]); }
        walk(x.children[x.children.length - 1]);
      };
      walk(this.root);
      return out;
    }

    height() { return this.snapshot().height; }

    _push(kind, msg, deco, hold) {
      if (this.quiet) return;
      this.steps.push({
        kind,
        msg,
        deco: deco || {},
        hold: hold || 1,
        tree: this.snapshot(),
        last: Object.assign({}, this.last),
        total: Object.assign({}, this.total),
      });
    }

    _resetLast() { this.last = { cmp: 0, reads: 0, splits: 0, merges: 0 }; }

    _commitLast() {
      this.total.cmp += this.last.cmp;
      this.total.reads += this.last.reads;
      this.total.splits += this.last.splits;
      this.total.merges += this.last.merges;
    }

    /* ═════════════ 탐색 ═════════════ */

    /**
     * 리프까지 하강하며 경로를 기록한다.
     * B-Tree 모드에서는 내부 노드에서 키를 찾으면 즉시 반환.
     */
    _descend(key, opts) {
      opts = opts || {};
      const path = [];
      let node = this.root;
      for (;;) {
        this.last.reads++;
        const pathIds = path.map((p) => p.node.id);
        this._push('visit',
          `page #${node.id} 읽기 → [${node.keys.join(' · ') || '비어 있음'}]`,
          { active: [node.id], path: pathIds });

        let idx;
        if (this.mode === 'btree') {
          idx = binarySearch(node.keys, key, this.last);
          if (node.keys[idx] === key) {
            this._push('found', `page #${node.id} 안에서 ${key} 발견 (${idx + 1}번째 키)`,
              { active: [node.id], path: pathIds, keyHi: { [node.id]: [idx] }, state: { [node.id]: 'found' } });
            return { node, path, idx, found: true };
          }
        } else {
          idx = routeBPlus(node.keys, key, this.last);
        }

        if (node.leaf) {
          if (this.mode === 'bplus') {
            const pos = binarySearch(node.keys, key, this.last);
            const hit = node.keys[pos] === key;
            if (hit && opts.reportLeafHit !== false) {
              this._push('found', `리프 page #${node.id} 에서 ${key} 발견`,
                { active: [node.id], path: pathIds, keyHi: { [node.id]: [pos] }, state: { [node.id]: 'found' } });
            }
            return { node, path, idx: pos, found: hit };
          }
          return { node, path, idx, found: false };
        }

        const child = node.children[idx];
        this._push('route', this._routeMsg(node, key, idx, child), {
          active: [node.id],
          path: pathIds,
          edge: [[node.id, idx]],
          ptrHi: { [node.id]: [idx] },
        });
        path.push({ node, idx });
        node = child;
      }
    }

    _routeMsg(node, key, idx, child) {
      const k = node.keys;
      let cond;
      if (idx === 0) cond = `${key} < ${k[0]}`;
      else if (idx === k.length) cond = `${key} ≥ ${k[k.length - 1]}`;
      else cond = `${k[idx - 1]} ≤ ${key} < ${k[idx]}`;
      return `${cond} → ${idx + 1}번 포인터 (page #${child.id}) 로 하강`;
    }

    search(key) {
      this.steps = [];
      this._resetLast();
      this._push('start', `SEARCH ${key} — 루트부터 하강`, {});
      const r = this._descend(key, {});
      if (r.found) {
        this._push('done',
          `✓ ${key} 찾음 · 페이지 읽기 ${this.last.reads}회 · 키 비교 ${this.last.cmp}회`,
          { active: [r.node.id], keyHi: { [r.node.id]: [r.idx] }, state: { [r.node.id]: 'found' } });
      } else {
        this._push('miss',
          `✗ ${key} 없음 · 페이지 읽기 ${this.last.reads}회 · 키 비교 ${this.last.cmp}회`,
          { active: [r.node.id], state: { [r.node.id]: 'miss' } });
      }
      this._commitLast();
      return { found: r.found, steps: this.steps };
    }

    /* ═════════════ 삽입 ═════════════ */

    insert(key) {
      this.steps = [];
      this._resetLast();
      this.total.ops++;
      this._push('start', `INSERT ${key} — 들어갈 리프를 찾는다`, {});

      const r = this._descend(key, { reportLeafHit: false });
      if (r.found || (r.node.leaf && r.node.keys[r.idx] === key)) {
        this._push('err', `${key} 는 이미 존재 — UNIQUE 인덱스라면 여기서 중복 에러`,
          { active: [r.node.id], state: { [r.node.id]: 'miss' } });
        this._commitLast();
        return { ok: false, steps: this.steps };
      }

      const leaf = r.node;
      const pos = binarySearch(leaf.keys, key, this.last);
      leaf.keys.splice(pos, 0, key);
      this._push('place',
        `리프 page #${leaf.id} 의 ${pos + 1}번째 자리에 ${key} 삽입 → [${leaf.keys.join(' · ')}]`,
        { active: [leaf.id], keyNew: { [leaf.id]: [pos] }, state: { [leaf.id]: 'target' } });

      this._fixOverflow(leaf, r.path);

      const snap = this.snapshot();
      this._push('done',
        `완료 · 페이지 읽기 ${this.last.reads}회 · 비교 ${this.last.cmp}회 · 분할 ${this.last.splits}회 · 높이 ${snap.height}`,
        {});
      this._commitLast();
      return { ok: true, steps: this.steps };
    }

    _fixOverflow(node, path) {
      while (node.keys.length > this.maxKeys) {
        const before = node.keys.slice();
        this._push('overflow',
          `page #${node.id} 에 키가 ${before.length}개 — 한 노드가 가질 수 있는 최대치 ${this.maxKeys}개를 넘었다`,
          {
            active: [node.id],
            state: { [node.id]: 'overflow' },
            overflowKeys: { [node.id]: before.map((_, i) => i) },
          }, 1.5);

        this.last.splits++;
        const parentEntry = path.length ? path[path.length - 1] : null;
        const right = this._mk(node.leaf);
        const isCopyUp = this.mode === 'bplus' && node.leaf;

        /* ── ① 분할 계획을 먼저 보여준다 (아직 자르지 않는다) ── */
        const n = before.length;
        const mid = isCopyUp ? Math.ceil(n / 2) : (n - 1) >> 1;
        const upKey = before[mid];
        const leftIdx = [];
        const rightIdx = [];
        for (let i = 0; i < n; i++) {
          if (i < mid) leftIdx.push(i);
          else if (i > mid) rightIdx.push(i);
          else if (isCopyUp) rightIdx.push(i);   /* copy-up 은 중앙 키가 오른쪽에 남는다 */
        }
        const leftKeys = before.slice(0, mid);
        const rightKeys = isCopyUp ? before.slice(mid) : before.slice(mid + 1);

        this._push('median',
          isCopyUp
            ? `가운데를 기준으로 왼쪽 ${leftKeys.length}개 · 오른쪽 ${rightKeys.length}개로 나눈다. 오른쪽 첫 키 ${upKey} 는 리프에 그대로 두고 부모에 복사(copy-up)한다`
            : `가운데 키 ${upKey} 를 부모로 올린다(승진). 남는 키는 왼쪽 [${leftKeys.join(' · ') || '없음'}] · 오른쪽 [${rightKeys.join(' · ') || '없음'}] 로 갈라진다`,
          {
            active: [node.id],
            state: { [node.id]: 'overflow' },
            groupLeft: { [node.id]: leftIdx },
            groupRight: { [node.id]: rightIdx },
            medianKey: { [node.id]: mid },
            promoteFrom: { node: node.id, idx: mid },
          }, 2.2);

        /* ── ② 실제로 자른다 ── */
        if (isCopyUp) {
          right.keys = node.keys.splice(mid);
          right.next = node.next;
          node.next = right;
        } else {
          right.keys = before.slice(mid + 1);
          node.keys = before.slice(0, mid);
          if (!node.leaf) {
            right.children = node.children.slice(mid + 1);
            node.children = node.children.slice(0, mid + 1);
          }
        }

        const splitMsg = isCopyUp
          ? `리프가 둘로 갈라졌다 → [${node.keys.join(' · ')}] | [${right.keys.join(' · ')}] · ${upKey} 는 양쪽 모두에 있다(리프에 원본, 부모에 이정표)`
          : node.leaf
            ? `리프가 둘로 갈라졌다 → [${node.keys.join(' · ') || '비어 있음'}] | [${right.keys.join(' · ')}] · ${upKey} 는 위로 올라가 여기엔 없다`
            : `내부 노드가 갈라지며 자식 포인터도 ${node.children.length}개 · ${right.children.length}개로 나뉜다`;

        const splitDeco = {
          active: [node.id, right.id],
          state: { [node.id]: 'split-left', [right.id]: 'split-right' },
          bornFrom: { [right.id]: node.id },
        };

        /* ── ③ 부모에 자리를 만들고 키를 올려보낸다 ── */
        if (!parentEntry) {
          const newRoot = this._mk(false);
          newRoot.keys = [upKey];
          newRoot.children = [node, right];
          this.root = newRoot;
          splitDeco.bornFrom[newRoot.id] = node.id;
          splitDeco.incoming = { [newRoot.id]: [0] };
          splitDeco.promoteTo = { node: newRoot.id, idx: 0 };
          this._push('split', splitMsg, splitDeco, 1.6);

          const h = this.snapshot().height;
          this._push('newroot',
            `올라간 ${upKey} 를 담을 부모가 없다 → 새 루트 page #${newRoot.id} 를 만든다 · 트리 높이 ${h - 1} → ${h}`,
            {
              active: [newRoot.id],
              state: { [newRoot.id]: 'new' },
              keyNew: { [newRoot.id]: [0] },
              edge: [[newRoot.id, 0], [newRoot.id, 1]],
            }, 2);
          return;
        }

        const p = parentEntry.node;
        const at = parentEntry.idx;
        p.keys.splice(at, 0, upKey);
        p.children.splice(at + 1, 0, right);
        splitDeco.incoming = { [p.id]: [at] };
        splitDeco.promoteTo = { node: p.id, idx: at };
        this._push('split', splitMsg, splitDeco, 1.6);

        this._push('promote',
          `부모 page #${p.id} 가 ${upKey} 를 받아 [${p.keys.join(' · ')}] 가 되고, 새로 생긴 page #${right.id} 를 가리키는 포인터가 하나 늘어난다`,
          {
            active: [p.id],
            keyNew: { [p.id]: [at] },
            state: { [p.id]: 'target' },
            edge: [[p.id, at + 1]],
          }, 1.8);

        path.pop();
        node = p;
      }
    }

    /* ═════════════ 삭제 ═════════════ */

    remove(key) {
      this.steps = [];
      this._resetLast();
      this.total.ops++;
      this._push('start', `DELETE ${key} — 키가 있는 노드를 찾는다`, {});

      const r = this._descend(key, {});
      let leaf = r.node;
      let path = r.path;
      let pos = r.idx;

      if (this.mode === 'btree' && r.found && !leaf.leaf) {
        /* 내부 노드의 키는 곧바로 지울 수 없다 → 선행자(predecessor)로 교체 */
        const internal = leaf;
        const iIdx = pos;
        path = path.concat([{ node: internal, idx: iIdx }]);
        let cur = internal.children[iIdx];
        this._push('route',
          `내부 노드의 키는 직접 못 지운다 → 왼쪽 서브트리의 최대값(선행자)을 찾으러 간다`,
          { active: [internal.id], edge: [[internal.id, iIdx]], keyHi: { [internal.id]: [iIdx] } });
        while (!cur.leaf) {
          this.last.reads++;
          path.push({ node: cur, idx: cur.children.length - 1 });
          this._push('visit', `page #${cur.id} 의 가장 오른쪽 자식으로 계속 하강`,
            { active: [cur.id], edge: [[cur.id, cur.children.length - 1]] });
          cur = cur.children[cur.children.length - 1];
        }
        this.last.reads++;
        const pred = cur.keys[cur.keys.length - 1];
        internal.keys[iIdx] = pred;
        this._push('place',
          `선행자 ${pred} 를 내부 노드로 끌어올려 ${key} 자리를 덮어쓴다`,
          { active: [internal.id, cur.id], keyHi: { [internal.id]: [iIdx], [cur.id]: [cur.keys.length - 1] } });
        leaf = cur;
        pos = cur.keys.length - 1;
      } else if (!r.found) {
        this._push('miss', `${key} 는 트리에 없다 — 삭제할 것이 없음`,
          { active: [leaf.id], state: { [leaf.id]: 'miss' } });
        this._commitLast();
        return { ok: false, steps: this.steps };
      }

      leaf.keys.splice(pos, 1);
      this._push('place',
        `리프 page #${leaf.id} 에서 제거 → [${leaf.keys.join(' · ') || '비어 있음'}]`,
        { active: [leaf.id], state: { [leaf.id]: 'target' } });

      this._fixUnderflow(leaf, path);

      /* 루트가 비면 높이 축소 */
      if (!this.root.leaf && this.root.keys.length === 0) {
        const old = this.root;
        this.root = this.root.children[0];
        const h = this.snapshot().height;
        this._push('shrink',
          `루트 page #${old.id} 가 비었다 → page #${this.root.id} 가 새 루트 · 높이 ${h + 1} → ${h}`,
          { active: [this.root.id], state: { [this.root.id]: 'new' } });
      }

      const snap = this.snapshot();
      this._push('done',
        `완료 · 페이지 읽기 ${this.last.reads}회 · 비교 ${this.last.cmp}회 · 병합 ${this.last.merges}회 · 높이 ${snap.height}`,
        {});
      this._commitLast();
      return { ok: true, steps: this.steps };
    }

    _minOf(n) { return n.leaf ? this.leafMin : this.minKeys; }

    _fixUnderflow(node, path) {
      while (node !== this.root) {
        const min = this._minOf(node);
        if (node.keys.length >= min) return;

        const entry = path[path.length - 1];
        const parent = entry.node;
        const idx = entry.idx;
        const left = idx > 0 ? parent.children[idx - 1] : null;
        const right = idx < parent.children.length - 1 ? parent.children[idx + 1] : null;

        this._push('underflow',
          `page #${node.id} 키 ${node.keys.length}개 < 최소 ${min}개 → 언더플로! 형제에게 빌리거나 병합한다`,
          { active: [node.id], state: { [node.id]: 'underflow' } });

        if (left && left.keys.length > this._minOf(left)) {
          this._borrowFromLeft(node, left, parent, idx);
          return;
        }
        if (right && right.keys.length > this._minOf(right)) {
          this._borrowFromRight(node, right, parent, idx);
          return;
        }

        this.last.merges++;
        if (left) this._merge(left, node, parent, idx - 1);
        else this._merge(node, right, parent, idx);

        path.pop();
        node = parent;
      }
    }

    _borrowFromLeft(node, left, parent, idx) {
      if (this.mode === 'bplus' && node.leaf) {
        const moved = left.keys.pop();
        node.keys.unshift(moved);
        parent.keys[idx - 1] = node.keys[0];
        this._push('borrow',
          `왼쪽 형제 page #${left.id} 에서 ${moved} 를 빌려온다 · 부모 구분키를 ${node.keys[0]} 로 갱신`,
          { active: [node.id, left.id, parent.id], keyHi: { [node.id]: [0], [parent.id]: [idx - 1] } });
      } else {
        const down = parent.keys[idx - 1];
        const up = left.keys.pop();
        node.keys.unshift(down);
        parent.keys[idx - 1] = up;
        if (!node.leaf) node.children.unshift(left.children.pop());
        this._push('borrow',
          `부모의 ${down} 가 내려오고, 왼쪽 형제의 ${up} 가 부모로 올라간다 (회전)`,
          { active: [node.id, left.id, parent.id], keyHi: { [node.id]: [0], [parent.id]: [idx - 1] } });
      }
    }

    _borrowFromRight(node, right, parent, idx) {
      if (this.mode === 'bplus' && node.leaf) {
        const moved = right.keys.shift();
        node.keys.push(moved);
        parent.keys[idx] = right.keys[0];
        this._push('borrow',
          `오른쪽 형제 page #${right.id} 에서 ${moved} 를 빌려온다 · 부모 구분키를 ${right.keys[0]} 로 갱신`,
          { active: [node.id, right.id, parent.id], keyHi: { [node.id]: [node.keys.length - 1], [parent.id]: [idx] } });
      } else {
        const down = parent.keys[idx];
        const up = right.keys.shift();
        node.keys.push(down);
        parent.keys[idx] = up;
        if (!node.leaf) node.children.push(right.children.shift());
        this._push('borrow',
          `부모의 ${down} 가 내려오고, 오른쪽 형제의 ${up} 가 부모로 올라간다 (회전)`,
          { active: [node.id, right.id, parent.id], keyHi: { [node.id]: [node.keys.length - 1], [parent.id]: [idx] } });
      }
    }

    /* a 와 b 를 병합한다. sepIdx = parent.keys 에서 둘 사이의 구분키 위치 */
    _merge(a, b, parent, sepIdx) {
      const sep = parent.keys[sepIdx];
      if (this.mode === 'bplus' && a.leaf) {
        a.keys = a.keys.concat(b.keys);
        a.next = b.next;
        this._push('merge',
          `리프 page #${a.id} 와 page #${b.id} 병합 → [${a.keys.join(' · ')}] · 부모의 구분키 ${sep} 는 버린다`,
          { active: [a.id], state: { [a.id]: 'merged' }, dying: [b.id] });
      } else {
        a.keys = a.keys.concat([sep], b.keys);
        a.children = a.children.concat(b.children);
        this._push('merge',
          `부모의 구분키 ${sep} 를 끌어내려 page #${a.id} + page #${b.id} 병합 → [${a.keys.join(' · ')}]`,
          { active: [a.id], state: { [a.id]: 'merged' }, dying: [b.id] });
      }
      parent.keys.splice(sepIdx, 1);
      parent.children.splice(sepIdx + 1, 1);
    }

    /* ═════════════ 범위 스캔 (B+Tree) ═════════════ */

    rangeScan(lo, hi) {
      this.steps = [];
      this._resetLast();
      this._push('start', `RANGE SCAN ${lo} ~ ${hi} — 먼저 ${lo} 이 있을 리프를 찾는다`, {});

      const r = this._descend(lo, { reportLeafHit: false });
      let leaf = r.node;
      const found = [];
      const visitedLeaves = [];

      if (this.mode !== 'bplus') {
        this._push('miss',
          `B-Tree 는 리프 연결 리스트가 없다 → 범위 스캔은 트리를 위아래로 오가는 중위 순회가 된다`,
          {});
        this._commitLast();
        return { steps: this.steps, found };
      }

      let guard = 0;
      while (leaf && guard++ < 4096) {
        visitedLeaves.push(leaf.id);
        const hits = [];
        let stopped = false;
        for (let i = 0; i < leaf.keys.length; i++) {
          const k = leaf.keys[i];
          this.last.cmp++;
          if (k > hi) { stopped = true; break; }
          if (k >= lo) { hits.push(i); found.push(k); }
        }
        this._push('scan',
          hits.length
            ? `리프 page #${leaf.id} 에서 ${hits.map((i) => leaf.keys[i]).join(', ')} 수집 (누적 ${found.length}건)`
            : `리프 page #${leaf.id} — 범위에 드는 키 없음`,
          {
            active: [leaf.id],
            keyHi: { [leaf.id]: hits },
            scanned: visitedLeaves.slice(),
            state: { [leaf.id]: 'scan' },
          });
        if (stopped) break;
        if (!leaf.next) break;
        this.last.reads++;
        this._push('link',
          `리프 링크를 따라 page #${leaf.next.id} 로 이동 — 루트로 되돌아갈 필요가 없다`,
          {
            active: [leaf.next.id],
            leafLink: [leaf.id, leaf.next.id],
            scanned: visitedLeaves.slice(),
          });
        leaf = leaf.next;
      }

      this._push('done',
        `✓ ${found.length}건 수집 · 리프 ${visitedLeaves.length}개 순회 · 페이지 읽기 ${this.last.reads}회`,
        { scanned: visitedLeaves.slice() });
      this._commitLast();
      return { steps: this.steps, found };
    }

    /* ═════════════ 유틸 ═════════════ */

    reset(order, mode) {
      if (order) this.order = order;
      if (mode) this.mode = mode;
      this.seq = 0;
      this.root = this._mk(true);
      this.steps = [];
      this.total = { cmp: 0, reads: 0, splits: 0, merges: 0, keys: 0, ops: 0 };
      this._resetLast();
    }

    /* 애니메이션 없이 즉시 채우기 (차수 변경/시드용) */
    bulkLoad(keys) {
      this.quiet = true;
      for (const k of keys) this.insert(k);
      this.quiet = false;
      this.steps = [];
    }

    /* 무결성 검증 — 테스트 하네스에서 사용 */
    validate() {
      const errs = [];
      const mode = this.mode;
      const maxK = this.maxKeys;
      const minInternal = this.minKeys;
      const minLeaf = this.leafMin;
      const depths = new Set();

      const walk = (n, depth, lo, hi) => {
        if (n.keys.length > maxK) errs.push(`node ${n.id}: keys ${n.keys.length} > max ${maxK}`);
        for (let i = 1; i < n.keys.length; i++) {
          if (n.keys[i - 1] >= n.keys[i]) errs.push(`node ${n.id}: keys not sorted [${n.keys}]`);
        }
        for (const k of n.keys) {
          if (lo !== null && k < lo) errs.push(`node ${n.id}: key ${k} < lower bound ${lo}`);
          if (hi !== null && k >= hi) errs.push(`node ${n.id}: key ${k} >= upper bound ${hi}`);
        }
        if (n !== this.root) {
          const min = n.leaf ? minLeaf : minInternal;
          if (n.keys.length < min) errs.push(`node ${n.id}: keys ${n.keys.length} < min ${min}`);
        }
        if (n.leaf) { depths.add(depth); return; }
        if (n.children.length !== n.keys.length + 1) {
          errs.push(`node ${n.id}: children ${n.children.length} != keys+1 ${n.keys.length + 1}`);
        }
        n.children.forEach((c, i) => {
          const clo = i === 0 ? lo : n.keys[i - 1];
          const chi = i === n.keys.length ? hi : n.keys[i];
          walk(c, depth + 1, clo, chi);
        });
      };
      walk(this.root, 0, null, null);
      if (depths.size > 1) errs.push(`leaf depths differ: ${[...depths].join(',')}`);

      const inorder = this.keysInOrder();
      for (let i = 1; i < inorder.length; i++) {
        if (inorder[i - 1] >= inorder[i]) { errs.push(`inorder not strictly increasing at ${i}`); break; }
      }

      if (mode === 'bplus') {
        /* 리프 연결 리스트가 정렬 순서와 일치하는지 */
        let n = this.root;
        while (!n.leaf) n = n.children[0];
        const chain = [];
        let guard = 0;
        while (n && guard++ < 100000) { chain.push(...n.keys); n = n.next; }
        if (chain.join(',') !== inorder.join(',')) errs.push('leaf link chain != inorder');
      }
      return errs;
    }
  }

  return { BTree, binarySearch };
});
