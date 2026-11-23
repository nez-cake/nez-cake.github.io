/**
 * Apps Script 편집기나 시트 메뉴에서 실행하는 관리 함수.
 *  - firstTimeSetup()      : 처음 한 번. 시트 연결, 시트 정리, 입금 토큰, 트리거, 점검
 *  - setupSheets()         : 탭·머리글·설정·사용법·픽업 명단 만들기. 예전 영어 모양 시트도 새 모양으로 옮긴다.
 *                            여러 번 실행해도 값은 그대로 둔다.
 *  - createDepositToken()  : 입금 토큰을 만들어 Script Properties에 저장하고 로그에 한 번 보여 줌
 *  - rotateDepositToken()  : 토큰을 새로 바꿈(단축어도 같이 바꿔야 함)
 *  - checkSetup()          : 설정 점검 결과를 로그로
 *  - purgePersonalData()   : 픽업이 끝난 주문의 개인정보 지우기
 *  - installTriggers()     : Triggers.js
 */

var PROTECT_PREFIX = '예약시스템: ';

/**
 * 설정 탭 항목: [내부 키, 항목(한글), 임시값, 설명, 종류]
 * 종류: text(글자), num(숫자), datetime(날짜와 시각), time(시각), check(체크박스)
 * '{capacity}' 자리에는 픽업 날짜마다 "12월 23일 수량" 줄이 들어간다.
 */
var CONFIG_ITEMS = [
  ['orderEnabled', '주문 받기', true, '체크하면 주문을 받고, 끄면 바로 멈춰요. 메뉴 [예약 관리 → 주문 받기 시작 / 중지]로도 바꿀 수 있어요.', 'check'],
  ['orderOpenAt', '주문 받기 시작', '2026-12-01 10:00', '이 시각부터 주문을 받아요. 예: 2026-12-01 10:00', 'datetime'],
  ['orderCloseAt', '주문 마감', '2026-12-21 23:59', '이 시각까지 주문을 받아요. 예: 2026-12-21 23:59', 'datetime'],
  ['depositDeadlineHours', '입금 기한(시간)', 24, '주문 후 몇 시간 안에 입금해야 하는지. 지나면 주문이 자동으로 "만료"돼요. 숫자만 적어요.', 'num'],
  ['pickupDates', '픽업 날짜', '2026-12-23, 2026-12-24, 2026-12-25', '쉼표로 구분해요. 바꾼 뒤에는 메뉴 [예약 관리 → 설정 점검]을 눌러 주세요(날짜별 수량 줄이 생겨요).', 'text'],
  ['{capacity}'],
  ['pickupStart', '픽업 시작 시각', '12:00', '손님이 고를 수 있는 가장 이른 시각. 예: 12:00', 'time'],
  ['pickupEnd', '픽업 끝 시각', '20:00', '가장 늦은 시각. 예: 20:00', 'time'],
  ['pickupInterval', '픽업 시간 간격(분)', 30, '30이면 12:00, 12:30, 13:00 … 처럼 나와요.', 'num'],
  ['maxQtyPerOrder', '한 번에 주문할 수 있는 개수', 2, '숫자만 적어요.', 'num'],
  ['maxPendingPerPhone', '같은 번호로 입금대기 최대', 3, '장난 주문을 막는 숫자예요. 보통 그대로 두세요.', 'num'],
  ['bankName', '은행', '토스뱅크', '주문 페이지와 손님 메일에 그대로 나와요.', 'text'],
  ['accountNumber', '계좌번호', '0000-0000-0000', '하이픈(-)을 넣어 적어도 돼요. 주문 페이지에 그대로 나와요.', 'text'],
  ['accountHolder', '예금주', '예금주', '통장에 적힌 이름 그대로.', 'text'],
  ['ownerEmail', '사장님 이메일', '', '매일 아침 요약과 확인할 입금 알림을 받을 주소. 비우면 이 시트 주인 계정으로 가요. 손님에게는 안 보여요.', 'text'],
  ['cafeName', '카페 이름', 'Nez', '주문 페이지 맨 위와 메일 제목에 나와요.', 'text'],
  ['cafeTagline', '소개 문구', '예약은 선착순으로 확정되며,준비된 수량이 모두 예약되면 마감됩니다.', '주문 페이지 카페 이름 아래 소개 문단으로 나와요.', 'text'],
  ['notice1', '안내 문구 1', '📍픽업 가능한 시간대 12:00pm~20:00pm', '주문 페이지와 확정 메일에 안내 1개로 나와요. 칸 안에서 줄을 바꾸려면 Ctrl+Enter(맥은 ⌘+Enter). 비워 두면 안 나와요.', 'multiline'],
  ['notice2', '안내 문구 2', '📍케이크 픽업 후 수평 수직을 맞추어 들어주세요\n생크림 케이크는 이틀 안으로 드시는 걸 권장합니다 꼭 냉장 보관 하시고 차가운 상태에서 드셔주세요😊', '안내 문구 1과 같아요.', 'multiline'],
  ['notice3', '안내 문구 3', '📍주문 제작 케이크는 이틀 전 부터 밑작업 준비 및 재료 준비를 해두기 때문에 노쇼 방지를 위해 계좌이체로 선결제받고 있어요\n2일 전 주문 취소 시 100%환불해드리고 있어요\n픽업 하루 전 취소 시 케이크 작업이 시작되기 때문에 전액 환불 안 되는 점 너른 양해 부탁드리겠습니다😊', '안내 문구 1과 같아요.', 'multiline'],
  ['notice4', '안내 문구 4', '📍케이크 나이프,성냥,실버 롱스틱 초1개 기본 구성입니다', '안내 문구 1과 같아요.', 'multiline'],
  ['instagramUrl', '인스타그램 주소', 'https://www.instagram.com/nez.parfait/', '', 'text'],
  ['heroImageUrl', '대표 사진 주소', '', '사진의 인터넷 주소. 없으면 비워 두세요.', 'text'],
  ['letteringEnabled', '레터링 받기', false, '체크하면 주문서에 레터링 문구 칸이 생겨요.', 'check'],
  ['letteringMaxLength', '레터링 최대 글자 수', 20, '숫자만 적어요.', 'num'],
  ['bizName', '상호', '네즈', '주문 페이지 맨 아래에 나와요.', 'text'],
  ['bizOwner', '대표자', '홍경빈', '주문 페이지 맨 아래에 나와요.', 'text'],
  ['bizRegNo', '사업자등록번호', '698-20-01880', '예: 123-45-67890', 'text'],
  ['bizAddress', '가게 주소', '마포구 성미산로 29-1 1층 카페 네즈', '주문 페이지 맨 아래에 나와요.', 'text'],
  ['bizPhone', '가게 연락처', '010-4566-0446', '주문 페이지 맨 아래와 손님 메일에 나와요. 예: 010-1234-5678', 'text'],
  ['refundPolicy', '환불 규정', '주문 제작 케이크는 이틀 전 부터 밑작업 준비 및 재료 준비를 해두기 때문에 노쇼 방지를 위해 계좌이체로 선결제받고 있어요\n2일 전 주문 취소 시 100%환불해드리고 있어요\n픽업 하루 전 취소 시 케이크 작업이 시작되기 때문에 전액 환불 안 되는 점 너른 양해 부탁드리겠습니다😊', '주문 페이지와 손님 메일에 그대로 나와요.', 'multiline'],
  ['privacyNotice', '개인정보 안내', '수집 항목: 이름, 전화번호, 이메일(선택) / 목적: 예약 확인과 픽업 안내 / 보관: 픽업 종료 후 환불 문의 기간까지', '주문서 동의 문구예요. 보통 그대로 두세요.', 'text'],
  ['autoConfirmEnabled', '입금 자동 확정', false, '아이폰 입금 알림으로 주문을 자동 확정해요. 1원 테스트로 확인하기 전까지는 끈 채로 두세요.', 'check']
];

