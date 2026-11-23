// 실행: node --test tests/
// 샘플 문구는 가상이다(실제 토스 원문 아님). 1원 테스트 후 samples/notifications.txt와 함께 교체.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNotification, normalizeName, namesMatch, matchDeposit, isDuplicateNotification
} = require('../apps-script/Matching.js');

const dep = (name, amount) => ({ kind: 'deposit', name, amount, pattern: 'x' });
const order = (orderId, status, amount, depositorName) => ({ orderId, status, amount, depositorName });

test('parse: 이름 있는 입금', () => {
  const r = parseNotification('토스뱅크', '홍길동님이 38,000원을 입금했어요');
  assert.equal(r.kind, 'deposit');
  assert.equal(r.name, '홍길동');
  assert.equal(r.amount, 38000);
  assert.ok(r.pattern);
});

test('parse: 타행 이체(은행명 괄호)', () => {
  const r = parseNotification('입금 알림', '홍길동(국민) 38,000원 입금');
  assert.deepEqual([r.kind, r.name, r.amount], ['deposit', '홍길동', 38000]);
});

test('parse: 제목에 금액, 본문에 이름', () => {
  const r = parseNotification('입금 38,000원', '홍길동 · 토스뱅크');
  assert.deepEqual([r.kind, r.name, r.amount], ['deposit', '홍길동', 38000]);
});

test('parse: 이름 없이 금액만', () => {
  const r = parseNotification('토스뱅크', '38,000원 입금');
  assert.equal(r.kind, 'deposit');
  assert.equal(r.name, null);
  assert.equal(r.amount, 38000);
});

test('parse: 본문이 내 통장 안내뿐이면 이름을 잘못 뽑지 않는다', () => {
  const r = parseNotification('입금 38,000원', '내 토스뱅크 통장');
  assert.equal(r.kind, 'deposit');
  assert.equal(r.name, null);
});

test('parse: 출금·결제·이자·광고·송금은 ignore', () => {
  const cases = [
    ['토스뱅크', '12,000원이 출금됐어요'],
    ['토스뱅크', '카페에서 4,500원 결제됐어요'],
    ['토스뱅크', '이자 123원이 들어왔어요'],
    ['(광고) 토스뱅크', '이번 주 혜택을 확인하세요'],
    ['토스뱅크', '홍길동님에게 10,000원을 보냈어요']
  ];
  for (const [t, b] of cases) assert.equal(parseNotification(t, b).kind, 'ignore', b);
});

test('parse: 이름에 "이자"가 들어가도 입금으로 본다', () => {
  const r = parseNotification('토스뱅크', '이자영님이 38,000원을 입금했어요');
  assert.deepEqual([r.kind, r.name], ['deposit', '이자영']);
});

test('parse: 알 수 없는 형식은 unknown', () => {
  const r = parseNotification('토스', '알 수 없는 문구입니다');
  assert.deepEqual(r, { kind: 'unknown', name: null, amount: null, pattern: null });
  assert.equal(parseNotification(null, undefined).kind, 'unknown');
});

test('normalizeName: 공백·괄호 제거', () => {
  assert.equal(normalizeName(' 홍 길동 (국민) '), '홍길동');
  assert.equal(normalizeName('홍길동[주]'), '홍길동');
  assert.equal(normalizeName('김(철)수'), '김수');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
});

test('namesMatch: 같음·앞부분·빈 값', () => {
  assert.equal(namesMatch('홍길동', '홍 길동'), true);
  assert.equal(namesMatch('홍길동(국민)', '홍길동'), true);
  assert.equal(namesMatch('홍길동', '홍길'), true); // 은행이 이름을 자름
  assert.equal(namesMatch('홍길', '홍길동'), true);
  assert.equal(namesMatch('홍길동', '김길동'), false);
  assert.equal(namesMatch('길동', '홍길동'), false); // 뒷부분은 불일치
  assert.equal(namesMatch('', '홍길동'), false);
  assert.equal(namesMatch('', ''), false);
});

