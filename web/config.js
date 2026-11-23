/*
 * 주문 페이지 설정. API 주소는 이 파일에만 둔다.
 *
 * API_URL: Apps Script 웹 앱 배포 주소 (https://script.google.com/macros/s/.../exec)
 * MOCK:    true면 web/mock/의 JSON으로 동작하는 가짜 API를 쓴다. 실제 연결 시 false로 바꾼다.
 *
 * 비밀 토큰(DEPOSIT_TOKEN)이나 시트 ID는 여기에 절대 넣지 않는다.
 * 가격·수량·날짜·계좌 같은 운영 값은 여기가 아니라 시트 Config 탭(catalog 응답)에서 온다.
 */
window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbwzq_wLIRRHazflWEm0u3WvLIG3vqiv9N0nURFxpwHqEOeYdxCpK3wGJbwTUAZCO18crA/exec",
  MOCK: false,

  // 화면 꾸밈 (운영 값 아님). 사진은 web/assets/의 같은 이름 파일을 바꾸면 교체된다.
  BRAND: {
    logoSub: "coffee · parfait · cake",
    motto: "A slow, warm moment"
  },
  IMAGES: {
    hero: "assets/hero.webp",       // catalog의 cafe.heroImageUrl이 비어 있을 때
    cake: "assets/cake-1.webp",     // 상품 imageUrl이 비어 있을 때
    story: "assets/lineup.webp"     // 소개 아래 띠 사진 (빈 문자열이면 숨김)
  }
};