/**
 * 예전에 넣어 둔 임시값. 시트에 이 값이 그대로 있으면 사람이 고치지 않은 것으로 보고 새 기본값으로 바꾼다.
 * 사람이 고친 값은 건드리지 않는다.
 */
var OLD_PLACEHOLDERS = {
  cafeTagline: ['크리스마스 홀케이크 예약', '예약은 선착순으로 확정되며, 준비된 수량이 모두 예약되면 마감됩니다.'],
  refundPolicy: ['픽업 3일 전까지 전액 환불, 이후 환불 불가 (임시)',
    '주문 제작 케이크는 이틀 전부터 재료와 밑작업을 준비해서, 노쇼 방지를 위해 계좌이체로 선결제를 받고 있어요. 픽업 2일 전까지 취소하시면 100% 환불해 드려요. 픽업 하루 전부터는 케이크 작업이 시작되어 환불이 어려운 점 양해 부탁드려요.'],
  cafeName: ['카페 이름']
};
var OLD_PRODUCT_PLACEHOLDERS = {
  name: ['크리스마스 딸기 초코 홀케이크', '딸기 생크림 케이크 (예시)'],
  description: ['가격·사이즈 임시', '2호 · 지름 18cm', '임시',
    '마스카포네 우유 생크림, 발로나 초코 제누와즈, 생딸기, 메리 크리스마스 레터링 버터 쿠키'],
  price: [38000]
};

