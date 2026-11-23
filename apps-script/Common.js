/**
 * 공통: 시트 이름과 머리글, 시트 열기, 설정 읽기, 날짜·문자열 도구.
 * 모든 파일이 전역 범위를 공유하므로 이름은 Matching.js와 겹치지 않게 짓는다.
 *
 * 시트에는 한글 머리글이 보이고, 코드는 내부 키(orderId 등)로 열을 찾는다.
 * 머리글 칸에 한글 이름이든 예전 영어 키든 어느 쪽이 있어도 읽힌다.
 */

var TZ = 'Asia/Seoul';

var SHEET = {
  GUIDE: '사용법',
  ORDERS: '주문',
  DEPOSITS: '입금',
  PRODUCTS: '케이크',
  CONFIG: '설정',
  PICKUP_VIEW: '픽업 명단'
};

/** 예전 영어 탭 이름. 새 모양으로 옮기기 전에도 웹 앱이 동작하게 둘 다 찾는다. */
var LEGACY_SHEET = {
  '주문': 'Orders',
  '입금': 'Deposits',
  '케이크': 'Products',
  '설정': 'Config',
  '픽업 명단': '픽업보기'
};

/** 탭별 [내부 키, 한글 머리글] 순서 = 시트 열 순서 */
var COLUMNS = {
  '주문': [
    ['orderId', '주문번호'], ['createdAt', '주문 시각'], ['status', '상태'], ['productId', '케이크 코드'],
    ['productName', '케이크'], ['pickupDate', '픽업 날짜'], ['pickupTime', '픽업 시간'], ['qty', '개수'],
    ['amount', '금액'], ['customerName', '성함'], ['phone', '연락처'], ['email', '이메일'],
    ['depositorName', '입금자명'], ['lettering', '레터링'], ['memo', '요청사항'], ['depositDeadline', '입금 기한'],
    ['confirmedAt', '확정 시각'], ['confirmedBy', '확정한 사람'], ['depositId', '입금번호'], ['clientRequestId', '중복방지코드']
  ],
  '입금': [
    ['depositId', '입금번호'], ['receivedAt', '받은 시각'], ['rawTitle', '알림 제목'], ['rawBody', '알림 내용'],
    ['parsedName', '읽은 입금자명'], ['parsedAmount', '읽은 금액'], ['status', '처리 상태'],
    ['matchedOrderId', '연결된 주문번호'], ['note', '메모']
  ],
  '케이크': [
    ['productId', '케이크 코드'], ['name', '케이크 이름'], ['price', '가격'], ['description', '설명'],
    ['imageUrl', '사진 주소'], ['active', '판매 중'], ['sortOrder', '보이는 순서']
  ],
  '설정': [
    ['label', '항목'], ['value', '값'], ['desc', '설명'], ['key', '키']
  ]
};

var ORDER_STATUS = { PENDING: '입금대기', CONFIRMED: '확정', EXPIRED: '만료', CANCELED: '취소', PICKED_UP: '픽업완료' };
var ORDER_STATUS_LIST = ['입금대기', '확정', '만료', '취소', '픽업완료'];
var DEPOSIT_STATUS = { MATCHED: '매칭완료', UNMATCHED: '미매칭', IGNORED: '무시' };

/** 남은 수량 계산에 들어가는 상태 */
var HOLDING_STATUSES = ['입금대기', '확정', '픽업완료'];

/** 시트에 날짜 값(날짜 셀)으로 저장하는 열 */
var DATETIME_KEYS = ['createdAt', 'depositDeadline', 'confirmedAt', 'receivedAt'];

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
  if (id) {
    spreadsheetCache_ = SpreadsheetApp.openById(id);
  } else {
    // 시트 메뉴에서 실행한 경우처럼 열린 시트가 있으면 그것을 쓴다.
    var active = null;
    try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
    if (!active) throw new Error('시트 연결 정보(SPREADSHEET_ID)가 없어요. docs/SETUP.md를 보세요.');
    spreadsheetCache_ = active;
  }
  return spreadsheetCache_;
}

