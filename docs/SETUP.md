# 백엔드 설치 안내 (구글 시트 + Apps Script)

이 순서대로 하면 구글 시트와 Apps Script 웹 앱이 준비된다. ✋ 표시는 브라우저에서 직접 해야 하는 단계다.

준비물: 구글 계정, Node.js, 이 폴더.

> **어느 계정으로 하나.** 웹 앱은 "배포한 사람" 권한으로 돌고, 손님 메일도 그 계정에서 나간다. 개발과 테스트는 내 계정으로 하고, 운영 전에 사장님 계정으로 시트를 새로 만들어 같은 순서를 한 번 더 밟는 것을 권한다(12장).

## 1. clasp 설치

```powershell
npm install -g @google/clasp
```

```powershell
clasp --version
```

## 2. ✋ Apps Script API 켜기

1. 브라우저에서 <https://script.google.com/home/usersettings> 를 연다.
2. "Google Apps Script API"를 **사용**으로 바꾼다.

## 3. ✋ 구글 시트와 스크립트 프로젝트 만들기

1. <https://sheets.new> 로 새 시트를 만들고 이름을 `크리스마스 케이크 예약`으로 바꾼다.
2. 주소창의 `https://docs.google.com/spreadsheets/d/` **뒤부터 `/edit` 앞까지**가 시트 ID다. 메모장에 잠깐 복사해 둔다(어디에도 커밋하지 않는다).
3. 시트 메뉴 **확장 프로그램 → Apps Script**를 누른다. 새 스크립트 편집기가 열린다.
4. 편집기 왼쪽 톱니바퀴 **프로젝트 설정**에서 **스크립트 ID**를 복사한다.

## 4. 로컬 폴더와 연결

1. `apps-script/.clasp.json.example`을 복사해 같은 폴더에 `.clasp.json`을 만들고 `scriptId`에 4번에서 복사한 스크립트 ID를 넣는다. (`.clasp.json`은 `.gitignore`에 들어 있다.)

   ```powershell
   Copy-Item apps-script\.clasp.json.example apps-script\.clasp.json
   ```

2. ✋ 로그인. 브라우저가 열리면 구글 계정을 고르고 허용한다.

   ```powershell
   clasp login
   ```

3. 코드 올리기. 편집기에 있던 기본 `Code.gs`는 지워지고 이 폴더의 파일로 바뀐다. `-f`는 `appsscript.json` 덮어쓰기 확인을 건너뛴다.

   ```powershell
   cd apps-script; clasp push -f
   ```

4. 편집기를 새로고침해 `Api`, `Catalog`, `Common`, `Deposits`, `Matching`, `Notify`, `Orders`, `Setup`, `Triggers` 파일이 보이면 된다.

## 5. ✋ Script Properties 설정

편집기 **프로젝트 설정 → 스크립트 속성 → 스크립트 속성 추가**:

| 속성 | 값 |
| --- | --- |
| `SPREADSHEET_ID` | 3장에서 복사한 시트 ID |

`DEPOSIT_TOKEN`은 직접 적지 않고 7장의 함수로 만든다.

## 6. ✋ 시트 초기화 (첫 실행 승인)

1. 편집기에서 `Setup.js`를 열고, 위쪽 함수 선택 칸에서 `setupSheets`를 골라 **실행**한다.
2. 처음 실행하면 권한 요청이 뜬다. **권한 검토 → 계정 선택 → (Google에서 확인하지 않은 앱) 고급 → 프로젝트로 이동(안전하지 않음) → 허용**. 내가 만든 스크립트라 이 경고가 뜨는 것이 정상이다.
3. 실행 로그에 `시트 준비 완료`가 나오면 시트로 가서 확인한다.
   - 탭 `Orders`, `Deposits`, `Products`, `Config`, `픽업보기`가 생겼다.
   - `Orders` 1행 맨 끝 열이 `clientRequestId`다.
   - `Products`에 `P1`(크리스마스 딸기 초코 홀케이크, 가격 임시, 활성)과 `TEST100`(100원 테스트, 비활성)이 있다.
   - `Config`에 키와 임시값이 채워져 있다.

`setupSheets`는 여러 번 실행해도 이미 있는 값은 건드리지 않고 빠진 것만 채운다.

### Config에서 바꿀 값

