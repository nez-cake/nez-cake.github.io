/**
 * POST action=order (docs/API.md 3장), GET ?action=status (4장), 주문 확정 공통 처리.
 */

var ORDER_ID_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
var PHONE_RE = /^01[016789]\d{7,8}$/;
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- 주문 생성 ----------

function createOrder_(body) {
  var cfg = getConfig_();
  var products = getActiveProducts_();
  var input = validateOrderInput_(body, cfg, products);
  var product = products.filter(function (p) { return p.productId === input.productId; })[0];

  var result = withLock_(function () {
    var table = readTable_(SHEET.ORDERS);
    var now = new Date();

    // 1) 같은 clientRequestId로 이미 만든 주문이 있으면 그대로 돌려준다.
    if (input.clientRequestId) {
      var dup = table.rows.filter(function (r) { return cellStr_(r.clientRequestId) === input.clientRequestId; })[0];
      if (dup) return { created: false, order: orderFromRow_(dup) };
    }

    // 2) 접수 기간
    if (!isOrderOpen_(cfg, now)) {
      throw apiError_('ORDER_CLOSED', '지금은 주문 접수 기간이 아니에요.');
    }

    // 3) 같은 전화번호의 입금대기 주문 수
    var pendingCount = table.rows.filter(function (r) {
      return cellStr_(r.status) === ORDER_STATUS.PENDING && normalizePhone_(r.phone) === input.phone;
    }).length;
    if (pendingCount >= cfg.maxPendingPerPhone) {
      throw apiError_('TOO_MANY_PENDING', '입금을 기다리는 주문이 이미 ' + cfg.maxPendingPerPhone +
        '건 있어요. 먼저 입금하시거나 카페로 문의해 주세요.');
    }

    // 4) 남은 수량
    var avail = computeAvailability_(cfg, products, table.rows);
    var left = (avail[input.pickupDate] || {})[input.productId] || 0;
    if (left < input.qty) {
      throw apiError_('SOLD_OUT', left > 0
        ? '선택한 날짜에 이 케이크는 ' + left + '개만 남았어요.'
        : '선택한 날짜의 케이크가 마감되었어요.', left > 0 ? 'qty' : 'pickupDate');
    }

    // 5) 입금 마감: 주문 시각 + N시간, 단 픽업일 전날 23:59를 넘지 않는다.
    var deadline = computeDepositDeadline_(now, input.pickupDate, cfg.depositDeadlineHours);
    if (deadline.getTime() <= now.getTime()) {
      throw apiError_('INVALID_INPUT', '이 날짜는 입금 마감이 지나 주문할 수 없어요.', 'pickupDate');
    }

    var existingIds = {};
    table.rows.forEach(function (r) { existingIds[cellStr_(r.orderId)] = true; });

    var order = {
      orderId: generateOrderId_(input.pickupDate, existingIds),
      createdAt: toIso_(now),
      status: ORDER_STATUS.PENDING,
      productId: product.productId,
      productName: product.name,
      pickupDate: input.pickupDate,
      pickupTime: input.pickupTime,
      qty: input.qty,
      amount: product.price * input.qty,
      customerName: input.customerName,
      phone: input.phone,
      email: input.email,
      depositorName: input.depositorName,
      lettering: input.lettering,
      memo: input.memo,
      depositDeadline: toIso_(deadline),
      confirmedAt: '',
      confirmedBy: '',
      depositId: '',
      clientRequestId: input.clientRequestId
    };

    table.sheet.appendRow(toRowArray_(table, order));
    return { created: true, order: order };
  });

  // 메일은 잠금 밖에서. 실패해도 주문은 이미 기록되어 있다.
  if (result.created) notifyCustomer(result.order, 'received');

  var o = result.order;
  return {
    orderId: o.orderId,
    status: o.status,
    productName: o.productName,
    qty: o.qty,
    amount: o.amount,
    pickupDate: o.pickupDate,
    pickupTime: o.pickupTime,
    depositorName: o.depositorName,
    depositDeadline: o.depositDeadline,
    account: accountInfo_(cfg)
  };
}