/** 탭 찾기: 한글 이름, 없으면 예전 영어 이름. */
function findSheet_(name) {
  var ss = getSpreadsheet_();
  return ss.getSheetByName(name) || (LEGACY_SHEET[name] ? ss.getSheetByName(LEGACY_SHEET[name]) : null);
}

function getSheet_(name) {
  var sh = findSheet_(name);
  if (!sh) throw new Error('"' + name + '" 탭이 없어요. 시트 정리 함수를 먼저 실행하세요.');
  return sh;
}

/** 시트 탭이 어느 표인지(한글 이름 기준). 예약 시스템 탭이 아니면 ''. */
function tableNameOf_(sheet) {
  var n = sheet.getName();
  if (COLUMNS[n] || n === SHEET.PICKUP_VIEW || n === SHEET.GUIDE) return n;
  for (var k in LEGACY_SHEET) if (LEGACY_SHEET[k] === n) return k;
  return '';
}

/** 머리글 칸 글자 → 내부 키. 한글 머리글, 영어 키 둘 다 받는다. */
function headerKeyMap_(tableName) {
  var m = {};
  (COLUMNS[tableName] || []).forEach(function (kv) { m[kv[0]] = kv[0]; m[kv[1]] = kv[0]; });
  return m;
}

/**
 * 탭 전체를 읽어 객체 배열로 돌려준다. 머리글로 열을 찾으므로 열 순서가 바뀌어도 동작한다.
 * 각 객체에 _row(시트 행 번호, 1부터)를 붙인다. col은 내부 키 → 열 번호.
 */
function readTable_(name) {
  var sh = getSheet_(name);
  var values = sh.getDataRange().getValues();
  var keyOf = headerKeyMap_(name);
  if (values.length === 0) return { sheet: sh, name: name, keys: [], col: {}, rows: [] };
  var keys = values[0].map(function (h) { var t = String(h).trim(); return keyOf[t] || ''; });
  var col = {};
  keys.forEach(function (k, i) { if (k && !col[k]) col[k] = i + 1; });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var obj = { _row: r + 1 };
    var empty = true;
    for (var c = 0; c < keys.length; c++) {
      if (!keys[c]) continue;
      var v = values[r][c];
      obj[keys[c]] = v;
      if (v !== '' && v !== null && v !== false) empty = false;
    }
    if (!empty) rows.push(obj);
  }
  return { sheet: sh, name: name, keys: keys, col: col, rows: rows };
}

/** 객체를 시트 열 순서의 한 행 배열로. 사용자 입력 문자열은 수식 주입 방지, 일시 열은 날짜 값으로. */
function toRowArray_(table, obj) {
  return table.keys.map(function (k) {
    if (!k || !obj.hasOwnProperty(k)) return '';
    var v = obj[k];
    if (DATETIME_KEYS.indexOf(k) >= 0 && v) return parseDate_(v) || v;
    return typeof v === 'string' ? safeText_(v) : v;
  });
}

function setCell_(table, rowNum, key, value) {
  var c = table.col[key];
  if (!c) throw new Error(table.sheet.getName() + ' 탭에 "' + key + '" 열이 없어요.');
  table.sheet.getRange(rowNum, c).setValue(value);
}

// ---------- 셀 값 정리 ----------

/** 셀 값을 문자열로. 시트가 날짜·시각으로 바꿔 버린 값도 API 형식 문자열로 되돌린다. */
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

/** 일시 셀(날짜 값 또는 ISO 문자열) → ISO 문자열. 비었으면 ''. */
function cellIso_(v) {
  var d = parseDate_(v);
  return d ? toIso_(d) : cellStr_(v);
}

function cellNum_(v) {
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(/[,\s원개]/g, ''));
  return isNaN(n) ? 0 : n;
}

