/**
 * 시트 위쪽 "예약 관리" 메뉴. 시트를 열 때마다(onOpen, 단순 트리거) 만들어진다.
 * 메뉴 기능은 누른 사람 계정으로 실행된다. 처음 누를 때 그 계정에 권한 허용 창이 한 번 뜬다.
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('예약 관리')
    .addItem('선택한 주문 확정하기', 'menuConfirmSelected')
    .addItem('선택한 주문 취소하기', 'menuCancelSelected')
    .addSeparator()
    .addItem('오늘 픽업 명단 보기', 'menuShowTodayPickup')
    .addItem('주문 받기 시작 / 중지', 'menuToggleOrders')
    .addItem('설정 점검', 'menuCheckSettings')
    .addSeparator()
    .addItem('시트 모양 다시 정리하기', 'menuSetupSheets')
    .addToUi();
}

function alert_(msg) {
  SpreadsheetApp.getUi().alert(msg);
}

function ask_(msg) {
  var ui = SpreadsheetApp.getUi();
  return ui.alert(msg, ui.ButtonSet.YES_NO) === ui.Button.YES;
}

/** 지금 선택한 칸들이 걸친 주문 탭의 행 번호들(머리글 제외, 중복 제거) */
function selectedOrderRows_() {
  var sh = SpreadsheetApp.getActiveSheet();
  if (tableNameOf_(sh) !== SHEET.ORDERS) return null;
  var rows = {};
  var list = sh.getActiveRangeList();
  var ranges = list ? list.getRanges() : [sh.getActiveRange()];
  ranges.forEach(function (rg) {
    for (var r = rg.getRow(); r <= rg.getLastRow(); r++) if (r >= 2) rows[r] = true;
  });
  return Object.keys(rows).map(Number).sort(function (a, b) { return a - b; });
}

function whoAmI_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
  return email ? email + '(메뉴)' : '사장님(메뉴)';
}

// ---------- 확정 ----------

function menuConfirmSelected() {
  var rowNums = selectedOrderRows_();
  if (!rowNums) return alert_('[주문] 탭에서 확정할 주문 줄을 먼저 선택해 주세요.');

  var t = readTable_(SHEET.ORDERS);
  var picked = t.rows.filter(function (r) { return rowNums.indexOf(r._row) >= 0; }).map(orderFromRow_);
  var targets = picked.filter(function (o) { return o.status === ORDER_STATUS.PENDING || o.status === ORDER_STATUS.EXPIRED; });
  if (!targets.length) return alert_('선택한 줄에 "입금대기"나 "만료" 주문이 없어요. 이미 확정됐거나 빈 줄이에요.');

  var expired = targets.filter(function (o) { return o.status === ORDER_STATUS.EXPIRED; });
  var msg = targets.map(function (o) { return o.orderId + '  ' + o.customerName + '  ' + o.productName + ' ' + o.qty + '개'; }).join('\n') +
    '\n\n이 ' + targets.length + '건을 확정할까요? 이메일을 적은 손님에게는 확정 메일이 가요.' +
    (expired.length ? '\n\n※ 이 중 ' + expired.length + '건은 이미 "만료"된 주문이에요. 그 사이 다른 손님이 주문해 날짜 수량을 넘을 수 있어요.' : '');
  if (!ask_(msg)) return;

  var who = whoAmI_();
  var done = withLock_(function () {
    var cur = readTable_(SHEET.ORDERS);
    var out = [];
    cur.rows.forEach(function (r) {
      var o = orderFromRow_(r);
      if (!targets.some(function (x) { return x.orderId === o.orderId; })) return;
      if (o.status !== ORDER_STATUS.PENDING && o.status !== ORDER_STATUS.EXPIRED) return;
      markOrderConfirmed_(cur, r._row, who, '', true);
      o.status = ORDER_STATUS.CONFIRMED;
      out.push(o);
    });
    return out;
  }, 30000);
  done.forEach(function (o) { notifyCustomer(o, 'confirmed'); });
  var mailed = done.filter(function (o) { return o.email; }).length;
  alert_(done.length + '건을 확정했어요.' + (mailed ? ' 확정 메일을 ' + mailed + '명에게 보냈어요.' : ' (이메일을 적은 손님이 없어 메일은 보내지 않았어요.)'));
}

// ---------- 취소 ----------

