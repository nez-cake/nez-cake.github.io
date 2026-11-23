/**
 * Matching.js - 입금 알림 파서와 주문 매칭 (시트와 무관한 순수 함수)
 *
 * Apps Script에서는 전역 함수로, Node에서는 require('./Matching.js')로 쓴다.
 * 규칙은 SPEC.md 5장, 함수 계약은 docs/API.md 6장.
 *
 * !!! 아래 NOTIFICATION_PATTERNS는 "가상 샘플"이다. 실제 토스 알림 원문이 아니다.
 * !!! 1원 테스트로 실제 원문을 얻으면 samples/notifications.txt에 붙여 넣고
 * !!! 패턴을 교체하거나 추가한다. (docs/SHORTCUT.md 참고)
 */

// 입금이 아닌 알림. 하나라도 걸리면 kind: "ignore".
// 사람 이름에 "이자"가 들어갈 수 있어("이자영님") 이자는 단어 단위로만 거른다.
var IGNORE_PATTERNS = [
  /출금/,
  /결제/,
  /\(광고\)|\[광고\]|광고/,
  /(^|\s)이자(\s|가|를|은|는|$)/,
  /(이벤트|혜택|쿠폰)/,
  /님에게\s*[\d,]+\s*원을?\s*(보냈|송금)/ // 내가 보낸 돈
];

// 순서대로 시도하고 처음 맞는 것을 쓴다. 구체적인 형식을 앞에, 금액만 있는 것을 맨 뒤에 둔다.
// name / amount는 캡처 그룹 번호이고, name이 null이면 이름 없이 금액만 뽑는 패턴이다.
// 가상 샘플, 1원 테스트 후 교체.
var NOTIFICATION_PATTERNS = [
  {
    id: 'sample-nim-ipgeum', // 예: "홍길동님이 38,000원을 입금했어요" (가상)
    regex: /(\S+?)님(?:이|께서)\s*([\d,]+)\s*원을?\s*(?:입금|보냈)/,
    name: 1,
    amount: 2
  },
  {
    id: 'sample-bank-paren', // 예: "홍길동(국민) 38,000원 입금" (가상, 타행 이체 형식)
    regex: /(\S+?)\s*\([^)]*\)\s*([\d,]+)\s*원\s*입금/,
    name: 1,
    amount: 2
  },
  {
    id: 'sample-title-amount-name', // 예: 제목 "입금 38,000원" + 본문 "홍길동 · 토스뱅크" (가상)
    regex: /입금\s*([\d,]+)\s*원\s*[|·\/\n]?\s*(?!내\s|토스|통장|계좌|입금)([가-힣A-Za-z][^\s|·\/]*)/,
    name: 2,
    amount: 1
  },
  {
    id: 'sample-depositor-label', // 예: "입금자 홍길동 / 금액 38,000원" (가상)
    regex: /입금자\s*[:：]?\s*(\S+)[\s\S]*?([\d,]+)\s*원/,
    name: 1,
    amount: 2
  },
  {
    id: 'sample-amount-only', // 이름 없이 금액만: "38,000원 입금" 또는 "입금 38,000원" (가상)
    regex: /(?:([\d,]+)\s*원\s*(?:이\s*)?입금|입금\s*(?:완료\s*)?([\d,]+)\s*원)/,
    name: null,
    amount: [1, 2]
  }
];

function parseAmount_(str) {
  if (str == null) return null;
  var n = parseInt(String(str).replace(/[,\s원]/g, ''), 10);
  return isFinite(n) && n > 0 ? n : null;
}

