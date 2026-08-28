# Trend Intelligence v2 연구 및 설계

조사일: 2026-08-28

## 목표

이 기능은 두 문제를 분리해서 해결한다.

1. GitHub Trending과 Search에 아직 잡히지 않은 저장소를 더 일찍 발견한다.
2. 이미 발견한 저장소 중 현재 실제 관심이 모이는 대상을 더 정확히 정렬한다.

기존 `baseline-v1`은 서비스가 직접 관측한 Star 증가량을 중심으로 동작한다. v2는 이를 교체하지 않고 공개 GitHub 이벤트를 결합한 섀도 점수로 함께 저장한다. 충분한 이력이 쌓여 검증되기 전까지 기본 정렬은 `baseline-v1`을 유지한다.

## 비교 조사

| 제품·프로젝트 | 확인한 핵심 방식 | 배울 점 | 그대로 채택하지 않은 이유 |
| --- | --- | --- | --- |
| [GitHub Trending](https://github.com/trending) | 현재 기간별 인기 목록 | 사용자가 이해하기 쉬운 기준점 | 공식 점수와 과거 순위 API가 없고 이미 노출된 저장소 중심이다. |
| [Trendshift Signal](https://trendshift.io/signal) | 참여 급증과 트렌딩 목록을 API로 제공 | 단순 누적량보다 급증 신호가 중요하다. | 외부 유료 데이터에 운영 랭킹을 종속시키지 않는다. |
| [RepoVelocity](https://repovelocity.com/about) | Star velocity, contributor spread, 활동 다양성, 신선도를 함께 평가 | 한 종류 이벤트보다 사람과 활동 폭을 같이 봐야 한다. | 점수 산식과 원시 근거가 공개되지 않아 독립 검증이 어렵다. |
| [OSSInsight](https://github.com/pingcap/ossinsight) | 대규모 GitHub 이벤트 분석과 기간별 증가 지표 | 공개 이벤트는 저장소 발견과 활동 검증 모두에 쓸 수 있다. | 별도 분석 플랫폼 전체를 도입하지 않고 필요한 시간 창만 저장한다. |
| [trending8](https://github.com/korbinjoe/trending8) | 절대 Star 증가, 작은 저장소의 상대 속도, 최근 commit 상태 | 신규 저장소에는 절대 증가량과 상대 증가율을 분리해야 한다. | 단일 상승 점수보다 현재 인기와 초기 돌파를 별도 랭킹으로 보여준다. |
| [GitHub Trending Intelligence](https://github.com/HundunOnline/github-trending-intelligence) | Star·fork·contributor·commit·issue를 정규화해 합산 | 서로 다른 규모의 신호는 정규화가 필요하다. | 고정 가중합 대신 동질 집단 내 백분위를 사용한다. |
| [RepoFOMO](https://repofomo.com/leaderboard/) | 여러 기간의 Star·fork velocity | 짧은 급등과 지속 상승을 구분해야 한다. | 1/6/24/72시간 창과 가속도·지속성으로 직접 표현한다. |
| [OpenDigger](https://github.com/X-lab2017/open-digger) | OpenRank와 장기 활동·협업 지표 | 장기 영향력은 인기 급등과 다른 축이다. | v2 첫 단계는 실시간성에 집중하고 장기 영향력은 후속 후보로 둔다. |

조사한 오픈소스의 코드를 가져오지 않았으며, 공개된 동작과 문서를 비교 기준으로만 사용했다.

## 데이터 선택

v2는 [GH Archive](https://www.gharchive.org/)의 시간별 공개 GitHub 이벤트 파일을 사용한다. 수집 이벤트는 `Watch`, `Fork`, `PullRequest`, `Issues`, `IssueComment`, `Push`, `Release`다.

- 원본 이벤트 전체를 영구 보관하지 않는다.
- 저장소·시간별 이벤트 수와 고유 actor ID 집합만 저장한다.
- 이벤트 집계는 168시간 후 삭제한다.
- 기존 랭킹 스냅샷과 Star 관측 기록은 이 정리 정책의 영향을 받지 않는다.
- 이벤트 수집 실패는 기존 모멘텀 수집을 막지 않는다. 대신 해당 v2 점수를 `insufficient_data`로 명시한다.

## 독자적인 설계

### Current Heat와 Breakout 분리

`Current Heat`는 지금 관심의 절대 크기를 측정한다.

- 24시간 Star 증가량의 전체 백분위
- 24시간 고유 actor 수의 전체 백분위
- Watch·Fork·Discussion·Development 네 활동군의 다양성
- 6시간 actor 흐름이 24시간 흐름에서 유지되는 비율

`Breakout`은 비슷한 저장소 사이에서 예상 밖으로 빨리 성장하는지를 측정한다.

- 언어
- 저장소 나이 구간
- 누적 Star 구간

이 세 조건이 같은 cohort 안에서 다음 네 값을 백분위로 변환해 평균한다.

- 기존 Star 대비 24시간 상대 성장률
- 6시간 Star 속도와 24시간 Star 속도의 차이
- 6시간 actor 속도와 24시간 actor 속도의 차이
- 24시간 고유 actor 폭

따라서 대형 저장소의 큰 절대 증가와 작은 신규 저장소의 이례적인 돌파가 같은 한 줄 점수에서 서로 가려지지 않는다.

### 증거 우선 상태

점수와 함께 `spark`, `breakout`, `hot`, `steady`, `cooling`, `insufficient_data` 단계를 저장한다. cohort가 8개 미만이거나 이벤트가 4시간보다 오래됐거나 Star 창이 비어 있으면 필요한 점수를 만들지 않는다. 누락된 근거와 신뢰도도 스냅샷에 함께 저장한다.

### 이벤트 기반 후보 발굴

최근 24시간 공개 이벤트에서 고유 actor 수, 이벤트 종류, 총 이벤트 수 순으로 후보를 선택한다. 이 후보를 기존 Trending·Search·유지 풀과 합친 뒤 GitHub GraphQL로 현재 저장소 상태를 검증한다. 이벤트만 많고 삭제됐거나 비공개로 바뀐 저장소는 기존 검증 단계에서 제외된다.

## 섀도 운영과 승격 기준

v2는 우선 사용자 선택형 `Breakout`과 `Current heat` 보기로 제공한다. 기본 `Momentum`을 교체하려면 최소 2주간 다음 항목을 스냅샷 기준으로 평가한다.

| 평가 항목 | 질문 |
| --- | --- |
| 24시간 후 Star 증가 상위 저장소 재현율 | 높은 점수를 준 저장소가 실제 후속 성장을 보였는가? |
| 신규 발견 선행 시간 | 기존 Trending/Search보다 얼마나 먼저 후보를 발견했는가? |
| top 20 변동률 | 실제 신호 없이 순위가 과도하게 흔들리지 않는가? |
| 데이터 가용률 | cohort와 이벤트 근거가 충분한 저장소 비율은 얼마인가? |
| 대형 저장소 편향 | 누적 Star가 큰 저장소가 근거 없이 상위를 독점하지 않는가? |

검증 결과가 쌓이기 전에는 임계값이나 가중치를 성과가 좋아 보이도록 반복 조정하지 않는다. 승격 시에는 점수 버전을 새로 만들고 기존 스냅샷의 산식을 소급 변경하지 않는다.

## 후속 연구

- 각 스냅샷의 예측과 24·72시간 후 실제 결과를 연결하는 공개 Accuracy 화면
- 언어별 이벤트 발생률 차이를 보정한 cohort 품질 비교
- release 이후 의존 패키지 채택 증가를 포함한 `Adoption` 축
- 자동화 계정·단일 조직 집중도를 낮추는 actor 품질 신호
- 30일 이상 장기 영향력과 실시간 관심을 분리한 별도 보기
