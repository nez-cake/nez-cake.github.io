/**
 * POST action=deposit (docs/API.md 5장, 6장)
 * 토큰 검사 → Deposits에 원문 기록 → Matching.js로 중복 확인·파싱·매칭 → 결과 반영.
 *
 * 자동 확정은 Config autoConfirmEnabled가 TRUE일 때만 한다(기본 FALSE, 1원 테스트 이후 켬).
 * 꺼져 있으면 매칭 결과가 1건이어도 "미매칭"으로 두고 note와 matchedOrderId에 후보를 적은 뒤
 * 사장님에게 메일을 보낸다. 사장님은 시트에서 status를 "확정"으로 바꾸면 된다.
 */

var DUPLICATE_WINDOW_MS = 120000;

function receiveDeposit_(body) {
  if (!isValidDepositToken_(body.token)) {
    throw apiError_('UNAUTHORIZED', '인증에 실패했어요.');
  }

  var serverNow = new Date();
  var title = String(body.title == null ? '' : body.title).substring(0, 1000);
  var text = String(body.body == null ? '' : body.body).substring(0, 5000);
  var receivedAt = parseDate_(body.receivedAt);
  var notes = [];
  if (!receivedAt) {
    receivedAt = serverNow;
    if (body.receivedAt) notes.push('receivedAt 해석 실패(서버 수신 시각 사용): ' + String(body.receivedAt).substring(0, 60));
  }

  var cfg = getConfig_();
  var outcome = withLock_(function () {
    var deps = readTable_(SHEET.DEPOSITS);
    var depositId = nextDepositId_(deps.rows, receivedAt);

    // 1) 원문부터 기록한다. 이후 단계가 실패해도 원문은 남는다.
    var rec = {
      depositId: depositId,
      receivedAt: toIso_(receivedAt),
      rawTitle: safeText_(title),
      rawBody: safeText_(text),
      parsedName: '',
      parsedAmount: '',
      status: DEPOSIT_STATUS.UNMATCHED,
      matchedOrderId: '',
      note: '처리 중'
    };
    deps.sheet.appendRow(toRowArray_(deps.header, rec));
    SpreadsheetApp.flush();
    var rowNum = deps.sheet.getLastRow();

    var res = { depositId: depositId, status: DEPOSIT_STATUS.UNMATCHED, matchedOrderId: null, duplicate: false };
    var confirmedOrder = null;
    var mailOwner = false;
    var parsed = null;

    try {
      if (!matchingModuleReady_()) {
        notes.push('매칭 모듈(Matching.js)이 없어 원문만 기록');
        mailOwner = true;
      } else if (isDuplicateNotification(
          { title: title.trim(), body: text.trim(), receivedAtMs: receivedAt.getTime() },
          recentDepositsForDup_(deps.rows), DUPLICATE_WINDOW_MS)) {
        // 2) 중복 알림
        res.status = DEPOSIT_STATUS.IGNORED;
        res.duplicate = true;
        notes.push('중복 알림(2분 안에 같은 제목·본문)');
      } else {
        // 3) 파싱
        parsed = parseNotification(title, text) || { kind: 'unknown' };
        if (parsed.kind === 'ignore') {
          res.status = DEPOSIT_STATUS.IGNORED;
          notes.push('입금 알림 아님');
        } else if (parsed.kind !== 'deposit') {
          notes.push('알림 해석 실패(파서에 형식 추가 필요)');
          mailOwner = true;
        } else {
          // 4) 매칭
          var orders = readTable_(SHEET.ORDERS);
          var list = orders.rows.map(function (r) {
            return { orderId: cellStr_(r.orderId), status: cellStr_(r.status), amount: cellNum_(r.amount), depositorName: cellStr_(r.depositorName) };
          });
          var m = matchDeposit(parsed, list) || { result: 'none', candidates: [] };
          var cands = (m.candidates || []).join(', ');

          if (m.result === 'matched' && cfg.autoConfirmEnabled) {
            var row = orders.rows.filter(function (r) { return cellStr_(r.orderId) === m.orderId; })[0];
            if (row && cellStr_(row.status) === ORDER_STATUS.PENDING) {
              markOrderConfirmed_(orders, row._row, '자동(' + depositId + ')', depositId, true);
              confirmedOrder = orderFromRow_(row);
              confirmedOrder.status = ORDER_STATUS.CONFIRMED;
              res.status = DEPOSIT_STATUS.MATCHED;
              res.matchedOrderId = m.orderId;
              notes.push('자동 확정');
            } else {
              notes.push('매칭된 주문 상태가 바뀌어 확정하지 않음: ' + m.orderId);
              mailOwner = true;
            }
          } else if (m.result === 'matched') {
            res.matchedOrderId = null;
            notes.push('후보 1건: ' + m.orderId + ' (자동 확정 꺼짐. 확인 후 Orders status를 "확정"으로)');
            rec.matchedOrderId = m.orderId;
            mailOwner = true;
          } else if (m.result === 'notDeposit') {
            res.status = DEPOSIT_STATUS.IGNORED;
            notes.push('입금 알림 아님');
          } else if (m.result === 'expiredMatch') {
            notes.push('만료 주문과 일치: ' + cands);
            mailOwner = true;
          } else if (m.result === 'ambiguous') {
            notes.push((parsed.name ? '' : '입금자명을 읽지 못함, ') + '후보 여러 건: ' + cands);
            mailOwner = true;
          } else {
            notes.push(parsed.name ? '맞는 입금대기 주문 없음' : '입금자명을 읽지 못함(금액만으로는 확정하지 않음)' + (cands ? ': ' + cands : ''));
            mailOwner = true;
          }
        }
      }
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      notes.push('처리 중 오류: ' + (err && err.message ? err.message : err));
      mailOwner = true;
    }

    // 5) 결과 반영
    if (parsed && parsed.kind === 'deposit') {
      setCell_(deps, rowNum, 'parsedName', safeText_(parsed.name || ''));
      setCell_(deps, rowNum, 'parsedAmount', parsed.amount == null ? '' : parsed.amount);
    }
    setCell_(deps, rowNum, 'status', res.status);
    setCell_(deps, rowNum, 'matchedOrderId', res.matchedOrderId || rec.matchedOrderId || '');
    setCell_(deps, rowNum, 'note', safeText_(notes.join(' / ')));

    return {
      res: res,
      confirmedOrder: confirmedOrder,
      mailOwner: mailOwner && res.status === DEPOSIT_STATUS.UNMATCHED,
      summary: {
        depositId: depositId, receivedAt: toIso_(receivedAt), title: title, body: text,
        parsedName: parsed && parsed.name, parsedAmount: parsed && parsed.amount, note: notes.join(' / ')
      }
    };
  });

  // 메일은 잠금 밖에서. 실패해도 기록·확정은 이미 끝났다.
  if (outcome.confirmedOrder) notifyCustomer(outcome.confirmedOrder, 'confirmed');
  if (outcome.mailOwner) notifyOwnerUnmatched_(cfg, outcome.summary);

  return outcome.res;
}