function validateOrderInput_(b, cfg, products) {
  var bad = function (field, msg) { throw apiError_('INVALID_INPUT', msg, field); };
  var str = function (v) { return v === null || v === undefined ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); };

  var productId = str(b.productId);
  if (!products.some(function (p) { return p.productId === productId; })) bad('productId', '케이크를 선택해 주세요.');

  var qty = typeof b.qty === 'string' && /^\d+$/.test(b.qty.trim()) ? Number(b.qty) : b.qty;
  if (typeof qty !== 'number' || !isFinite(qty) || Math.floor(qty) !== qty || qty < 1 || qty > cfg.maxQtyPerOrder) {
    bad('qty', '수량은 1개부터 ' + cfg.maxQtyPerOrder + '개까지 고를 수 있어요.');
  }

  var pickupDate = str(b.pickupDate);
  if (cfg.pickupDates.indexOf(pickupDate) < 0) bad('pickupDate', '픽업 날짜를 선택해 주세요.');

  var pickupTime = str(b.pickupTime);
  if (cfg.pickupTimes.indexOf(pickupTime) < 0) bad('pickupTime', '픽업 시간을 선택해 주세요.');

  var customerName = str(b.customerName);
  if (customerName.length < 1 || customerName.length > 20) bad('customerName', '이름을 1~20자로 적어 주세요.');

  var phone = str(b.phone).replace(/[\s-]/g, '');
  if (!PHONE_RE.test(phone)) bad('phone', '휴대폰 번호를 정확히 적어 주세요.');

  var email = str(b.email);
  if (email && (email.length > 100 || !EMAIL_RE.test(email))) bad('email', '이메일 주소 형식을 확인해 주세요.');

  var depositorName = str(b.depositorName);
  if (depositorName.length < 1 || depositorName.length > 20) bad('depositorName', '입금자명을 1~20자로 적어 주세요.');

  var lettering = str(b.lettering);
  if (!cfg.letteringEnabled) {
    lettering = '';
  } else if (lettering.length > cfg.letteringMaxLength) {
    bad('lettering', '레터링 문구는 ' + cfg.letteringMaxLength + '자까지 적을 수 있어요.');
  }

  var memo = str(b.memo);
  if (memo.length > 200) bad('memo', '요청사항은 200자까지 적을 수 있어요.');

  if (b.agreePrivacy !== true) bad('agreePrivacy', '개인정보 수집·이용에 동의해 주세요.');

  var clientRequestId = str(b.clientRequestId).substring(0, 100);

  return {
    productId: productId, qty: qty, pickupDate: pickupDate, pickupTime: pickupTime,
    customerName: customerName, phone: phone, email: email, depositorName: depositorName,
    lettering: lettering, memo: memo, clientRequestId: clientRequestId
  };
}

function computeDepositDeadline_(now, pickupDate, hours) {
  var byHours = new Date(now.getTime() + hours * 3600 * 1000);
  var pickupEveLimit = new Date(new Date(pickupDate + 'T23:59:00+09:00').getTime() - 24 * 3600 * 1000);
  return byHours.getTime() < pickupEveLimit.getTime() ? byHours : pickupEveLimit;
}

/** C-MMDD-XXXX. 시트에 이미 있으면 다시 뽑는다. */
function generateOrderId_(pickupDate, existingIds) {
  var mmdd = pickupDate.substring(5, 7) + pickupDate.substring(8, 10);
  for (var tries = 0; tries < 50; tries++) {
    var s = '';
    for (var i = 0; i < 4; i++) s += ORDER_ID_CHARS.charAt(Math.floor(Math.random() * ORDER_ID_CHARS.length));
    var id = 'C-' + mmdd + '-' + s;
    if (!existingIds[id]) return id;
  }
  throw new Error('주문번호를 만들지 못했습니다.');
}

function normalizePhone_(v) {
  var s = cellStr_(v).replace(/\D/g, '');
  // 사장님이 셀 서식을 바꿔 앞자리 0이 빠진 경우
  if (/^1[016789]\d{7,8}$/.test(s)) s = '0' + s;
  return s;
}

/** 시트 행 → 주문 객체(문자열·숫자로 정리). */
function orderFromRow_(r) {
  return {
    _row: r._row,
    orderId: cellStr_(r.orderId),
    createdAt: cellIso_(r.createdAt),
    status: cellStr_(r.status),
    productId: cellStr_(r.productId),
    productName: cellStr_(r.productName),
    pickupDate: cellStr_(r.pickupDate),
    pickupTime: cellStr_(r.pickupTime),
    qty: cellNum_(r.qty),
    amount: cellNum_(r.amount),
    customerName: cellStr_(r.customerName),
    phone: normalizePhone_(r.phone),
    email: cellStr_(r.email),
    depositorName: cellStr_(r.depositorName),
    lettering: cellStr_(r.lettering),
    memo: cellStr_(r.memo),
    depositDeadline: cellIso_(r.depositDeadline),
    confirmedAt: cellIso_(r.confirmedAt),
    confirmedBy: cellStr_(r.confirmedBy),
    depositId: cellStr_(r.depositId),
    clientRequestId: cellStr_(r.clientRequestId)
  };
}