/** 예전 "안내 문구" 한 칸(notices)에 넣었던 다듬은 문구. 이 값이 그대로면 버리고 안내 문구 1~4 원문을 쓴다. */
var OLD_NOTICES_PLACEHOLDER = '픽업 가능한 시간은 12:00 ~ 20:00이에요.\n케이크는 수평을 맞춰 들어 주세요. 생크림 케이크는 이틀 안에 드시는 것을 권장하고, 꼭 냉장 보관 후 차가운 상태로 드셔 주세요.\n케이크 나이프, 성냥, 실버 롱스틱 초 1개가 기본 구성이에요.';

/** 예전 모양에만 있던 키(새 모양에서 다른 줄로 바뀜) */
var LEGACY_CONFIG_KEYS = ['capacity', 'capacityMode', 'pickupTimes', 'notices'];

var TEST_PRODUCTS = [
  // productId, name, price, description, imageUrl, active, sortOrder
  ['P1', '크리스마스 딸기 홀케이크', 60000, '구성-마스카포네 우유 생크림,발로나 초코 제누와즈,생딸기,메리 크리스마스 레터링 버터 쿠키', '', true, 1],
  ['TEST100', '100원 테스트 상품', 100, '테스트용. 평소에는 꺼 두세요', '', false, 99]
];

/** 사장님이 볼 필요 없는 열(숨김) */
var HIDDEN_KEYS = {
  '주문': ['productId', 'depositId', 'clientRequestId'],
  '입금': [],
  '케이크': [],
  '설정': ['key']
};

/** 사장님이 고치면 안 되는 열(고치려 하면 경고) */
var LOCKED_KEYS = {
  '주문': ['orderId', 'createdAt', 'productId', 'productName', 'amount', 'depositDeadline', 'confirmedAt', 'confirmedBy', 'depositId', 'clientRequestId'],
  '입금': ['depositId', 'receivedAt', 'rawTitle', 'rawBody', 'parsedName', 'parsedAmount'],
  '케이크': ['productId'],
  '설정': ['label', 'desc', 'key']
};

var STATUS_COLORS = {
  '입금대기': '#fff2cc',
  '확정': '#d9ead3',
  '만료': '#e7e6e6',
  '취소': '#f4cccc',
  '픽업완료': '#cfe2f3'
};

// ---------- 처음 한 번 ----------

/**
 * 처음 한 번 편집기에서 실행하는 "한 번에 설치" 함수.
 * 시트에 붙어 있는 스크립트라면 SPREADSHEET_ID를 직접 적지 않아도 지금 시트의 ID를 Script Properties에 저장한다.
 * 이어서 시트 정리, 입금 토큰 생성(없을 때만), 트리거 설치, 점검까지 한다. 여러 번 실행해도 안전하다.
 */
function firstTimeSetup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SPREADSHEET_ID')) {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) throw new Error('시트에 붙은 스크립트가 아니에요. 프로젝트 설정 → 스크립트 속성에 SPREADSHEET_ID를 직접 넣어 주세요.');
    props.setProperty('SPREADSHEET_ID', active.getId());
    console.log('SPREADSHEET_ID를 지금 시트로 저장했어요.');
  }
  setupSheets();
  createDepositToken();
  installTriggers();
  checkSetup();
}

/** 이미 만들어진(예전 영어 모양) 시트를 새 한글 모양으로 옮긴다. setupSheets와 같다. */
function migrateToKoreanSheets() {
  setupSheets();
}

// ---------- 시트 정리 ----------

