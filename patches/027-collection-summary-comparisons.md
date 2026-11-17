# 수집 요약의 성장 비교를 최근 저장소만 조회

[수정 패치](027-collection-summary-comparisons.patch)는 [026](026-identity-context-state.md) 다음에 별도 운영 번들(`deploy/oracle/`)에 적용하는 변경분이다. 웹 코드는 바뀌지 않는다.

## 문제

026 적용 직후 첫 수집이 `api.collection_summary` 호출에서 RPC 제한 30초를 넘겨 실패했다. 지난 2주 수집 실패 387건 가운데 35건이 이 함수였다(나머지 352건은 026에서 고친 함수).

이 함수는 `repository_state`의 모든 저장소(58,712개)마다 성장 비교 시점(최신 스냅샷에서 `retention_growth_days` 전 이하의 마지막 관측)을 스냅샷 본문에서 한 행씩 찾았다. 페이지 30만 1천 개를 건드렸고, 캐시가 빈 상태에서 34.5초, 데워진 상태에서 3초가 걸렸다.

## 변경

비교 기준 시각 이후로 관측되지 않은 저장소는 마지막 관측이 곧 비교 시점이다. 스냅샷 시각은 `snapshots_captured_at_key`로 유일하므로 그 행의 별 수는 `repository_state.latest_stars`와 같다. 이 저장소들은 상태 테이블 값을 그대로 쓰고, 기준 시각 이후에 관측된 저장소만 스냅샷 이력을 조회한다.

운영 데이터에서 조회 대상이 58,712개에서 9,334개로 줄었다. 이 수는 이력 길이가 아니라 최근 `retention_growth_days`(7일) 동안 관측한 저장소 수에 비례한다. 응답 형식과 `collection_context`, `repository_observations`의 동작은 같다.

DB 컨테이너는 `shared_buffers=1GB`(기본 128MB)와 `log_min_duration_statement=5s`로 시작한다. 026·027이 자주 읽는 인덱스와 상태 테이블(약 900MB)을 같은 서버의 다른 서비스와 다투는 파일 캐시 대신 Postgres 버퍼에 두고, 수집기 RPC 제한 30초에 다가가는 호출을 실패 전에 DB 로그로 볼 수 있게 한다. 적용하려면 DB 컨테이너를 다시 만들어야 하며(`docker compose up -d db`), 그동안 수십 초 서비스가 끊긴다.

## 결과

운영 DB에서 트랜잭션으로 적용해 비교했다. 응답이 기존 함수와 같았고, 건드린 페이지가 301,160개에서 54,270개로 줄었다.

## 적용과 검증

```bash
git apply --check patches/027-collection-summary-comparisons.patch
git apply --reverse --check patches/027-collection-summary-comparisons.patch
npm run test:integration -- 027
npm test -- deploy/oracle/operations.test.ts
```

함수 교체만 하므로 잠금이 짧고 백업 외 준비가 필요 없다. 기존 배포 절차로 적용한 뒤 다음 정기 수집의 성공과 `/api/status`의 `ok`를 확인한다.

`regression-027.mjs`는 013의 원래 함수를 참조 구현으로 만들어, 기준 시각 전에만 관측된 저장소, 계속 관측된 저장소, 기준 시각 뒤에 처음 관측된 저장소, 관측이 끊겼다가 다시 나타난 저장소에서 요약·관측 포함·이름 필터 세 경로의 응답이 같은지 확인한다.
