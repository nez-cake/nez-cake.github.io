/**
 * 공통: 시트 이름과 헤더, 시트 열기, Config 읽기, 날짜·문자열 도구.
 * 모든 파일이 전역 범위를 공유하므로 이름은 Matching.js와 겹치지 않게 짓는다.
 */

var TZ = 'Asia/Seoul';

var SHEET = {
  ORDERS: 'Orders',
  DEPOSITS: 'Deposits',
  PRODUCTS: 'Products',
  CONFIG: 'Config',
  PICKUP_VIEW: '픽업보기'
};

var HEADERS = {
  Orders: ['orderId', 'createdAt', 'status', 'productId', 'productName', 'pickupDate', 'pickupTime',
    'qty', 'amount', 'customerName', 'phone', 'email', 'depositorName', 'lettering', 'memo',
    'depositDeadline', 'confirmedAt', 'confirmedBy', 'depositId', 'clientRequestId'],
  Deposits: ['depositId', 'receivedAt', 'rawTitle', 'rawBody', 'parsedName', 'parsedAmount',
    'status', 'matchedOrderId', 'note'],
  Products: ['productId', 'name', 'price', 'description', 'imageUrl', 'active', 'sortOrder'],
  Config: ['key', 'value']
};

var ORDER_STATUS = { PENDING: '입금대기', CONFIRMED: '확정', EXPIRED: '만료', CANCELED: '취소', PICKED_UP: '픽업완료' };
var DEPOSIT_STATUS = { MATCHED: '매칭완료', UNMATCHED: '미매칭', IGNORED: '무시' };

/** 남은 수량 계산에 들어가는 상태 */
var HOLDING_STATUSES = ['입금대기', '확정', '픽업완료'];

// ---------- 오류 ----------

/** 손님에게 보여 줄 수 있는 오류. doGet/doPost가 응답 형식으로 바꾼다. */
function ApiError(code, message, field) {
  this.code = code;
  this.message = message;
  this.field = field;
}

function apiError_(code, message, field) {
  return new ApiError(code, message, field);
}

// ---------- 시트 ----------

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

var spreadsheetCache_ = null;

function getSpreadsheet_() {
  if (spreadsheetCache_) return spreadsheetCache_;
  var id = getProp_('SPREADSHEET_ID');
  if (!id) throw new Error('Script Properties에 SPREADSHEET_ID가 없습니다. docs/SETUP.md를 보세요.');
  spreadsheetCache_ = SpreadsheetApp.openById(id);
  return spreadsheetCache_;
}

function getSheet_(name) {
  var sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('"' + name + '" 탭이 없습니다. setupSheets()를 먼저 실행하세요.');
  return sh;
}

/**
 * 탭 전체를 읽어 객체 배열로 돌려준다. 헤더 이름으로 열을 찾으므로 열 순서가 바뀌어도 동작한다.
 * 각 객체에 _row(시트 행 번호, 1부터)를 붙인다.
 */
function readTable_(name) {
  var sh = getSheet_(name);
  var values = sh.getDataRange().getValues();
  if (values.length === 0) return { sheet: sh, header: [], col: {}, rows: [] };
  var header = values[0].map(function (h) { return String(h).trim(); });
  var col = {};
  header.forEach(function (h, i) { if (h) col[h] = i + 1; });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var obj = { _row: r + 1 };
    var empty = true;
    for (var c = 0; c < header.length; c++) {
      if (!header[c]) continue;
      obj[header[c]] = values[r][c];
      if (values[r][c] !== '' && values[r][c] !== null) empty = false;
    }
    if (!empty) rows.push(obj);
  }
  return { sheet: sh, header: header, col: col, rows: rows };
}

/** 헤더 순서에 맞춰 객체를 한 행 배열로 바꾼다. */
function toRowArray_(header, obj) {
  return header.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
}

function setCell_(table, rowNum, key, value) {
  var c = table.col[key];
  if (!c) throw new Error(table.sheet.getName() + ' 탭에 "' + key + '" 열이 없습니다.');
  table.sheet.getRange(rowNum, c).setValue(value);
}

// ---------- 셀 값 정리 ----------

/**
 * 셀 값을 문자열로. 시트가 날짜·시각으로 바꿔 버린 값도 API 형식 문자열로 되돌린다.
 */
function cellStr_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (v.getFullYear() < 1900) return Utilities.formatDate(v, TZ, 'HH:mm');
    var hms = Utilities.formatDate(v, TZ, 'HH:mm:ss');
    if (hms === '00:00:00') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
    return toIso_(v);
  }
  var s = String(v).trim();
  // 수식 주입 방지로 붙인 작은따옴표가 값에 남아 있으면 떼어 낸다.
  if (/^'[=+\-@]/.test(s)) s = s.substring(1);
  return s;
}

function cellNum_(v) {
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(/[,\s원]/g, ''));
  return isNaN(n) ? 0 : n;
}