function parseNotification(title, body) {
  var text = String(title == null ? '' : title) + '\n' + String(body == null ? '' : body);
  var i, m;

  for (i = 0; i < IGNORE_PATTERNS.length; i++) {
    if (IGNORE_PATTERNS[i].test(text)) {
      return { kind: 'ignore', name: null, amount: null, pattern: null };
    }
  }

  for (i = 0; i < NOTIFICATION_PATTERNS.length; i++) {
    var p = NOTIFICATION_PATTERNS[i];
    m = p.regex.exec(text);
    if (!m) continue;

    var amountStr = null;
    var idx = [].concat(p.amount);
    for (var k = 0; k < idx.length; k++) {
      if (m[idx[k]]) { amountStr = m[idx[k]]; break; }
    }
    var amount = parseAmount_(amountStr);
    if (amount === null) continue;

    var name = null;
    if (p.name !== null && m[p.name]) {
      name = String(m[p.name]).replace(/^[\s:：]+|[\s,.]+$/g, '') || null;
    }
    return { kind: 'deposit', name: name, amount: amount, pattern: p.id };
  }

  return { kind: 'unknown', name: null, amount: null, pattern: null };
}

// 공백과 괄호(괄호 안 문자 포함)를 지운다. "홍길동 (국민)" -> "홍길동"
function normalizeName(s) {
  var t = String(s == null ? '' : s);
  var prev;
  do {
    prev = t;
    t = t.replace(/\([^()]*\)|\[[^\[\]]*\]|（[^（）]*）/g, '');
  } while (t !== prev);
  t = t.replace(/[()\[\]（）]/g, ''); // 짝 없는 괄호 찌꺼기
  return t.replace(/[\s\u00a0\u3000]+/g, '');
}

// 정규화 후 같거나 한쪽이 다른 쪽의 앞부분이면 true (은행이 긴 이름을 자르는 경우). 빈 값은 false.
function namesMatch(a, b) {
  var x = normalizeName(a);
  var y = normalizeName(b);
  if (!x || !y) return false;
  return x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0;
}

// 이름 없이 금액만 있으면 자동 확정하지 않는다: 금액 일치 입금대기 주문이 있으면 candidates에 담아
// 2건 이상은 "ambiguous", 0~1건은 "none"으로 돌려준다(1건이어도 확정 안 함, 사람이 확인).
function matchDeposit(parsed, orders) {
  if (!parsed || parsed.kind !== 'deposit') {
    return { result: 'notDeposit', orderId: null, candidates: [] };
  }
  var list = orders || [];
  var amount = parsed.amount;
  if (amount == null) return { result: 'none', orderId: null, candidates: [] };

  var byAmount = function (status) {
    return list.filter(function (o) { return o.status === status && Number(o.amount) === amount; });
  };
  var ids = function (arr) { return arr.map(function (o) { return o.orderId; }); };

  if (!parsed.name) {
    var pendingAmt = byAmount('입금대기');
    var c = ids(pendingAmt);
    return { result: c.length >= 2 ? 'ambiguous' : 'none', orderId: null, candidates: c };
  }

  var forName = function (status) {
    return byAmount(status).filter(function (o) { return namesMatch(parsed.name, o.depositorName); });
  };

  var pending = forName('입금대기');
  if (pending.length === 1) return { result: 'matched', orderId: pending[0].orderId, candidates: ids(pending) };
  if (pending.length >= 2) return { result: 'ambiguous', orderId: null, candidates: ids(pending) };

  var expired = forName('만료');
  if (expired.length > 0) return { result: 'expiredMatch', orderId: null, candidates: ids(expired) };
  return { result: 'none', orderId: null, candidates: [] };
}

// title + body가 같고 windowMs(기본 2분) 안에 들어온 것이 recent에 있으면 중복.
function isDuplicateNotification(dep, recent, windowMs) {
  var win = windowMs == null ? 120000 : windowMs;
  var list = recent || [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r.title === dep.title && r.body === dep.body &&
        Math.abs(dep.receivedAtMs - r.receivedAtMs) <= win) {
      return true;
    }
  }
  return false;
}

if (typeof module !== 'undefined') {
  module.exports = { parseNotification, normalizeName, namesMatch, matchDeposit, isDuplicateNotification };
}
