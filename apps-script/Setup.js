/**
 * Apps Script 편집기에서 직접 실행하는 관리 함수.
 *  - setupSheets()        : 탭·헤더·Config 임시값·테스트 상품·픽업보기 탭 만들기 (여러 번 실행해도 안전)
 *  - createDepositToken() : DEPOSIT_TOKEN을 만들어 Script Properties에 저장하고 로그에 한 번 보여 줌
 *  - rotateDepositToken() : 토큰을 새로 바꿈(단축어도 같이 바꿔야 함)
 *  - checkSetup()         : 설정 상태 점검(값은 보여 주지 않음)
 *  - purgePersonalData()  : 픽업이 끝난 주문의 개인정보 열 지우기
 *  - installTriggers()    : Triggers.js
 */

var CONFIG_DEFAULTS = [
  ['cafeName', 'Nez'],
  ['cafeTagline', '크리스마스 홀케이크 예약'],
  ['instagramUrl', 'https://www.instagram.com/nez.parfait/'],
  ['heroImageUrl', ''],
  ['bankName', '토스뱅크'],
  ['accountNumber', '0000-0000-0000'],
  ['accountHolder', '예금주'],
  ['orderOpenAt', '2026-12-01T10:00:00+09:00'],
  ['orderCloseAt', '2026-12-21T23:59:00+09:00'],
  ['depositDeadlineHours', '24'],
  ['pickupDates', '2026-12-23,2026-12-24,2026-12-25'],
  ['pickupTimes', '12:00,12:30,13:00,13:30,14:00,14:30,15:00,15:30,16:00,16:30,17:00,17:30,18:00,18:30,19:00,19:30,20:00'],
  ['capacityMode', 'total'],
  ['capacity', '{"2026-12-23":10,"2026-12-24":10,"2026-12-25":10}'],
  ['maxQtyPerOrder', '2'],
  ['maxPendingPerPhone', '3'],
  ['letteringEnabled', 'FALSE'],
  ['letteringMaxLength', '20'],
  ['bizName', ''],
  ['bizOwner', ''],
  ['bizRegNo', ''],
  ['bizAddress', ''],
  ['bizPhone', ''],
  ['refundPolicy', '픽업 3일 전까지 전액 환불, 이후 환불 불가 (임시)'],
  ['privacyNotice', '수집 항목: 이름, 전화번호, 이메일(선택) / 목적: 예약 확인과 픽업 안내 / 보관: 픽업 종료 후 환불 문의 기간까지'],
  ['ownerEmail', ''],
  ['autoConfirmEnabled', 'FALSE']
];

var TEST_PRODUCTS = [
  // productId, name, price, description, imageUrl, active, sortOrder
  ['P1', '크리스마스 딸기 초코 홀케이크', 38000, '가격·사이즈 임시', '', true, 1],
  ['TEST100', '100원 테스트 상품', 100, '끝에서 끝까지 테스트용. 운영 전 비활성으로 둘 것', '', false, 99]
];

/**
 * 처음 한 번 편집기에서 실행하는 "한 번에 설치" 함수.
 * 시트에 붙어 있는(확장 프로그램 → Apps Script로 연) 스크립트라면 SPREADSHEET_ID를 직접 적지 않아도
 * 지금 시트의 ID를 Script Properties에 저장한다(코드에는 ID가 남지 않는다).
 * 이어서 시트 초기화, 입금 토큰 생성(없을 때만), 트리거 설치, 점검까지 한다. 여러 번 실행해도 안전하다.
 */
function firstTimeSetup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SPREADSHEET_ID')) {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) throw new Error('시트에 붙은 스크립트가 아닙니다. 프로젝트 설정 → 스크립트 속성에 SPREADSHEET_ID를 직접 넣어 주세요.');
    props.setProperty('SPREADSHEET_ID', active.getId());
    console.log('SPREADSHEET_ID를 지금 시트로 저장했습니다.');
  }
  setupSheets();
  createDepositToken();
  installTriggers();
  checkSetup();
}