function setupSheets() {
  var ss = getSpreadsheet_();
  ss.setSpreadsheetTimeZone(TZ);
  configCache_ = null;

  // 설정을 먼저 읽어 둔다(예전 모양이어도 값은 그대로 옮긴다).
  var oldRaw = findSheet_(SHEET.CONFIG) ? readConfigRaw_() : {};
  configCache_ = null;

  setupDataSheet_(ss, SHEET.ORDERS);
  setupDataSheet_(ss, SHEET.DEPOSITS);
  setupDataSheet_(ss, SHEET.PRODUCTS);
  setupConfigSheet_(ss, oldRaw);
  configCache_ = null;
  setupPickupView_(ss);
  setupGuide_(ss);
  removeBlankDefaultSheet_(ss);

  // 탭 순서: 사용법, 주문, 픽업 명단, 입금, 케이크, 설정
  [SHEET.GUIDE, SHEET.ORDERS, SHEET.PICKUP_VIEW, SHEET.DEPOSITS, SHEET.PRODUCTS, SHEET.CONFIG].forEach(function (n, i) {
    var sh = ss.getSheetByName(n);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  ss.setActiveSheet(ss.getSheetByName(SHEET.GUIDE));

  SpreadsheetApp.flush();
  console.log('시트 정리 완료: 사용법, 주문, 픽업 명단, 입금, 케이크, 설정');
}

/** 주문·입금·케이크 탭: 한글 이름, 한글 머리글, 서식, 드롭다운, 색, 숨김, 보호 */
function setupDataSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh && LEGACY_SHEET[name]) {
    sh = ss.getSheetByName(LEGACY_SHEET[name]);
    if (sh) sh.setName(name);
  }
  if (!sh) sh = ss.insertSheet(name);

  var cols = COLUMNS[name];
  var keyOf = headerKeyMap_(name);
  var labelOf = {};
  cols.forEach(function (kv) { labelOf[kv[0]] = kv[1]; });

  // 머리글: 예전 영어 키든 한글이든 한글 이름으로 바꾸고, 빠진 열은 맨 끝에 붙인다.
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var cur = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  if (cur.every(function (h) { return h === ''; })) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (kv) { return kv[1]; })]);
  } else {
    var curKeys = cur.map(function (h) { return keyOf[h] || ''; });
    var relabeled = cur.map(function (h, i) { return curKeys[i] ? labelOf[curKeys[i]] : h; });
    sh.getRange(1, 1, 1, relabeled.length).setValues([relabeled]);
    var add = cols.filter(function (kv) { return curKeys.indexOf(kv[0]) < 0; }).map(function (kv) { return kv[1]; });
    if (add.length) sh.getRange(1, relabeled.length + 1, 1, add.length).setValues([add]);
  }

  var t = readTable_(name);
  var maxRows = sh.getMaxRows();
  var colRange = function (key) { return sh.getRange(2, t.col[key], maxRows - 1, 1); };

  // 서식: 글자 열은 일반 텍스트(전화번호 앞 0, 날짜 자동 변환 방지), 숫자·일시 열은 따로
  var numberKeys = { qty: '0', amount: '#,##0', parsedAmount: '#,##0', price: '#,##0', sortOrder: '0' };
  cols.forEach(function (kv) {
    var k = kv[0];
    if (!t.col[k]) return;
    if (DATETIME_KEYS.indexOf(k) >= 0) colRange(k).setNumberFormat('yyyy-mm-dd hh:mm');
    else if (numberKeys[k]) colRange(k).setNumberFormat(numberKeys[k]);
    else if (k !== 'active') colRange(k).setNumberFormat('@');
  });

  // 예전에 글자로 적힌 일시(ISO)를 날짜 값으로 바꾼다.
  DATETIME_KEYS.forEach(function (k) {
    if (!t.col[k]) return;
    t.rows.forEach(function (r) {
      if (typeof r[k] === 'string' && r[k]) {
        var d = parseDate_(r[k]);
        if (d) sh.getRange(r._row, t.col[k]).setValue(d);
      }
    });
  });

  if (name === SHEET.ORDERS) {
    colRange('status').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(ORDER_STATUS_LIST, true).setAllowInvalid(false)
      .setHelpText('입금대기, 확정, 만료, 취소, 픽업완료 중에서 골라 주세요.').build());
    var rules = Object.keys(STATUS_COLORS).map(function (st) {
      return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(st)
        .setBackground(STATUS_COLORS[st]).setRanges([colRange('status')]).build();
    });
    sh.setConditionalFormatRules(rules);
  }
  if (name === SHEET.DEPOSITS) {
    colRange('status').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['매칭완료', '미매칭', '무시'], true).setAllowInvalid(false).build());
    sh.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('미매칭').setBackground('#fff2cc').setRanges([colRange('status')]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('매칭완료').setBackground('#d9ead3').setRanges([colRange('status')]).build()
    ]);
  }
  if (name === SHEET.PRODUCTS) {
    if (t.rows.length === 0) {
      sh.getRange(2, 1, TEST_PRODUCTS.length, TEST_PRODUCTS[0].length).setValues(TEST_PRODUCTS);
    } else {
      // P1의 이름·설명이 예전 임시값 그대로면 실제 값으로 바꾼다(가격은 건드리지 않음).
      var p1 = t.rows.filter(function (r) { return cellStr_(r.productId) === 'P1'; })[0];
      if (p1) {
        if ((OLD_PRODUCT_PLACEHOLDERS.name.indexOf(cellStr_(p1.name)) >= 0 || !cellStr_(p1.name)) && t.col.name) {
          sh.getRange(p1._row, t.col.name).setValue(TEST_PRODUCTS[0][1]);
        }
        if ((OLD_PRODUCT_PLACEHOLDERS.description.indexOf(cellStr_(p1.description)) >= 0 || !cellStr_(p1.description)) && t.col.description) {
          sh.getRange(p1._row, t.col.description).setValue(TEST_PRODUCTS[0][3]);
        }
        if ((OLD_PRODUCT_PLACEHOLDERS.price.indexOf(cellNum_(p1.price)) >= 0 || !cellNum_(p1.price)) && t.col.price) {
          sh.getRange(p1._row, t.col.price).setValue(TEST_PRODUCTS[0][2]);
        }
      }
    }
    // 빈 행 전체에 체크박스를 넣으면 빈 행이 FALSE 값으로 남으므로 상품 행 + 여유 20행만.
    sh.getRange(2, t.col.active, Math.max(sh.getLastRow() - 1, 1) + 20, 1).insertCheckboxes();
  }

  styleHeaderAndProtect_(sh, name, readTable_(name));
}

