# API 계약서

프론트(`web/`), 백엔드(`apps-script/`), 매칭(`apps-script/Matching.js`)이 함께 따르는 약속이다. SPEC.md보다 이 문서가 구체적이면 이 문서를 따른다.

**이 문서는 관리 세션만 고친다.** 바꿔야 할 것이 생기면 직접 고치지 말고, 작업 보고에 "API.md 변경 요청: 무엇을, 왜"를 적는다.

## 1. 공통 규칙

### 호출 방식

- API 주소는 Apps Script 웹 앱 배포 주소 하나다. 프론트는 `web/config.js`에만 적는다.
- GET: `API_URL?action=catalog` 처럼 쿼리스트링으로 보낸다.
- POST: `Content-Type: text/plain;charset=utf-8`, 본문은 JSON 문자열. 브라우저에서 CORS 사전 요청을 피하기 위해서다.
- 단축어가 보내는 POST는 `application/json`이어도 된다. 백엔드는 `e.postData.contents`를 JSON으로 파싱하므로 두 형식을 똑같이 처리한다.
- Apps Script는 항상 HTTP 200을 돌려준다. 성공 여부는 본문의 `ok`로 판단한다.

### 응답 형식

성공:

```json
{ "ok": true, "data": { } }
```

실패:

```json
{ "ok": false, "error": { "code": "SOLD_OUT", "message": "선택한 날짜의 케이크가 마감되었어요.", "field": "pickupDate" } }
```

- `message`는 손님에게 그대로 보여 줄 수 있는 한국어 문장이다.
- `field`는 입력 오류일 때만 있다. 프론트는 이 값으로 해당 입력란에 오류를 표시한다.

| code | 뜻 |
| --- | --- |
| INVALID_INPUT | 입력값 오류. `field` 포함 |
| ORDER_CLOSED | 주문 접수 기간이 아님 |
| SOLD_OUT | 선택한 날짜·케이크의 남은 수량 부족 |
| TOO_MANY_PENDING | 같은 전화번호의 입금대기 주문이 이미 3건 |
| NOT_FOUND | 주문번호와 전화 뒷 4자리가 맞는 주문 없음 |
| UNAUTHORIZED | deposit 토큰 불일치 |
| BUSY | 잠금 대기 시간 초과. 잠시 후 다시 시도 |
| INTERNAL | 그 밖의 서버 오류 |

### 값 형식

- 시간대는 모두 한국 시간이다. `appsscript.json`의 `timeZone`은 `Asia/Seoul`.
- 날짜: `"2026-12-24"`. 시각: `"14:00"`. 일시: `"2026-12-24T14:00:00+09:00"`(ISO 8601, +09:00 고정).
- 금액: 원 단위 정수. 예: `38000`.
- 전화번호: 숫자만. `"01012345678"`. 프론트는 하이픈을 넣어 보여 줘도 되지만 보낼 때는 숫자만 보낸다.
- 주문 상태: `"입금대기"`, `"확정"`, `"만료"`, `"취소"`, `"픽업완료"` (시트에 적힌 한국어 그대로)
- 입금 상태: `"매칭완료"`, `"미매칭"`, `"무시"`

## 2. GET ?action=catalog

주문 페이지를 그리는 데 필요한 모든 값을 한 번에 준다. 다른 고객의 정보는 담지 않는다.

