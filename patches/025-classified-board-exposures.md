# 분류 도입 이후 보드 노출만 발굴 성과에 반영

[수정 패치](025-classified-board-exposures.patch)는 [024](024-board-track-record.md) 다음에 별도 운영 번들(`deploy/oracle/`)에 적용하는 변경분이다. 웹 코드는 바뀌지 않는다.

## 문제

신규 발굴 분류(첫 관측 Star 1만 미만, Trending 이력 없음)는 `trend-intelligence-v7-shadow`부터 적용됐고, 운영 스냅샷 기준 첫 분류 스냅샷은 2026-09-09 15:29 UTC다. 그 전 스냅샷의 breakout 보드에는 `rust-lang/rust` 같은 큰 저장소도 올라 있었다. 024는 모든 스냅샷을 노출로 기록해 이런 저장소 241개가 섞였고, "Trending 전 노출"이 75개로 부풀었다(분류 이후만 세면 24개). 7일 적중률은 Top 10 20%, 보드 전체 8%에서 7%로 영향이 작았다.

## 변경

`radar.record_board_exposures`는 `snapshot_summary.classification_available`인 스냅샷만 기록한다. 025는 노출 기록을 비우고 분류된 스냅샷만으로 다시 채운 뒤 적중을 확정하고 요약을 다시 계산한다. 다시 적용해도 같은 결과가 나온다.

## 적용과 검증

```bash
git apply --check patches/025-classified-board-exposures.patch
git apply --reverse --check patches/025-classified-board-exposures.patch
npm run test:integration -- 024 025
npm test -- deploy/oracle/operations.test.ts
```

`regression-025.mjs`는 분류 없는 스냅샷의 보드를 노출로 세지 않는 것, 분류 이후 첫 노출 시각·순위, 재구성 시 이전 기록 제거와 멱등성을 검증한다. 적용 후 `/api/track-record`의 `board.evidence_started_at`이 첫 분류 스냅샷 이후인지 확인한다.