function cellBool_(v) {
  if (v === true) return true;
  return /^(true|1|y|yes|on|예|o)$/i.test(String(v).trim());
}

/** 시트에 쓰는 사용자 입력: =, +, -, @로 시작하면 작은따옴표를 붙여 수식 실행을 막는다. */
function safeText_(s) {
  s = s === null || s === undefined ? '' : String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// ---------- 날짜 ----------

/** Date → "2026-12-24T14:00:00+09:00" */
function toIso_(d) {
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ss") + '+09:00';
}

/** 문자열이나 Date를 Date로. 실패하면 null. */
function parseDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v || '').trim();
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function ymd_(d) {
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function splitList_(s) {
  return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(String);
}

// ---------- Config ----------

/** Config 탭을 {key: 원래 셀 값} 으로 읽는다. 한 실행 안에서는 한 번만 읽는다. */
var configCache_ = null;

function readConfigRaw_() {
  if (configCache_) return configCache_;
  var t = readTable_(SHEET.CONFIG);
  var map = {};
  t.rows.forEach(function (r) {
    var k = cellStr_(r.key);
    if (k) map[k] = r.value;
  });
  configCache_ = map;
  return map;
}

/** 쓰기 쉬운 모양으로 정리한 설정. 비어 있으면 API.md 7장 임시값을 쓴다. */
function getConfig_() {
  var raw = readConfigRaw_();
  var s = function (k) { return raw.hasOwnProperty(k) ? cellStr_(raw[k]) : ''; };
  var sOr = function (k, def) { var v = s(k); return v === '' ? def : v; };
  var nOr = function (k, def) { var v = s(k); return v === '' || isNaN(Number(v)) ? def : Number(v); };
  var bOr = function (k, def) { return raw.hasOwnProperty(k) && s(k) !== '' ? cellBool_(raw[k]) : def; };

  var capacity = {};
  try { capacity = JSON.parse(sOr('capacity', '{}')); } catch (e) { capacity = {}; }

  return {
    cafeName: sOr('cafeName', 'Nez'),
    cafeTagline: sOr('cafeTagline', '크리스마스 홀케이크 예약'),
    instagramUrl: s('instagramUrl'),
    heroImageUrl: s('heroImageUrl'),
    bankName: sOr('bankName', '토스뱅크'),
    accountNumber: sOr('accountNumber', '0000-0000-0000'),
    accountHolder: sOr('accountHolder', '예금주'),
    orderOpenAt: parseDate_(raw.orderOpenAt) || new Date('2026-12-01T10:00:00+09:00'),
    orderCloseAt: parseDate_(raw.orderCloseAt) || new Date('2026-12-21T23:59:00+09:00'),
    depositDeadlineHours: nOr('depositDeadlineHours', 24),
    pickupDates: splitList_(sOr('pickupDates', '2026-12-23,2026-12-24,2026-12-25')),
    pickupTimes: splitList_(sOr('pickupTimes', '12:00,12:30,13:00,13:30,14:00,14:30,15:00,15:30,16:00,16:30,17:00,17:30,18:00,18:30,19:00,19:30,20:00')),
    capacityMode: sOr('capacityMode', 'total') === 'perProduct' ? 'perProduct' : 'total',
    capacity: capacity,
    maxQtyPerOrder: nOr('maxQtyPerOrder', 2),
    maxPendingPerPhone: nOr('maxPendingPerPhone', 3),
    letteringEnabled: bOr('letteringEnabled', false),
    letteringMaxLength: nOr('letteringMaxLength', 20),
    bizName: s('bizName'),
    bizOwner: s('bizOwner'),
    bizRegNo: s('bizRegNo'),
    bizAddress: s('bizAddress'),
    bizPhone: s('bizPhone'),
    refundPolicy: s('refundPolicy'),
    privacyNotice: s('privacyNotice'),
    ownerEmail: s('ownerEmail'),
    autoConfirmEnabled: bOr('autoConfirmEnabled', false)
  };
}

function accountInfo_(cfg) {
  return { bankName: cfg.bankName, accountNumber: cfg.accountNumber, accountHolder: cfg.accountHolder };
}

/** 사장님 메일 주소: Config ownerEmail, 비어 있으면 스크립트 소유자. */
function ownerEmail_(cfg) {
  if (cfg.ownerEmail) return cfg.ownerEmail;
  try { return Session.getEffectiveUser().getEmail(); } catch (e) { return ''; }
}

// ---------- 잠금 ----------

/** 스크립트 잠금 안에서 fn을 실행한다. 잠금을 못 얻으면 BUSY. */
function withLock_(fn, waitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 20000)) {
    throw apiError_('BUSY', '주문이 몰려 잠시 처리가 늦어지고 있어요. 잠시 후 다시 시도해 주세요.');
  }
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}