function styleHeaderAndProtect_(sh, name, t) {
  sh.setFrozenRows(1);
  var lastCol = sh.getLastColumn();
  sh.getRange(1, 1, 1, lastCol).setFontWeight('bold').setBackground('#f3efe9');

  (HIDDEN_KEYS[name] || []).forEach(function (k) { if (t.col[k]) sh.hideColumns(t.col[k]); });

  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (String(p.getDescription()).indexOf(PROTECT_PREFIX) === 0) p.remove();
  });
  sh.getRange(1, 1, 1, lastCol).protect().setDescription(PROTECT_PREFIX + '머리글').setWarningOnly(true);
  (LOCKED_KEYS[name] || []).forEach(function (k) {
    if (!t.col[k]) return;
    sh.getRange(2, t.col[k], sh.getMaxRows() - 1, 1).protect()
      .setDescription(PROTECT_PREFIX + '자동으로 채워지는 칸').setWarningOnly(true);
    sh.getRange(2, t.col[k], sh.getMaxRows() - 1, 1).setFontColor('#666666');
  });
}

// ---------- 설정 탭 ----------

/**
 * 설정 탭을 "항목 | 값 | 설명 | 키(숨김)" 모양으로 다시 만든다.
 * 이미 적힌 값은 그대로 옮기고, 예전 모양의 값(JSON 수량, 픽업 시간 목록, ISO 날짜)은 새 줄로 바꿔 옮긴다.
 */
function setupConfigSheet_(ss, raw) {
  var has = function (k) { return raw.hasOwnProperty(k) && raw[k] !== '' && raw[k] !== null; };

  // 예전 값 변환
  var legacyCap = {};
  if (has('capacity')) { try { legacyCap = JSON.parse(cellStr_(raw.capacity)); } catch (e) { legacyCap = {}; } }
  var legacyTimes = has('pickupTimes') ? splitList_(cellStr_(raw.pickupTimes)) : [];
  var toMin = function (t) { var p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); };
  var hasNewNotices = ['notice1', 'notice2', 'notice3', 'notice4'].some(function (k) { return raw.hasOwnProperty(k); });
  var legacyNoticesEdited = !hasNewNotices && has('notices') &&
    cellStr_(raw.notices).replace(/\r\n?/g, '\n') !== OLD_NOTICES_PLACEHOLDER;

  var pickupDates = splitList_(has('pickupDates') ? cellStr_(raw.pickupDates) : '2026-12-23,2026-12-24,2026-12-25');

  var rows = []; // [label, value, desc, key, type]
  CONFIG_ITEMS.forEach(function (it) {
    if (it[0] === '{capacity}') {
      pickupDates.forEach(function (d) {
        var key = 'capacity:' + d;
        var v = has(key) ? cellNum_(raw[key])
          : (typeof legacyCap[d] === 'number' ? legacyCap[d] : 10);
        rows.push([koMonthDay_(d) + ' 수량', v, '이날 받을 케이크 총 개수. 숫자만 적어요. 0이면 그날은 마감이에요.', key, 'num']);
      });
      return;
    }
    var key = it[0], type = it[4], v;
    var isOldPlaceholder = has(key) && (OLD_PLACEHOLDERS[key] || []).indexOf(cellStr_(raw[key])) >= 0;
    if (has(key) && !isOldPlaceholder) {
      v = raw[key];
    } else if (/^notice[1-4]$/.test(key) && legacyNoticesEdited) {
      // 예전 한 칸짜리 안내 문구를 사람이 고쳐 두었으면 그 내용을 1번 칸에 옮기고 2~4번은 비운다.
      v = key === 'notice1' ? raw.notices : '';
    } else if (key === 'pickupStart' && legacyTimes.length) {
      v = legacyTimes[0];
    } else if (key === 'pickupEnd' && legacyTimes.length) {
      v = legacyTimes[legacyTimes.length - 1];
    } else if (key === 'pickupInterval' && legacyTimes.length > 1) {
      v = toMin(legacyTimes[1]) - toMin(legacyTimes[0]);
    } else {
      v = it[2];
    }
    if (type === 'datetime') v = parseDate_(v, key === 'orderCloseAt') || v;
    if (type === 'check') v = cellBool_(v);
    if (type === 'num') v = cellNum_(v);
    if (type === 'time') v = parseTime_(v) || cellStr_(v);
    if (type === 'text') v = key === 'pickupDates' ? pickupDates.join(', ') : cellStr_(v);
    if (type === 'multiline') v = cellStr_(v);
    rows.push([it[1], v, it[3], key, type]);
  });

  // 표에 없는 키는 지우지 않고 맨 아래에 남긴다(예전 모양 전용 키 제외).
  var known = {};
  rows.forEach(function (r) { known[r[3]] = true; });
  Object.keys(raw).forEach(function (k) {
    if (known[k] || LEGACY_CONFIG_KEYS.indexOf(k) >= 0 || /^capacity:/.test(k)) return;
    rows.push([k, raw[k], '(예전 항목)', k, 'text']);
  });

  // 탭을 새로 만든다(예전 설정·Config 탭은 지운다).
  var old = ss.getSheetByName(SHEET.CONFIG) || ss.getSheetByName(LEGACY_SHEET[SHEET.CONFIG]);
  var sh = ss.insertSheet(SHEET.CONFIG + '_새로');
  if (old) ss.deleteSheet(old);
  sh.setName(SHEET.CONFIG);

  sh.getRange(1, 1, 1, 4).setValues([COLUMNS[SHEET.CONFIG].map(function (kv) { return kv[1]; })]);
  sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(2, 3, rows.length, 2).setNumberFormat('@');
  rows.forEach(function (r, i) {
    var cell = sh.getRange(i + 2, 2);
    if (r[4] === 'datetime') cell.setNumberFormat('yyyy-mm-dd hh:mm');
    else if (r[4] === 'num') cell.setNumberFormat('0');
    else if (r[4] !== 'check') cell.setNumberFormat('@');
    if (r[4] === 'multiline') cell.setWrap(true);
  });
  sh.getRange(2, 1, rows.length, 4).setValues(rows.map(function (r) { return [r[0], r[1], r[2], r[3]]; }));
  rows.forEach(function (r, i) {
    if (r[4] === 'check') sh.getRange(i + 2, 2).insertCheckboxes();
  });

  sh.getRange(2, 2, rows.length, 1).setBackground('#fffbea');
  sh.getRange(2, 3, rows.length, 1).setFontColor('#666666').setWrap(true);
  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(2, 260);
  sh.setColumnWidth(3, 520);
  styleHeaderAndProtect_(sh, SHEET.CONFIG, readTable_(SHEET.CONFIG));
}