값은 `Config` 탭 B열을 고치면 바로 반영된다(재배포 필요 없음).

- 카페 정보: `cafeName`, `cafeTagline`, `instagramUrl`, `heroImageUrl`
- 계좌: `bankName`, `accountNumber`, `accountHolder` (페이지에 노출된다)
- 접수 기간: `orderOpenAt`, `orderCloseAt` (`2026-12-01T10:00:00+09:00` 형식)
- 수량 한도: `capacityMode`가 `total`이면 `capacity`는 `{"2026-12-23":10,...}`, `perProduct`면 `{"2026-12-23":{"P1":5,"P2":5},...}`
- `ownerEmail`: 사장님 요약·미매칭 알림을 받을 주소. 비워 두면 스크립트 소유자에게 간다.
- `autoConfirmEnabled`: 입금 알림으로 자동 확정할지. **1원 테스트로 파서를 확인하기 전까지 `FALSE`로 둔다.** `FALSE`면 매칭 후보가 1건이어도 확정하지 않고, Deposits note와 사장님 메일로 후보만 알려 준다.

케이크는 `Products` 탭에서 행을 추가하고 `active` 체크박스를 켠다. `sortOrder` 순으로 보인다.

## 7. 입금 토큰 만들기

1. 편집기에서 `createDepositToken`을 실행한다.
2. 실행 로그에 64자 토큰이 **한 번** 나온다. 아이폰 단축어의 `token` 값에 붙여 넣는다(`docs/SHORTCUT.md`). 메모장·메신저·문서 어디에도 저장하지 않는다.
3. 잃어버렸거나 새어 나갔으면 `rotateDepositToken`으로 새로 만들고 단축어도 바꾼다.

## 8. 트리거 설치

편집기에서 `installTriggers`를 실행한다(추가 권한 요청이 뜨면 6장처럼 허용). 다음이 설치된다.

| 함수 | 언제 | 하는 일 |
| --- | --- | --- |
| `runEvery10Minutes` | 10분마다 | 입금 마감 지난 주문 만료, 만료 30분 전 손님 안내 메일, 입금 알림이 하루 넘게 없으면 사장님 경고 |
| `handleOrdersEdit` | 시트 편집 시 | `Orders` status를 "확정"으로 바꾸면 confirmedAt·confirmedBy를 채우고 손님에게 확정 메일 |
| `sendDailySummary` | 매일 오전 9시 | 입금대기·미매칭·어제 만료 목록과 날짜별 확정 수량을 사장님에게 메일 |

편집기 왼쪽 시계 아이콘(**트리거**)에서 세 개가 보이면 된다. 다시 실행해도 중복으로 쌓이지 않는다.

## 9. 설정 점검

`checkSetup`을 실행하면 시트 ID·토큰·탭·트리거·매칭 모듈이 준비됐는지 로그에 나온다(값 자체는 보여 주지 않는다). `debugCatalog`는 catalog 응답을 로그로 보여 준다.

## 10. ✋ 웹 앱 배포

1. 편집기 오른쪽 위 **배포 → 새 배포**.
2. 톱니바퀴에서 유형 **웹 앱**.
3. 설명: `v1`, 다음 사용자 인증 정보로 실행: **나**, 액세스 권한이 있는 사용자: **모든 사용자**.
4. **배포**를 누르고 권한을 허용한다.
5. 나오는 **웹 앱 URL**(`https://script.google.com/macros/s/.../exec`)을 복사해 관리 세션에 알려 준다. 프론트는 이 주소를 `web/config.js`에만 적는다.

### 코드를 고친 뒤 재배포

`clasp push`만으로는 배포된 웹 앱이 바뀌지 않는다. 주소를 그대로 두고 새 버전으로 바꾸려면:

1. `cd apps-script; clasp push -f`
2. 편집기 **배포 → 배포 관리 → (연필) 수정 → 버전: 새 버전 → 배포**.

"새 배포"를 다시 누르면 주소가 바뀌니 주의한다. Config·Products 값만 바꾼 경우는 재배포가 필요 없다.

## 11. 동작 확인

아래에서 `웹앱주소`는 10장의 `/exec` 주소다.

### catalog (브라우저)

주소창에 `웹앱주소?action=catalog` 를 넣는다. `{"ok":true,"data":{"cafe":...,"products":[...],"availability":{...}}}` 가 보이면 된다. `ownerEmail`, 시트 링크, 토큰이 응답에 없는지도 확인한다.