function matchingModuleReady_() {
  return typeof parseNotification === 'function' &&
    typeof matchDeposit === 'function' &&
    typeof isDuplicateNotification === 'function';
}

/** Script Properties의 DEPOSIT_TOKEN과 비교. 토큰이 설정되어 있지 않으면 항상 거부. */
function isValidDepositToken_(given) {
  var expected = getProp_('DEPOSIT_TOKEN');
  if (!expected || expected.length < 32 || typeof given !== 'string') return false;
  if (given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** D-YYYYMMDD-NNNN. 같은 날짜의 마지막 번호 + 1. */
function nextDepositId_(rows, when) {
  var prefix = 'D-' + Utilities.formatDate(when, TZ, 'yyyyMMdd') + '-';
  var max = 0;
  rows.forEach(function (r) {
    var id = cellStr_(r.depositId);
    if (id.indexOf(prefix) === 0) {
      var n = Number(id.substring(prefix.length));
      if (n > max) max = n;
    }
  });
  return prefix + ('000' + (max + 1)).slice(-4);
}

/** 중복 판정용 최근 알림(마지막 50건). */
function recentDepositsForDup_(rows) {
  return rows.slice(-50).map(function (r) {
    var d = parseDate_(r.receivedAt);
    return { title: cellStr_(r.rawTitle), body: cellStr_(r.rawBody), receivedAtMs: d ? d.getTime() : 0 };
  });
}
