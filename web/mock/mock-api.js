/*
 * 가짜 API (config.js의 MOCK: true일 때만 동작)
 *
 * 응답 모양은 docs/API.md와 같고, 바탕은 web/mock/*.json 파일이다.
 * - catalog: catalog.json + 이 브라우저에서 넣은 가짜 주문 수량을 뺀 남은 수량
 * - order:   화면 왼쪽 아래 MOCK 패널에서 결과(성공, SOLD_OUT, INVALID_INPUT 등)를 고른다
 * - status:  N번 조회하면 "입금대기"에서 "확정"으로 바뀐다 (N은 패널에서 조정)
 * - lookup:  성함 + 연락처로 찾기 (API.md 4-1장)
 * 데모 주문: C-1224-A7K2 / 전화 뒷 4자리 5678
 * 조회 데모: 김민지 / 010-1234-5678 → 1건, 이준호 / 010-2222-3333 → 2건, 그 밖 → 없음
 *
 * 실제 API로 배포된 뒤에도 주소에 ?mock=1 을 붙이면 가짜 API로 볼 수 있다.
 * ?closed=before / ?closed=after 를 함께 붙이면 접수 전 / 마감 후 화면을 볼 수 있다.
 * JSON을 fetch로 읽으므로 file://이 아니라 로컬 서버로 띄운다.
 *   예) web 폴더에서  python -m http.server 8000
 */