function cellBool_(v) {
  if (v === true) return true;
  return /^(true|1|y|yes|on|예|o|켜기|켬)$/i.test(String(v).trim());
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

/**
 * 날짜 셀, ISO 문자열, "2026-12-01 10:00", "2026. 12. 1 10:00", "2026-12-21" 등을 Date로(한국 시간).
 * 시각이 없으면 endOfDay가 참일 때 23:59, 아니면 00:00. 실패하면 null.
 */
function parseDate_(v, endOfDay) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v || '').trim();
  if (!s) return null;
  if (/T\d{1,2}:\d{2}/.test(s)) {
    var iso = new Date(s);
    if (!isNaN(iso.getTime())) return iso;
  }
  var m = s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D*?(?:\s+(오전|오후)?\s*(\d{1,2})(?::|시\s*)(\d{2})?)?/);
  if (m) {
    var h = m[5] != null ? Number(m[5]) : (endOfDay ? 23 : 0);
    var mi = m[5] != null ? Number(m[6] || 0) : (endOfDay ? 59 : 0);
    if (m[4] === '오후' && h < 12) h += 12;
    if (m[4] === '오전' && h === 12) h = 0;
    var p2 = function (n) { return ('0' + n).slice(-2); };
    var d = new Date(m[1] + '-' + p2(m[2]) + '-' + p2(m[3]) + 'T' + p2(h) + ':' + p2(mi) + ':00+09:00');
    return isNaN(d.getTime()) ? null : d;
  }
  var any = new Date(s);
  return isNaN(any.getTime()) ? null : any;
}

/** "12:00", "12시", "12:30", 시각 셀 → "HH:mm". 실패하면 ''. */
function parseTime_(v) {
  var s = cellStr_(v);
  var m = s.match(/(\d{1,2})(?::|시\s*)?(\d{2})?/);
  if (!m) return '';
  var h = Number(m[1]), mi = Number(m[2] || 0);
  if (h > 23 || mi > 59) return '';
  return ('0' + h).slice(-2) + ':' + ('0' + mi).slice(-2);
}

function ymd_(d) {
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function splitList_(s) {
  return String(s || '').split(/[,\n]/).map(function (x) { return x.trim(); }).filter(String);
}

/** "2026-12-23" → "12월 23일" */
function koMonthDay_(ymd) {
  var m = String(ymd).match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? Number(m[1]) + '월 ' + Number(m[2]) + '일' : String(ymd);
}

/** 시작~끝 시각을 간격(분)으로 나눈 목록 */
function timeSlots_(start, end, stepMin) {
  var toMin = function (t) { var p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); };
  var out = [];
  if (!start || !end || !(stepMin > 0)) return out;
  for (var t = toMin(start); t <= toMin(end) && out.length < 100; t += stepMin) {
    out.push(('0' + Math.floor(t / 60)).slice(-2) + ':' + ('0' + (t % 60)).slice(-2));
  }
  return out;
}

// ---------- 설정 ----------

/**
 * 설정 탭을 {내부 키: 셀 값} 으로 읽는다. 한 실행 안에서는 한 번만 읽는다.
 * 새 모양(항목 | 값 | 설명 | 키[숨김])과 예전 모양(key | value) 둘 다 읽는다.
 */
var configCache_ = null;

function readConfigRaw_() {
  if (configCache_) return configCache_;
  var sh = getSheet_(SHEET.CONFIG);
  var values = sh.getDataRange().getValues();
  var head = (values[0] || []).map(function (h) { return String(h).trim(); });
  var keyCol = head.indexOf('키'), valCol = head.indexOf('값');
  if (keyCol < 0) { keyCol = 0; valCol = 1; }
  var map = {};
  for (var r = 1; r < values.length; r++) {
    var k = String(values[r][keyCol] || '').trim();
    if (k) map[k] = values[r][valCol];
  }
  configCache_ = map;
  return map;
}