```json
{
  "ok": true,
  "data": {
    "cafe": {
      "name": "카페 이름",
      "tagline": "크리스마스 홀케이크 예약",
      "instagramUrl": "https://instagram.com/...",
      "heroImageUrl": ""
    },
    "products": [
      {
        "productId": "P1",
        "name": "딸기 생크림 케이크",
        "price": 38000,
        "description": "2호 · 지름 18cm",
        "imageUrl": ""
      }
    ],
    "pickupDates": ["2026-12-23", "2026-12-24", "2026-12-25"],
    "pickupTimes": ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"],
    "availability": {
      "2026-12-23": { "P1": 5, "P2": 0 },
      "2026-12-24": { "P1": 2, "P2": 3 },
      "2026-12-25": { "P1": 0, "P2": 0 }
    },
    "maxQtyPerOrder": 2,
    "lettering": { "enabled": true, "maxLength": 20 },
    "account": { "bankName": "토스뱅크", "accountNumber": "1000-0000-0000", "accountHolder": "홍길동" },
    "order": {
      "isOpen": true,
      "openAt": "2026-12-01T10:00:00+09:00",
      "closeAt": "2026-12-21T23:59:00+09:00",
      "depositDeadlineHours": 24
    },
    "business": {
      "name": "상호",
      "owner": "대표자",
      "regNo": "000-00-00000",
      "address": "주소",
      "phone": "010-0000-0000"
    },
    "policies": {
      "refund": "환불·변경 규정 문구",
      "privacy": "수집 항목: 이름, 전화번호, 이메일(선택) / 목적: 예약 확인과 픽업 안내 / 보관: 픽업 종료 후 환불 문의 기간까지"
    }
  }
}
```

- `availability[날짜][productId]`는 그 날짜에 그 케이크를 더 주문할 수 있는 최대 개수다. 한도가 날짜 합계 방식이든 케이크별 방식이든 백엔드가 계산해서 이 모양으로 준다. 프론트는 방식을 몰라도 된다.
- 프론트 표시 규칙: 0이면 "마감"으로 선택 불가, 1~3이면 "N개 남음". 한 날짜의 모든 케이크가 0이면 그 날짜 전체를 "마감"으로 표시한다.
- `products`는 `active`가 참인 것만 `sortOrder` 순으로 준다.
- `imageUrl`, `heroImageUrl`이 빈 문자열이면 프론트는 사진 자리만 그린다.
- 사장님 이메일, 시트 링크, 토큰은 절대 담지 않는다.

## 3. POST action=order

요청:

```json
{
  "action": "order",
  "clientRequestId": "b3f1c2d4-....",
  "productId": "P1",
  "qty": 1,
  "pickupDate": "2026-12-24",
  "pickupTime": "14:00",
  "customerName": "김민지",
  "phone": "01012345678",
  "email": "",
  "depositorName": "김민지",
  "lettering": "",
  "memo": "",
  "agreePrivacy": true
}
```

- 주문서 화면 구성(2026-11-23 사장님 요청): 손님에게 보이는 필수 항목은 픽업 날짜, 픽업 시간, 성함, 연락처, 케이크 개수 다섯 가지와 개인정보 동의뿐이다. 날짜와 시간은 달력·시간표 형태로 고른다. 케이크가 1종이면 케이크 선택 단계를 보여 주지 않고 `productId`를 자동으로 넣는다. `depositorName`은 성함과 같게 보내되 "입금자명이 다른가요?"를 펼치면 고칠 수 있게 한다. `email`, `memo`는 화면에서 빼고 빈 문자열로 보낸다. `lettering`은 `lettering.enabled`가 참일 때만 보인다. 요청 JSON의 모양은 그대로다.
- `clientRequestId`: 프론트가 주문서를 열 때 한 번 만드는 무작위 문자열(`crypto.randomUUID()`, 없으면 대체 생성). 같은 값으로 두 번 들어오면 백엔드는 새 주문을 만들지 않고 처음 만든 주문을 그대로 돌려준다. 네트워크가 끊겨 재시도해도 주문이 둘이 되지 않게 하기 위해서다.
- 금액은 보내지 않는다. 백엔드가 Products의 가격 × qty로 계산한다.

백엔드 검증 (실패 시 INVALID_INPUT + field):

| field | 규칙 |
| --- | --- |
| productId | active 상품 |
| qty | 1 이상 `maxQtyPerOrder` 이하 정수 |
| pickupDate | `pickupDates` 중 하나 |
| pickupTime | `pickupTimes` 중 하나 |
| customerName | 공백 제거 후 1~20자 |
| phone | `^01[016789]\d{7,8}$` |
| email | 비어 있거나 이메일 형식 |
| depositorName | 공백 제거 후 1~20자 |
| lettering | lettering.enabled일 때만, maxLength 이하 |
| memo | 200자 이하 |
| agreePrivacy | true |

검증을 통과하면 `LockService.getScriptLock()` 안에서 접수 기간 → 같은 전화번호 입금대기 3건 → 남은 수량 순으로 확인하고 기록한다.