(function () {
  "use strict";
  var cfg = window.APP_CONFIG || {};
  // 확인용: 주소 끝에 ?mock=1 을 붙이면 config.js가 MOCK:false여도 이 브라우저 탭에서만 가짜 API를 쓴다
  if (/[?&](mock=1|demo=)/.test(location.search)) cfg.MOCK = true;
  if (!cfg.MOCK) return;

  var BASE = "mock/";
  var LS_KEY = "xmasCake.mock.v1";
  var DEMO = { orderId: "C-1224-A7K2", phone4: "5678" };
  // 조회 데모 손님 (주문은 처음 조회할 때 가짜 저장소에 만든다)
  var DEMO_PEOPLE = [
    { name: "김민지", phone: "01012345678", orders: [{ id: "C-1224-A7K2" }] },
    { name: "이준호", phone: "01022223333", orders: [
      { id: "C-1223-B3QX", status: "입금대기", qty: 2, pickupDate: "2026-12-23", pickupTime: "13:30" },
      { id: "C-1224-K5RT", status: "확정", qty: 1, pickupDate: "2026-12-24", pickupTime: "18:00" }
    ] }
  ];
  var ID_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  var cache = {};

  function defaults() {
    return {
      settings: { orderResult: "success", confirmAfter: 3, closed: false },
      orders: {},      // orderId -> { data, phone4, polls }
      byRequest: {}    // clientRequestId -> orderId
    };
  }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY));
      if (s && s.settings) return s;
    } catch (e) { /* 무시 */ }
    return defaults();
  }
  function save(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* 무시 */ }
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function getJSON(name) {
    if (cache[name]) return Promise.resolve(clone(cache[name]));
    return fetch(BASE + name + ".json", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { cache[name] = j; return clone(j); });
  }

  // epoch ms -> "2026-12-24T14:00:00+09:00"
  function toKstIso(ms) {
    var d = new Date(ms + 9 * 3600 * 1000);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
      "T" + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":00+09:00";
  }
  function newOrderId(pickupDate, s) {
    var mmdd = pickupDate.slice(5, 7) + pickupDate.slice(8, 10);
    var id;
    do {
      var r = "";
      for (var i = 0; i < 4; i++) r += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
      id = "C-" + mmdd + "-" + r;
    } while (s.orders[id] || id === DEMO.orderId);
    return id;
  }
  function usedQty(s, date, productId) {
    var n = 0;
    Object.keys(s.orders).forEach(function (k) {
      var o = s.orders[k];
      if (o.productId === productId && o.data.pickupDate === date &&
          (o.data.status === "입금대기" || o.data.status === "확정")) n += o.data.qty;
    });
    return n;
  }

  function catalog() {
    var s = load();
    return getJSON("catalog").then(function (j) {
      var av = j.data.availability;
      Object.keys(av).forEach(function (date) {
        Object.keys(av[date]).forEach(function (pid) {
          av[date][pid] = Math.max(0, av[date][pid] - usedQty(s, date, pid));
        });
      });
      if (s.settings.closed) j.data.order.isOpen = false;
      // 확인용: 주소에 ?closed=before(접수 전) 또는 ?closed=after(마감 후)
      var cm = /[?&]closed=(before|after)/.exec(location.search);
      if (cm) {
        j.data.order.isOpen = false;
        if (cm[1] === "after") { j.data.order.openAt = "2026-11-01T10:00:00+09:00"; j.data.order.closeAt = "2026-11-20T23:59:00+09:00"; }
        else { j.data.order.openAt = "2099-12-01T10:00:00+09:00"; }
      }
      return j;
    });
  }

  function status(params) {
    var s = load();
    var id = String(params.orderId || "").trim().toUpperCase();
    var p4 = String(params.phone4 || "").trim();

    if (id === DEMO.orderId && p4 === DEMO.phone4 && !s.orders[id]) {
      s.orders[id] = { data: null, phone4: DEMO.phone4, polls: 0, demo: true };
    }
    var o = s.orders[id];
    if (!o || o.phone4 !== p4) return getJSON("status-not-found");

    o.polls += 1;
    save(s);
    return snapshot(s, o).then(function (d) { delete d.depositorName; return { ok: true, data: d }; });
  }

  // 지금 상태의 주문 한 건 (status 응답 모양 + depositorName). 조회 횟수는 올리지 않는다.
  function snapshot(s, o) {
    var confirmed = (o.data && o.data.status === "확정") || o.polls >= s.settings.confirmAfter;
    return getJSON(confirmed ? "status-confirmed" : "status-pending").then(function (j) {
      var d = j.data;
      if (o.data) {
        ["orderId", "productName", "qty", "amount", "pickupDate", "pickupTime", "depositDeadline"]
          .forEach(function (k) { d[k] = o.data[k]; });
        if (!confirmed) d.account = o.data.account;
        if (confirmed && o.data.status !== "확정") {
          o.data.status = "확정";
          save(s);
        }
      }
      d.depositorName = (o.data && o.data.depositorName) || o.name || "";
      return d;
    });
  }

  function nameKey(v) { return String(v || "").replace(/\s+/g, ""); }
  function phoneKey(v) { return String(v || "").replace(/\D/g, ""); }

  // 성함 + 연락처로 찾기 (API.md 4-1장): 최근 것부터 최대 5건
  function lookup(body) {
    var name = nameKey(body.customerName), phone = phoneKey(body.phone);
    if (!name || name.length > 20) {
      return Promise.resolve({ ok: false, error: { code: "INVALID_INPUT", field: "customerName", message: "성함을 확인해 주세요." } });
    }
    if (!/^01[016789]\d{7,8}$/.test(phone)) {
      return Promise.resolve({ ok: false, error: { code: "INVALID_INPUT", field: "phone", message: "연락처를 확인해 주세요." } });
    }
    return catalog().then(function (cat) {
      var s = load();
      DEMO_PEOPLE.forEach(function (p) {
        if (nameKey(p.name) !== name || p.phone !== phone) return;
        p.orders.forEach(function (f, i) {
          if (s.orders[f.id]) { s.orders[f.id].name = p.name; s.orders[f.id].phone = p.phone; return; }
          var o = { data: null, phone4: p.phone.slice(-4), polls: 0, demo: true, name: p.name, phone: p.phone, createdAt: 1000 - i };
          if (f.status) {
            var product = cat.data.products[0];
            o.data = {
              orderId: f.id, status: f.status, productName: product.name, qty: f.qty,
              amount: product.price * f.qty, pickupDate: f.pickupDate, pickupTime: f.pickupTime,
              depositorName: p.name,
              depositDeadline: toKstIso(Math.min(Date.now() + 24 * 3600 * 1000, Date.parse(f.pickupDate + "T23:59:00+09:00") - 24 * 3600 * 1000)),
              account: clone(cat.data.account)
            };
            if (f.status === "확정") o.polls = 999;
          }
          s.orders[f.id] = o;
        });
      });
      save(s);
      var hits = Object.keys(s.orders).map(function (k) { return s.orders[k]; })
        .filter(function (o) { return nameKey(o.name) === name && o.phone === phone; })
        .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
        .slice(0, 5);
      if (!hits.length) {
        return { ok: false, error: { code: "NOT_FOUND", message: "성함과 연락처가 맞는 주문을 찾지 못했어요." } };
      }
      return Promise.all(hits.map(function (o) { return snapshot(s, o); }))
        .then(function (orders) { return { ok: true, data: { orders: orders } }; });
    });
  }

  function order(body) {
    var s = load();
    var result = s.settings.orderResult;

    // 같은 clientRequestId로 다시 오면 처음 주문을 그대로 돌려준다 (API.md 3장)
    var prev = body.clientRequestId && s.byRequest[body.clientRequestId];
    if (prev && s.orders[prev]) {
      return Promise.resolve({ ok: true, data: clone(s.orders[prev].data) });
    }
    if (s.settings.closed) return getJSON("order-closed");
    if (result === "soldout") return getJSON("order-sold-out");
    if (result === "invalid") return getJSON("order-invalid-input");
    if (result === "toomany") return getJSON("order-too-many-pending");
    if (result === "network") return Promise.reject(new TypeError("Failed to fetch (mock)"));

    return Promise.all([catalog(), getJSON("order-success")]).then(function (arr) {
      var cat = arr[0].data, tpl = arr[1];
      var product = cat.products.filter(function (p) { return p.productId === body.productId; })[0];
      var left = (cat.availability[body.pickupDate] || {})[body.productId] || 0;
      if (!product || left < body.qty) return getJSON("order-sold-out");

      var now = Date.now();
      var deadline = Math.min(
        now + cat.order.depositDeadlineHours * 3600 * 1000,
        Date.parse(body.pickupDate + "T23:59:00+09:00") - 24 * 3600 * 1000
      );
      var d = tpl.data;
      d.orderId = newOrderId(body.pickupDate, s);
      d.status = "입금대기";
      d.productName = product.name;
      d.qty = body.qty;
      d.amount = product.price * body.qty;
      d.pickupDate = body.pickupDate;
      d.pickupTime = body.pickupTime;
      d.depositorName = body.depositorName;
      d.depositDeadline = toKstIso(deadline);
      d.account = clone(cat.account);

      s.orders[d.orderId] = { data: clone(d), phone4: body.phone.slice(-4), polls: 0, productId: body.productId,
        name: body.customerName, phone: phoneKey(body.phone), createdAt: now };
      if (body.clientRequestId) s.byRequest[body.clientRequestId] = d.orderId;
      save(s);
      return tpl;
    });
  }

  // ?demo=pending 또는 ?demo=confirmed 로 열면 데모 주문을 이 기기에 저장해 둔다 (스크린샷·확인용)
  (function seedDemo() {
    var m = /[?&]demo=(pending|confirmed)/.exec(location.search);
    if (!m) return;
    try {
      var orders = JSON.parse(localStorage.getItem("xmasCake.orders")) || {};
      orders[DEMO.orderId] = { phone4: DEMO.phone4, depositorName: "김민지", savedAt: Date.now() };
      localStorage.setItem("xmasCake.orders", JSON.stringify(orders));
    } catch (e) { /* 무시 */ }
    var s = load();
    s.orders[DEMO.orderId] = { data: null, phone4: DEMO.phone4, polls: m[1] === "confirmed" ? 999 : -999, demo: true };
    save(s);
  })();

  window.MockAPI = {
    get: function (params) {
      return wait(450).then(function () {
        if (params.action === "catalog") return catalog();
        if (params.action === "status") return status(params);
        return { ok: false, error: { code: "INTERNAL", message: "알 수 없는 요청이에요." } };
      });
    },
    post: function (body) {
      return wait(900).then(function () {
        if (body.action === "order") return order(body);
        if (body.action === "lookup") return lookup(body);
        return { ok: false, error: { code: "INTERNAL", message: "알 수 없는 요청이에요." } };
      });
    }
  };

  // ---------- MOCK 패널 ----------
  function panel() {
    var s = load();
    var wrap = document.createElement("div");
    wrap.className = "mock-panel";
    wrap.innerHTML =
      '<button type="button" class="mock-toggle" aria-expanded="false">MOCK</button>' +
      '<div class="mock-body" hidden>' +
      '<p class="mock-title">가짜 API 설정</p>' +
      '<label>주문 결과<select data-k="orderResult">' +
      '<option value="success">성공</option>' +
      '<option value="soldout">SOLD_OUT</option>' +
      '<option value="invalid">INVALID_INPUT (전화번호)</option>' +
      '<option value="toomany">TOO_MANY_PENDING</option>' +
      '<option value="network">네트워크 오류</option>' +
      '</select></label>' +
      '<label>확정까지 조회 횟수<input type="number" min="1" max="50" data-k="confirmAfter"></label>' +
      '<label class="mock-check"><input type="checkbox" data-k="closed"> 주문 접수 마감</label>' +
      '<p class="mock-hint">데모 주문 C-1224-A7K2 / 5678<br>조회 1건: 김민지 / 010-1234-5678<br>조회 2건: 이준호 / 010-2222-3333</p>' +
      '<button type="button" class="mock-reset">가짜 주문·저장값 초기화</button>' +
      '</div>';
    document.body.appendChild(wrap);

    var body = wrap.querySelector(".mock-body");
    var toggle = wrap.querySelector(".mock-toggle");
    toggle.addEventListener("click", function () {
      body.hidden = !body.hidden;
      toggle.setAttribute("aria-expanded", String(!body.hidden));
    });
    wrap.querySelectorAll("[data-k]").forEach(function (el) {
      var k = el.getAttribute("data-k");
      if (el.type === "checkbox") el.checked = !!s.settings[k];
      else el.value = s.settings[k];
      el.addEventListener("change", function () {
        var st = load();
        st.settings[k] = el.type === "checkbox" ? el.checked :
          (el.type === "number" ? Math.max(1, parseInt(el.value, 10) || 1) : el.value);
        save(st);
        if (k === "closed") location.reload();
      });
    });
    wrap.querySelector(".mock-reset").addEventListener("click", function () {
      try {
        localStorage.removeItem(LS_KEY);
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf("xmasCake.") === 0) localStorage.removeItem(k);
        });
        sessionStorage.clear();
      } catch (e) { /* 무시 */ }
      location.href = location.pathname;
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", panel);
  else panel();
})();
