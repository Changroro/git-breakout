<div align="center">

![GitHub Trend Radar](docs/banner.png)

**GitHub Trending을 복제하지 않고, 저장소의 실제 성장 속도와 활동성을 2시간 단위로 추적하는 모멘텀 랭킹.**

[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Collector](https://img.shields.io/badge/Collector-Every%202%20hours-3FB950?style=flat-square)](.github/workflows/collect.yml)
[![Status](https://img.shields.io/badge/Status-Personal%20project-8B949E?style=flat-square)](#상태와-범위)

[English](README.en.md) · [공개 웹](https://github-trend-radar.imbch.dev) · [API 상태](https://github-trend-radar.imbch.dev/rpc/health)

</div>

> [!IMPORTANT]
> 이 프로젝트는 GitHub 공식 서비스가 아닌 개인 프로젝트다. 공개 웹, API, 수집 데이터 저장소를 Oracle A1에서 운영한다.

## 프로젝트 소개

GitHub Trend Radar는 현재 Trending 목록만 다시 보여주는 페이지가 아니다. 현재 GitHub Trending, 최근 생성 저장소, 최근 push 저장소, 유지 조건을 통과한 이전 저장소를 하나의 후보군으로 합치고, 반복 관측으로 계산한 스타 증가량과 저장소 활동성을 기준으로 다시 정렬한다.

`Momentum`은 저장소의 누적 인기도가 아니라 **지금 얼마나 빠르게 관심을 얻고 있는지**를 나타낸다. 큰 저장소가 항상 상위에 오르지 않도록 전체 스타 수보다 관측 성장 속도에 더 높은 가중치를 둔다.

### 현재 후보군

| 소스 | 수집 범위 | 역할 |
| --- | --- | --- |
| GitHub Trending | daily · weekly · monthly 현재 목록 | 공식 노출 신호와 현재 순위 기록 |
| GitHub Search | 최근 7일 생성 저장소, 최근 24시간 push 저장소 | Trending 밖의 신규·활성 저장소 발견 |
| GH Archive | 최근 72시간 Watch·Fork·PR·Issue·Comment·Push·Release 이벤트 | 이벤트가 먼저 발생한 저장소 발견과 관심 폭 검증 |
| Bootstrap seeds | 아직 관측하지 못한 검증된 공개 저장소 | 최초 수집의 관측 풀만 보강 |
| 이전 관측 저장소 | 14일 유예·7일 Star 증가·30일 내 push 조건을 통과한 직전 모멘텀 상위 1,000개 | Trending/Search 범위를 벗어난 유효 후보 추적 |
| GitHub GraphQL | 스타·fork·watcher·issue·언어·topic·push 시각 | 현재 메타데이터 갱신 |

Search 쿼리 하나당 최대 1,000개만 가져오므로 이것을 “GitHub 전체 저장소의 완전한 순위”라고 부르지는 않는다. 조건에서 탈락한 저장소는 새 스냅샷 수집만 멈추며 기존 기록은 보존된다. 이후 Trending/Search에서 다시 발견되면 자동으로 관측을 재개한다.

## 화면

| 데스크톱 | 모바일 |
| :---: | :---: |
| ![데스크톱 랭킹과 타임라인](docs/screenshots/desktop.png) | ![모바일 랭킹과 타임라인](docs/screenshots/mobile.png) |

타임라인의 각 점은 실제로 저장된 랭킹 스냅샷이다. 특정 시점을 선택하면 그때의 순위와 저장소 내용으로 전환되며, 페이지 전환과 새 데이터 반영 시 행 내용에 플립 모션을 적용한다.

## 주요 기능

### 발견과 랭킹

- **GitHub-wide discovery**: Trending 3종과 Search 2종을 합치고 이름 변경·삭제 저장소를 검증한다.
- **검증된 조기 발견**: 첫 관측 출처가 Search 또는 GH Archive이고 이후 GitHub Trending Daily에서 관측된 경우만 두 관측 사이의 간격과 당시 순위를 증거로 기록한다.
- **Track Record**: 검증 건수, 관측 리드타임 중앙값, 7일·14일 전환율을 공개하며 과거 출처 불명 데이터와 수집 공백은 분모에서 제외한다.
- **14일 컷오프**: 신규 저장소에는 14일을 부여하고, 이후 7일 Star 증가 또는 30일 내 push가 있는 후보만 유지한다.
- **2시간 관측 윈도우**: 관측 데이터로 1시간·6시간·24시간 스타 증가량을 계산한다.
- **모멘텀 점수**: 성장 속도, 저장소 나이 대비 스타 속도, 규모, fork, open issue, 최근 push를 합산한다.
- **신뢰도 표시**: 첫 관측은 실제 성장으로 간주하지 않고 `low` 신뢰도로 기록한다.
- **Breakout 섀도 랭킹**: 처음 관측했을 때 Star가 1만 개 미만이고 과거 GitHub Trending 이력이 없는 저장소만 대상으로, 최근 하루 성장세가 자신의 지난 7일 평균과 비슷한 저장소보다 얼마나 두드러지는지 비교한다.
- **Current Heat 섀도 랭킹**: 절대 Star 속도, 고유 actor, 활동 다양성, 지속성으로 현재 관심의 크기를 별도로 보여준다.
- **증거 기반 상태**: 실제 Star 증가가 없거나 이벤트가 오래됐거나 cohort가 작으면 점수를 만들지 않고 `insufficient_data`와 누락 근거를 저장한다.

### 히스토리와 UI

- **스냅샷 타임라인**: 저장된 시점으로 드래그해 과거 랭킹을 조회한다.
- **페이지네이션**: 중앙 정렬된 이전·다음 버튼과 최대 10개 페이지 번호를 제공한다.
- **실제 Repository 카드**: GitHub Open Graph 이미지를 캐시해 저장소별로 표시한다.
- **자체 Star 성장 그래프**: 최초 관측 이후 직접 저장한 Star 시계열을 행별 스파크라인으로 표시한다.
- **반응형 화면**: 데스크톱 표와 모바일 카드 레이아웃, 라이트·다크 테마를 제공한다.
- **페이지 단위 조회**: 화면에 필요한 저장소 10개와 제한된 facet만 전송하고, 전체 스냅샷은 브라우저로 내려보내지 않는다.
- **공개 방법론**: 화면의 물음표에서 모멘텀 산식, Breakout·Current Heat 구성 요소, 발견 증거 기준과 한계를 확인할 수 있다.

### 저장과 자동화

- **로컬 개발**: SQLite에 수집 실행, lease, 스냅샷, 저장소 관측값을 저장한다.
- **원격 운영**: PostgreSQL 17 + PostgREST 14를 별도 스택으로 운영한다.
- **예약 수집**: Oracle의 systemd timer가 DB의 2시간 수집 주기를 확인하고 원격 수집을 실행한다.
- **이벤트 수집**: 각 수집 주기에 완료된 GH Archive 2시간분을 먼저 집계하며, 이벤트 장애가 발생해도 기본 모멘텀 스냅샷은 계속 생성한다.
- **중복 방지**: 서버 파일 잠금과 DB lease로 수집기가 겹치지 않게 한다.
- **운영 보호**: 일일 PostgreSQL 백업, 주간 실제 복구 검증, 5분 상태·디스크 점검을 systemd timer로 실행한다.

## 랭킹 방식

현재 점수 버전은 `baseline-v1`이다.

```text
score = log1p(observedStarsPerDay) × 55
      + log1p(stars / ageDays)     × 28
      + log1p(stars)               × 5
      + log1p(forks)               × 2
      + log1p(openIssues)          × 0.5
      + max(0, 14 - pushAgeDays)
      + firstObservationBonus
```

- `observedStarsPerDay`가 가장 큰 비중을 차지한다.
- 첫 관측에는 성장값을 만들지 않고 12점 탐색 보너스만 준다.
- 2시간 이상 간격의 이전 관측이 생긴 뒤부터 실제 성장 속도를 계산한다.
- GitHub Trending 순위는 후보 발견과 이유 표시에 사용하며, 현재 버전에서는 점수에 직접 더하지 않는다.
- 동점이면 `owner/repository` 이름 순으로 정렬해 결과를 결정적으로 유지한다.

### Trend Intelligence v5 섀도 모델

기본 정렬을 교체하지 않은 채 `Breakout`과 `Current heat` 보기를 함께 저장한다. `Breakout`은 최초 관측 Star가 1만 개 미만이고 최초 관측 당시 공식 Trending에 없었으며 이전 Trending 진입 이력이 없는 저장소만 계산한다. 최소 6시간의 실제 Star 증가가 필요하며, 수집 공백으로 정확한 구간이 없으면 2시간 이상 떨어진 관측값으로 계산한 일일 환산 속도를 저신뢰도 근거로 사용한다. 초기 후보는 전체 신규 후보 중 계산 점수 상위 10%만 보여주고, 24시간 데이터가 생긴 뒤에는 70점 이상을 모두 보여준다. 7일 자기 기준점과 GitHub 이벤트는 점수와 신뢰도를 보강하지만 필수 조건은 아니다. `Current heat`는 전체 후보군의 현재 Star 속도와 고유 actor 폭을 사용한다.

공개 이벤트는 후보 발굴에도 사용한다. 최근 24시간 고유 actor 수, 활동 종류, 이벤트 수가 높은 저장소를 기존 후보군에 더한 뒤 GitHub API로 현재 상태를 검증한다. 이벤트 집계는 168시간만 보관하며 랭킹 스냅샷은 그대로 남는다.

비교 조사와 기본 산식은 [Trend Intelligence v2 연구 및 설계](docs/research/trend-intelligence-v2.md)에 정리했다. v5는 유명 저장소를 제외한 뒤 6시간 초기 후보와 24시간 성숙 후보를 서로 다른 노출 기준으로 평가한다.

```text
Trending + Search + retained pool
                 │
                 ▼
    retention filter and dedupe
                 │
                 ▼
        GitHub GraphQL metadata
                 │
                 ▼
      1h / 6h / 24h growth windows
                 │
                 ▼
       baseline-v1 momentum ranking
                 │
                 ▼
   PostgreSQL snapshot → timeline UI
```

## 과거 백필

현재 구현은 **서비스가 관측을 시작한 시점 이후**의 랭킹과 성장량을 정확히 보존한다. 과거 데이터를 임의로 만들어 채우지 않으며, 관측 출처가 저장되기 전 데이터는 조기 발견 성과에서 `legacy`로 제외한다.

| 백필 대상 | 가능 여부 | 이유 |
| --- | --- | --- |
| 과거 GitHub Trending 순위 | 불가 | GitHub Trending은 현재 페이지를 제공하며 공식 과거 순위 API가 없다. |
| 과거 시점의 fork·issue·push 상태 | 불가 | GitHub API는 현재 메타데이터를 반환하므로 과거 스냅샷을 재구성할 수 없다. |
| 오래된 저장소 후보군 발견 | 구현 가능 | 날짜 구간을 잘게 나눈 Search로 과거 생성 저장소를 관측 풀에 추가할 수 있다. 현재는 미구현이다. |
| 과거 스타 증가 곡선 | 제한적 | `starred_at` 목록이 필요하지만 2026년 7월부터 stargazer 목록 접근이 관리자·협업자로 제한됐다. 임의의 공개 저장소 전체 백필에는 사용할 수 없다. |

GitHub의 stargazer 응답은 원래 `application/vnd.github.star+json`으로 star 생성 시각을 제공하지만, 현재 접근 제한은 [GitHub 공식 문서](https://docs.github.com/en/rest/activity/starring?apiVersion=2026-03-10#list-stargazers)에 명시돼 있다. 따라서 이 프로젝트는 외부 저장소의 과거 값을 추정치로 섞지 않고, 직접 관측한 스냅샷만 랭킹 계산에 사용한다.

## 시작하기

### 요구 사항

- Node.js 22
- npm
- 공개 저장소 메타데이터를 조회할 수 있는 GitHub API 토큰

### 로컬 실행

```bash
git clone https://github.com/Changroro/github-trend-radar.git
cd github-trend-radar
npm ci
GITHUB_TOKEN=your_token npm run collect
npm run dev
```

브라우저에서 `http://localhost:5173`을 연다. 수집된 스냅샷이 없으면 UI는 데이터가 없다는 오류를 표시한다.

### 검증

```bash
npm test
npm run build
```

<details>
<summary><strong>원격 수집과 Oracle 배포</strong></summary>

원격 수집은 다음 값을 필수로 요구한다.

```bash
export GITHUB_TOKEN=your_token
export TREND_RADAR_API_URL=https://your-api.example.com
export TREND_RADAR_COLLECTOR_TOKEN=your_collector_jwt
npm run collect:remote
```

완료된 UTC 시간의 GH Archive 이벤트 집계는 별도 명령으로 적재한다.

```bash
npm run collect:events:remote -- --hour=2026-08-28T00:00:00.000Z --limit=5000
```

Oracle용 Compose를 실행하기 전에 `.env.example`의 필수 값을 채우고 Cloudflare Tunnel 설정 예제를 복사해 Tunnel ID와 hostname을 입력해야 한다.

Compose는 PostgreSQL, PostgREST, Node 웹 서버, Cloudflare Tunnel을 실행한다. 웹 서버는 정적 UI를 제공하고, 타임라인 메타데이터와 선택한 스냅샷의 현재 페이지·검색 결과만 PostgREST에서 조회하며, `/rpc/*` 수집 요청을 내부 PostgREST로 전달한다.

```bash
cp deploy/oracle/.env.example deploy/oracle/.env
cp deploy/oracle/cloudflared.yml.example deploy/oracle/cloudflared.yml
docker compose --env-file deploy/oracle/.env \
  -f deploy/oracle/docker-compose.yml up -d
```

Oracle 서버의 Git credential helper가 `github.com` 인증 정보를 반환하는지 확인한 뒤 수집 타이머를 설치한다.

```bash
sudo install -m 0644 deploy/oracle/systemd/github-trend-radar-collector.service \
  /etc/systemd/system/github-trend-radar-collector.service
sudo install -m 0644 deploy/oracle/systemd/github-trend-radar-collector.timer \
  /etc/systemd/system/github-trend-radar-collector.timer
sudo systemctl daemon-reload
sudo systemctl enable --now github-trend-radar-collector.timer
```

</details>

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| 프런트엔드 | React 19, TypeScript, Vite, Radix Slider, Primer Octicons |
| 수집기 | Node.js, GitHub REST/Search/GraphQL, Cheerio |
| 공개 이벤트 | GH Archive 시간별 이벤트 집계 |
| 로컬 저장 | SQLite, better-sqlite3 |
| 원격 저장 | PostgreSQL 17, PostgREST 14 |
| 네트워크 | Cloudflare Tunnel |
| 자동화 | Oracle systemd timer, DB 기반 2시간 주기 |
| 테스트 | Vitest, TypeScript strict build |

## 상태와 범위

- 개인 프로젝트이며 공개 웹, API, 예약 수집기를 운영 중이다.
- Star 그래프는 외부 서비스 없이 이 프로젝트가 직접 수집한 스냅샷만 사용한다.
- Trend Intelligence v5는 섀도 단계이며 기본 정렬은 검증된 `baseline-v1`을 유지한다.
- GitHub 공식 제품이 아니며 GitHub의 상표와 이용 조건을 따른다.
- 소스 저장소는 비공개이며 재배포 라이선스를 제공하지 않는다.

### 로드맵

- [ ] 날짜 구간 분할과 완전성 상태를 포함한 저장소 후보군 백필
- [x] 공개 웹 UI에서 선택한 PostgREST 스냅샷 온디맨드 조회
- [x] 원격 DB 일일 백업·주간 복구 검증과 스냅샷 영구 보존 정책
- [x] 외부 서비스 의존 없는 자체 관측 Star 성장 그래프
- [ ] v5 예측과 24·72시간 후 실제 결과를 비교하는 Accuracy 화면

---

<div align="center">
Built by <a href="https://github.com/Changroro">Changroro</a>
</div>
