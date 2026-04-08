# 채움 G2

저장한 블로그 목록을 Google Search Console 화면 우측 패널에 표시하고, 원하는 속성을 눌러 바로 URL 검사와 색인 생성 요청까지 이어지게 하는 크롬 확장 프로그램입니다.

## 핵심 흐름
- 옵션 페이지에서 블로그 목록 저장
- Search Console 접속 시 우측 패널에서 저장 목록 자동 로드
- 저장한 RSS 주소로 최신 글 목록 불러오기
- 검사할 URL 입력
- 원하는 블로그 속성 클릭
- 해당 속성으로 URL 검사 화면 이동
- 가능하면 색인 생성 요청 버튼까지 자동 클릭

## 저장 형식
- `URL 접두어`: `https://today10gong.tistory.com/`
- `도메인 속성`: `today10gong.tistory.com`
- `RSS 주소`: `https://today10gong.tistory.com/rss`

## 참고
- Search Console UI가 바뀌면 자동 클릭 선택자는 추가 보정이 필요할 수 있습니다.