function menuCancelSelected() {
  var rowNums = selectedOrderRows_();
  if (!rowNums) return alert_('[주문] 탭에서 취소할 주문 줄을 먼저 선택해 주세요.');

  var t = readTable_(SHEET.ORDERS);
  var targets = t.rows.filter(function (r) { return rowNums.indexOf(r._row) >= 0; }).map(orderFromRow_)
    .filter(function (o) { return o.orderId && o.status !== ORDER_STATUS.CANCELED; });
  if (!targets.length) return alert_('선택한 줄에 취소할 주문이 없어요.');

  var paid = targets.filter(function (o) { return o.status === ORDER_STATUS.CONFIRMED || o.status === ORDER_STATUS.PICKED_UP; });
  var msg = targets.map(function (o) { return o.orderId + '  ' + o.customerName + '  ' + o.status; }).join('\n') +
    '\n\n이 ' + targets.length + '건을 "취소"로 바꿀까요? 그 개수만큼 다시 주문을 받을 수 있게 돼요.' +
    (paid.length ? '\n\n※ 이미 입금한 주문이 ' + paid.length + '건 있어요. 환불은 토스에서 직접 보내 주세요.' +
      (getConfig_().refundPolicy ? '\n\n환불 규정: ' + getConfig_().refundPolicy : '') : '');
  if (!ask_(msg)) return;

  var n = withLock_(function () {
    var cur = readTable_(SHEET.ORDERS);
    var count = 0;
    cur.rows.forEach(function (r) {
      if (!targets.some(function (x) { return x.orderId === cellStr_(r.orderId); })) return;
      if (cellStr_(r.status) === ORDER_STATUS.CANCELED) return;
      setCell_(cur, r._row, 'status', ORDER_STATUS.CANCELED);
      count++;
    });
    return count;
  }, 30000);
  alert_(n + '건을 취소했어요.');
}

// ---------- 픽업 명단 ----------

function menuShowTodayPickup() {
  var cfg = getConfig_();
  var sh = findSheet_(SHEET.PICKUP_VIEW);
  if (!sh) return alert_('[픽업 명단] 탭이 없어요. 메뉴 [예약 관리 → 시트 모양 다시 정리하기]를 먼저 눌러 주세요.');
  var today = ymd_(new Date());
  var day = today;
  var note = '';
  if (cfg.pickupDates.indexOf(today) < 0) {
    day = cfg.pickupDates.filter(function (d) { return d >= today; })[0] || cfg.pickupDates[0];
    note = '오늘은 픽업 날이 아니라서 가장 가까운 ' + koMonthDay_(day) + ' 명단을 보여 드려요.';
  }
  sh.getRange('B1').setValue(day);
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sh);
  if (note) alert_(note);
}

// ---------- 주문 받기 켜고 끄기 ----------

function menuToggleOrders() {
  var sh = getSheet_(SHEET.CONFIG);
  var t = readTable_(SHEET.CONFIG);
  var row = t.rows.filter(function (r) { return cellStr_(r.key) === 'orderEnabled'; })[0];
  if (!row) return alert_('[설정] 탭에 "주문 받기" 줄이 없어요. 메뉴 [예약 관리 → 시트 모양 다시 정리하기]를 먼저 눌러 주세요.');
  var next = !cellBool_(row.value);
  sh.getRange(row._row, t.col.value).setValue(next);
  configCache_ = null;
  var cfg = getConfig_();
  var range = Utilities.formatDate(cfg.orderOpenAt, TZ, 'M월 d일 HH:mm') + ' ~ ' + Utilities.formatDate(cfg.orderCloseAt, TZ, 'M월 d일 HH:mm');
  if (!next) return alert_('지금부터 주문을 받지 않아요. 주문 페이지에 "접수 기간이 아니에요"로 보여요.');
  if (isOrderOpen_(cfg, new Date())) return alert_('지금부터 다시 주문을 받아요.');
  alert_('"주문 받기"를 켰어요. 다만 지금은 접수 기간(' + range + ')이 아니라서 기간이 되면 자동으로 열려요. 바로 열려면 [설정] 탭 "주문 받기 시작"을 고쳐 주세요.');
}

// ---------- 설정 점검 ----------

function menuCheckSettings() {
  var added = ensureCapacityRows_();
  var r = settingsReport_();
  var msg = '';
  if (added.length) msg += '[설정] 탭 맨 아래에 ' + added.map(koMonthDay_).join(', ') + ' 수량 줄을 만들었어요. 숫자를 적어 주세요.\n\n';
  msg += r.problems.length ? '고칠 것\n- ' + r.problems.join('\n- ') : '고칠 것이 없어요.';
  msg += '\n\n지금 상태\n- ' + r.info.join('\n- ');
  alert_(msg);
}

// ---------- 시트 정리 ----------

function menuSetupSheets() {
  if (!ask_('탭 이름, 머리글, 설정 모양, 색, 사용법 탭을 새로 정리할까요?\n주문·입금 기록과 설정 값은 그대로 남아요.')) return;
  setupSheets();
  alert_('정리했어요. 맨 앞 [사용법] 탭을 한 번 읽어 보세요.');
}
