# 인수인계: GitHub Star History API 도입

작성일: 2026-09-06
브랜치: `claude/github-star-history-api-uq6mi3` (main 미머지, PR 미생성)

## 배경

2026-09-04에 GitHub이 스타 히스토리 REST 엔드포인트를 공개했다. 7월부터 stargazers 목록 조회가 admin·collaborator로 제한되면서 나온 대체 API다. 우리는 원래 개별 stargazer를 쓰지 않았으므로 제한의 영향은 없고, 새로 생긴 과거 데이터만 활용했다.

- 엔드포인트: `GET /repos/{owner}/{repo}/stargazers/history`
- 응답: 주 단위 배열(최신 주가 먼저), 각 항목은 `week`(일요일 00:00 UTC epoch 초), `total`, `days`(7개 정수)
- 페이지: `per_page` 최대 30주, `page` 최대 100 → 1페이지로 약 7개월 커버
- 쿼터: 응답 헤더 `X-RateLimit-Resource: core`. 호출 1회당 core 1점

## 무엇을 바꿨나

커밋 3개. 순서대로 읽으면 흐름이 이어진다.

### 1. `112558b` Star 시계열에 히스토리 병합

- `server/star-history.ts` 신규. 히스토리 일 단위 증가를 현재 별 개수에 고정해 각 날짜 자정의 절대값으로 변환한다.
- 웹 서버 `/api/star-series` 응답 단계에서 우리 2시간 관측과 하나의 90일 시계열로 합친다. **출처 구분 없이 하나의 선으로 그린다.** 두 값 모두 각 시점의 실제 값이라 구분할 이유가 없다는 판단.
- 저장소별 디스크 캐시(웹 서버 TTL 6시간).
- 운영 DB 스키마는 이 레포 밖이라 DB를 건드리지 않고 읽기 경로에서만 합쳤다.

### 2. `a57697c` 급부상 판정 개편 (`trend-intelligence-v6-shadow`)

기존 게이트 세 개를 제거했다. 이 조건들은 "과거를 알 수 없어서" 쓰던 대리 지표였고, 이제 실제 과거가 있으므로 불필요하다.

| 제거한 조건 | 대체 |
| --- | --- |
| 첫 관측 시 별 1만 개 미만 | 없음. 절대 크기 상한 없음 |
| 첫 관측 시 Trending 아님 | 없음. 배지·발굴 성과에만 사용 |
| 과거 Trending 이력 없음 | 없음 |
| 우리 관측 7일 baseline | GitHub 히스토리 12주 중앙값 |

- `self_relative_growth` = 최근 하루 증가 ÷ 이전 최대 12주 주간 증가 중앙값(일 환산). 완료된 2주 미만이면 `star_history_baseline`을 부족 근거로 남기고 나머지 요소로만 채점.
- 관측 6시간 구간이 없으면 GitHub의 최근 완료된 하루를 정확한 24시간 근거로 사용(36시간보다 오래되면 미사용). 그 뒤에야 2시간 관측 속도로 내려간다. 덕분에 첫 관측에서도 바로 점수가 나온다.
- **재부상도 급부상으로 잡힌다.** 오래된 저장소가 다시 오르는 것과 신규 저장소가 처음 오르는 것을 같은 기준으로 본다.
- 코호트는 아직 `breakout:global` 하나.

### 3. `16ebe64` API 한도 예산 방식

처음엔 후보 전체를 갱신하고 한도가 넘치면 다음 실행으로 미루게 짰는데, 그러면 밀린 분량이 누적된다. 실행마다 감당 가능한 만큼만 하도록 바꿨다.

- 실행 시작 시 `/rate_limit`으로 남은 core 쿼터를 읽는다(이 엔드포인트는 쿼터를 쓰지 않는다).
- 예산 = `(remaining - reserve) / 2`. 저장소당 2콜(현재 별 개수 + 히스토리 1페이지). reserve 기본 500.
- 신선한 캐시는 0콜이라 예산을 안 쓴다. 갱신이 필요한 것만 경쟁하고, **히스토리가 아예 없는 저장소 우선, 그다음 가장 오래된 순**으로 예산을 쓴다.
- 예산 밖 저장소는 기존(오래된) 캐시를 그대로 쓰고, 캐시도 없으면 `star_history` 부족 근거로 남긴다. **다음 실행으로 밀린 빚을 넘기지 않는다.**
- 수집기 캐시 TTL은 20시간 + 저장소별 최대 6시간 고정 지터. 2시간마다 후보군 일부씩만 갱신된다.
- 로그에 갱신·재사용·누락 수와 예산을 남긴다.

