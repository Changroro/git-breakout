# 수집 요약을 보존 후보만 반환

[수정 패치](028-retention-candidate-summary.patch)는 [027](027-collection-summary-comparisons.md) 다음에 별도 운영 번들(`deploy/oracle/`)에 적용하는 변경분이다. 수집기 코드(`server/remote-history.ts`, `server/collect-remote.ts`)도 함께 바뀐다.

## 문제

026·027 뒤에 수집기가 부르는 DB 경로를 모두 다시 쟀다. 저장소 이력 조회(`api.repository_identity_context`)는 요청한 저장소 수에, 수집 완료(`api.complete_collection`)는 한 번에 저장하는 행 수에, 이벤트 조회와 기록은 이벤트 보존 기간에 비례해 이력이 쌓여도 느려지지 않는다.

`api.collection_summary`만 계속 커진다. 지금까지 관측한 저장소 전체를 응답으로 돌려주는데, 저장소는 주마다 3,400~8,500개씩 늘고 지우지 않는다. 운영 데이터에서 58,712개, 26.8MB, 1.8~2.0초였고 시간 대부분은 응답 JSON을 만드는 데 쓰였다.

수집기는 이 응답으로 다시 수집할 저장소를 고른다(`selectRetainedRepositoryNames`). 첫 관측이 `grace_days` 이내이거나, 마지막 push가 `push_days` 이내이거나, `growth_days` 전보다 별이 늘어난 저장소 가운데 순위 상위 `repository_limit`개다. 그 밖의 저장소는 응답에 있어도 쓰이지 않는다.

## 변경

`api.collection_summary`는 이 조건을 통과할 수 있는 저장소만 돌려준다. 기간마다 하루 여유를 두어 통과 대상보다 넓게 고르고, 수집기는 받은 목록에 기존 조건과 정렬을 그대로 적용한다. 그래서 고르는 저장소는 이전과 같다.

- 첫 관측이 `grace_days` 이내인 저장소와 별이 늘어난 저장소는 모두 최근에 관측됐으므로 마지막 관측 시각으로 찾는다(`repository_state_observed_idx`).
- push 시각은 GitHub이 주는 고정 폭 UTC 문자열이라 문자열 순서가 시간 순서다. 새 인덱스 `repository_state_pushed_idx`로 찾는다. 이 형식이 아닌 값은 범위로 비교할 수 없어 부분 인덱스 `repository_state_unparsed_push_idx`로 항상 포함한다.
- 응답에 `observed_repository_count`(관측한 저장소 전체 수)가 추가된다. 수집 로그의 "of N observed repositories"가 이 값을 쓴다. 저장소별 필드는 그대로다.
- `api.collection_context`와 `radar.collection_context_data`는 바뀌지 않는다.

수집기는 응답에 없는 저장소를 더 이상 검증하지 않는다. 지금까지는 어느 저장소든 값이 잘못돼 있으면 수집이 실패했다.

같은 마이그레이션에서 두 가지를 더 한다.

- `api.repository_identity_context`에 `jit = off`를 붙인다. 운영 데이터에서 이 함수 실행 6.4초 가운데 3.0초가 JIT 컴파일이었다.
- 같은 테이블의 unique 인덱스와 키가 같은 `snapshot_repositories_snapshot_idx`(149MB)와 `repository_identity_history_idx`(142MB)를 지운다. 조회는 unique 인덱스로 넘어가고, 수집마다 인덱스 두 개를 덜 쓴다.

새 수집기는 `observed_repository_count`가 없는 응답도 읽는다. 028 이전 DB는 저장소 전체를 돌려주므로 그때는 목록 길이가 곧 전체 수다. 이전 수집기도 새 응답을 읽을 수 있고, 로그의 N만 후보 수로 나온다. 번들과 웹 코드 가운데 어느 쪽을 먼저 배포해도 된다.

## 결과

운영 DB에서 읽기 전용으로 비교했다(최신 스냅샷 2026-11-17 01:14 UTC).

| 항목 | 이전 | 이후 |
|---|---|---|
| 응답 저장소 수 | 58,712 | 24,790 |
| 응답 크기 | 26.8MB | 11.3MB |
| 요약 조회 시간 | 1.8~2.0초 | 0.87초(새 인덱스 없이 실행) |
| 저장소 이력 조회 시간 | 6.9~7.2초 | 3.0~3.2초 |

이전 응답과 새 응답을 수집기의 실제 선택 함수에 넣었을 때 고른 1,000개와 그 순서가 같았다. 상한을 없앤 통과 대상 24,168개도 같았고, 새 응답의 저장소별 값은 이전 응답과 같았다. 저장소 이력 조회 응답은 JIT를 꺼도 같았다(md5 비교).

후보 수는 누적 저장소 수가 아니라 최근 `push_days`+1일 동안 push된 저장소와 최근 `grace_days`+1일 동안 관측한 저장소 수에 비례한다.

## 적용과 검증

```bash
git apply --check patches/028-retention-candidate-summary.patch
git apply --reverse --check patches/028-retention-candidate-summary.patch
npm run test:integration -- 028
npm test -- deploy/oracle/operations.test.ts server/remote-history.test.ts server/collect-remote.test.ts
```

인덱스 생성은 `repository_state`(약 5.9만 행) 쓰기를 잠깐 막고, 인덱스 삭제는 커밋 직전에 `snapshot_repositories`와 `repository_identity_observations`를 잠깐 잠근다. 5초 넘게 도는 조회가 있으면 `lock_timeout`으로 실패하고 다음 배포 주기에 다시 시도된다. 기존 배포 절차로 적용한 뒤 다음 정기 수집의 성공, 로그의 "of N observed repositories"가 전체 수인지, `/api/status`의 `ok`를 확인한다.

`regression-028.mjs`는 013의 원래 함수를 참조 구현으로 만들어, 유예 기간 경계, push 기간 경계, 소수 초가 붙은 push 시각, 시간대 표기가 다른 push 시각, push 시각 없음, 관측 뒤의 push 시각, 별 증가, 관측이 끊겼다가 다시 나타난 저장소에서 두 응답으로 고른 저장소가 같은지 확인한다. 상한을 줄였을 때와 보존 정책을 바꿨을 때도 비교하고, 세 인덱스가 조회에 쓰이는지, JIT 설정과 인덱스 삭제가 반영됐는지, 마이그레이션을 다시 적용해도 같은지 확인한다.