/** 픽업 날짜에 맞는 "N월 N일 수량" 줄이 빠져 있으면 설정 탭 맨 아래에 더한다. 더한 날짜 목록을 돌려준다. */
function ensureCapacityRows_() {
  configCache_ = null;
  var raw = readConfigRaw_();
  var cfg = getConfig_();
  var sh = getSheet_(SHEET.CONFIG);
  if (sh.getRange(1, 4).getValue() !== '키') return [];
  var added = cfg.pickupDates.filter(function (d) { return !raw.hasOwnProperty('capacity:' + d); });
  added.forEach(function (d) {
    var r = sh.getLastRow() + 1;
    sh.getRange(r, 2).setNumberFormat('0');
    sh.getRange(r, 1, 1, 4).setValues([[koMonthDay_(d) + ' 수량', 0, '이날 받을 케이크 총 개수. 숫자만 적어요. 0이면 그날은 마감이에요.', 'capacity:' + d]]);
    sh.getRange(r, 2).setBackground('#fffbea');
  });
  configCache_ = null;
  return added;
}

// ---------- 픽업 명단 ----------

/** 보기용 탭: B1에서 날짜를 고르면 그 날짜의 확정·픽업완료 주문이 시간순으로 나온다. 매번 새로 만든다. */
function setupPickupView_(ss) {
  [SHEET.PICKUP_VIEW, LEGACY_SHEET[SHEET.PICKUP_VIEW]].forEach(function (n) {
    var old = ss.getSheetByName(n);
    if (old) ss.deleteSheet(old);
  });
  var sh = ss.insertSheet(SHEET.PICKUP_VIEW);
  var cfg = getConfig_();
  var dates = cfg.pickupDates.length ? cfg.pickupDates : ['2026-12-23', '2026-12-24', '2026-12-25'];

  var t = readTable_(SHEET.ORDERS);
  var L = function (key) { return columnLetter_(t.col[key]); };
  var lastLetter = columnLetter_(t.keys.length);
  var src = "'" + SHEET.ORDERS + "'!";
  var dateCond = L('pickupDate') + " = '\"&TEXT(B1,\"yyyy-mm-dd\")&\"' and (" +
    L('status') + " = '확정' or " + L('status') + " = '픽업완료')";

  sh.getRange('A1').setValue('픽업 날짜 →').setFontWeight('bold');
  sh.getRange('B1').setNumberFormat('@').setValue(dates[0]).setBackground('#fff2cc').setFontWeight('bold')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(dates, true).build());
  sh.getRange('C1').setValue('← 날짜를 눌러 바꿔 보세요').setFontColor('#666666');
  sh.getRange('E1').setValue('케이크 합계').setFontWeight('bold');
  sh.getRange('F1').setFormula('=IFERROR(SUM(QUERY(' + src + 'A2:' + lastLetter + ',"select ' + L('qty') +
    ' where ' + dateCond + '",0)),0)');

  var select = ['pickupTime', 'status', 'customerName', 'phone', 'productName', 'qty', 'lettering', 'memo', 'orderId']
    .map(L).join(', ');
  sh.getRange('A3').setFormula('=IFERROR(QUERY(' + src + 'A1:' + lastLetter + ',"select ' + select +
    ' where ' + dateCond + ' order by ' + L('pickupTime') + ', ' + L('orderId') + '",1),"이 날짜에 확정된 주문이 아직 없어요")');
  sh.setFrozenRows(3);
  sh.getRange('A3:Z').protect().setDescription(PROTECT_PREFIX + '보기용 명단(주문 탭에서 고쳐 주세요)').setWarningOnly(true);
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

