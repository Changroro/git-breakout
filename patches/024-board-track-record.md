# 발굴 성과를 보드 노출 기준으로 측정

[수정 패치](024-board-track-record.patch)는 별도 운영 번들(`deploy/oracle/`)에 적용하는 변경분이다. 공개 저장소의 웹 코드는 이 마이그레이션이 만든 `track_record.board`를 필수로 읽으므로, **운영 DB에 024를 먼저 적용한 뒤 웹 코드를 배포해야 한다.** 순서가 바뀌면 새 웹이 트랙레코드 파싱에 실패해 랭킹 화면까지 열리지 않는다.

## 조회 계약

`radar.discovery_board_exposures`는 저장소마다 발굴 보드에 처음 오른 스냅샷 시각·순위·Star와 처음 Top 10에 든 시각·Star를 저장한다. 보드 순서는 `api.snapshot_page`의 breakout 정렬(점수 내림차순, `full_name_key`)과 같다. 수집이 완료될 때 `update_track_record_summary` 트리거가 그 실행의 스냅샷(실행 id = 스냅샷 id)을 기록하고, 7일이 지난 노출의 적중 여부를 한 번만 확정한다.

적중은 노출 후 7일 안에 일간 Trending에 들거나, 그 기간 관측된 최대 Star가 노출 시점보다 500개 이상 많은 경우다. 기준은 `track_record.board.hit_rule`로 함께 반환한다. 관측이 없는 수집 공백은 적중으로 세지 않는다.

기존 `track_record` 필드(`schema_version` 1.0, 7·14일 전환율 등)는 그대로 둔다. 마이그레이션과 새 웹 배포 사이에 이전 웹이 계속 동작하게 하려는 호환 조치이며 화면에는 더 이상 쓰지 않는다.

## 적용과 검증

1. 운영 번들에 패치가 적용 가능한지 확인한다. 이미 반영된 번들에서는 역방향 검사로 일치 여부를 확인한다.
2. 최근 DB 백업을 확인한다. 024는 새 테이블과 함수 교체만 하는 추가 변경이며, 기존 스냅샷을 읽어 백필한다. 2026-10-16 운영 데이터 기준 백필 계산은 약 15초다.
3. 패치된 `024_board_track_record.sql`과 `auto-deploy.sh`를 운영 번들에 반영한다. 배포 타이머가 운영 파일 변경을 감지해 024를 적용하고 `schema_migrations`에 체크섬을 기록한다.
4. `/api/track-record`에 `board`가 있고 값이 합리적인지 확인한 뒤 웹 코드를 푸시한다.
5. 새 웹 배포 후 발굴 성과 화면과 다음 수집 완료 시 노출 기록이 늘어나는지 확인한다.

```bash
git apply --check patches/024-board-track-record.patch
git apply --reverse --check patches/024-board-track-record.patch
npm run test:integration -- 024
npm test -- deploy/oracle/operations.test.ts
```

`regression-024.mjs`는 트리거 경로의 첫 노출·Top 10 기록, 7일 적중의 Star·Trending 두 경로와 미적중·미성숙 구분, 보드 지표 계산, 재적용 멱등성과 기존 필드 유지를 검증한다.
