# Public presentation

## README

`README.md` keeps Korean body text and `README.en.md` keeps English body text. Both use English section and subsection headings, including `Intro`, `Features`, `Data Flow`, `Ranking Model` and `Getting Started`.

Both READMEs show the desktop screenshot only. The mobile screenshot asset can remain in `docs/screenshots/`, but is not embedded in either README. The collection badge links to `#collection-and-storage`.

The footer puts the GitHub non-affiliation notice before a separate blank line (`<br />`). The centered `Built by Changroro` credit is the final content. This is the README footer; the website footer is a separate component.

## Ranking and discovery interface

Ranking rows retain their score but do not expose per-repository score-evidence disclosures or confidence labels. The public calculation explanation remains available through the existing methodology help. Data and scoring semantics are documented in [the methodology](methodology.md#evidence-and-confidence).

The Track Record page uses the existing Geist fonts, theme variables and bordered surfaces. Its evaluation timestamp occupies its own full-width row above the metrics. Recent verified cases occupy a separate full-width section with the observed dates and lead interval. The [verified early discovery contract](methodology.md#verified-early-discovery) defines the meaning of those values.

## 반응형 목록과 필터

랭킹과 아카이브의 페이지당 게시글 개수는 화면 크기에 따라 조절한다. 데스크톱 필터 사이드바의 상단과 하단은 랭킹 본문 패널과 맞추고, 언어·토픽 목록은 남은 공간 안에서 스크롤한다. 토픽의 상위 개수 제한과 안내 문구는 없으며 검색 결과 전체를 표시한다. 좁은 화면에서는 기존 모바일 필터 대화상자를 사용한다.

`src/App.tsx`의 `useResponsivePageSize`는 첫 데이터 행이 표시된 뒤 화면 높이에서 사이트 헤더·푸터와 본문 패널의 목록 외 영역을 제외하고, 첫 행의 실제 높이로 표시 개수를 계산한다. 초기 요청 크기는 측정 전 데이터 확보에만 쓰며, 이후에는 랭킹·아카이브 요청 모두 계산된 `page_size`를 사용한다. 발굴 성과 화면은 페이지네이션이 있는 목록이 아니므로 이 계산 대상에 포함하지 않는다.

랭킹 캐시는 쿼리와 페이지 크기를 함께 구분한다. 응답의 페이지 크기가 요청과 다르면 오류를 표시하고, 크기 변경으로 요청 페이지가 범위를 벗어나면 서버가 정규화한 페이지로 주소를 교체한다. 화면·경로·언어·랭킹 뷰가 바뀔 때 측정하며, 응답이 목록 높이를 바꾸는 것만으로 재요청을 반복하지 않는다. 첫 행 기준이므로 설명 길이가 다른 모든 행을 한 화면에 정확히 맞추는 방식은 아니다.

`src/styles.css`의 그리드 stretch와 사이드바 size containment로 필터 목록이 본문 높이를 늘리지 않게 한다. 내부 필터 그룹과 옵션은 flex 공간을 나눠 사용하며 기존 색상·글꼴·테두리와 모바일 전환 기준을 유지한다.

검증은 `src/App.test.tsx`의 공간 계산·페이지 크기별 캐시 테스트, 프로덕션 빌드와 실제 브라우저에서 랭킹·아카이브, 작은 화면·큰 화면, 마지막 페이지·필터 적용을 확인하는 방식이다.

## 모바일 레이아웃

폭 720px 이하(`MOBILE_LAYOUT_QUERY`)에서는 화면 높이 계산을 하지 않고 페이지당 10개를 표시한 뒤 스크롤한다. 주 내비게이션은 화면 아래에 고정된 탭바(랭킹·아카이브·발굴 성과·더보기)가 되고, 언어 전환·테마·오늘 방문수는 상단 헤더와 떠 있는 테마 버튼 대신 더보기 시트에 들어간다.

랭킹 화면은 큰 제목과 마지막 갱신 줄을 숨긴다. 스냅샷 시각 칩과 필터 버튼을 한 줄에 두고, 기록 스크러버는 칩을 눌렀을 때만 펼친다. 랭킹 모델은 가로 탭 대신 네이티브 `select`로 고르고, 출처 설명·결과 개수·평가 시점 문단은 숨긴다. 행은 썸네일 없이 이름(한 줄 말줄임)과 단계 배지, 설명 두 줄, 언어·스타·증가량으로 구성하며 가로 스크롤이 생기지 않아야 한다.

## 헤더

헤더의 검색 버튼 옆에 `https://github.com/Changroro/git-breakout` 링크를 둔다. 데스크톱은 아이콘과 `GitHub` 글자, 720px 이하는 아이콘만 보인다.

오늘 방문수는 Cloudflare `httpRequestsAdaptiveGroups`에서 KST 자정 이후 HTML 요청의 `visits`를 User-Agent별로 받아, `server/cloudflare-traffic.ts`의 `isLikelyHumanUserAgent`가 사람으로 판단한 것만 더한다. 크롤러·스캐너·미리보기 봇, 리눅스 데스크톱 크롬, iOS 13.2.3 고정 UA, 크롬 140 미만을 제외하는 휴리스틱이라 브라우저를 흉내 내는 봇은 남는다. 고유 방문자 수가 아니라 외부 유입 페이지뷰 수다.

## 사이트 푸터

사이트에는 별도의 ‘소스 코드’ 항목을 두지 않는다. 우측 GitHub 링크의 주소와 표시 텍스트는 `https://github.com/Changroro/git-breakout` 저장소를 가리킨다. 후원과 이메일 링크는 유지한다. 이 동작은 `SiteFooter`와 영문·한글 푸터 테스트에서 확인한다.
