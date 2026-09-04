<div align="center">

![GitBreakout](docs/banner.png)

**실제 성장과 활동 신호를 관측해 떠오르는 GitHub 저장소를 찾는 오픈소스 랭킹.**

[![License](https://img.shields.io/badge/License-MIT-f1e05a?style=flat-square)](LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Collection](https://img.shields.io/badge/Collection-every%202%20hours-3FB950?style=flat-square)](#수집과-저장)

[English](README.en.md) · [서비스 열기](https://gitbreakout.imbch.dev) · [API 상태](https://gitbreakout.imbch.dev/rpc/health)

</div>

## GitBreakout이 필요한 이유

GitHub Trending은 지금 주목받는 저장소를 확인하기에는 유용하지만, 이미 알려진 저장소가 반복해서 노출되거나 성장 초기의 프로젝트를 놓칠 수 있다. GitBreakout은 Trending 목록뿐 아니라 최근 생성·푸시된 저장소와 공개 이벤트를 함께 관측하고, 누적 인기도보다 **최근의 변화**에 무게를 둔다.

이 프로젝트는 GitHub 전체 저장소의 완전한 색인이 아니다. API 검색 한계 안에서 후보를 넓게 발견하고, 반복 관측한 값만 사용해 순위와 Star 그래프를 만든다.

## 화면

### 데스크톱

<p align="center">
  <img src="docs/screenshots/desktop.png" alt="GitBreakout 데스크톱 랭킹 화면" width="960" />
</p>

### 모바일

<p align="center">
  <img src="docs/screenshots/mobile.png" alt="GitBreakout 모바일 랭킹 화면" width="360" />
</p>

## 주요 기능

- **급부상**: 처음 관측했을 때 Star가 1만 개 미만이고 과거 Trending 이력이 없는 저장소 중 성장 가속이 두드러지는 후보를 찾는다.
- **모멘텀**: 관측된 Star 증가, 전체 성장 속도, 저장소 규모, 최근 활동을 합산해 지속적인 성장 강도를 비교한다.
- **현재 관심도**: Star 속도와 고유 참여자, 활동 종류, 단기 지속성으로 지금의 관심 집중도를 계산한다.
- **GitHub Trending**: 수집 시점의 Daily·Weekly·Monthly 원본 순위를 별도 탭으로 보존한다.
- **히스토리**: 2시간 단위 스냅샷 타임라인으로 과거 순위와 당시 저장소 상태를 조회한다.
- **Star 시계열**: 외부 그래프 서비스 없이 GitBreakout이 직접 관측한 Star 변화만 표시한다.
- **아카이브**: 최신 후보군에서 제외된 저장소도 과거 스냅샷과 함께 보존한다.
- **발굴 성과**: GitBreakout이 먼저 관측한 저장소가 이후 Daily Trending에 진입했는지 검증한다.
- **탐색 UI**: 저장소 검색, 언어·토픽 필터, 페이지네이션, 읽은 항목 표시, 한·영 전환, 반응형 라이트·다크 테마를 제공한다.

## 데이터 흐름

```text
GitHub Trending ─┐
GitHub Search ───┼─→ 후보 통합·중복 제거 ─→ GitHub 메타데이터 검증
GH Archive ──────┘                            │
                                             ▼
                                  성장·활동 구간 계산
                                             │
                                             ▼
                              PostgreSQL 스냅샷·아카이브
                                             │
                                             ▼
                                 API ─→ GitBreakout UI
```

### 후보 소스

| 소스 | 범위 | 용도 |
| --- | --- | --- |
| GitHub Trending | Daily · Weekly · Monthly 현재 목록 | 현재 노출과 원본 순위 기록 |
| GitHub Search | 최근 생성·푸시 저장소 | Trending 밖의 신규·활성 저장소 발견 |
| GH Archive | Watch, Fork, PR, Issue, Comment, Push, Release | 이벤트가 먼저 증가한 저장소 발견과 관심 폭 측정 |
| 이전 관측 | 14일 유지 정책을 통과한 후보 | 검색 범위를 벗어난 저장소의 연속 추적 |
| GitHub GraphQL | Star, Fork, Issue, 언어, Topic, Push 시각 | 현재 메타데이터 검증 |

GitHub Search는 쿼리별 최대 1,000개 결과만 반환하므로 GitBreakout의 순위를 “GitHub 전체 저장소의 완전한 순위”로 해석하면 안 된다. 후보군에서 제외된 저장소는 새 관측만 멈추며 기존 스냅샷은 삭제하지 않는다.

## 랭킹 방식

기본 모멘텀 모델은 `baseline-v1`이다.

```text
score = log1p(observedStarsPerDay) × 55
      + log1p(stars / ageDays)     × 28
      + log1p(stars)               × 5
      + log1p(forks)               × 2
      + log1p(openIssues)          × 0.5
      + max(0, 14 - pushAgeDays)
      + firstObservationBonus
```

- 첫 관측에는 성장량을 만들지 않고 탐색 보너스만 부여한다.
- 최소 2시간 떨어진 관측이 생긴 뒤부터 실제 Star 속도를 계산한다.
- GitHub Trending 순위는 후보 발견과 증거 표시에 사용하며 모멘텀 점수에는 직접 더하지 않는다.
- 데이터가 부족한 값은 0점으로 꾸미지 않고 `insufficient_data`로 남긴다.
- 급부상과 현재 관심도는 `trend-intelligence-v5-shadow` 모델로 별도 계산한다.

자세한 모델 비교와 한계는 [Trend Intelligence 연구 문서](docs/research/trend-intelligence-v2.md)에 정리돼 있다. 웹 화면의 각 지표 옆 물음표에서도 현재 계산 방식을 확인할 수 있다.

## 수집과 저장

- 운영 수집기는 DB가 기록한 다음 실행 시각을 기준으로 약 2시간마다 실행된다.
- 중복 실행은 서버 파일 잠금과 DB lease로 차단한다.
- 최근 168시간의 집계 이벤트를 유지하고 1·6·24·72시간 구간을 계산한다.
- 랭킹 스냅샷과 아카이브는 이벤트 보존 기간과 별도로 유지한다.
- 운영 스택은 PostgreSQL 17, PostgREST 14, Node 웹 서버, Cloudflare Tunnel로 구성된다.
- GitHub Actions 예약 수집은 사용하지 않는다.

## 시작하기

### 요구 사항

- Node.js 22 이상
- npm
- 공개 저장소를 조회할 수 있는 GitHub API 토큰

### 로컬 실행

```bash
git clone https://github.com/Changroro/git-breakout.git
cd git-breakout
npm ci
GITHUB_TOKEN=your_token npm run collect
npm run dev
```

브라우저에서 `http://localhost:5173`을 연다. 수집된 스냅샷이 없으면 화면은 데이터가 필요하다는 오류를 명시적으로 표시한다.

### 검증

```bash
npm test
npm run typecheck
npm run build
```

### 원격 수집

```bash
export GITHUB_TOKEN=your_token
export TREND_RADAR_API_URL=https://your-api.example.com
export TREND_RADAR_COLLECTOR_TOKEN=your_collector_jwt
npm run collect:remote
```

`deploy/oracle/.env.example`과 `deploy/oracle/cloudflared.yml.example`은 자체 호스팅용 예제다. 실제 토큰·비밀번호·Tunnel credentials는 저장소에 커밋하지 않는다.

```bash
cp deploy/oracle/.env.example deploy/oracle/.env
cp deploy/oracle/cloudflared.yml.example deploy/oracle/cloudflared.yml
docker compose --env-file deploy/oracle/.env \
  -f deploy/oracle/docker-compose.yml up -d
```

## 프로젝트 구조

```text
src/                 React UI, i18n, filters, ranking views
server/              GitHub collectors, ranking API, web server
deploy/oracle/db/    PostgreSQL schema and migrations
deploy/oracle/       Docker Compose and systemd operations
docs/                Brand assets, screenshots, research notes
```

## 기여

개발 환경과 제출 절차는 [CONTRIBUTING.md](CONTRIBUTING.md), 취약점 제보 방법은 [SECURITY.md](SECURITY.md)를 참고한다. 사용된 주요 서드파티 자산과 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 정리돼 있다.

이 프로젝트는 [MIT License](LICENSE)로 배포된다.

---

<div align="center">
Built by <a href="https://github.com/Changroro">Changroro</a>
</div>

이 프로젝트는 GitHub 공식 제품이 아니며 GitHub, Inc.와 제휴·후원·승인 관계가 없습니다.