/** 쓰기 쉬운 모양으로 정리한 설정. 비어 있으면 임시값을 쓴다. */
function getConfig_() {
  var raw = readConfigRaw_();
  var has = function (k) { return raw.hasOwnProperty(k) && cellStr_(raw[k]) !== ''; };
  var s = function (k) { return raw.hasOwnProperty(k) ? cellStr_(raw[k]) : ''; };
  var sOr = function (k, def) { return has(k) ? s(k) : def; };
  var nOr = function (k, def) { var v = cellNum_(raw[k]); return has(k) && !isNaN(Number(String(raw[k]).replace(/[,\s원개시간분]/g, ''))) ? v : def; };
  var bOr = function (k, def) { return raw.hasOwnProperty(k) && raw[k] !== '' ? cellBool_(raw[k]) : def; };

  var pickupDates = splitList_(sOr('pickupDates', '2026-12-23,2026-12-24,2026-12-25'));

  // 픽업 시간: 시작·끝·간격(새 모양), 없으면 예전 목록
  var pickupTimes;
  if (has('pickupStart')) {
    pickupTimes = timeSlots_(parseTime_(raw.pickupStart), parseTime_(sOr('pickupEnd', '20:00')), nOr('pickupInterval', 30));
  } else {
    pickupTimes = splitList_(sOr('pickupTimes', '12:00,12:30,13:00,13:30,14:00,14:30,15:00,15:30,16:00,16:30,17:00,17:30,18:00,18:30,19:00,19:30,20:00'));
  }

  // 수량 한도: 날짜별 줄(capacity:2026-12-23), 없으면 예전 JSON
  var capacityMode = 'total';
  var capacity = {};
  var hasDateRows = pickupDates.some(function (d) { return raw.hasOwnProperty('capacity:' + d); });
  if (hasDateRows) {
    pickupDates.forEach(function (d) { capacity[d] = cellNum_(raw['capacity:' + d]); });
  } else {
    try { capacity = JSON.parse(sOr('capacity', '{}')); } catch (e) { capacity = {}; }
    capacityMode = sOr('capacityMode', 'total') === 'perProduct' ? 'perProduct' : 'total';
  }

  return {
    cafeName: sOr('cafeName', 'Nez'),
    cafeTagline: sOr('cafeTagline', ''),
    instagramUrl: s('instagramUrl'),
    heroImageUrl: s('heroImageUrl'),
    bankName: sOr('bankName', '토스뱅크'),
    accountNumber: sOr('accountNumber', '0000-0000-0000'),
    accountHolder: sOr('accountHolder', '예금주'),
    orderEnabled: bOr('orderEnabled', true),
    orderOpenAt: parseDate_(raw.orderOpenAt, false) || new Date('2026-12-01T10:00:00+09:00'),
    orderCloseAt: parseDate_(raw.orderCloseAt, true) || new Date('2026-12-21T23:59:00+09:00'),
    depositDeadlineHours: nOr('depositDeadlineHours', 24),
    pickupDates: pickupDates,
    pickupTimes: pickupTimes,
    capacityMode: capacityMode,
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
    notices: readNotices_(raw),
    privacyNotice: s('privacyNotice'),
    ownerEmail: s('ownerEmail'),
    autoConfirmEnabled: bOr('autoConfirmEnabled', false)
  };
}

/**
 * 안내 문구 1~4 칸 → 배열. 칸 하나가 원소 하나, 칸 안의 줄바꿈은 그대로 둔다. 빈 칸은 건너뛴다.
 * 예전 모양(안내 문구 한 칸, 키 notices)만 있으면 줄 단위로 나눈다.
 */
function readNotices_(raw) {
  var keys = ['notice1', 'notice2', 'notice3', 'notice4'];
  if (keys.some(function (k) { return raw.hasOwnProperty(k); })) {
    return keys.map(function (k) {
      return String(raw[k] == null ? '' : raw[k]).replace(/\r\n?/g, '\n').trim();
    }).filter(String);
  }
  return String(raw.notices == null ? '' : raw.notices).split(/\r?\n/)
    .map(function (x) { return x.trim(); }).filter(String);
}

function accountInfo_(cfg) {
  return { bankName: cfg.bankName, accountNumber: cfg.accountNumber, accountHolder: cfg.accountHolder };
}

/** 사장님 메일 주소: 설정의 사장님 이메일, 비어 있으면 스크립트 소유자. */
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
