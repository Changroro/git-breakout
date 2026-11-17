# 저장소 이력 조회 타임아웃 수정

[수정 패치](023-identity-context-scalars.patch)는 별도 운영 번들에 적용하는 변경분이다. 운영 번들 전체나 비밀 설정을 공개 저장소에 다시 추가하는 방식이 아니다. 공개 저장소 clone만으로 운영 스키마와 통합 검증 환경이 제공되지는 않는다.

## 조회 계약

`api.repository_identity_context`는 저장소 ID와 허용된 이름 이력을 사용해 최초 관측, 트렌딩 진입 횟수, 최근 관측과 성장 비교를 계산한다. 최근 관측 일부만 반환하더라도 최초 시각과 진입 횟수의 계산에는 전체 이력이 필요하다. 이름 변경·이름 재사용·미검증 옛 기록의 구분과 원본 스냅샷 보존을 유지한다.

기존 조회는 각 과거 행의 큰 `payload_json`에서 업데이트 시각과 공식 트렌딩 값을 반복해서 꺼냈다. `023_identity_context_scalars`는 `snapshot_repositories`에 `identity_pushed_at`과 `identity_is_trending` generated stored 열을 추가하고, 조회가 이 작은 값을 읽도록 바꾼다. 원본 JSON은 유지하고 삽입·수정에 따른 파생 값 동기화는 DB가 수행한다. 설정 조회는 singleton 제약에 맞춰 `LIMIT 1`로 행 수 과대 추정을 제한한다.

RPC의 제한 시간을 늘린 수정은 아니다. 전체 이력 조인과 정렬 비용은 남으므로 향후 느려지면 실제 실행 계획과 요청 규모를 다시 측정한다. 이름 기반 요약을 그대로 대체하면 다른 저장소가 재사용한 이름의 이력을 섞을 수 있어, ID별 계약 검증이 필요하다.

## 적용과 검증

1. 운영 번들 원본에서 패치가 적용 가능한지 확인한다. 이미 반영된 번들에서는 역방향 검사로 일치 여부를 확인한다.
2. 적용 전 DB 백업과 기존 실행 중인 수집을 확인한다. generated 열의 기존 행 변환은 테이블 재작성과 배타적 잠금을 수반하므로 조회가 대기할 수 있다.
3. 기존 적용 마이그레이션은 유지하고 새 마이그레이션을 기존 배포 절차로 적용한다. 적용 파일의 체크섬과 `schema_migrations` 기록을 일치시키며 초기화·Compose·배포 스크립트의 등록도 함께 반영한다.
4. 적용 전후 원본 행 수, 두 generated 열, 함수 정의와 권한을 확인한다. 필요하면 테이블·설정 통계를 갱신한다. 잠시 멈춘 타이머는 원래 상태로 복구한다.
5. 대표 입력 조회뿐 아니라 실제 수집의 새 스냅샷 저장과 공개 `/api/status`의 정상화를 확인한다.

```bash
git apply --check patches/023-identity-context-scalars.patch
git apply --reverse --check patches/023-identity-context-scalars.patch
npm run test:integration -- 023
npm test -- deploy/oracle/operations.test.ts
```

두 patch 검사는 적용 전과 적용 후에 각각 사용한다. 통합 테스트에는 별도 운영 번들, 실행 중인 Docker daemon과 로컬 PostgreSQL 이미지가 필요하다. `regression-023.mjs`는 기존 데이터 변환, 이름 변경·재사용·legacy 결과의 동등성, 최초 관측·트렌딩 횟수와 최근 관측 창, 파생 값의 삽입·수정 동기화를 검증한다.