test('match: 1건이면 matched', () => {
  const r = matchDeposit(dep('홍길동', 38000), [
    order('A', '입금대기', 38000, '홍길동'),
    order('B', '입금대기', 38000, '김철수'),
    order('C', '확정', 38000, '홍길동')
  ]);
  assert.deepEqual(r, { result: 'matched', orderId: 'A', candidates: ['A'] });
});

test('match: 0건이면 none', () => {
  const r = matchDeposit(dep('박영희', 38000), [order('A', '입금대기', 38000, '홍길동')]);
  assert.deepEqual(r, { result: 'none', orderId: null, candidates: [] });
});

test('match: 2건 이상이면 ambiguous, 후보 반환', () => {
  const r = matchDeposit(dep('홍길동', 38000), [
    order('A', '입금대기', 38000, '홍길동'),
    order('B', '입금대기', 38000, '홍 길동')
  ]);
  assert.equal(r.result, 'ambiguous');
  assert.equal(r.orderId, null);
  assert.deepEqual(r.candidates, ['A', 'B']);
});

test('match: 만료 주문과 일치하면 expiredMatch (자동 확정 안 함)', () => {
  const r = matchDeposit(dep('홍길동', 38000), [order('A', '만료', 38000, '홍길동')]);
  assert.deepEqual(r, { result: 'expiredMatch', orderId: null, candidates: ['A'] });
});

test('match: 입금대기가 있으면 만료 주문보다 우선', () => {
  const r = matchDeposit(dep('홍길동', 38000), [
    order('A', '만료', 38000, '홍길동'), order('B', '입금대기', 38000, '홍길동')
  ]);
  assert.equal(r.result, 'matched');
  assert.equal(r.orderId, 'B');
});

test('match: 금액이 다르면 이름이 맞아도 none', () => {
  const r = matchDeposit(dep('홍길동', 37000), [order('A', '입금대기', 38000, '홍길동')]);
  assert.equal(r.result, 'none');
});

test('match: 은행이 이름을 자른 경우 앞부분 일치', () => {
  const r = matchDeposit(dep('홍길', 38000), [order('A', '입금대기', 38000, '홍길동')]);
  assert.equal(r.result, 'matched');
});

test('match: 괄호·공백 정규화 후 일치', () => {
  const r = matchDeposit(dep('홍길동(국민)', 38000), [order('A', '입금대기', 38000, ' 홍 길동 ')]);
  assert.equal(r.result, 'matched');
});

test('match: 이름 없이 금액만 있으면 자동 확정하지 않는다', () => {
  const one = matchDeposit(dep(null, 38000), [order('A', '입금대기', 38000, '홍길동')]);
  assert.equal(one.result, 'none');
  assert.deepEqual(one.candidates, ['A']);
  const two = matchDeposit(dep(null, 38000), [
    order('A', '입금대기', 38000, '홍길동'), order('B', '입금대기', 38000, '김철수')
  ]);
  assert.equal(two.result, 'ambiguous');
  assert.deepEqual(two.candidates, ['A', 'B']);
  assert.equal(matchDeposit(dep(null, 1), []).result, 'none');
});

test('match: 파싱 실패·ignore는 notDeposit', () => {
  const orders = [order('A', '입금대기', 38000, '홍길동')];
  for (const [t, b] of [['토스', '모르는 문구'], ['토스뱅크', '12,000원이 출금됐어요']]) {
    const r = matchDeposit(parseNotification(t, b), orders);
    assert.deepEqual(r, { result: 'notDeposit', orderId: null, candidates: [] });
  }
});

test('match: 알림 파싱부터 매칭까지', () => {
  const parsed = parseNotification('토스뱅크', '홍길동님이 38,000원을 입금했어요');
  assert.equal(matchDeposit(parsed, [order('A', '입금대기', 38000, '홍길동')]).result, 'matched');
});