/** 이미 있는 탭·값은 건드리지 않고 빠진 것만 채운다. */
function setupSheets() {
  var ss = getSpreadsheet_();
  ss.setSpreadsheetTimeZone(TZ);

  // Orders: 숫자 열(qty, amount)을 뺀 나머지는 일반 텍스트 서식(날짜·전화번호 자동 변환 방지)
  var orders = ensureSheet_(ss, SHEET.ORDERS, HEADERS.Orders);
  setTextColumns_(orders, HEADERS.Orders, ['qty', 'amount']);
  var statusCol = HEADERS.Orders.indexOf('status') + 1;
  orders.getRange(2, statusCol, orders.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['입금대기', '확정', '만료', '취소', '픽업완료'], true)
      .setAllowInvalid(false).build());

  var deposits = ensureSheet_(ss, SHEET.DEPOSITS, HEADERS.Deposits);
  setTextColumns_(deposits, HEADERS.Deposits, ['parsedAmount']);
  var depStatusCol = HEADERS.Deposits.indexOf('status') + 1;
  deposits.getRange(2, depStatusCol, deposits.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['매칭완료', '미매칭', '무시'], true)
      .setAllowInvalid(false).build());

  var products = ensureSheet_(ss, SHEET.PRODUCTS, HEADERS.Products);
  setTextColumns_(products, HEADERS.Products, ['price', 'active', 'sortOrder']);
  if (products.getLastRow() < 2) {
    products.getRange(2, 1, TEST_PRODUCTS.length, TEST_PRODUCTS[0].length).setValues(TEST_PRODUCTS);
  }
  // 빈 행 전체에 체크박스를 넣으면 빈 행이 FALSE 값으로 읽히므로 상품 행 + 여유 20행만.
  products.getRange(2, HEADERS.Products.indexOf('active') + 1, Math.max(products.getLastRow() - 1, 1) + 20, 1).insertCheckboxes();

  var config = ensureSheet_(ss, SHEET.CONFIG, HEADERS.Config);
  config.getRange('A:B').setNumberFormat('@');
  var existing = {};
  if (config.getLastRow() >= 2) {
    config.getRange(2, 1, config.getLastRow() - 1, 1).getValues().forEach(function (r) { existing[String(r[0]).trim()] = true; });
  }
  var missing = CONFIG_DEFAULTS.filter(function (kv) { return !existing[kv[0]]; });
  if (missing.length) {
    config.getRange(config.getLastRow() + 1, 1, missing.length, 2).setValues(missing);
  }
  config.setColumnWidth(1, 180);
  config.setColumnWidth(2, 520);

  setupPickupView_(ss);
  removeBlankDefaultSheet_(ss);

  SpreadsheetApp.flush();
  console.log('시트 준비 완료. Config 탭의 값을 실제 카페 값으로 바꾸세요. 추가된 Config 키: ' +
    (missing.length ? missing.map(function (kv) { return kv[0]; }).join(', ') : '없음'));
}

function ensureSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var cur = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  if (cur.every(function (h) { return h === ''; })) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  } else {
    // 이미 헤더가 있으면 빠진 열만 맨 끝에 붙인다(예: clientRequestId).
    var add = header.filter(function (h) { return cur.indexOf(h) < 0; });
    if (add.length) sh.getRange(1, cur.length + 1, 1, add.length).setValues([add]);
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#f3efe9');
  return sh;
}

function setTextColumns_(sh, header, exceptKeys) {
  var cur = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  header.forEach(function (h) {
    if (exceptKeys.indexOf(h) >= 0) return;
    var c = cur.indexOf(h) + 1;
    if (c > 0) sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
  });
}

/** 픽업 당일 보기용 탭: B1에서 날짜를 고르면 그 날짜의 확정·픽업완료 주문이 시간순으로 나온다. */
function setupPickupView_(ss) {
  var sh = ss.getSheetByName(SHEET.PICKUP_VIEW);
  if (sh) return;
  sh = ss.insertSheet(SHEET.PICKUP_VIEW);
  var cfg = getConfig_();
  var dates = cfg.pickupDates.length ? cfg.pickupDates : ['2026-12-23', '2026-12-24', '2026-12-25'];

  // Orders 열 위치를 헤더에서 찾아 QUERY 열 문자로 바꾼다.
  var header = ss.getSheetByName(SHEET.ORDERS).getRange(1, 1, 1, ss.getSheetByName(SHEET.ORDERS).getLastColumn())
    .getValues()[0].map(function (h) { return String(h).trim(); });
  var L = function (key) { return columnLetter_(header.indexOf(key) + 1); };
  var lastLetter = columnLetter_(header.length);

  sh.getRange('A1').setValue('픽업일 선택 →').setFontWeight('bold');
  sh.getRange('B1').setNumberFormat('@').setValue(dates[0]).setBackground('#fff4c2').setFontWeight('bold')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(dates, true).build());
  sh.getRange('D1').setValue('확정 수량 합계');
  sh.getRange('E1').setFormula(
    '=IFERROR(SUM(QUERY(Orders!A2:' + lastLetter + ',"select ' + L('qty') + ' where ' + L('pickupDate') + " = '\"&TEXT(B1,\"yyyy-mm-dd\")&\"' and (" +
    L('status') + " = '확정' or " + L('status') + " = '픽업완료')\",0)),0)");

  var select = ['pickupTime', 'status', 'orderId', 'productName', 'qty', 'customerName', 'phone', 'lettering', 'memo']
    .map(L).join(', ');
  sh.getRange('A3').setFormula(
    '=IFERROR(QUERY(Orders!A1:' + lastLetter + ',"select ' + select + ' where ' + L('pickupDate') + " = '\"&TEXT(B1,\"yyyy-mm-dd\")&\"' and (" +
    L('status') + " = '확정' or " + L('status') + " = '픽업완료') order by " + L('pickupTime') + ', ' + L('orderId') +
    '",1),"이 날짜의 확정 주문이 아직 없어요")');
  sh.setFrozenRows(3);
}

