/**
 * 시간·편집 트리거. installTriggers()를 한 번 실행하면 아래가 모두 설치된다.
 *  - runEvery10Minutes : 입금 마감 지난 주문 만료, 만료 30분 전 손님 안내, 입금 수신 공백 경고
 *  - handleOrdersEdit  : 사장님이 Orders status를 "확정"으로 바꾸면 확정 처리(설치형 onEdit)
 *  - sendDailySummary  : 매일 오전 9시 사장님 요약 메일
 */

var TRIGGER_HANDLERS = ['runEvery10Minutes', 'handleOrdersEdit', 'sendDailySummary'];
var REMINDER_BEFORE_MS = 30 * 60 * 1000;
var DEPOSIT_GAP_MS = 24 * 3600 * 1000;

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runEvery10Minutes').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('handleOrdersEdit').forSpreadsheet(getSpreadsheet_()).onEdit().create();
  ScriptApp.newTrigger('sendDailySummary').timeBased().atHour(9).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  console.log('트리거 설치 완료: ' + TRIGGER_HANDLERS.join(', '));
}

// ---------- 10분마다 ----------

function runEvery10Minutes() {
  var steps = [expirePendingOrders, sendDepositReminders, checkDepositGap];
  steps.forEach(function (fn) {
    try { fn(); } catch (e) { console.error(fn.name + ' 실패: ' + (e && e.stack ? e.stack : e)); }
  });
}

/** 입금 마감이 지난 "입금대기" 주문을 "만료"로. 수량은 계산식에서 자동으로 돌아온다. */
function expirePendingOrders() {
  var now = Date.now();
  var expired = withLock_(function () {
    var t = readTable_(SHEET.ORDERS);
    var ids = [];
    t.rows.forEach(function (r) {
      if (cellStr_(r.status) !== ORDER_STATUS.PENDING) return;
      var dl = parseDate_(r.depositDeadline);
      if (!dl || dl.getTime() > now) return;
      // 읽은 뒤 사장님이 바꿨을 수 있으니 셀을 다시 확인한다.
      var cur = cellStr_(t.sheet.getRange(r._row, t.col.status).getValue());
      if (cur !== ORDER_STATUS.PENDING) return;
      setCell_(t, r._row, 'status', ORDER_STATUS.EXPIRED);
      ids.push(cellStr_(r.orderId));
    });
    return ids;
  }, 30000);
  if (expired.length) console.log('만료 처리: ' + expired.join(', '));
}

/** 입금 마감 30분 전 손님 안내(이메일을 적은 손님만, 주문당 한 번). */
function sendDepositReminders() {
  var now = Date.now();
  var props = PropertiesService.getScriptProperties();
  var sent = {};
  try { sent = JSON.parse(props.getProperty('REMINDED_ORDER_IDS') || '{}'); } catch (e) { sent = {}; }

  var targets = readTable_(SHEET.ORDERS).rows.map(orderFromRow_).filter(function (o) {
    if (o.status !== ORDER_STATUS.PENDING || !o.email || sent[o.orderId]) return false;
    var dl = parseDate_(o.depositDeadline);
    if (!dl) return false;
    var left = dl.getTime() - now;
    return left > 0 && left <= REMINDER_BEFORE_MS;
  });
  if (!targets.length) return;

  targets.forEach(function (o) {
    notifyCustomer(o, 'reminder');
    sent[o.orderId] = toIso_(new Date());
  });
  props.setProperty('REMINDED_ORDER_IDS', JSON.stringify(sent));
}

/**
 * 주문은 들어오는데 입금 알림이 하루 넘게 한 건도 없으면 사장님에게 경고(하루 한 번까지).
 * 단축어가 멈췄거나 폰 알림이 꺼진 것을 빨리 알기 위해서다.
 */
function checkDepositGap() {
  var props = PropertiesService.getScriptProperties();
  var lastWarn = Number(props.getProperty('LAST_DEPOSIT_GAP_WARNING') || 0);
  var now = Date.now();
  if (now - lastWarn < DEPOSIT_GAP_MS) return;

  var lastDeposit = 0;
  readTable_(SHEET.DEPOSITS).rows.forEach(function (r) {
    var d = parseDate_(r.receivedAt);
    if (d && d.getTime() > lastDeposit) lastDeposit = d.getTime();
  });

  var ordersSince = readTable_(SHEET.ORDERS).rows.map(orderFromRow_).filter(function (o) {
    var c = parseDate_(o.createdAt);
    return c && c.getTime() > lastDeposit && o.status !== ORDER_STATUS.CANCELED;
  });
  if (!ordersSince.length) return;

  var oldest = Math.min.apply(null, ordersSince.map(function (o) { return parseDate_(o.createdAt).getTime(); }));
  var gapStart = lastDeposit || oldest;
  if (now - gapStart < DEPOSIT_GAP_MS || now - oldest < DEPOSIT_GAP_MS) return;

  var cfg = getConfig_();
  notifyOwner_(cfg, '입금 알림이 하루 넘게 들어오지 않았어요', [
    '마지막 입금 알림 수신: ' + (lastDeposit ? formatDateTimeKo_(toIso_(new Date(lastDeposit))) : '아직 없음'),
    '그 뒤 들어온 주문: ' + ordersSince.length + '건',
    '',
    '아이폰 단축어 자동화가 멈췄거나 토스 알림이 꺼졌을 수 있어요.',
    '토스 입금 내역과 Orders 탭을 대조해 입금된 주문은 status를 "확정"으로 바꿔 주세요.',
    '단축어 설정은 docs/SHORTCUT.md를 보세요.'
  ].join('\n'));
  props.setProperty('LAST_DEPOSIT_GAP_WARNING', String(now));
}

