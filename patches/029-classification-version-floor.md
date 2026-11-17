# 분류 가능 스냅샷을 점수 버전 하한으로 판정

[수정 패치](029-classification-version-floor.patch)는 [028](028-retention-candidate-summary.md) 다음에 별도 운영 번들(`deploy/oracle/`)에 적용하는 변경분이다. 점수 버전을 `trend-intelligence-v9-shadow`로 올리는 웹·수집기 코드보다 먼저 적용해야 한다.

## 문제

수집이 끝나면 `radar.refresh_snapshot_summary`가 스냅샷마다 `classification_available`(발굴 후보 분류가 들어 있는지)을 기록한다. [021](../deploy/oracle/db/migrations/021_v8_classification.sql)은 이 값을 점수 버전이 `trend-intelligence-v7-shadow` 또는 `trend-intelligence-v8-shadow`인 행이 있는지로 정했다.

점수 버전이 v9로 올라가면 새 스냅샷이 모두 미분류로 기록된다. 발굴 보드 노출 기록(`radar.record_board_exposures`, 025)과 발굴 성과 집계는 분류된 스냅샷만 보므로 둘 다 멈춘다. 버전을 올릴 때마다 이 목록을 함께 고쳐야 하는 구조다.

## 변경

판정을 목록에서 하한으로 바꾼다. 점수 버전이 `trend-intelligence-v<숫자>-shadow` 꼴이고 숫자가 7 이상이면 분류된 스냅샷이다. 분류 필드는 v7에서 생겼고 이후 버전이 유지한다. 나중 버전이 분류 필드를 없앤다면 이 판정도 함께 바꿔야 한다.

숫자는 9자리까지만 읽는다. 더 긴 숫자는 정수로 바꿀 때 오류가 나 수집 전체가 실패하므로, 꼴이 맞지 않는 값과 같이 미분류로 둔다.

함수의 나머지(언어·토픽 집계, `intelligence_available`)는 021과 같다. 기존 `snapshot_summary` 행은 고치지 않는다. 기존 스냅샷은 모두 v8 이하라 다시 계산해도 값이 같기 때문이다.

## 결과

운영 DB에서 읽기 전용으로 확인했다(2026-11-17 04:09 UTC, 스냅샷 895개).

| 저장된 값 | 점수 버전 | 스냅샷 수 | 새 판정 |
|---|---|---|---|
| 미분류 | 점수 없음 | 19 | 미분류 |
| 미분류 | v2, v3, v4, v5, v6 | 19, 24, 5, 55, 19 | 미분류 |
| 분류 | v7 | 32 | 분류 |
| 분류 | v8 | 722 | 분류 |

점수 버전은 스냅샷마다 순위 1~3위 행에서 읽었고, 한 스냅샷 안에서 버전이 섞인 경우는 없었다. 세 묶음에서 다섯 개씩 고른 스냅샷 15개를 트랜잭션 안에서 새 함수로 다시 계산했을 때 요약 행 전체가 저장된 값과 같았다(롤백).

## 적용과 검증

```bash
git apply --check patches/029-classification-version-floor.patch
npm run test:integration -- 021 029
npm test -- deploy/oracle/operations.test.ts
```

함수 하나만 바꾸므로 잠금 대기가 없다. 기존 배포 절차(`github-trend-radar-deploy.service`)로 적용한 뒤 v9 코드를 배포한다. v9로 수집한 첫 스냅샷의 `classification_available`이 참인지, 보드 노출 기록이 이어지는지 확인한다.

`regression-029.mjs`는 021의 함수를 참조 구현으로 만들어 요약 행 전체를 비교한다. 점수 없음, 빈 `trend_intelligence`, v6, v7, v8, 버전이 섞인 스냅샷, 꼴이 다른 문자열(접미사 없음, 접미사 추가, 접두사 다름, 숫자 없음, 대소문자 다름, 빈 문자열, 11자리 숫자)에서 두 함수의 결과가 같은지 확인하고, v9·v10과 v6·v9가 섞인 스냅샷이 분류로 기록되는지 확인한다. `regression-021.mjs`는 수집 완료 경로로 v9와 v10을 추가로 넣어 분류 가능으로 기록되는지 확인한다.
