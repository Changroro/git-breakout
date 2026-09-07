# 인수인계: GitHub Star History API 도입

작성일: 2026-09-06
PR: `#31` (`claude/github-star-history-api-uq6mi3`, main 미머지)

## 배경

2026-09-04에 GitHub이 스타 히스토리 REST 엔드포인트를 공개했다. 7월부터 stargazers 목록 조회가 admin·collaborator로 제한되면서 나온 대체 API다. 우리는 원래 개별 stargazer를 쓰지 않았으므로 제한의 영향은 없고, 새로 생긴 과거 데이터만 활용했다.

- 엔드포인트: `GET /repos/{owner}/{repo}/stargazers/history`
- 응답: 주 단위 배열(최신 주가 먼저), 각 항목은 `week`, `total`, `days`(7개 정수). GitHub은 주·일 경계가 UTC와 일치한다고 보장하지 않는다.
- 페이지: `per_page` 최대 30주, `page` 최대 100 → 1페이지로 약 7개월 커버
- 쿼터: 응답 헤더 `X-RateLimit-Resource: core`. 호출 1회당 core 1점
- 의미: 조회 시점에도 남아 있는 스타를 GitHub이 보고한 획득일 버킷에 집계한다. 과거 시점의 전체 스타 수가 아니다.

## 무엇을 바꿨나

기존 구현에 검토 보완을 더했다.

### 1. Star 시계열에 히스토리 사용

- `server/star-history.ts`가 완료된 일별 유지 스타 획득 수를 0부터 누적한 최대 90일 시계열을 만든다.
- 웹 서버 `/api/star-series`는 GitHub 유지 스타 획득 시계열과 자체 관측 전체 스타 수를 절대 합치지 않는다. GitHub 데이터를 쓸 때는 `github_retained_acquisitions`, 실패 시에는 `observed` 출처를 명시한다.
- 저장소별 디스크 캐시(웹 서버 TTL 6시간).
- 운영 DB 스키마는 이 레포 밖이라 DB를 건드리지 않고 읽기 경로에서만 합쳤다.

### 2. `a57697c` 급부상 판정 개편 (`trend-intelligence-v6-shadow`)

기존 게이트 세 개를 제거하고 더 긴 자기 기준선을 사용한다.

| 제거한 조건 | 대체 |
| --- | --- |
| 첫 관측 시 별 1만 개 미만 | 없음. 절대 크기 상한 없음 |
| 첫 관측 시 Trending 아님 | 없음. 배지·발굴 성과에만 사용 |
| 과거 Trending 이력 없음 | 없음 |
| 우리 관측 7일 baseline | GitHub 히스토리 12주 중앙값 |

- `self_relative_growth` = 최근 하루 증가 ÷ 이전 최대 12주 주간 증가 중앙값(일 환산). 완료된 2주 미만이면 `star_history_baseline`을 부족 근거로 남기고 나머지 요소로만 채점.
- 관측 6시간 구간이 없으면 GitHub의 최근 완료된 유지 스타 획득일을 24시간 대리 근거로 사용한다(36시간보다 오래되면 미사용). 그 뒤에야 2시간 관측 속도로 내려간다.
- **재부상도 급부상으로 잡힌다.** 오래된 저장소가 다시 오르는 것과 신규 저장소가 처음 오르는 것을 같은 기준으로 본다.
- 코호트는 아직 `breakout:global` 하나.

### 3. `16ebe64` API 한도 예산 방식

처음엔 후보 전체를 갱신하고 한도가 넘치면 다음 실행으로 미루게 짰는데, 그러면 밀린 분량이 누적된다. 실행마다 감당 가능한 만큼만 하도록 바꿨다.

- 실행 시작 시 `/rate_limit`으로 남은 core 쿼터를 읽는다(이 엔드포인트는 쿼터를 쓰지 않는다).
- 예산 = `remaining - reserve`. 98일 범위는 보통 저장소당 히스토리 1콜이며 현재 별 개수는 별도로 조회하지 않는다. reserve 기본 500.
- 신선한 캐시는 0콜이라 예산을 안 쓴다. 갱신이 필요한 것만 경쟁하고, **히스토리가 아예 없는 저장소 우선, 그다음 가장 오래된 순**으로 예산을 쓴다.
- 예산 밖 저장소는 기존(오래된) 캐시를 그대로 쓰고, 캐시도 없으면 `star_history` 부족 근거로 남긴다. **다음 실행으로 밀린 빚을 넘기지 않는다.**
- 수집기 캐시 TTL은 20시간 + 저장소별 최대 6시간 고정 지터. 2시간마다 후보군 일부씩만 갱신된다.
- 로그에 갱신·재사용·누락 수와 예산을 남긴다.