function columnLetter_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 새 시트에 기본으로 있는 빈 "시트1"/"Sheet1"을 지운다. 내용이 있으면 그대로 둔다. */
function removeBlankDefaultSheet_(ss) {
  ['시트1', 'Sheet1'].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() === 0 && sh.getLastColumn() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

// ---------- 토큰 ----------

/** DEPOSIT_TOKEN이 없을 때만 만든다. 값은 실행 로그에 이번 한 번만 보인다. */
function createDepositToken() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('DEPOSIT_TOKEN')) {
    console.log('DEPOSIT_TOKEN이 이미 있습니다. 바꾸려면 rotateDepositToken()을 실행하세요(단축어도 같이 바꿔야 합니다).');
    return;
  }
  issueDepositToken_(props);
}

function rotateDepositToken() {
  issueDepositToken_(PropertiesService.getScriptProperties());
}

function issueDepositToken_(props) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('DEPOSIT_TOKEN', token);
  console.log('새 DEPOSIT_TOKEN (아이폰 단축어의 token 값에 붙여 넣고, 이 로그는 다른 곳에 저장하지 마세요):\n' + token);
}

// ---------- 점검 ----------

/** 값은 보여 주지 않고 무엇이 준비되었는지만 로그에 남긴다. */
function checkSetup() {
  var props = PropertiesService.getScriptProperties();
  var lines = [];
  var sid = props.getProperty('SPREADSHEET_ID');
  lines.push('SPREADSHEET_ID: ' + (sid ? '설정됨' : '없음'));
  var tok = props.getProperty('DEPOSIT_TOKEN');
  lines.push('DEPOSIT_TOKEN: ' + (tok ? '설정됨(' + tok.length + '자)' : '없음'));
  if (sid) {
    var ss = getSpreadsheet_();
    [SHEET.ORDERS, SHEET.DEPOSITS, SHEET.PRODUCTS, SHEET.CONFIG, SHEET.PICKUP_VIEW].forEach(function (n) {
      lines.push('탭 ' + n + ': ' + (ss.getSheetByName(n) ? '있음' : '없음'));
    });
    if (ss.getSheetByName(SHEET.CONFIG)) {
      var cfg = getConfig_();
      lines.push('활성 상품: ' + getActiveProducts_().map(function (p) { return p.productId; }).join(', '));
      lines.push('주문 접수 중: ' + isOrderOpen_(cfg, new Date()));
      lines.push('자동 확정: ' + (cfg.autoConfirmEnabled ? '켜짐' : '꺼짐'));
      lines.push('사장님 메일: ' + (cfg.ownerEmail ? 'Config에 있음' : '비어 있음(스크립트 소유자에게 보냄)'));
    }
  }
  lines.push('매칭 모듈: ' + (matchingModuleReady_() ? '있음' : '없음'));
  lines.push('트리거: ' + ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join(', '));
  lines.push('메일 남은 한도: ' + MailApp.getRemainingDailyQuota());
  console.log(lines.join('\n'));
}

/** 편집기에서 catalog 응답을 미리 보기. */
function debugCatalog() {
  console.log(JSON.stringify(getCatalog_(), null, 2));
}

// ---------- 개인정보 ----------

var PERSONAL_ORDER_COLUMNS = ['customerName', 'phone', 'email', 'depositorName', 'lettering', 'memo'];
var PERSONAL_DEPOSIT_COLUMNS = ['rawTitle', 'rawBody', 'parsedName'];

/**
 * 픽업일이 PURGE_AFTER_DAYS일 넘게 지난 주문의 개인정보 열을 지운다.
 * 주문번호·상품·금액·상태는 매출 기록으로 남긴다. Deposits의 원문과 입금자명도 같은 기준으로 지운다.
 * 보관 기간(환불 문의 기간)이 끝난 뒤 편집기에서 직접 실행한다.
 */
var PURGE_AFTER_DAYS = 0;

function purgePersonalData() {
  var cutoff = ymd_(new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 3600 * 1000));
  var cleared = withLock_(function () {
    var t = readTable_(SHEET.ORDERS);
    var n = 0;
    var purgedOrderIds = {};
    t.rows.forEach(function (r) {
      var d = cellStr_(r.pickupDate);
      if (!d || d >= cutoff) return;
      PERSONAL_ORDER_COLUMNS.forEach(function (k) { if (t.col[k]) t.sheet.getRange(r._row, t.col[k]).clearContent(); });
      purgedOrderIds[cellStr_(r.orderId)] = true;
      n++;
    });

    var dt = readTable_(SHEET.DEPOSITS);
    var dn = 0;
    dt.rows.forEach(function (r) {
      var rec = parseDate_(r.receivedAt);
      var old = rec && ymd_(rec) < cutoff;
      if (!old && !purgedOrderIds[cellStr_(r.matchedOrderId)]) return;
      PERSONAL_DEPOSIT_COLUMNS.forEach(function (k) { if (dt.col[k]) dt.sheet.getRange(r._row, dt.col[k]).clearContent(); });
      dn++;
    });
    return { orders: n, deposits: dn };
  }, 30000);
  PropertiesService.getScriptProperties().deleteProperty('REMINDED_ORDER_IDS');
  console.log('개인정보 삭제: 주문 ' + cleared.orders + '건, 입금 알림 ' + cleared.deposits + '건 (기준: 픽업일 ' + cutoff + ' 이전)');
}