성공 응답:

```json
{
  "ok": true,
  "data": {
    "orderId": "C-1224-A7K2",
    "status": "입금대기",
    "productName": "딸기 생크림 케이크",
    "qty": 1,
    "amount": 38000,
    "pickupDate": "2026-12-24",
    "pickupTime": "14:00",
    "depositorName": "김민지",
    "depositDeadline": "2026-12-20T15:30:00+09:00",
    "account": { "bankName": "토스뱅크", "accountNumber": "1000-0000-0000", "accountHolder": "홍길동" }
  }
}
```

- 주문번호: `C-` + 픽업일 `MMDD` + `-` + 4자. 4자는 헷갈리는 글자(0, O, 1, I, L)를 뺀 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`에서 고른다. 시트에 이미 있으면 다시 뽑는다.
- 입금 마감: 주문 시각 + `depositDeadlineHours`. 단, 픽업일 전날 23:59를 넘지 않는다.

## 4. GET ?action=status&orderId=...&phone4=...

주문번호와 전화번호 뒷 4자리가 둘 다 맞을 때만 응답한다. 하나라도 틀리면 NOT_FOUND이며, 어느 쪽이 틀렸는지 알려 주지 않는다.

```json
{
  "ok": true,
  "data": {
    "orderId": "C-1224-A7K2",
    "status": "입금대기",
    "productName": "딸기 생크림 케이크",
    "qty": 1,
    "amount": 38000,
    "pickupDate": "2026-12-24",
    "pickupTime": "14:00",
    "depositDeadline": "2026-12-20T15:30:00+09:00",
    "account": { "bankName": "토스뱅크", "accountNumber": "1000-0000-0000", "accountHolder": "홍길동" }
  }
}
```

- 이름, 전체 전화번호, 이메일, 입금자명은 담지 않는다. 입금자명은 프론트가 주문 직후 브라우저 `localStorage`에 저장해 두고 보여 준다.
- `account`는 status가 `입금대기`일 때만 담는다.
- 프론트는 입금 안내 화면에서 5초마다 이 요청을 보낸다. 화면이 다시 보일 때(`visibilitychange`)는 바로 한 번 보낸다. status가 `입금대기`가 아니면 조회를 멈춘다.
- 주소 형식: `web/index.html#order=C-1224-A7K2` . 전화 뒷 4자리는 주소에 넣지 않고 `localStorage`에 둔다. 다른 기기에서 열면 뒷 4자리를 다시 묻는다.

## 5. POST action=deposit

아이폰 단축어가 보낸다. 자동 확정은 1원 테스트 이후에 붙이므로, 1차 구현은 "기록 + 매칭 함수 호출"까지 만들어 두고 실제 알림 샘플이 들어오면 파서만 채운다.

요청:

```json
{
  "action": "deposit",
  "token": "Script Properties의 DEPOSIT_TOKEN과 같은 값",
  "title": "알림 제목",
  "body": "알림 메시지",
  "receivedAt": "2026-12-20T14:02:11+09:00"
}
```

- `receivedAt`은 단축어의 날짜 형식이 제각각일 수 있으니 파싱에 실패하면 서버 수신 시각을 쓴다.
- 토큰이 틀리면 UNAUTHORIZED를 돌려주고 시트에 아무것도 쓰지 않는다.

성공 응답:

```json
{ "ok": true, "data": { "depositId": "D-20261220-0007", "status": "매칭완료", "matchedOrderId": "C-1224-A7K2", "duplicate": false } }
```

## 6. 매칭 모듈 함수 (apps-script/Matching.js)

시트를 모르는 순수 함수다. Apps Script에서는 전역 함수로, Node 테스트에서는 `require('../apps-script/Matching.js')`로 쓴다. 파일 끝에 다음을 둔다.

```js
if (typeof module !== 'undefined') {
  module.exports = { parseNotification, normalizeName, namesMatch, matchDeposit, isDuplicateNotification };
}
```