// ---------- 사용법 ----------

var GUIDE_LINES = [
  ['크리스마스 케이크 예약 시트 사용법', 'title'],
  ['', ''],
  ['① 주문 확정하기', 'head'],
  ['토스에서 입금을 확인했으면 [주문] 탭에서 그 주문의 "상태" 칸을 눌러 "확정"을 고르세요. 손님에게 확정 메일이 자동으로 가요.', ''],
  ['여러 건을 한꺼번에 하려면 주문 줄을 선택하고 위쪽 메뉴 [예약 관리 → 선택한 주문 확정하기]를 누르세요.', ''],
  ['', ''],
  ['② 주문 취소하기', 'head'],
  ['[주문] 탭에서 "상태"를 "취소"로 바꾸면 그 개수만큼 다시 주문을 받을 수 있어요. 환불은 토스에서 직접 보내 주세요.', ''],
  ['', ''],
  ['③ 가격·수량 바꾸기', 'head'],
  ['가격은 [케이크] 탭의 "가격" 칸, 날짜별 수량은 [설정] 탭 "12월 23일 수량" 같은 줄의 "값" 칸에 숫자만 적으세요. 주문 페이지에 바로 반영돼요.', ''],
  ['', ''],
  ['④ 계좌 바꾸기', 'head'],
  ['[설정] 탭의 "은행", "계좌번호", "예금주" 줄의 "값" 칸을 고치세요. 주문 페이지와 손님 메일에 바로 나와요.', ''],
  ['', ''],
  ['⑤ 주문 받기 열고 닫기', 'head'],
  ['위쪽 메뉴 [예약 관리 → 주문 받기 시작 / 중지]를 누르면 바로 열리거나 닫혀요. 기간은 [설정] 탭 "주문 받기 시작", "주문 마감"에서 바꿔요.', ''],
  ['', ''],
  ['알아 두면 좋은 것', 'head'],
  ['· 픽업 날에는 메뉴 [예약 관리 → 오늘 픽업 명단 보기]를 누르면 그날 손님이 시간순으로 나와요. 다 찾아가면 "상태"를 "픽업완료"로 바꿔 주세요.', ''],
  ['· 입금 기한까지 입금이 없으면 주문은 자동으로 "만료"돼요. 그 뒤에 입금이 들어오면 상태를 직접 "확정"으로 바꾸면 돼요.', ''],
  ['· 매일 아침 9시에 입금을 기다리는 주문과 확인할 입금 목록이 메일로 와요.', ''],
  ['· 회색 글씨 칸과 맨 윗줄(머리글)은 자동으로 채워지는 곳이라 고치지 마세요. 고치려고 하면 경고가 떠요.', ''],
  ['· 설정을 바꾼 뒤 메뉴 [예약 관리 → 설정 점검]을 누르면 빠진 값이 없는지 알려 줘요.', ''],
  ['· 아이폰 단축어에 넣을 주소와 비밀 토큰은 메뉴 [예약 관리 → 아이폰 연결 정보 보기]에서 복사해요. 토큰은 다른 사람에게 보내지 마세요.', '']
];

function setupGuide_(ss) {
  var old = ss.getSheetByName(SHEET.GUIDE);
  if (old) ss.deleteSheet(old);
  var sh = ss.insertSheet(SHEET.GUIDE);
  sh.getRange(1, 1, GUIDE_LINES.length, 1).setValues(GUIDE_LINES.map(function (l) { return [l[0]]; })).setWrap(true);
  GUIDE_LINES.forEach(function (l, i) {
    var c = sh.getRange(i + 1, 1);
    if (l[1] === 'title') c.setFontSize(16).setFontWeight('bold');
    if (l[1] === 'head') c.setFontSize(12).setFontWeight('bold').setBackground('#f3efe9');
  });
  sh.setColumnWidth(1, 760);
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
    console.log('입금 토큰이 이미 있어요. 바꾸려면 rotateDepositToken을 실행하세요(아이폰 단축어도 같이 바꿔야 해요).');
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
  console.log('새 입금 토큰 (아이폰 단축어의 token 값에 붙여 넣고, 다른 곳에는 저장하지 마세요):\n' + token);
}