test('duplicate: 2분 안 같은 알림은 중복', () => {
  const base = { title: 't', body: 'b', receivedAtMs: 1000000 };
  assert.equal(isDuplicateNotification({ ...base, receivedAtMs: 1060000 }, [base]), true);
  assert.equal(isDuplicateNotification({ ...base, receivedAtMs: 1000000 + 120000 }, [base]), true);
});

test('duplicate: 2분이 지났거나 내용이 다르면 중복 아님', () => {
  const base = { title: 't', body: 'b', receivedAtMs: 1000000 };
  assert.equal(isDuplicateNotification({ ...base, receivedAtMs: 1000000 + 120001 }, [base]), false);
  assert.equal(isDuplicateNotification({ ...base, body: 'c' }, [base]), false);
  assert.equal(isDuplicateNotification(base, []), false);
  assert.equal(isDuplicateNotification({ ...base, receivedAtMs: 1005000 }, [base], 1000), false);
  assert.equal(isDuplicateNotification({ ...base, receivedAtMs: 1005000 }, [base], 10000), true);
});

// ---- 실제 토스뱅크 형식 (1원 테스트로 확인, 이름은 가짜) ----
test('real: 제목/본문 분리, 화살표 ->', () => {
  const r = parseNotification('60,000원 입금', '홍길동 -> 내 토스뱅크 통장');
  assert.deepEqual([r.kind, r.name, r.amount, r.pattern], ['deposit', '홍길동', 60000, 'toss-real-ipgeum-arrow']);
});

test('real: 화살표 → 와 공백 없는 경우', () => {
  for (const body of ['홍길동 → 내 토스뱅크 통장', '홍길동->내 토스뱅크 통장', '홍길동→내통장', '홍길동 - > 내 통장'.replace(' - > ', '=>')]) {
    const r = parseNotification('2원 입금', body);
    assert.deepEqual([r.kind, r.name, r.amount], ['deposit', '홍길동', 2], body);
  }
});

test('real: 1원 입금은 이름이 가려져 name null', () => {
  for (const arrow of ['->', '→', ' -> ']) {
    const r = parseNotification('1원 입금', '****' + arrow + ' 내 토스뱅크 통장');
    assert.deepEqual([r.kind, r.name, r.amount], ['deposit', null, 1]);
  }
});

test('real: 두 줄이 한 덩어리 (title 비고 body에, 또는 반대)', () => {
  const text = '60,000원 입금\n홍길동 -> 내 토스뱅크 통장';
  for (const [t, b] of [['', text], [text, ''], [null, text], [text, undefined]]) {
    const r = parseNotification(t, b);
    assert.deepEqual([r.kind, r.name, r.amount], ['deposit', '홍길동', 60000]);
  }
});

test('real: 통장 별명이 달라도, 이름에 공백이 있어도 읽는다', () => {
  assert.equal(parseNotification('38,000원 입금', '홍길동 -> 가게 사업자 통장').name, '홍길동');
  assert.equal(parseNotification('38,000원 입금', '홍 길동 -> 내 토스뱅크 통장').name, '홍 길동');
  assert.equal(parseNotification('38,000원 입금', '홍길동(국민) -> 내 토스뱅크 통장').name, '홍길동(국민)');
});

test('real: 쉼표 금액과 매칭 연결', () => {
  const parsed = parseNotification('1,238,000원 입금', '홍길동 -> 내 토스뱅크 통장');
  assert.equal(parsed.amount, 1238000);
  assert.equal(matchDeposit(parsed, [order('A', '입금대기', 1238000, '홍길동')]).result, 'matched');
});

test('real: 이름이 가려진 1원 입금은 자동 확정하지 않는다', () => {
  const parsed = parseNotification('1원 입금', '**** -> 내 토스뱅크 통장');
  const r = matchDeposit(parsed, [order('A', '입금대기', 1, '홍길동')]);
  assert.equal(r.result, 'none');
});

test('real: 같은 형식의 출금·결제는 입금이 아니다', () => {
  assert.equal(parseNotification('60,000원 출금', '내 토스뱅크 통장 -> 홍길동').kind, 'ignore');
});
