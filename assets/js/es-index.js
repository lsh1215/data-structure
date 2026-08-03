/* ═══════════════════════════════════════════════════════════
   Elasticsearch — Analyzer + Inverted Index + BM25
   - char filter → tokenizer → token filter 파이프라인
   - term dictionary + posting list 구축
   - posting list 교집합(AND) 워크와 BM25 점수 계산
═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ESLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be', 'been',
    'of', 'to', 'in', 'into', 'for', 'on', 'at', 'by', 'with', 'from', 'as', 'it', 'its',
    'this', 'that', 'these', 'those', 'not', 'no', 'so', 'than', 'then', 'they', 'we', 'you',
  ]);

  /* 아주 단순화한 영어 스테머 (Porter 의 일부 규칙만) */
  function stem(w) {
    if (w.length <= 3) return w;
    if (/(ss|us|is)$/.test(w)) return w;
    if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (/(ches|shes|xes|zes|ses)$/.test(w)) return w.slice(0, -2);
    if (/s$/.test(w)) return w.slice(0, -1);
    if (/ing$/.test(w) && w.length > 5) return w.slice(0, -3);
    if (/ed$/.test(w) && w.length > 4) return w.slice(0, -2);
    return w;
  }

  const ANALYZER_STAGES = [
    { id: 'raw', name: '원문', desc: '색인할 원본 문자열' },
    { id: 'char', name: 'char filter', desc: 'html_strip — 태그 제거, 엔티티 변환' },
    { id: 'token', name: 'tokenizer', desc: 'standard — 문자·숫자가 아닌 곳에서 자른다' },
    { id: 'lower', name: 'lowercase', desc: '대소문자 정규화' },
    { id: 'stop', name: 'stop filter', desc: '검색에 도움이 안 되는 불용어 제거' },
    { id: 'stem', name: 'stemmer', desc: '어간 추출 — searching → search' },
  ];

  function analyze(text) {
    const out = { raw: text };
    const stripped = String(text).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<');
    out.char = stripped;

    const tokens = [];
    const re = /[A-Za-z0-9가-힣]+/g;
    let m;
    while ((m = re.exec(stripped)) !== null) tokens.push({ text: m[0], start: m.index });
    out.token = tokens.map((t) => t.text);

    const lower = out.token.map((t) => t.toLowerCase());
    out.lower = lower;

    const kept = [];
    const removed = [];
    lower.forEach((t, i) => {
      if (STOPWORDS.has(t)) removed.push(t);
      else kept.push({ text: t, pos: i });
    });
    out.stop = kept.map((t) => t.text);
    out.stopRemoved = removed;

    const stemmed = kept.map((t) => ({ text: stem(t.text), pos: t.pos, before: t.text }));
    out.stem = stemmed.map((t) => t.text);
    out.final = stemmed;
    return out;
  }

  class InvertedIndex {
    constructor() {
      this.docs = [];          // {id, text, len}
      this.terms = new Map();  // term -> Map(docId -> {tf, positions:[]})
      this.steps = [];
      this.k1 = 1.2;
      this.b = 0.75;
    }

    get N() { return this.docs.length; }
    get avgdl() {
      if (!this.docs.length) return 0;
      return this.docs.reduce((a, d) => a + d.len, 0) / this.docs.length;
    }

    snapshot() {
      const terms = [...this.terms.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([term, postings]) => ({
          term,
          df: postings.size,
          postings: [...postings.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([doc, p]) => ({ doc, tf: p.tf, positions: p.positions.slice() })),
        }));
      return {
        docs: this.docs.map((d) => ({ id: d.id, text: d.text, len: d.len })),
        terms,
        avgdl: this.avgdl,
        N: this.N,
      };
    }

    _push(kind, msg, detail, deco) {
      if (this.quiet) return;
      this.steps.push({ kind, msg, detail: detail || '', deco: deco || {}, snap: this.snapshot() });
    }

    /* ═════════ 색인 ═════════ */
    addDocument(text) {
      this.steps = [];
      const id = this.docs.length;
      const a = analyze(text);

      this._push('doc', `문서 #${id} 색인 시작`, text,
        { stage: 'raw', tokens: [{ t: text, cls: '' }], docId: id });

      this._push('char', 'char filter — html_strip 적용', a.char,
        { stage: 'char', tokens: [{ t: a.char, cls: '' }], docId: id });

      this._push('token', `tokenizer — ${a.token.length}개 토큰으로 분리`,
        'standard tokenizer 는 유니코드 텍스트 분할 규칙(UAX#29)을 따른다. ' +
        '공백뿐 아니라 구두점에서도 자르고, 토큰마다 원문에서의 위치(offset)를 함께 기록한다.',
        { stage: 'token', tokens: a.token.map((t) => ({ t, cls: '' })), docId: id });

      this._push('lower', 'lowercase filter — 대소문자 통일',
        '색인할 때와 검색할 때 같은 analyzer 를 쓰지 않으면 영원히 매칭되지 않는다. ' +
        '"Redis" 로 색인하고 "redis" 로 찾으면 못 찾는 사고가 여기서 난다.',
        { stage: 'lower', tokens: a.lower.map((t) => ({ t, cls: '' })), docId: id });

      this._push('stop', `stop filter — 불용어 ${a.stopRemoved.length}개 제거`,
        a.stopRemoved.length ? `제거: ${a.stopRemoved.join(', ')}` : '제거된 불용어 없음',
        {
          stage: 'stop',
          tokens: a.lower.map((t) => ({ t, cls: STOPWORDS.has(t) ? 'gone' : '' })),
          docId: id,
        });

      this._push('stem', 'stemmer — 어간 추출',
        a.final.filter((t) => t.before !== t.text).map((t) => `${t.before} → ${t.text}`).join(' · ') || '변형된 토큰 없음',
        { stage: 'stem', tokens: a.final.map((t) => ({ t: t.text, cls: t.before !== t.text ? 'changed' : '' })), docId: id });

      /* 문서 등록 */
      this.docs.push({ id, text, len: a.final.length });

      /* 역색인 반영 */
      const added = [];
      a.final.forEach((tok) => {
        let postings = this.terms.get(tok.text);
        const isNew = !postings;
        if (!postings) { postings = new Map(); this.terms.set(tok.text, postings); }
        let p = postings.get(id);
        if (!p) { p = { tf: 0, positions: [] }; postings.set(id, p); }
        p.tf++;
        p.positions.push(tok.pos);
        added.push({ term: tok.text, isNew });
      });

      const uniq = [...new Set(a.final.map((t) => t.text))];
      uniq.forEach((term, i) => {
        this._push('post',
          `term "${term}" 의 posting list 에 문서 #${id} 추가 (tf=${this.terms.get(term).get(id).tf})`,
          'term dictionary 는 정렬된 상태로 유지된다 (Lucene 은 FST 로 압축 저장). ' +
          'posting list 에는 문서 ID 가 오름차순으로 들어가고, 실제로는 delta + VInt 로 압축된다.',
          { stage: 'index', activeTerm: term, docId: id, newTerm: added.find((x) => x.term === term && x.isNew) ? term : null });
      });

      this._push('done',
        `문서 #${id} 색인 완료 · 전체 term ${this.terms.size}개 · 문서 ${this.N}개 · 평균 길이 ${this.avgdl.toFixed(1)}`,
        '', { stage: 'index', docId: id });
      return this.steps;
    }

    /* ═════════ 검색 ═════════ */
    search(query, mode) {
      mode = mode || 'AND';
      this.steps = [];
      const a = analyze(query);
      const qterms = [...new Set(a.final.map((t) => t.text))];

      this._push('query', `검색어 "${query}" 에 색인과 동일한 analyzer 적용`,
        `토큰: ${a.token.join(', ')} → 최종: ${qterms.join(', ') || '(없음)'}\n` +
        '색인 시점과 검색 시점의 analyzer 가 같아야 매칭된다.',
        { stage: 'query', qterms });

      if (!qterms.length) {
        this._push('miss', '검색할 term 이 없다 (전부 불용어이거나 빈 문자열)', '', {});
        return this.steps;
      }

      /* term dictionary 조회 */
      const lists = [];
      for (const t of qterms) {
        const postings = this.terms.get(t);
        const list = postings ? [...postings.entries()].sort((x, y) => x[0] - y[0]) : [];
        lists.push({ term: t, list });
        this._push('lookup',
          postings
            ? `term dictionary 에서 "${t}" 발견 → df = ${postings.size}, posting list = [${list.map((x) => '#' + x[0]).join(', ')}]`
            : `term dictionary 에 "${t}" 없음 → 이 term 은 매칭 0건`,
          'term dictionary 는 정렬된 term 을 FST(유한 상태 트랜스듀서)로 저장한다. ' +
          '접두사를 공유해 메모리에 통째로 올릴 만큼 작아지고, 조회는 term 길이에 비례한다 — O(길이).',
          { stage: 'dict', activeTerm: t, qterms });
      }

      /* 교집합 / 합집합 */
      lists.sort((x, y) => x.list.length - y.list.length);
      let result;
      if (mode === 'AND') {
        this._push('merge',
          `AND 질의 — posting list 가 가장 짧은 "${lists[0].term}"(${lists[0].list.length}건) 부터 맞춰나간다`,
          '짧은 리스트를 기준으로 삼으면 비교 횟수가 줄어든다. ' +
          '실제 Lucene 은 skip list(건너뛰기 포인터)를 써서 맞지 않는 구간을 통째로 건너뛴다.',
          { stage: 'merge', qterms });

        result = lists[0].list.map((x) => x[0]);
        for (let i = 1; i < lists.length; i++) {
          const other = new Set(lists[i].list.map((x) => x[0]));
          const before = result.slice();
          result = result.filter((d) => other.has(d));
          this._push('merge',
            `"${lists[i].term}" 과 교집합 → [${before.map((d) => '#' + d).join(', ') || '없음'}] ∩ [${lists[i].list.map((x) => '#' + x[0]).join(', ') || '없음'}] = [${result.map((d) => '#' + d).join(', ') || '없음'}]`,
            '두 리스트 모두 문서 ID 오름차순이라 두 포인터로 한 번에 훑으면 O(n+m) 이다.',
            { stage: 'merge', qterms, matchDocs: result.slice() });
        }
      } else {
        const s = new Set();
        lists.forEach((l) => l.list.forEach((x) => s.add(x[0])));
        result = [...s].sort((x, y) => x - y);
        this._push('merge', `OR 질의 — 모든 posting list 합집합 = [${result.map((d) => '#' + d).join(', ')}]`, '',
          { stage: 'merge', qterms, matchDocs: result.slice() });
      }

      if (!result.length) {
        this._push('miss', '매칭되는 문서 없음', '', { stage: 'merge', qterms });
        return this.steps;
      }

      /* BM25 채점 */
      const scored = result.map((docId) => ({ docId, ...this.scoreDoc(docId, qterms) }));
      scored.sort((x, y) => y.score - x.score);

      scored.forEach((s) => {
        this._push('score',
          `문서 #${s.docId} BM25 점수 = ${s.score.toFixed(4)}`,
          s.detail,
          { stage: 'score', qterms, matchDocs: result.slice(), activeDoc: s.docId });
      });

      this._push('done',
        `검색 완료 — ${scored.length}건, 1위 문서 #${scored[0].docId} (${scored[0].score.toFixed(4)})`,
        scored.map((s, r) => `${r + 1}위  문서 #${s.docId}   score ${s.score.toFixed(4)}   길이 ${this.docs[s.docId].len} terms`).join('\n') +
        `\n\nN = ${this.N},  avgdl = ${this.avgdl.toFixed(2)},  k₁ = ${this.k1},  b = ${this.b}`,
        { stage: 'score', qterms, matchDocs: result.slice(), ranked: scored.map((s) => ({ doc: s.docId, score: s.score })) });
      return this.steps;
    }

    /* BM25 */
    scoreDoc(docId, qterms) {
      const N = this.N;
      const avgdl = this.avgdl;
      const dl = this.docs[docId].len;
      const k1 = this.k1;
      const b = this.b;
      let score = 0;
      const lines = [];
      const parts = [];
      for (const t of qterms) {
        const postings = this.terms.get(t);
        if (!postings || !postings.has(docId)) continue;
        const df = postings.size;
        const tf = postings.get(docId).tf;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const norm = tf + k1 * (1 - b + b * (dl / avgdl));
        const contrib = idf * ((tf * (k1 + 1)) / norm);
        score += contrib;
        parts.push({ term: t, idf, tf, df, contrib });
        lines.push(
          `[${t}]  idf = ln(1 + (${N} − ${df} + 0.5)/(${df} + 0.5)) = ${idf.toFixed(4)}\n` +
          `      tf = ${tf}, dl = ${dl}, avgdl = ${avgdl.toFixed(1)}\n` +
          `      norm = ${tf} + ${k1}×(1 − ${b} + ${b}×${dl}/${avgdl.toFixed(1)}) = ${norm.toFixed(3)}\n` +
          `      기여 = ${idf.toFixed(4)} × (${tf}×${(k1 + 1).toFixed(1)} / ${norm.toFixed(3)}) = ${contrib.toFixed(4)}`
        );
      }
      lines.push(`총점 = ${score.toFixed(4)}`);
      return { score, detail: lines.join('\n'), parts };
    }

    reset() {
      this.docs = [];
      this.terms = new Map();
      this.steps = [];
    }

    bulk(texts) {
      this.quiet = true;
      texts.forEach((t) => this.addDocument(t));
      this.quiet = false;
      this.steps = [];
    }

    validate() {
      const errs = [];
      for (const [term, postings] of this.terms) {
        const ids = [...postings.keys()];
        if (new Set(ids).size !== ids.length) errs.push(`${term}: 중복 문서 ID`);
        for (const [docId, p] of postings) {
          if (!this.docs[docId]) errs.push(`${term}: 존재하지 않는 문서 ${docId}`);
          if (p.tf !== p.positions.length) errs.push(`${term}/#${docId}: tf(${p.tf}) != positions(${p.positions.length})`);
        }
      }
      /* 모든 문서의 토큰이 색인되었는지 */
      this.docs.forEach((d) => {
        const a = analyze(d.text);
        const uniq = new Set(a.final.map((t) => t.text));
        for (const t of uniq) {
          const p = this.terms.get(t);
          if (!p || !p.has(d.id)) errs.push(`문서 ${d.id} 의 term "${t}" 누락`);
        }
        if (d.len !== a.final.length) errs.push(`문서 ${d.id} 길이 불일치`);
      });
      return errs;
    }
  }

  /* ═════════ 세그먼트 라이프사이클 ═════════ */
  class SegmentEngine {
    constructor() {
      this.buffer = [];
      this.translog = [];
      this.segments = [];  // {id, docs, deleted, size}
      this.seq = 0;
      this.docSeq = 0;
      this.steps = [];
      this.time = 0;
    }

    snapshot() {
      return {
        buffer: this.buffer.slice(),
        translog: this.translog.slice(),
        segments: this.segments.map((s) => ({ ...s, docs: s.docs.slice() })),
        time: this.time,
      };
    }

    _push(kind, msg, detail, deco) {
      this.steps.push({ kind, msg, detail: detail || '', deco: deco || {}, snap: this.snapshot() });
    }

    index(n) {
      this.steps = [];
      for (let i = 0; i < (n || 1); i++) {
        const id = 'd' + (++this.docSeq);
        this.buffer.push(id);
        this.translog.push(id);
        this._push('index',
          `색인 요청 ${id} — 메모리 버퍼 + translog 에 기록`,
          'translog 에 먼저 append 하기 때문에 이 시점에 장애가 나도 복구할 수 있다. ' +
          '하지만 아직 세그먼트가 아니라서 검색에는 잡히지 않는다.',
          { hot: 'buffer' });
      }
      return this.steps;
    }

    refresh() {
      this.steps = [];
      if (!this.buffer.length) {
        this._push('refresh', 'refresh — 버퍼가 비어 있어 새 세그먼트를 만들지 않는다', '', {});
        return this.steps;
      }
      const seg = { id: 's' + (++this.seq), docs: this.buffer.slice(), deleted: [] };
      this.segments.push(seg);
      this.buffer = [];
      this._push('refresh',
        `refresh — 버퍼의 ${seg.docs.length}개 문서를 세그먼트 ${seg.id} 로 만든다 (이제 검색됨)`,
        '기본 1초마다 자동 실행(index.refresh_interval). 이때 만들어진 세그먼트는 아직 디스크에 fsync 되지 않았고 ' +
        'OS 파일 시스템 캐시에만 있다. "near real-time" 이라 부르는 이유 — 색인 즉시가 아니라 refresh 후 검색된다.',
        { hot: seg.id, newSeg: seg.id });
      return this.steps;
    }

    flush() {
      this.steps = [];
      this._push('flush',
        `flush — 세그먼트를 디스크에 fsync 하고 translog 를 비운다`,
        'Lucene commit. 이 시점 이후로는 translog 없이도 복구 가능하다. ' +
        '기본적으로 translog 가 512MB 를 넘거나 30분마다 수행된다.',
        { hot: 'translog' });
      this.translog = [];
      return this.steps;
    }

    merge() {
      this.steps = [];
      if (this.segments.length < 2) {
        this._push('merge', '병합할 세그먼트가 2개 미만이다', '', {});
        return this.steps;
      }
      const targets = this.segments.slice(0, Math.min(3, this.segments.length));
      const rest = this.segments.slice(targets.length);
      const docs = [];
      let dropped = 0;
      targets.forEach((s) => {
        s.docs.forEach((d) => {
          if (s.deleted.includes(d)) dropped++;
          else docs.push(d);
        });
      });
      const merged = { id: 's' + (++this.seq), docs, deleted: [] };
      this.segments = [merged, ...rest];
      this._push('merge',
        `merge — ${targets.map((s) => s.id).join(' + ')} → ${merged.id} (삭제 표시된 ${dropped}건은 이때 실제로 사라진다)`,
        '세그먼트는 불변(immutable)이라 삭제는 "삭제 표시(.del)"일 뿐이고, 병합 때 비로소 제거된다. ' +
        '병합은 디스크 I/O 를 많이 쓰므로 색인 처리량과 트레이드오프가 있다.',
        { hot: merged.id, newSeg: merged.id });
      return this.steps;
    }

    deleteDoc() {
      this.steps = [];
      const withDocs = this.segments.filter((s) => s.docs.length > s.deleted.length);
      if (!withDocs.length) {
        this._push('delete', '삭제할 문서가 없다', '', {});
        return this.steps;
      }
      const seg = withDocs[0];
      const target = seg.docs.find((d) => !seg.deleted.includes(d));
      seg.deleted.push(target);
      this._push('delete',
        `${target} 삭제 — 세그먼트 ${seg.id} 는 불변이므로 .del 비트만 세운다`,
        '검색 결과에서는 제외되지만 디스크 공간은 그대로다. ' +
        '업데이트도 마찬가지로 "기존 문서 삭제 표시 + 새 문서 색인" 으로 구현된다.',
        { hot: seg.id, deletedDoc: target });
      return this.steps;
    }

    reset() {
      this.buffer = []; this.translog = []; this.segments = [];
      this.seq = 0; this.docSeq = 0; this.steps = [];
    }
  }

  return { InvertedIndex, SegmentEngine, analyze, stem, ANALYZER_STAGES, STOPWORDS };
});