// ---------- 주문 조회 ----------

function getOrderStatus_(orderId, phone4) {
  var id = String(orderId || '').trim().toUpperCase();
  var p4 = String(phone4 || '').trim();
  var notFound = apiError_('NOT_FOUND', '주문번호와 전화번호 뒷 4자리가 맞는 주문을 찾지 못했어요.');
  if (!id || !/^\d{4}$/.test(p4)) throw notFound;

  var row = readTable_(SHEET.ORDERS).rows.filter(function (r) { return cellStr_(r.orderId) === id; })[0];
  if (!row) throw notFound;
  var o = orderFromRow_(row);
  if (o.phone.slice(-4) !== p4) throw notFound;

  var data = {
    orderId: o.orderId,
    status: o.status,
    productName: o.productName,
    qty: o.qty,
    amount: o.amount,
    pickupDate: o.pickupDate,
    pickupTime: o.pickupTime,
    depositDeadline: o.depositDeadline
  };
  if (o.status === ORDER_STATUS.PENDING) data.account = accountInfo_(getConfig_());
  return data;
}

// ---------- 성함 + 연락처로 찾기 (API.md 4-1장) ----------

var LOOKUP_MAX_FAILS = 10;      // 같은 연락처로 1분에 틀릴 수 있는 횟수
var LOOKUP_WINDOW_SEC = 60;

function lookupOrders_(b) {
  var name = String(b.customerName == null ? '' : b.customerName).replace(/[\s 　]+/g, '');
  var phone = String(b.phone == null ? '' : b.phone).replace(/\D/g, '');
  if (name.length < 1 || name.length > 20) {
    throw apiError_('INVALID_INPUT', '성함을 1~20자로 적어 주세요.', 'customerName');
  }
  if (!PHONE_RE.test(phone)) throw apiError_('INVALID_INPUT', '휴대폰 번호를 정확히 적어 주세요.', 'phone');

  var cache = CacheService.getScriptCache();
  var key = 'lookupFail:' + phone;
  var fails = Number(cache.get(key)) || 0;
  if (fails >= LOOKUP_MAX_FAILS) {
    throw apiError_('BUSY', '여러 번 맞지 않았어요. 1분 뒤에 다시 시도해 주세요.');
  }

  var cfg = null;
  var found = readTable_(SHEET.ORDERS).rows.map(orderFromRow_).filter(function (o) {
    return o.orderId && o.phone === phone && o.customerName.replace(/[\s 　]+/g, '') === name;
  });
  if (!found.length) {
    cache.put(key, String(fails + 1), LOOKUP_WINDOW_SEC);
    throw apiError_('NOT_FOUND', '성함과 연락처가 맞는 주문을 찾지 못했어요.');
  }

  found.sort(function (x, y) {
    var a = parseDate_(x.createdAt), c = parseDate_(y.createdAt);
    return (c ? c.getTime() : 0) - (a ? a.getTime() : 0) || y._row - x._row;
  });
  return {
    orders: found.slice(0, 5).map(function (o) {
      var d = {
        orderId: o.orderId,
        status: o.status,
        productName: o.productName,
        qty: o.qty,
        amount: o.amount,
        pickupDate: o.pickupDate,
        pickupTime: o.pickupTime,
        depositorName: o.depositorName,
        depositDeadline: o.depositDeadline
      };
      if (o.status === ORDER_STATUS.PENDING) d.account = accountInfo_(cfg || (cfg = getConfig_()));
      return d;
    })
  };
}

// ---------- 확정 ----------

/**
 * 주문 행에 확정 정보를 채운다. 잠금 안에서 부른다.
 * setStatus=false는 사장님이 status 셀을 이미 "확정"으로 바꾼 경우(onEdit).
 * 확정 메일은 돌려받은 주문으로 부르는 쪽에서 잠금 밖에서 보낸다.
 */
function markOrderConfirmed_(table, rowNum, confirmedBy, depositId, setStatus) {
  if (setStatus) setCell_(table, rowNum, 'status', ORDER_STATUS.CONFIRMED);
  setCell_(table, rowNum, 'confirmedAt', new Date());
  setCell_(table, rowNum, 'confirmedBy', safeText_(confirmedBy));
  if (depositId) setCell_(table, rowNum, 'depositId', depositId);
}
