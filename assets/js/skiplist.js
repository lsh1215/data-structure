/* ═══════════════════════════════════════════════════════════
   Redis ZSET skiplist — 모델 + 시각화
   - zslRandomLevel(P=0.25), zslInsert 의 update[]/rank[]/span[]
     구조를 그대로 따라간다.
═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkipLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const P = 0.25;
  const MAXLEVEL = 8; // 실제 Redis 는 32. 화면을 위해 8로 제한

  class SkipList {
    constructor(rng) {
      this.rng = rng || Math.random;
      this.head = { member: 'HEAD', score: -Infinity, forward: new Array(MAXLEVEL).fill(null), span: new Array(MAXLEVEL).fill(0), level: MAXLEVEL };
      this.level = 1;
      this.length = 0;
      this.steps = [];
    }

    order() {
      const out = [];
      let x = this.head.forward[0];
      while (x) { out.push(x); x = x.forward[0]; }
      return out;
    }

    snapshot() {
      const nodes = this.order();
      const index = new Map(nodes.map((n, i) => [n, i]));
      return {
        level: this.level,
        length: this.length,
        head: { forwards: this.head.forward.map((f) => (f ? index.get(f) : null)), spans: this.head.span.slice() },
        nodes: nodes.map((n) => ({
          member: n.member,
          score: n.score,
          level: n.level,
          forwards: n.forward.map((f) => (f ? index.get(f) : null)),
          spans: n.span.slice(),
        })),
      };
    }

    _push(kind, msg, detail, deco) {
      if (this.quiet) return;
      this.steps.push({ kind, msg, detail: detail || '', deco: deco || {}, snap: this.snapshot() });
    }

    randomLevel(record) {
      let lvl = 1;
      const rolls = [];
      while (this.rng() < P && lvl < MAXLEVEL) { rolls.push(true); lvl++; }
      rolls.push(false);
      if (record) {
        this._push('dice',
          `동전 던지기 결과 → 레벨 ${lvl}`,
          `while (random() < 0.25) level++  —  1/4 확률로 계속 올라간다.\n` +
          `레벨 L 이 될 확률 = 0.25^(L−1) × 0.75  ⇒  평균 레벨 = 1/(1−p) = ${(1 / (1 - P)).toFixed(2)}\n` +
          `기대 포인터 수 = n/(1−p) = 1.33n 개 (메모리 오버헤드 33%)`,
          { rolls, newLevel: lvl });
      }
      return lvl;
    }

    insert(score, member) {
      this.steps = [];
      const update = new Array(MAXLEVEL).fill(this.head);
      const rank = new Array(MAXLEVEL).fill(0);
      let x = this.head;

      this._push('start', `ZADD ${score} ${member} — 가장 높은 레벨에서 오른쪽으로 달린다`,
        '최상위 레벨은 노드를 듬성듬성 건너뛴다. 더 갈 수 없으면 한 층 내려간다. 이 과정이 이진 탐색과 같은 효과를 낸다.', {});

      const path = [];
      for (let i = this.level - 1; i >= 0; i--) {
        rank[i] = i === this.level - 1 ? 0 : rank[i + 1];
        while (x.forward[i] && (x.forward[i].score < score || (x.forward[i].score === score && x.forward[i].member < member))) {
          rank[i] += x.span[i];
          path.push({ from: x, level: i });
          x = x.forward[i];
          this._push('walk',
            `레벨 ${i + 1}: ${fmtNode(x)} 까지 전진 (누적 rank ${rank[i]})`,
            'span 을 더해가며 이동하면 몇 번째 원소인지(rank)를 O(log N) 에 알 수 있다 → ZRANK 가 빠른 이유',
            { cursor: x.member, level: i, path: path.slice() });
        }
        update[i] = x;
        this._push('down',
          `레벨 ${i + 1}: ${fmtNode(x)} 의 다음이 ${score} 보다 크다 → 한 층 내려간다`,
          'update[' + i + '] = ' + fmtNode(x) + '  (새 노드가 끼어들 자리를 층마다 기억해 둔다)',
          { cursor: x.member, level: i, path: path.slice(), marked: update.slice(0, this.level).map((u) => u.member) });
      }

      const lvl = this.randomLevel(true);
      if (lvl > this.level) {
        for (let i = this.level; i < lvl; i++) {
          rank[i] = 0;
          update[i] = this.head;
          this.head.span[i] = this.length;
        }
        const old = this.level;
        this.level = lvl;
        this._push('grow', `새 노드의 레벨(${lvl})이 현재 최대 레벨(${old})보다 높다 → 리스트 레벨 상승`,
          '위쪽 레벨의 시작점은 항상 head 다.', { newLevel: lvl });
      }

      const node = {
        member, score, level: lvl,
        forward: new Array(MAXLEVEL).fill(null),
        span: new Array(MAXLEVEL).fill(0),
      };

      for (let i = 0; i < lvl; i++) {
        node.forward[i] = update[i].forward[i];
        update[i].forward[i] = node;
        node.span[i] = update[i].span[i] - (rank[0] - rank[i]);
        update[i].span[i] = (rank[0] - rank[i]) + 1;
      }
      for (let i = lvl; i < this.level; i++) update[i].span[i]++;
      this.length++;

      this._push('link', `${lvl}개 레벨의 포인터를 연결 — 연결 리스트 삽입을 레벨 수만큼 반복할 뿐`,
        '균형 트리처럼 회전(rotation)이 없다. 그래서 구현이 짧고 동시성 제어도 쉽다.',
        { newMember: member, levels: lvl });

      this._push('done', `완료 · 원소 ${this.length}개 · 리스트 레벨 ${this.level}`,
        `기대 탐색 비용 = O(log₁/ₚ N) = O(log₄ N).  N=${this.length} 이면 약 ${(Math.log(Math.max(2, this.length)) / Math.log(4)).toFixed(1)} 단계`,
        { newMember: member });
      return this.steps;
    }

    search(score) {
      this.steps = [];
      let x = this.head;
      const path = [];
      this._push('start', `ZSCORE 탐색 — score ${score} 찾기`, '', {});
      for (let i = this.level - 1; i >= 0; i--) {
        while (x.forward[i] && x.forward[i].score < score) {
          path.push({ from: x, level: i });
          x = x.forward[i];
          this._push('walk', `레벨 ${i + 1}: ${fmtNode(x)} 로 전진`, '', { cursor: x.member, level: i, path: path.slice() });
        }
        this._push('down', `레벨 ${i + 1} 에서 더 갈 수 없다 → 한 층 아래로`, '', { cursor: x.member, level: i, path: path.slice() });
      }
      const hit = x.forward[0] && x.forward[0].score === score ? x.forward[0] : null;
      this._push(hit ? 'done' : 'miss',
        hit ? `찾음 → ${fmtNode(hit)}` : `score ${score} 없음`,
        '탐색은 항상 레벨 1(가장 아래)에서 끝난다. 모든 원소는 레벨 1에 다 들어 있다.',
        hit ? { cursor: hit.member, found: hit.member } : {});
      return this.steps;
    }

    remove(member) {
      this.steps = [];
      const target = this.order().find((n) => n.member === member);
      if (!target) return this.steps;
      const update = new Array(MAXLEVEL).fill(this.head);
      let x = this.head;
      for (let i = this.level - 1; i >= 0; i--) {
        while (x.forward[i] && (x.forward[i].score < target.score ||
          (x.forward[i].score === target.score && x.forward[i].member < member))) x = x.forward[i];
        update[i] = x;
      }
      x = x.forward[0];
      if (!x || x.member !== member) return this.steps;
      for (let i = 0; i < this.level; i++) {
        if (update[i].forward[i] === x) {
          update[i].span[i] += x.span[i] - 1;
          update[i].forward[i] = x.forward[i];
        } else {
          update[i].span[i]--;
        }
      }
      while (this.level > 1 && !this.head.forward[this.level - 1]) this.level--;
      this.length--;
      this._push('done', `${member} 삭제 · 원소 ${this.length}개 · 레벨 ${this.level}`,
        '레벨마다 앞 노드의 forward 를 뒤 노드로 이어주기만 하면 된다.', {});
      return this.steps;
    }

    bulk(pairs) {
      this.quiet = true;
      for (const [s, m] of pairs) this.insert(s, m);
      this.quiet = false;
      this.steps = [];
    }

    validate() {
      const errs = [];
      const nodes = this.order();
      for (let i = 1; i < nodes.length; i++) {
        if (nodes[i - 1].score > nodes[i].score) errs.push('score 정렬 깨짐');
      }
      for (let l = 0; l < this.level; l++) {
        let x = this.head;
        let count = 0;
        while (x.forward[l]) {
          if (x !== this.head && x.forward[l].score < x.score) errs.push(`레벨 ${l} 정렬 깨짐`);
          x = x.forward[l];
          if (++count > 100000) { errs.push('무한 루프'); break; }
        }
      }
      /* span 검증: head 에서 span 을 더하면 각 노드의 순위가 나와야 한다 */
      const rankOf = new Map(nodes.map((n, i) => [n, i + 1]));
      for (let l = 0; l < this.level; l++) {
        let x = this.head;
        let r = 0;
        while (x.forward[l]) {
          r += x.span[l];
          if (rankOf.get(x.forward[l]) !== r) errs.push(`span 오류 (level ${l}, ${x.forward[l].member}: ${r} != ${rankOf.get(x.forward[l])})`);
          x = x.forward[l];
        }
      }
      return errs;
    }
  }

  function fmtNode(n) {
    return n.member === 'HEAD' ? 'HEAD' : `${n.member}(${n.score})`;
  }

  return { SkipList, MAXLEVEL, P };
});