// ---------- 수동 확정 (설치형 onEdit) ----------

/**
 * 사장님이 Orders 탭 status 셀을 "확정"으로 바꾸면 confirmedAt, confirmedBy를 채우고 확정 메일을 보낸다.
 * 스크립트가 바꾼 값에는 onEdit가 돌지 않으므로 자동 확정과 겹치지 않는다.
 * 함수 이름을 onEdit로 하지 않는다(단순 트리거로도 돌아 두 번 실행되기 때문).
 */
function handleOrdersEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== SHEET.ORDERS) return;

  var toNotify = [];
  try {
    withLock_(function () {
      var t = readTable_(SHEET.ORDERS);
      var statusCol = t.col.status;
      var r0 = e.range.getRow(), r1 = e.range.getLastRow();
      var c0 = e.range.getColumn(), c1 = e.range.getLastColumn();
      if (!statusCol || statusCol < c0 || statusCol > c1) return;

      var who = '사장님(수동)';
      try {
        var email = e.user && e.user.getEmail && e.user.getEmail();
        if (email) who = email + '(수동)';
      } catch (err) { /* 무시 */ }

      t.rows.forEach(function (r) {
        if (r._row < Math.max(r0, 2) || r._row > r1) return;
        var o = orderFromRow_(r);
        if (o.status !== ORDER_STATUS.CONFIRMED || o.confirmedAt) return;
        markOrderConfirmed_(t, r._row, who, '', false);
        toNotify.push(o);
      });
    }, 30000);
  } catch (err) {
    console.error('수동 확정 처리 실패: ' + (err && err.stack ? err.stack : err));
    return;
  }
  toNotify.forEach(function (o) { notifyCustomer(o, 'confirmed'); });
}

// ---------- 매일 오전 9시 요약 ----------

function sendDailySummary() {
  var cfg = getConfig_();
  var orders = readTable_(SHEET.ORDERS).rows.map(orderFromRow_);
  var deposits = readTable_(SHEET.DEPOSITS).rows;
  var yesterday = ymd_(new Date(Date.now() - 24 * 3600 * 1000));

  var pending = orders.filter(function (o) { return o.status === ORDER_STATUS.PENDING; });
  var unmatched = deposits.filter(function (d) { return cellStr_(d.status) === DEPOSIT_STATUS.UNMATCHED; });
  var expiredYesterday = orders.filter(function (o) {
    var dl = parseDate_(o.depositDeadline);
    return o.status === ORDER_STATUS.EXPIRED && dl && ymd_(dl) === yesterday;
  });

  var orderLine = function (o) {
    return '- ' + o.orderId + ' | ' + o.productName + ' ×' + o.qty + ' | ' + formatWon_(o.amount) +
      ' | 입금자 ' + o.depositorName + ' | 픽업 ' + o.pickupDate + ' ' + o.pickupTime +
      ' | 마감 ' + formatDateTimeKo_(o.depositDeadline);
  };
  var depLine = function (d) {
    return '- ' + cellStr_(d.depositId) + ' | ' + formatDateTimeKo_(cellStr_(d.receivedAt)) +
      ' | ' + (cellStr_(d.parsedName) || '?') + ' ' + (cellStr_(d.parsedAmount) ? formatWon_(cellNum_(d.parsedAmount)) : '?') +
      ' | ' + cellStr_(d.note);
  };

  var counts = {};
  cfg.pickupDates.forEach(function (d) { counts[d] = 0; });
  orders.forEach(function (o) {
    if (o.status === ORDER_STATUS.CONFIRMED && counts.hasOwnProperty(o.pickupDate)) counts[o.pickupDate] += o.qty;
  });

  var body = [
    '오늘의 예약 현황입니다.',
    '',
    '■ 입금대기 ' + pending.length + '건',
    pending.length ? pending.map(orderLine).join('\n') : '- 없음',
    '',
    '■ 확인이 필요한 입금(미매칭) ' + unmatched.length + '건',
    unmatched.length ? unmatched.map(depLine).join('\n') : '- 없음',
    '',
    '■ 어제 만료된 주문 ' + expiredYesterday.length + '건',
    expiredYesterday.length ? expiredYesterday.map(orderLine).join('\n') : '- 없음',
    '',
    '■ 날짜별 확정 수량',
    Object.keys(counts).map(function (d) { return '- ' + d + ': ' + counts[d] + '개'; }).join('\n'),
    '',
    '토스 입금 내역과 대조해 입금된 주문은 Orders 탭 status를 "확정"으로 바꿔 주세요.',
    '미매칭 입금을 처리했다면 Deposits 탭 status를 "매칭완료"(주문을 찾은 경우) 또는 "무시"로 바꾸면 내일 목록에서 빠집니다.'
  ].join('\n');

  notifyOwner_(cfg, '매일 요약 ' + ymd_(new Date()), body);
}