## 배포 전 필요한 것

1. PR #31 검토 보완 커밋 후 main 머지
2. **운영 웹 서버 환경변수에 `GITHUB_TOKEN`과 `TREND_RADAR_STAR_HISTORY_WEB_HOURLY_LIMIT=300` 추가.** 둘 중 하나라도 없으면 웹 서버가 시작하지 않는다.
3. 평소 방식대로 배포. **DB 스키마 변경 없음**

선택 환경변수:

| 이름 | 기본값 | 용도 |
| --- | --- | --- |
| `TREND_RADAR_STAR_HISTORY_CACHE_DIR` | `data/star-history` | 수집기 히스토리 캐시 위치 |
| `TREND_RADAR_STAR_HISTORY_RESERVE` | `500` | 히스토리에 쓰지 않고 남겨둘 core 콜 수 |

웹 서버 캐시는 기존 캐시 디렉터리 아래 `star-history/`에 쌓인다. 둘 다 `.gitignore` 처리됨.

## 직접 확인한 데이터 의미

2026-09-07에 실제 API와 되돌릴 수 있는 star/unstar 실험으로 확인했다.

1. `facebook/react`, `freeCodeCamp/freeCodeCamp`는 전체 히스토리 버킷 합계가 현재 stargazer count와 일치했다.
2. `Changroro/git-breakout`을 star하자 해당 획득일 버킷과 현재 수가 함께 1 증가했고, unstar하자 같은 버킷과 현재 수가 다시 0으로 감소했다.
3. 실험 후 star 상태와 개수는 시작 상태인 0으로 복구했다.

로컬에서 토큰으로 확인하는 명령:

```bash
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  "https://api.github.com/repos/facebook/react/stargazers/history?per_page=3"
```

## 알려진 동작

- **unstar의 소급 반영**: 이전 날짜에 획득한 스타를 나중에 제거하면 과거 버킷도 감소한다. 이 때문에 차트는 과거 전체 스타 수가 아니라 현재 유지 중인 획득 수로 표시한다.
- **첫 배포일 급부상 목록이 크게 바뀐다.** 게이트가 사라져 큰 저장소와 재부상 저장소가 새로 들어온다.
- **웹 API 강제 한도**: 프로세스 기준 고정 1시간 창에서 300콜까지만 허용한다(코드 허용 범위 1~500). 초과 시 새 GitHub 호출 없이 디스크 캐시 또는 자체 관측 시계열을 사용한다.

## 남은 작업

1. **코호트 분리** — 지금은 3만 개짜리 재부상과 500개짜리 신규가 같은 풀에서 경쟁한다. 절대 증가량에서 큰 쪽이 유리하므로 별 규모 구간별 코호트가 필요하다. 다만 구간 경계는 실제 분포를 봐야 정할 수 있어서 배포 후로 미뤘다. 방법론 문서에도 예정 사항으로 적어뒀다.
2. 첫 실행 시 캐시가 비어 있어 예산이 여러 번에 걸쳐 소진된다. 며칠은 히스토리 없는 저장소가 섞이는데, 정상 동작이며 점차 채워진다.

## 검증 상태

| 항목 | 결과 |
| --- | --- |
| `npm test` | 211개 통과 |
| `npm run typecheck` | 통과 |
| `npm run build` | 통과 |
| 실제 GitHub 응답 의미 | 대형 저장소 2개 합계 비교와 직접 star/unstar 복구 실험으로 확인 |

## 관련 파일

```text
server/star-history.ts        히스토리 조회·캐시·출처 분리·예산 (신규)
server/star-history.test.ts   위 테스트 (신규)
server/web-server.ts          /api/star-series 출처 선택, GITHUB_TOKEN·시간당 한도 요구
server/history-api.ts         로컬 개발 서버 동일 경로
server/collect-remote.ts      수집기: 예산 계산 + 히스토리 수집
src/lib/trend-intelligence.ts 급부상 판정 (v6)
src/lib/star-series.ts        90일 창 상수
docs/methodology.md           공개 방법론
```
