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
  var refund = cfg.refundPolicy ? '\n\n[환불·변경 안내]\n' + cfg.refundPolicy : '';
  var notices = cfg.notices && cfg.notices.length ? '\n\n[안내]\n' + cfg.notices.join('\n\n') : '';
  // 안내 문구에 환불 규정이 이미 들어 있으면 확정 메일에서 두 번 쓰지 않는다.
  var refundFirstLine = String(cfg.refundPolicy || '').split('\n')[0].trim();
  var refundInNotices = !!refundFirstLine && (cfg.notices || []).some(function (n) { return n.indexOf(refundFirstLine) >= 0; });

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
        '마감 시각까지 입금이 확인되지 않으면 주문이 자동으로 취소됩니다.' + refund + contact
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
        '픽업하실 때 주문번호나 성함을 말씀해 주세요.' + notices + (refundInNotices ? '' : refund) + contact
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
  notifyOwner_(cfg, '확인이 필요한 입금이 있어요 (' + (s.parsedName || '이름 모름') + (s.parsedAmount != null ? ', ' + formatWon_(s.parsedAmount) : '') + ')', [
    '입금 알림이 들어왔는데 어느 주문인지 확실하지 않아 그대로 두었어요.',
    '토스 입금 내역을 보고, 맞는 주문이 있으면 시트 [주문] 탭에서 그 주문의 "상태"를 "확정"으로 바꿔 주세요. 손님에게 확정 메일이 자동으로 가요.',
    '',
    '받은 시각: ' + formatDateTimeKo_(s.receivedAt),
    '입금한 사람: ' + (s.parsedName || '(알림에서 찾지 못함)'),
    '금액: ' + (s.parsedAmount != null ? formatWon_(s.parsedAmount) : '(알림에서 찾지 못함)'),
    '이유: ' + s.note,
    '',
    '받은 알림 내용 그대로',
    s.title,
    s.body,
    '',
    '(시트 [입금] 탭 ' + s.depositId + ' 줄에도 적혀 있어요. 처리했으면 그 줄의 "처리 상태"를 "매칭완료"나 "무시"로 바꿔 두세요.)'
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