| 함수 | 입력 | 출력 |
| --- | --- | --- |
| `parseNotification(title, body)` | 문자열 2개 | `{ kind: "deposit" \| "ignore" \| "unknown", name: string\|null, amount: number\|null, pattern: string\|null }` |
| `normalizeName(s)` | 문자열 | 공백·괄호와 괄호 안 문자를 지운 문자열 |
| `namesMatch(a, b)` | 문자열 2개 | 정규화 후 같거나 한쪽이 다른 쪽의 앞부분이면 true. 빈 문자열은 false |
| `matchDeposit(parsed, orders)` | parseNotification 결과, `[{ orderId, status, amount, depositorName }]` | `{ result: "matched" \| "none" \| "ambiguous" \| "expiredMatch" \| "notDeposit", orderId: string\|null, candidates: string[] }` |
| `isDuplicateNotification(dep, recent, windowMs)` | `{ title, body, receivedAtMs }`, 같은 모양의 배열, 기본 120000 | true/false |

- `kind`가 deposit이 아니면 `matchDeposit`은 `notDeposit`.
- 금액이 같고 이름이 맞는 `입금대기` 주문이 1건 → `matched`. 0건이면, 같은 조건의 `만료` 주문이 있으면 `expiredMatch`, 없으면 `none`. 2건 이상 → `ambiguous`(candidates에 주문번호).
- 이름을 뽑지 못하고 금액만 있으면(`name: null`) 자동 확정하지 않고 `none` 또는 `ambiguous`로 처리한다. 금액만으로 확정할지는 1원 테스트 결과를 보고 관리 세션이 정한다.

백엔드의 deposit 처리: `matched` → 주문 확정 + Deposits `매칭완료`, `notDeposit` → `무시`, 나머지 → `미매칭` + note(후보 주문번호, "만료 주문과 일치" 등) + 사장님 메일.

## 7. 시트 열

SPEC.md 4.1의 열에 다음 하나를 Orders 맨 끝에 더한다.

- `clientRequestId`: 3장의 중복 제출 방지용

Config 탭 키 (백엔드가 시트 초기화 함수로 임시값을 채운다):

| key | 임시값 | 설명 |
| --- | --- | --- |
| cafeName | Nez | 네즈 (성산동·망원동) |
| cafeTagline | 크리스마스 홀케이크 예약 | |
| instagramUrl | https://www.instagram.com/nez.parfait/ | |
| heroImageUrl | (빈 값) | |
| bankName | 토스뱅크 | |
| accountNumber | 0000-0000-0000 | |
| accountHolder | 예금주 | |
| orderOpenAt | 2026-12-01T10:00:00+09:00 | |
| orderCloseAt | 2026-12-21T23:59:00+09:00 | |
| depositDeadlineHours | 24 | 수동 확정 기준의 넉넉한 값. 자동 확정 후 3으로 줄일 수 있음 |
| pickupDates | 2026-12-23,2026-12-24,2026-12-25 | 쉼표 구분 |
| pickupTimes | 12:00,12:30,13:00,13:30,14:00,14:30,15:00,15:30,16:00,16:30,17:00,17:30,18:00,18:30,19:00,19:30,20:00 | 쉼표 구분. 사장님 요청: 12:00~20:00, 30분 단위는 임시 |
| capacityMode | total | `total`(날짜별 합계) 또는 `perProduct`(케이크별) |
| capacity | {"2026-12-23":10,"2026-12-24":10,"2026-12-25":10} | perProduct면 {"2026-12-23":{"P1":5,"P2":5}} |
| maxQtyPerOrder | 2 | |
| maxPendingPerPhone | 3 | |
| letteringEnabled | FALSE | 사장님이 요청한 항목에 없어 기본은 끔 |
| letteringMaxLength | 20 | |
| bizName, bizOwner, bizRegNo, bizAddress, bizPhone | (빈 값) | 페이지 하단 |
| refundPolicy | 픽업 3일 전까지 전액 환불, 이후 환불 불가 (임시) | |
| privacyNotice | (2장 policies.privacy 문구) | |
| ownerEmail | (빈 값) | 응답에 절대 넣지 않음 |

Script Properties (코드와 문서에 값을 적지 않는다): `SPREADSHEET_ID`, `DEPOSIT_TOKEN`
