/**
 * 손님·사장님 안내. 손님 안내는 notifyCustomer() 한 곳으로 모은다.
 * 어떤 안내가 실패해도 예외를 밖으로 던지지 않는다(주문 기록과 확정을 막지 않기 위해).
 */

/**
 * @param {Object} order orderFromRow_() 모양의 주문
 * @param {string} kind 'received' | 'confirmed' | 'reminder'
 */
function notifyCustomer(order, kind) {
  var cfg;
  try {
    cfg = getConfig_();
  } catch (e) {
    console.error('notifyCustomer: Config 읽기 실패', e);
    return;
  }

  if (order.email) {
    try {
      var msg = buildCustomerMail_(cfg, order, kind);
      if (msg) {
        if (MailApp.getRemainingDailyQuota() < 1) throw new Error('오늘 메일 발송 한도를 다 썼습니다.');
        var opts = { name: cfg.cafeName };
        if (cfg.ownerEmail) opts.replyTo = cfg.ownerEmail;
        MailApp.sendEmail(order.email, msg.subject, msg.body, opts);
      }
    } catch (e) {
      console.error('손님 메일 실패 ' + order.orderId + ' ' + kind + ': ' + e);
    }
  }

  try {
    sendSms_(order, kind);
  } catch (e) {
    console.error('문자 발송 실패 ' + order.orderId + ': ' + e);
  }
}

/** 문자·알림톡 자리. 나중에 문자 API를 붙일 때 여기만 채운다. */
function sendSms_(order, kind) {
  // 구현하지 않음. order.phone, kind를 받아 문자 API로 보내면 된다.
}

function buildCustomerMail_(cfg, o, kind) {
  var cafe = cfg.cafeName;
  var line = '────────────────';
  var item = o.productName + ' × ' + o.qty;
  var pickup = formatPickup_(o.pickupDate, o.pickupTime);
  var amount = formatWon_(o.amount);
  var deadline = formatDateTimeKo_(o.depositDeadline);
  var account = cfg.bankName + ' ' + cfg.accountNumber + ' (예금주 ' + cfg.accountHolder + ')';
  var contact = cfg.bizPhone ? '\n문의: ' + cfg.bizPhone : '';
  var lettering = o.lettering ? '\n레터링: ' + o.lettering : '';

  if (kind === 'received') {
    return {
      subject: '[' + cafe + '] 주문이 접수되었어요 (' + o.orderId + ')',
      body: [
        o.customerName + '님, 주문해 주셔서 감사합니다.',
        '아래 계좌로 입금하시면 예약이 확정됩니다.',
        '',
        line,
        '주문번호: ' + o.orderId,
        '케이크: ' + item + lettering,
        '픽업: ' + pickup,
        '',
        '입금 계좌: ' + account,
        '입금 금액: ' + amount,
        '입금자명: ' + o.depositorName + '  ← 이 이름 그대로 입금해 주세요',
        '입금 마감: ' + deadline,
        line,
        '',
        '마감 시각까지 입금이 확인되지 않으면 주문이 자동으로 취소됩니다.' + contact
      ].join('\n')
    };
  }
  if (kind === 'confirmed') {
    return {
      subject: '[' + cafe + '] 예약이 확정되었어요 (' + o.orderId + ')',
      body: [
        o.customerName + '님, 입금이 확인되어 예약이 확정되었습니다.',
        '',
        line,
        '주문번호: ' + o.orderId,
        '케이크: ' + item + lettering,
        '금액: ' + amount,
        '픽업: ' + pickup,
        line,
        '',
        '픽업하실 때 주문번호나 성함을 말씀해 주세요.' + contact
      ].join('\n')
    };
  }
  if (kind === 'reminder') {
    return {
      subject: '[' + cafe + '] 입금 마감 30분 전이에요 (' + o.orderId + ')',
      body: [
        o.customerName + '님, 주문하신 케이크의 입금 마감이 30분 남았어요.',
        '',
        '입금 계좌: ' + account,
        '입금 금액: ' + amount,
        '입금자명: ' + o.depositorName,
        '입금 마감: ' + deadline,
        '',
        '이미 입금하셨는데 이 메일을 받으셨다면 카페로 연락 주세요. 확인 후 바로 확정해 드릴게요.' +
          (cfg.bizPhone ? '\n연락처: ' + cfg.bizPhone : '') +
          (cfg.instagramUrl ? '\n인스타그램: ' + cfg.instagramUrl : '')
      ].join('\n')
    };
  }
  return null;
}

// ---------- 사장님 메일 ----------

function notifyOwner_(cfg, subject, body) {
  try {
    var to = ownerEmail_(cfg);
    if (!to) {
      console.error('사장님 메일 주소가 없습니다: ' + subject);
      return;
    }
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('오늘 메일 발송 한도를 다 썼습니다.');
    MailApp.sendEmail(to, '[' + cfg.cafeName + ' 예약] ' + subject, body);
  } catch (e) {
    console.error('사장님 메일 실패: ' + subject + ': ' + e);
  }
}

function notifyOwnerUnmatched_(cfg, s) {
  notifyOwner_(cfg, '확인이 필요한 입금 ' + s.depositId, [
    '자동으로 처리하지 못한 입금 알림이 있어요. Deposits 탭과 토스 내역을 확인해 주세요.',
    '해당 주문이 맞으면 Orders 탭에서 status를 "확정"으로 바꾸면 손님에게 확정 메일이 갑니다.',
    '',
    '입금번호: ' + s.depositId,
    '수신 시각: ' + formatDateTimeKo_(s.receivedAt),
    '읽은 입금자명: ' + (s.parsedName || '(없음)'),
    '읽은 금액: ' + (s.parsedAmount != null ? formatWon_(s.parsedAmount) : '(없음)'),
    '메모: ' + s.note,
    '',
    '알림 원문',
    '제목: ' + s.title,
    '내용: ' + s.body
  ].join('\n'));
}

// ---------- 표시 형식 ----------

var KO_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function formatWon_(n) {
  return Number(n).toLocaleString('ko-KR') + '원';
}

function formatPickup_(dateStr, timeStr) {
  var d = new Date(dateStr + 'T12:00:00+09:00');
  if (isNaN(d.getTime())) return dateStr + ' ' + timeStr;
  var wd = KO_WEEKDAYS[Number(Utilities.formatDate(d, TZ, 'u')) % 7];
  return Utilities.formatDate(d, TZ, 'M월 d일') + '(' + wd + ') ' + timeStr;
}

function formatDateTimeKo_(iso) {
  var d = parseDate_(iso);
  if (!d) return String(iso || '');
  return Utilities.formatDate(d, TZ, 'M월 d일 HH:mm');
}