### 주문 넣기 (PowerShell)

`orderOpenAt`이 미래면 `ORDER_CLOSED`가 나온다. 테스트할 때는 Config의 `orderOpenAt`을 과거로 잠시 바꾼다.

```powershell
$url = "웹앱주소"
$body = @{ action="order"; clientRequestId=[guid]::NewGuid().ToString(); productId="P1"; qty=1; pickupDate="2026-12-24"; pickupTime="14:00"; customerName="테스트"; phone="01012345678"; email=""; depositorName="테스트"; lettering=""; memo=""; agreePrivacy=$true } | ConvertTo-Json
Invoke-RestMethod -Uri $url -Method Post -ContentType "text/plain;charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Depth 5
```

- 응답에 `orderId`(예: `C-1224-A7K2`)와 `depositDeadline`이 온다.
- `Orders` 탭에 `입금대기` 행이 생긴다. 같은 `$body`로 한 번 더 보내면 같은 주문번호가 오고 행이 늘지 않는다.
- 브라우저로 `웹앱주소?action=catalog` 를 다시 열면 그 날짜 `availability`가 줄어 있다.

### 주문 조회 (브라우저)

`웹앱주소?action=status&orderId=C-1224-A7K2&phone4=5678` → 상태가 온다. 뒷 4자리를 틀리면 `NOT_FOUND`.

### 수동 확정

`Orders` 탭에서 그 주문의 status를 드롭다운으로 `확정`으로 바꾼다. 몇 초 뒤 `confirmedAt`, `confirmedBy`가 채워지고, 주문에 이메일이 있으면 확정 메일이 간다. 조회 응답 status도 `확정`이 된다.

### 입금 알림 (PowerShell)

```powershell
$token = Read-Host "DEPOSIT_TOKEN"
$body = @{ action="deposit"; token=$token; title="테스트 알림"; body="테스트님이 38,000원을 입금했어요"; receivedAt=(Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz") } | ConvertTo-Json
Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json" -Body ([Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json
```

- `Deposits` 탭에 원문 행이 생긴다. 파서가 형식을 모르면 `미매칭` + note "알림 해석 실패"로 남고 사장님 메일이 간다.
- 같은 요청을 2분 안에 다시 보내면 `duplicate: true`, status `무시`.
- 토큰을 틀리게 보내면 `UNAUTHORIZED`이고 시트에 아무것도 생기지 않는다.

### 만료

테스트 주문의 `depositDeadline`을 과거 시각(`2026-11-01T00:00:00+09:00`)으로 고치고 10분 안에 status가 `만료`로 바뀌는지 본다. 기다리기 싫으면 편집기에서 `runEvery10Minutes`를 직접 실행한다.

### 테스트 데이터 정리

확인이 끝나면 `Orders`, `Deposits`의 테스트 행을 지우고 Config `orderOpenAt`을 원래 값으로 되돌린다.

## 12. 운영 전 (사장님 계정으로 옮기기)

1. 사장님 구글 계정으로 3~10장을 다시 한다(새 시트, 새 스크립트, 새 토큰, 새 웹 앱 주소). `.clasp.json`의 `scriptId`도 새 것으로 바꾸고 `clasp login`도 사장님 계정으로 한다.
2. Config에 실제 값(계좌, 카페 정보, `ownerEmail`, 수량 한도)을 넣는다.
3. 프론트 `web/config.js`의 주소를 새 웹 앱 주소로 바꾼다.
4. 1원 테스트로 파서가 확인되면 `autoConfirmEnabled`를 `TRUE`로 바꾸고, 원하면 `depositDeadlineHours`를 줄인다.
5. `TEST100` 상품은 끝에서 끝까지 테스트 후 다시 비활성으로 둔다.

## 13. 픽업 이후 개인정보 삭제

환불 문의 기간이 끝나면 편집기에서 `purgePersonalData`를 실행한다. 픽업일이 지난 주문의 이름·전화번호·이메일·입금자명·레터링·요청사항과 Deposits의 알림 원문·입금자명을 지운다. 주문번호·상품·금액·상태는 매출 기록으로 남는다. 되돌릴 수 없으니 필요하면 먼저 시트 사본을 만든다(**파일 → 사본 만들기**).