## 배포 전 필요한 것

1. PR 생성 후 main 머지 (아직 PR 없음)
2. **운영 웹 서버 환경변수에 `GITHUB_TOKEN` 추가.** 없으면 웹 서버가 시작하지 않는다. 수집기 토큰 재사용 가능
3. 평소 방식대로 배포. **DB 스키마 변경 없음**

선택 환경변수:

| 이름 | 기본값 | 용도 |
| --- | --- | --- |
| `TREND_RADAR_STAR_HISTORY_CACHE_DIR` | `data/star-history` | 수집기 히스토리 캐시 위치 |
| `TREND_RADAR_STAR_HISTORY_RESERVE` | `500` | 히스토리에 쓰지 않고 남겨둘 core 콜 수 |

웹 서버 캐시는 기존 캐시 디렉터리 아래 `star-history/`에 쌓인다. 둘 다 `.gitignore` 처리됨.

## 확인 못 한 것

세션 환경의 프록시가 우리 레포(별 0개) 외 GitHub API 접근을 막아서, **값이 실제로 들어있는 응답을 한 번도 보지 못했다.** 배포 후 아래를 확인해야 한다.

1. `days` 값이 unstar를 반영한 순증인지, 총증인지. 총증이면 그래프가 실제보다 높게 그려진다. 스파크라인 최신값과 GraphQL `stargazerCount`를 비교하면 바로 드러난다
2. 하루 값의 반영 지연. 현재는 36시간 넘은 날은 24시간 근거로 안 쓴다
3. 422 "endpoint spammed" 제한이 어느 빈도에서 걸리는지

로컬에서 토큰으로 확인하는 명령:

```bash
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  "https://api.github.com/repos/facebook/react/stargazers/history?per_page=3"
```

## 알려진 동작

- **주 경계 지연**: GitHub이 새 주 버킷을 여는 데 시간이 걸린다. 실제로 UTC 일요일 00:14에도 새 주가 없었다. 이 동안은 오늘 얻은 별을 분리할 수 없어 정확한 자정값을 만들 수 없으므로, 캐시가 있으면 캐시를, 없으면 관측값만 쓴다(`StarHistoryLagError`). 잘못된 값을 그리지는 않는다.
- **첫 배포일 급부상 목록이 크게 바뀐다.** 게이트가 사라져 큰 저장소와 재부상 저장소가 새로 들어온다.

## 남은 작업

1. **코호트 분리** — 지금은 3만 개짜리 재부상과 500개짜리 신규가 같은 풀에서 경쟁한다. 절대 증가량에서 큰 쪽이 유리하므로 별 규모 구간별 코호트가 필요하다. 다만 구간 경계는 실제 분포를 봐야 정할 수 있어서 배포 후로 미뤘다. 방법론 문서에도 예정 사항으로 적어뒀다.
2. 위 "확인 못 한 것" 3가지 검증
3. 첫 실행 시 캐시가 비어 있어 예산이 여러 번에 걸쳐 소진된다. 며칠은 히스토리 없는 저장소가 섞이는데, 정상 동작이며 점차 채워진다.

## 검증 상태

| 항목 | 결과 |
| --- | --- |
| `npm test` | 213개 통과 |
| `npm run typecheck` | 통과 |
| `npm run build` | 통과 |
| 실제 GitHub 응답 파싱 | 우리 레포(별 0개) 페이로드로만 확인 |

## 관련 파일

```text
server/star-history.ts        히스토리 조회·캐시·병합·예산 (신규)
server/star-history.test.ts   위 테스트 (신규)
server/web-server.ts          /api/star-series에서 병합, GITHUB_TOKEN 요구
server/history-api.ts         로컬 개발 서버 동일 경로
server/collect-remote.ts      수집기: 예산 계산 + 히스토리 수집
src/lib/trend-intelligence.ts 급부상 판정 (v6)
src/lib/star-series.ts        90일 창 상수
docs/methodology.md           공개 방법론
```
