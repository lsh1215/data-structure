# DB Internals Visualized

데이터베이스 내부 자료구조를 **애니메이션으로** 이해하기 위한 정적 사이트입니다.
글로 읽어서는 감이 안 오는 B+Tree 분할, Redis 리해싱, 역색인 구축 과정을
값을 하나씩 넣어가며 눈으로 확인합니다.

프레임워크·빌드 도구 없음. HTML/CSS/바닐라 JS만 사용합니다.

## 페이지

| 경로 | 주제 | 인터랙션 |
|---|---|---|
| `/` | DB 선택 홈 | — |
| `/rdb/` | B-Tree · B+Tree 인덱스 | 삽입/삭제/탐색/범위스캔 애니메이션, 차수·모드 변경, fanout·높이 계산기 |
| `/redis/` | dict · hashtable · skiplist | SET/GET/DEL 파이프라인, 버킷 체이닝, 점진적 리해싱, ZSET skiplist |
| `/elasticsearch/` | 역색인 · BM25 · 세그먼트 | analyzer 파이프라인, posting list 구축, AND/OR 병합, 점수 계산, refresh/merge |

각 페이지는 시각화 아래에 **왜 그런 복잡도가 나오는지**를 수식으로 유도한 설명이 붙어 있습니다.
특히 RDB 페이지에는 `O(log N)` 의 **밑이 왜 2가 아니라 fanout 인지**를
높이의 상·하한 유도부터 실제 InnoDB 페이지 계산까지 정리해 두었습니다.

## 구조

```
.
├── index.html                 # 홈 (DB 선택)
├── rdb/index.html
├── redis/index.html
├── elasticsearch/index.html
├── assets/
│   ├── css/
│   │   ├── base.css           # 디자인 토큰 · 공용 컴포넌트
│   │   ├── home.css           # 홈 카드
│   │   ├── tree.css           # 시각화 공용 (무대 · 노드 · 내레이션 · 파이프라인)
│   │   ├── redis.css          # 해시 테이블 · skiplist
│   │   └── es.css             # 토큰 · 역색인 · 세그먼트
│   └── js/
│       ├── starfield.js       # 배경 캔버스
│       ├── btree.js           # B-Tree / B+Tree 엔진 (스텝 기록)
│       ├── btree-viz.js       # 트리 렌더러 (자체 rAF 트윈)
│       ├── complexity.js      # fanout / 높이 / I/O 계산기
│       ├── redis-dict.js      # dict · 체이닝 · 점진적 리해싱
│       ├── redis-viz.js       # 파이프라인 + 해시 테이블 렌더러
│       ├── skiplist.js        # zslInsert / span / rank
│       ├── skiplist-viz.js    # 레벨 격자 렌더러
│       ├── es-index.js        # analyzer · 역색인 · BM25 · 세그먼트
│       └── es-viz.js          # 색인/검색/세그먼트 렌더러
└── tests/                     # Node 로 돌리는 자료구조 검증
```

모든 시각화는 **실제 알고리즘 구현 위에서** 동작합니다.
엔진(`btree.js`, `redis-dict.js`, `skiplist.js`, `es-index.js`)은 연산을 수행하면서
모든 중간 상태를 스냅샷으로 기록하고, 렌더러는 그 스냅샷을 순서대로 재생할 뿐입니다.
그래서 화면에 보이는 트리는 “그림”이 아니라 실제로 그 알고리즘이 만든 트리입니다.

## 로컬 실행

빌드 단계가 없으므로 파일을 그대로 열어도 되고, 정적 서버를 써도 됩니다.

```bash
python3 -m http.server 8000
# http://localhost:8000
```

## 테스트

자료구조 구현의 무결성을 Node 로 검증합니다 (총 177개 단언).

```bash
node tests/btree.test.js      # B-Tree/B+Tree 불변식, 삽입/삭제 1200회 랜덤, 높이 이론 상·하한
node tests/redis.test.js      # 버킷 인덱스, 리해싱 중 조회/삽입/삭제, 확장·축소
node tests/skiplist.test.js   # 정렬 유지, span/rank 정확도, 레벨 분포(≈0.75)
node tests/es.test.js         # analyzer, posting list 정렬, tf/positions, BM25 성질, 세그먼트
```

## 배포

`main` 브랜치에 push 하면 GitHub Actions 가 테스트를 돌린 뒤 GitHub Pages 로 배포합니다
(`.github/workflows/deploy.yml`). 별도 빌드가 없으므로 Vercel·Netlify 에
저장소를 그대로 연결해도 동작합니다 (빌드 명령 없음, 출력 디렉터리 `.`).

## 참고한 것

- 시각적 설명 방식: ByteByteGo, [SoftwareMill Kafka Visualisation](https://softwaremill.com/kafka-visualisation/)
- 디자인 테마: [sanghun-plugin](https://sanghun-plugin.vercel.app/)
- 알고리즘: CLRS(B-Tree), Redis `dict.c` / `t_zset.c`, Lucene 인덱스 포맷 문서

## 라이선스

MIT