// ---------- 점검 ----------

/** 설정에서 고쳐야 할 것과 현재 상태를 쉬운 문장 목록으로. 값(토큰·시트 ID)은 보여 주지 않는다. */
function settingsReport_() {
  var problems = [];
  var info = [];
  var props = PropertiesService.getScriptProperties();
  var cfg = getConfig_();
  var now = new Date();

  if (/^[0\-\s]*$/.test(cfg.accountNumber)) problems.push('계좌번호가 아직 임시값이에요. [설정] 탭 "계좌번호"를 고쳐 주세요.');
  if (cfg.accountHolder === '예금주' || !cfg.accountHolder) problems.push('예금주가 아직 임시값이에요.');
  if (!cfg.ownerEmail) problems.push('사장님 이메일이 비어 있어요. 비워 두면 이 시트 주인 계정으로 메일이 가요.');
  if (cfg.orderOpenAt.getTime() >= cfg.orderCloseAt.getTime()) problems.push('"주문 받기 시작"이 "주문 마감"보다 늦어요.');
  if (!cfg.pickupTimes.length) problems.push('픽업 시간을 읽지 못했어요. "픽업 시작 시각", "픽업 끝 시각", "픽업 시간 간격(분)"을 확인해 주세요.');
  cfg.pickupDates.forEach(function (d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) problems.push('픽업 날짜 "' + d + '"의 모양이 이상해요. 2026-12-24처럼 적어 주세요.');
    else if (cfg.capacityMode === 'total' && !(cellNum_(cfg.capacity[d]) > 0)) problems.push(koMonthDay_(d) + ' 수량이 0이라 그날은 주문을 받지 않아요.');
  });
  var products = getActiveProducts_();
  if (!products.length) problems.push('[케이크] 탭에 "판매 중"으로 체크된 케이크가 없어요.');
  products.forEach(function (p) {
    if (!(p.price > 0)) problems.push('"' + p.name + '" 가격이 비어 있어요.');
    if (p.productId === 'TEST100') problems.push('100원 테스트 상품이 판매 중이에요. 테스트가 끝나면 체크를 꺼 주세요.');
  });

  info.push('주문 받기: ' + (isOrderOpen_(cfg, now) ? '지금 받는 중' : '지금은 받지 않음') +
    ' (기간 ' + Utilities.formatDate(cfg.orderOpenAt, TZ, 'M월 d일 HH:mm') + ' ~ ' + Utilities.formatDate(cfg.orderCloseAt, TZ, 'M월 d일 HH:mm') +
    (cfg.orderEnabled ? '' : ', "주문 받기" 꺼짐') + ')');
  info.push('픽업 시간: ' + (cfg.pickupTimes.length ? cfg.pickupTimes[0] + ' ~ ' + cfg.pickupTimes[cfg.pickupTimes.length - 1] + ', ' + cfg.pickupTimes.length + '개' : '없음'));
  info.push('판매 중인 케이크: ' + (products.map(function (p) { return p.name + ' ' + formatWon_(p.price); }).join(', ') || '없음'));
  info.push('입금 자동 확정: ' + (cfg.autoConfirmEnabled ? '켜짐' : '꺼짐(사장님이 직접 확정)'));
  info.push('아이폰 입금 알림 연결 비밀번호: ' + (props.getProperty('DEPOSIT_TOKEN') ? '준비됨' : '아직 없음'));
  var trig = [];
  try { trig = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }); } catch (e) { trig = []; }
  var trigOk = TRIGGER_HANDLERS.every(function (h) { return trig.indexOf(h) >= 0; });
  info.push('자동 작업(만료 처리, 확정 메일, 아침 요약): ' + (trigOk ? '설치됨' : '이 계정에서는 확인되지 않음(시트 주인 계정으로 설치돼 있으면 괜찮아요)'));
  return { problems: problems, info: info };
}

/** 편집기에서 실행하면 점검 결과를 로그로 남긴다. */
function checkSetup() {
  var props = PropertiesService.getScriptProperties();
  var lines = ['시트 연결: ' + (props.getProperty('SPREADSHEET_ID') ? '설정됨' : '없음'),
    '매칭 모듈: ' + (matchingModuleReady_() ? '있음' : '없음'),
    '메일 남은 한도: ' + MailApp.getRemainingDailyQuota()];
  var r = settingsReport_();
  lines = lines.concat(r.info);
  lines.push(r.problems.length ? '고칠 것:\n- ' + r.problems.join('\n- ') : '고칠 것: 없음');
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
 * 주문번호·케이크·금액·상태는 매출 기록으로 남긴다. 입금 탭의 알림 원문과 입금자명도 같은 기준으로 지운다.
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
