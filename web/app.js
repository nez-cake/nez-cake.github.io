/*
 * Nez 크리스마스 홀케이크 주문 페이지
 * 화면: 소개(#) → 주문서(#form) → 입금 안내(#order=주문번호) / 주문 조회(#lookup)
 * API 계약: docs/API.md — 가격·수량·날짜·시간·계좌는 모두 catalog 응답에서 그린다.
 */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var BRAND = CFG.BRAND || {};
  var IMAGES = CFG.IMAGES || {};
  var POLL_MS = 5000;
  var TIMEOUT_MS = 20000;
  var KEY_ORDERS = "xmasCake.orders";   // localStorage: { [orderId]: { phone4, depositorName, savedAt, last } }
  var KEY_REQ = "xmasCake.reqId";       // sessionStorage: 주문서의 clientRequestId

  var state = {
    catalog: null,
    sel: { productId: null, pickupDate: null, pickupTime: null, qty: 1 },
    depositorTouched: false,
    submitting: false,
    screen: null,
    poll: { timer: null, orderId: null, phone4: null, inflight: false, lastStatus: null }
  };

  // ---------------------------------------------------------------- 유틸
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function won(n) { return (Number(n) || 0).toLocaleString("ko-KR") + "원"; }
  var WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  function ymdParts(ymd) {
    var p = String(ymd).split("-");
    var y = +p[0], m = +p[1], d = +p[2];
    var wi = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return { y: y, m: m, d: d, wi: wi, w: WEEK[wi] };
  }
  function fmtDate(ymd) { var p = ymdParts(ymd); return p.m + "월 " + p.d + "일 (" + p.w + ")"; }
  function fmtDateShort(ymd) { var p = ymdParts(ymd); return p.m + "/" + p.d + " (" + p.w + ")"; }
  // ISO(+09:00) → "12월 20일 (일) 오후 3:30" 기기 시간대와 무관하게 한국 시간으로
  function fmtDateTime(iso) {
    var ms = Date.parse(iso);
    if (isNaN(ms)) return String(iso || "");
    var k = new Date(ms + 9 * 3600 * 1000);
    var h = k.getUTCHours(), mi = k.getUTCMinutes();
    var ap = h < 12 ? "오전" : "오후";
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return (k.getUTCMonth() + 1) + "월 " + k.getUTCDate() + "일 (" + WEEK[k.getUTCDay()] + ") " +
      ap + " " + h12 + ":" + (mi < 10 ? "0" : "") + mi;
  }
  function timeLeft(iso) {
    var diff = Date.parse(iso) - Date.now();
    if (isNaN(diff)) return "";
    if (diff <= 0) return "마감 시각이 지났어요";
    var m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return d + "일 " + (h % 24) + "시간 남음";
    if (h >= 1) return h + "시간 " + (m % 60) + "분 남음";
    return Math.max(1, m) + "분 남음";
  }
  function digits(s) { return String(s || "").replace(/\D/g, ""); }
  function fmtPhone(s) {
    var d = digits(s).slice(0, 11);
    if (d.length < 4) return d;
    if (d.length < 8) return d.slice(0, 3) + "-" + d.slice(3);
    if (d.length === 10) return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6);
    return d.slice(0, 3) + "-" + d.slice(3, 7) + "-" + d.slice(7);
  }
  function uuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* 대체 생성 */ }
    var b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  // 저장소 (사생활 모드 등에서 막혀도 페이지는 동작)
  function lsGet(k, def) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 무시 */ } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* 무시 */ } }
  function savedOrders() { return lsGet(KEY_ORDERS, {}); }
  function saveOrder(id, patch) {
    var all = savedOrders();
    var cur = all[id] || {};
    Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
    cur.savedAt = cur.savedAt || Date.now();
    all[id] = cur;
    lsSet(KEY_ORDERS, all);
    return cur;
  }

  // ---------------------------------------------------------------- API
  var NETWORK_ERROR = { ok: false, error: { code: "NETWORK", message: "인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요." } };

  function withTimeout(promise) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(NETWORK_ERROR); }, TIMEOUT_MS);
      promise.then(function (r) { clearTimeout(t); resolve(r); }, function () { clearTimeout(t); resolve(NETWORK_ERROR); });
    });
  }
  function normalize(res) {
    if (res && typeof res.ok === "boolean") return res;
    return { ok: false, error: { code: "INTERNAL", message: "잠시 문제가 생겼어요. 다시 시도해 주세요." } };
  }
  function apiGet(params) {
    if (CFG.MOCK && window.MockAPI) return withTimeout(window.MockAPI.get(params)).then(normalize);
    var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
    return withTimeout(fetch(CFG.API_URL + (CFG.API_URL.indexOf("?") >= 0 ? "&" : "?") + qs, { method: "GET", cache: "no-store" })
      .then(function (r) { return r.json(); })).then(normalize);
  }
  function apiPost(body) {
    if (CFG.MOCK && window.MockAPI) return withTimeout(window.MockAPI.post(body)).then(normalize);
    // text/plain: Apps Script가 CORS 사전 요청에 응답하지 못하므로 (API.md 1장)
    return withTimeout(fetch(CFG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })).then(normalize);
  }

  // ---------------------------------------------------------------- 화면 전환
  function parseHash() {
    var h = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    if (h.indexOf("order=") === 0) return { name: "order", orderId: h.slice(6).trim().toUpperCase() };
    if (h === "lookup") return { name: "lookup" };
    return { name: "home", toForm: h === "form" }; // 소개와 주문서는 한 화면. #form이면 주문서 자리로 내려 준다
  }

  var TITLES = { home: "", order: "입금 안내", lookup: "주문 조회", loading: "", error: "" };

  function showScreen(name) {
    var changed = state.screen !== name;
    $all("[data-screen]").forEach(function (s) { s.hidden = s.getAttribute("data-screen") !== name; });
    $("#backBtn").hidden = name === "home" || name === "loading" || name === "error";
    document.body.classList.toggle("has-bar", name === "home" && !$("#orderForm").hidden);
    $("#footer").hidden = !state.catalog || name === "loading";
    state.screen = name;
    var cafe = state.catalog && state.catalog.cafe ? state.catalog.cafe : {};
    var base = (cafe.name ? cafe.name + " · " : "") + "크리스마스 홀케이크 예약"; // tagline은 소개 문단이라 제목에 쓰지 않는다
    document.title = TITLES[name] ? TITLES[name] + " · " + base : base;
    if (changed) {
      window.scrollTo(0, 0);
      // 화면이 바뀌면 스크린리더 초점을 본문 처음으로
      if (name !== "loading") { try { $("#main").focus({ preventScroll: true }); } catch (e) { /* 무시 */ } }
    }
  }

  function route() {
    var r = parseHash();
    if (r.name !== "order") stopPolling();

    if (r.name === "lookup") { openLookup(); return; }
    if (r.name === "order") { openOrder(r.orderId); return; }
    // 소개+주문서: API를 기다리지 않고 바로 보여 준다. 가격·날짜 자리는 뼈대로 있다가 채워진다.
    showScreen("home");
    if (!state.catalog) loadIntroData(r.toForm);
    else { openForm(); if (r.toForm) scrollToForm(); }
  }

  // ---------------------------------------------------------------- 카탈로그
  var catalogPromise = null;
  function ensureCatalog() {
    showScreen("loading");
    if (catalogPromise) return;
    catalogPromise = loadCatalog().then(function () {
      catalogPromise = null;
      route();
    }, function (res) {
      catalogPromise = null;
      $("#loadErrorMsg").textContent = (res && res.error && res.error.message) || "인터넷 연결을 확인하고 다시 시도해 주세요.";
      showScreen("error");
    });
  }

  function scrollToForm() {
    var f0 = $("#orderForm");
    var target = f0.hidden ? $("#closedNotice") : f0;
    if (target && !target.hidden) setTimeout(function () { target.scrollIntoView({ behavior: "smooth", block: "start" }); }, 50);
  }

  function loadIntroData(toForm) {
    var msg = $("#introLoadMsg");
    msg.textContent = "예약 현황을 불러오고 있어요…";
    msg.hidden = false;
    if (catalogPromise) return;
    catalogPromise = loadCatalog().then(function () {
      catalogPromise = null;
      if (state.screen === "home") { openForm(); if (toForm) scrollToForm(); }
    }, function (res) {
      catalogPromise = null;
      // 실패해도 사진·제목·설명은 그대로 보이고, 이 자리에만 안내와 다시 시도 버튼을 둔다
      msg.innerHTML = esc((res && res.error && res.error.message) || "예약 현황을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.") +
        '<br><button type="button" class="btn btn-line" id="introRetry">다시 불러오기</button>';
      $("#introRetry").addEventListener("click", function () { loadIntroData(toForm); });
    });
  }

  function loadCatalog() {
    return apiGet({ action: "catalog" }).then(function (res) {
      if (!res.ok) throw res;
      state.catalog = res.data;
      renderCatalog();
      return res.data;
    });
  }

  function avail(date, pid) {
    var a = state.catalog.availability || {};
    return Math.max(0, Number((a[date] || {})[pid]) || 0);
  }
  function dateAllOut(date) {
    return state.catalog.products.every(function (p) { return avail(date, p.productId) === 0; });
  }
  function dateTotal(date) {
    return state.catalog.products.reduce(function (s, p) { return s + avail(date, p.productId); }, 0);
  }
  function productAllOut(pid) {
    return state.catalog.pickupDates.every(function (d) { return avail(d, pid) === 0; });
  }
  function productById(pid) {
    return state.catalog.products.filter(function (p) { return p.productId === pid; })[0] || null;
  }
  function isOpen() { var o = state.catalog.order; return !o || o.isOpen !== false; }
  function singleProduct() { return state.catalog.products.length === 1; }
  function bgImage(el, url) { el.style.backgroundImage = url ? "url(\"" + String(url).replace(/"/g, "%22") + "\")" : ""; }

  function renderCatalog() {
    var c = state.catalog;
    var cafe = c.cafe || {};
    var dates = c.pickupDates || [];
    var times = c.pickupTimes || [];

    // 로고·제목·사진은 HTML에 이미 있다. 시트 값이 다를 때만 바꾼다.
    if (cafe.name) { $("#logoName").textContent = cafe.name; $("#introCafe").textContent = cafe.name; }
    if (BRAND.logoSub) $("#logoSub").textContent = BRAND.logoSub;
    if (BRAND.motto) $("#introKicker").textContent = BRAND.motto;
    if (String(cafe.tagline || "").trim()) $("#introLead").textContent = String(cafe.tagline).trim(); // 소개 문단
    var hero = $("#heroPhoto");
    var heroUrl = cafe.heroImageUrl || IMAGES.hero || "";
    if (heroUrl && heroUrl !== IMAGES.hero) bgImage(hero, heroUrl);
    hero.setAttribute("aria-label", (c.products[0] && c.products[0].name ? c.products[0].name : "케이크") + " 사진");
    var open = isOpen();
    var before = !open && c.order && c.order.openAt && Date.now() < Date.parse(c.order.openAt);
    var openLabel = before ? fmtMonthDay(c.order.openAt) + " 오픈" : "접수 마감";

    $("#introLoadMsg").hidden = true;
    $("#introData").removeAttribute("aria-busy");
    $("#introData").classList.add("fill-in");
    $("#cakeList").innerHTML = c.products.map(function (p) {
      return "<li><div><b>" + esc(p.name) + "</b>" + (p.description ? '<span class="desc">' + esc(p.description) + "</span>" : "") +
        '</div><span class="price">' + won(p.price) + "</span></li>";
    }).join("");

    $("#introDates").innerHTML = dates.map(function (d) {
      var pp = ymdParts(d), out = dateAllOut(d), n = dateTotal(d), cls = "", s = "예약 가능";
      if (out) { cls = "is-out"; s = "마감"; }
      else if (!open) { cls = "is-closed"; s = openLabel; } // 접수 전·마감 후에는 버튼과 같은 말로
      else if (n <= 3) { cls = "is-low"; s = n + "개 남음"; }
      return '<div role="listitem" class="' + cls + '" aria-label="' + esc(fmtDate(d) + " " + s) + '">' +
        '<div class="n" aria-hidden="true">' + pp.d + '</div><div class="w" aria-hidden="true">' + pp.w + '요일</div>' +
        '<span class="s" aria-hidden="true">' + esc(s) + "</span></div>";
    }).join("");

    var note = [];
    if (times.length) note.push("픽업 " + times[0] + " ~ " + times[times.length - 1]);
    if (c.order && c.order.depositDeadlineHours) note.push("주문 후 " + c.order.depositDeadlineHours + "시간 안에 계좌이체");
    if (c.order && c.order.closeAt) note.push("주문 마감 " + fmtDateTime(c.order.closeAt));
    $("#introNote").innerHTML = note.map(function (n) { return "<span>" + esc(n) + "</span>"; }).join('<span aria-hidden="true"> · </span>');
    renderPlace($("#introPlace"));

    // 접수 전·마감 후: 주문서와 하단 바를 숨기고 안내만 보인다
    var notice = $("#closedNotice");
    if (!open) {
      notice.textContent = before
        ? fmtOpenAt(c.order.openAt) + "부터 주문을 받아요."
        : "올해 크리스마스 케이크 주문 접수가 마감되었어요. 감사합니다.";
      notice.hidden = false;
      $("#orderForm").hidden = true;
      $("#orderBar").hidden = true;
    } else {
      notice.hidden = true;
      $("#orderForm").hidden = false;
      $("#orderBar").hidden = false;
    }
    document.body.classList.toggle("has-bar", state.screen === "home" && open);

    // 픽업 안내(notices): 비어 있으면 구역 전체를 숨긴다
    var notices = noticeList();
    var story = $("#story");
    $("#introNotices").innerHTML = notices.map(noticeItem).join("");
    story.hidden = !notices.length;


    renderFooter();
    $("#footer").hidden = state.screen === "loading" || state.screen === "error";
    buildForm();
    // 주문 화면이 카탈로그보다 먼저 그려졌으면 픽업 장소·연락처를 넣어 다시 그린다
    if (state.screen === "order") {
      var r = parseHash(), saved = r.orderId ? savedOrders()[r.orderId] : null;
      if (saved && saved.last) {
        state.poll.lastStatus = null;
        $("#orderView").removeAttribute("data-order");
        renderOrder(saved.last, saved);
      }
    }
  }

  function renderFooter() {
    var c = state.catalog, b = c.business || {}, cafe = c.cafe || {};
    $("#footName").textContent = cafe.name || b.name || "";
    var rows = [
      ["상호", b.name], ["대표자", b.owner], ["사업자등록번호", b.regNo], ["주소", b.address], ["연락처", b.phone]
    ].map(function (r) { return [r[0], String(r[1] == null ? "" : r[1]).trim()]; })
      .filter(function (r) { return r[1]; });
    $("#footBiz").hidden = !rows.length; // 값이 하나도 없으면 빈 줄을 남기지 않는다
    $("#footBiz").innerHTML = rows.map(function (r) {
      var v = r[0] === "연락처" ? '<a href="tel:' + esc(digits(r[1])) + '">' + esc(r[1]) + "</a>" : esc(r[1]);
      return "<div><dt>" + esc(r[0]) + "</dt><dd>" + v + "</dd></div>";
    }).join("");
    var refund = String((c.policies || {}).refund || "").trim();
    $("#formRefundText").textContent = refund;
    $("#formRefund").hidden = !refund;
    $("#footRefund").textContent = refund || "";
    $("#footPolicy").hidden = !refund;
    var insta = $("#footInsta");
    if (cafe.instagramUrl) { insta.href = cafe.instagramUrl; insta.hidden = false; } else insta.hidden = true;
  }

  // ---------------------------------------------------------------- 주문서
  var form, f = {};

  function buildForm() {
    var c = state.catalog;

    // 케이크: 1종이면 선택 단계 없이 자동으로 넣는다 (API.md 3장)
    $("#cakeField").hidden = singleProduct();
    $("#cakeChoices").innerHTML = c.products.map(function (p) {
      return '<label class="cake-opt" data-pid="' + esc(p.productId) + '">' +
        '<input type="radio" name="productId" value="' + esc(p.productId) + '">' +
        '<span class="radio" aria-hidden="true"></span>' +
        '<span class="name">' + esc(p.name) + (p.description ? "<small>" + esc(p.description) + "</small>" : "") + "</span>" +
        '<span class="price">' + won(p.price) + "</span></label>";
    }).join("");
    if (singleProduct()) state.sel.productId = c.products[0].productId;

    // 달력: 픽업 날짜가 들어 있는 달마다 하나
    var months = [];
    c.pickupDates.forEach(function (d) { var k = d.slice(0, 7); if (months.indexOf(k) < 0) months.push(k); });
    $("#calendars").innerHTML = months.map(buildMonth).join("");
    $("#dateHint").textContent = c.pickupDates.map(function (d) { return ymdParts(d).d; }).join(" · ") + "일 중에서";

    // 시간표: 낮(17시 전) / 저녁
    var groups = [["낮", []], ["저녁", []]];
    (c.pickupTimes || []).forEach(function (t) { groups[parseInt(t, 10) < 17 ? 0 : 1][1].push(t); });
    $("#timeChoices").innerHTML = groups.filter(function (g) { return g[1].length; }).map(function (g) {
      return '<div class="ap" aria-hidden="true">' + g[0] + "</div>" + g[1].map(function (t) {
        return '<label data-time="' + esc(t) + '"><input type="radio" name="pickupTime" value="' + esc(t) + '"' +
          ' aria-label="' + esc(g[0] + " " + t) + '"><span aria-hidden="true">' + esc(t) + "</span></label>";
      }).join("") + fillers(g[1].length);
    }).join("");

    var lt = c.lettering || {};
    $("#letteringField").hidden = !lt.enabled;
    f.lettering.maxLength = lt.maxLength || 20;
    $("#letteringMax").textContent = lt.maxLength || 20;

    var pv = (c.policies || {}).privacy || "";
    $("#privacyText").textContent = pv.split("/").map(function (s) { return s.trim(); }).filter(Boolean).join(" / ");

    // 선택값이 아직 유효하면 유지
    if (state.sel.productId && !productById(state.sel.productId)) state.sel.productId = null;
    if (state.sel.pickupDate && c.pickupDates.indexOf(state.sel.pickupDate) < 0) state.sel.pickupDate = null;
    if (state.sel.pickupTime && (c.pickupTimes || []).indexOf(state.sel.pickupTime) < 0) state.sel.pickupTime = null;
    syncChoices();
  }

  // 시간표 마지막 줄의 빈칸도 격자선이 이어지게 채운다 (열 수는 화면 폭에 따라 4 또는 6)
  function fillers(n) {
    var cols = window.matchMedia("(min-width: 768px)").matches ? 6 : 4;
    var k = (cols - (n % cols)) % cols, out = "";
    for (var i = 0; i < k; i++) out += '<div class="fill" aria-hidden="true"></div>';
    return out;
  }

  function buildMonth(ym) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    var days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var pick = state.catalog.pickupDates;
    var cells = WEEK.map(function (w) { return '<div class="wd" aria-hidden="true">' + w + "</div>"; }).join("");
    var i;
    for (i = 0; i < first; i++) cells += '<div class="d" aria-hidden="true"></div>';
    for (i = 1; i <= days; i++) {
      var ymd = ym + "-" + (i < 10 ? "0" : "") + i;
      if (pick.indexOf(ymd) >= 0) {
        cells += '<label class="d" data-date="' + ymd + '">' +
          '<input type="radio" name="pickupDate" value="' + ymd + '">' +
          '<span class="c">' + i + '</span><span class="t"></span></label>';
      } else {
        cells += '<div class="d" aria-hidden="true">' + i + "</div>";
      }
    }
    var tail = (7 - ((first + days) % 7)) % 7;
    for (i = 0; i < tail; i++) cells += '<div class="d" aria-hidden="true"></div>';
    return '<div class="cal">' +
      '<p class="cal-h" aria-hidden="true">' + m + "<small>월</small></p>" +
      '<div class="cal-g">' + cells + "</div>" +
      '<div class="cal-legend" aria-hidden="true"><span><i style="background:var(--choco)"></i>선택</span><span><i style="background:var(--pink)"></i>마감</span></div>' +
      "</div>";
  }

  function maxQty() {
    var m = state.catalog.maxQtyPerOrder || 1;
    if (state.sel.productId && state.sel.pickupDate) m = Math.min(m, avail(state.sel.pickupDate, state.sel.productId));
    return Math.max(1, m);
  }

  // 선택 상태와 마감 표시, 주문 요약을 다시 그린다
  function syncChoices() {
    var s = state.sel, open = isOpen(), c = state.catalog;

    if (s.productId && s.pickupDate && avail(s.pickupDate, s.productId) === 0) s.pickupDate = null;
    if (!singleProduct() && s.productId && productAllOut(s.productId)) s.productId = null;

    $all(".cake-opt").forEach(function (el) {
      var pid = el.getAttribute("data-pid"), input = $("input", el);
      input.disabled = productAllOut(pid) || !open;
      input.checked = s.productId === pid;
      el.classList.toggle("is-checked", input.checked);
      el.classList.toggle("is-disabled", input.disabled);
    });

    $all("#calendars label.d").forEach(function (el) {
      var d = el.getAttribute("data-date"), input = $("input", el), t = $(".t", el);
      var n = s.productId ? avail(d, s.productId) : dateTotal(d);
      var out = dateAllOut(d) || (s.productId && n === 0);
      var text = out ? "마감" : (n <= 3 ? n + "개 남음" : "예약 가능");
      input.disabled = !!out || !open;
      input.checked = s.pickupDate === d;
      input.setAttribute("aria-label", fmtDate(d) + ", " + text);
      el.classList.toggle("is-checked", input.checked);
      el.classList.toggle("is-out", !!out);
      el.classList.toggle("is-low", !out && n <= 3);
      t.textContent = text;
    });

    $all("#timeChoices label").forEach(function (el) {
      var input = $("input", el);
      input.disabled = !open;
      input.checked = s.pickupTime === el.getAttribute("data-time");
      el.classList.toggle("is-checked", input.checked);
      el.classList.toggle("is-disabled", !open);
    });
    $("#timeHint").textContent = s.pickupDate ? fmtDate(s.pickupDate) : "";

    var mx = maxQty();
    if (s.qty > mx) s.qty = mx;
    if (s.qty < 1) s.qty = 1;
    $("#qtyValue").textContent = s.qty;
    $("#qtyMinus").disabled = s.qty <= 1;
    $("#qtyPlus").disabled = s.qty >= mx;
    var cap = c.maxQtyPerOrder || 1;
    $("#qtyHint").textContent = mx < cap && s.productId && s.pickupDate
      ? "이 날짜에는 " + mx + "개까지 주문할 수 있어요."
      : "한 번에 " + cap + "개까지 주문할 수 있어요.";

    var p = s.productId ? productById(s.productId) : null;
    $("#totalAmount").textContent = won(p ? p.price * s.qty : 0);
    // 모바일 하단 바: 고른 날짜·시간·개수를 금액 위에 보여 준다
    $("#barMeta").textContent = s.pickupDate
      ? fmtDateShort(s.pickupDate) + (s.pickupTime ? " " + s.pickupTime : "") + " · " + s.qty + "개"
      : "결제 금액";

    var btn = $("#submitBtn");
    if (!open) { btn.disabled = true; btn.textContent = "주문 접수 기간이 아니에요"; }
    else if (!state.submitting) { btn.disabled = false; btn.textContent = "주문하기"; }
  }

  function depositorValue() {
    return (f.depositorName.value.trim() || f.customerName.value.trim());
  }
  function syncDepositorSummary() { /* 한 화면형: 별도 요약 칸 없음 */ }

  function openForm() {
    if (!state.catalog || !isOpen()) return;
    // 주문서를 처음 보여 줄 때 clientRequestId를 한 번 만든다. 재시도해도 같은 값을 보낸다.
    if (!ssGet(KEY_REQ)) ssSet(KEY_REQ, uuid());
    syncChoices();
  }

  function setFieldError(name, msg) {
    var box = $('[data-field="' + name + '"]', form);
    if (box) box.classList.toggle("has-error", !!msg);
    var e = document.getElementById("err-" + name);
    if (e) e.textContent = msg || "";
    var input = box && $("input:not([type=radio]):not([type=checkbox])", box);
    if (input) { if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); }
    return box;
  }
  function clearErrors() {
    $all(".has-error", form).forEach(function (b) { setFieldError(b.getAttribute("data-field"), ""); });
    $("#formError").hidden = true;
  }

  function collect() {
    var name = f.customerName.value.trim();
    return {
      action: "order",
      clientRequestId: ssGet(KEY_REQ) || uuid(),
      productId: state.sel.productId || "",
      qty: state.sel.qty,
      pickupDate: state.sel.pickupDate || "",
      pickupTime: state.sel.pickupTime || "",
      customerName: name,
      phone: digits(f.phone.value),
      email: "",
      depositorName: f.depositorName.value.trim() || name,
      lettering: $("#letteringField").hidden ? "" : f.lettering.value.trim(),
      memo: "",
      agreePrivacy: f.agreePrivacy.checked
    };
  }

  // 서버 검증(API.md 3장)과 같은 규칙. 서버가 최종 판단한다.
  function validate(o) {
    var c = state.catalog, errs = [];
    var lt = c.lettering || {};
    function add(k, m) { errs.push([k, m]); }
    if (!productById(o.productId)) add("productId", "케이크를 골라 주세요.");
    if (c.pickupDates.indexOf(o.pickupDate) < 0) add("pickupDate", "픽업 날짜를 골라 주세요.");
    if ((c.pickupTimes || []).indexOf(o.pickupTime) < 0) add("pickupTime", "픽업 시간을 골라 주세요.");
    if (!o.customerName) add("customerName", "성함을 적어 주세요.");
    else if (o.customerName.length > 20) add("customerName", "성함은 20자까지 적을 수 있어요.");
    if (o.depositorName.length > 20) add("depositorName", "입금자명은 20자까지 적을 수 있어요.");
    if (!/^01[016789]\d{7,8}$/.test(o.phone)) add("phone", "휴대폰 번호를 정확히 적어 주세요.");
    if (!(o.qty >= 1 && o.qty <= (c.maxQtyPerOrder || 1))) add("qty", "케이크 개수를 확인해 주세요.");
    if (lt.enabled && o.lettering.length > (lt.maxLength || 20)) add("lettering", "레터링은 " + (lt.maxLength || 20) + "자까지 적을 수 있어요.");
    if (!o.agreePrivacy) add("agreePrivacy", "개인정보 수집·이용에 동의해 주세요.");
    return errs;
  }

  function focusField(name) {
    if (name === "depositorName") $("#depositorDetails").open = true;
    var box = $('[data-field="' + name + '"]', form);
    if (!box) return;
    box.scrollIntoView({ block: "center", behavior: "smooth" });
    var input = $("input:not([disabled])", box);
    if (input) setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }, 350);
  }

  function setSubmitting(on) {
    state.submitting = on;
    var btn = $("#submitBtn");
    btn.disabled = on;
    btn.classList.toggle("is-loading", on);
    btn.textContent = on ? "주문 넣는 중" : "주문하기";
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (state.submitting) return; // 중복 제출 방지
    clearErrors();
    var o = collect();
    var errs = validate(o);
    if (errs.length) {
      errs.forEach(function (e) { setFieldError(e[0], e[1]); });
      // 긴 한 화면이라, 빠진 항목을 알려 주고 첫 항목 자리로 부드럽게 올려 준다
      var NAMES = { productId: "케이크", pickupDate: "픽업 날짜", pickupTime: "픽업 시간", customerName: "성함",
        depositorName: "입금자명", phone: "연락처", qty: "개수", lettering: "레터링", agreePrivacy: "개인정보 동의" };
      toast("확인해 주세요: " + errs.map(function (e) { return NAMES[e[0]] || e[0]; }).join(", "));
      focusField(errs[0][0]);
      return;
    }
    ssSet(KEY_REQ, o.clientRequestId);
    setSubmitting(true);

    apiPost(o).then(function (res) {
      if (res.ok) {
        var d = res.data;
        saveOrder(d.orderId, { phone4: o.phone.slice(-4), depositorName: d.depositorName || o.depositorName, last: d });
        ssSet(KEY_REQ, null);
        resetForm();
        setSubmitting(false);
        location.replace("#order=" + encodeURIComponent(d.orderId));
        return;
      }
      setSubmitting(false);
      handleOrderError(res.error || {});
    });
  }

  function handleOrderError(err) {
    var msg = err.message || "주문을 넣지 못했어요. 다시 시도해 주세요.";
    var box = $("#formError");
    if (err.code === "NETWORK") {
      msg = "인터넷 연결이 불안정해요. 다시 눌러도 주문이 두 번 들어가지 않으니 한 번 더 눌러 주세요.";
    }
    if (err.code === "SOLD_OUT" || err.code === "ORDER_CLOSED") {
      // 남은 수량을 다시 받아 달력을 고친다
      loadCatalog().then(function () { syncChoices(); }, function () { /* 무시 */ });
    }
    var field = err.field;
    if (field === "email" || field === "memo") field = null; // 화면에 없는 칸
    if (field && $('[data-field="' + field + '"]', form)) {
      setFieldError(field, msg);
      focusField(field);
    } else {
      box.textContent = msg;
      box.hidden = false;
      box.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function resetForm() {
    form.reset();
    $("#depositorDetails").open = false;
    state.sel = { productId: null, pickupDate: null, pickupTime: null, qty: 1 };
    if (singleProduct()) state.sel.productId = state.catalog.products[0].productId;
    state.depositorTouched = false;
    $("#letteringCount").textContent = "0";
    clearErrors();
    syncChoices();
  }

  function bindForm() {
    form = $("#orderForm");
    ["customerName", "phone", "depositorName", "lettering", "agreePrivacy"].forEach(function (k) { f[k] = $("#" + k); });
    form.addEventListener("submit", onSubmit);

    form.addEventListener("change", function (e) {
      var t = e.target;
      if (t.name === "productId") { state.sel.productId = t.value; setFieldError("productId", ""); syncChoices(); }
      if (t.name === "pickupDate") { state.sel.pickupDate = t.value; setFieldError("pickupDate", ""); syncChoices(); }
      if (t.name === "pickupTime") { state.sel.pickupTime = t.value; setFieldError("pickupTime", ""); syncChoices(); }
      if (t.id === "agreePrivacy") setFieldError("agreePrivacy", "");
    });
    $("#qtyMinus").addEventListener("click", function () { state.sel.qty -= 1; setFieldError("qty", ""); syncChoices(); });
    $("#qtyPlus").addEventListener("click", function () { state.sel.qty += 1; setFieldError("qty", ""); syncChoices(); });

    // 입금자명 기본값 = 성함. 직접 고치면 그때부터 따라가지 않는다.
    f.customerName.addEventListener("input", function () {
      setFieldError("customerName", "");
      if (!state.depositorTouched) f.depositorName.value = f.customerName.value;
      syncDepositorSummary();
    });
    f.depositorName.addEventListener("input", function () {
      setFieldError("depositorName", "");
      state.depositorTouched = f.depositorName.value !== "" && f.depositorName.value !== f.customerName.value;
      syncDepositorSummary();
    });
    f.phone.addEventListener("input", function () {
      var v = fmtPhone(f.phone.value);
      if (v !== f.phone.value) f.phone.value = v;
      setFieldError("phone", "");
    });
    f.lettering.addEventListener("input", function () { $("#letteringCount").textContent = f.lettering.value.length; setFieldError("lettering", ""); });
  }

  // ---------------------------------------------------------------- 입금 안내 / 주문 상태
  function openOrder(orderId) {
    var saved = savedOrders()[orderId];
    if (!saved || !saved.phone4) {
      // 다른 기기에서 연 주소: 뒷 4자리를 다시 묻는다
      openLookup("이 기기에서 처음 여는 주문이에요. 주문하신 성함과 연락처를 입력해 주세요.", true, orderId);
      return;
    }
    showScreen("order");
    if (state.poll.orderId !== orderId) {
      stopPolling();
      state.poll.lastStatus = null;
      var view = $("#orderView");
      view.removeAttribute("data-order");
      if (saved.last) renderOrder(saved.last, saved);
      else view.innerHTML = '<div class="screen-center"><div class="dots" aria-hidden="true"><span></span><span></span><span></span></div><p class="muted">주문을 불러오고 있어요</p></div>';
      state.poll.orderId = orderId;
      state.poll.phone4 = saved.phone4;
    }
    pollNow();
  }

  function stopPolling() {
    clearTimeout(state.poll.timer);
    state.poll.timer = null;
    state.poll.orderId = null;
  }
  function schedulePoll() {
    clearTimeout(state.poll.timer);
    state.poll.timer = setTimeout(pollNow, POLL_MS);
  }
  function pollNow() {
    var p = state.poll;
    if (!p.orderId || p.inflight) return;
    if (document.hidden) { schedulePoll(); return; } // 숨겨져 있으면 쉬고, 다시 보이면 바로 조회
    p.inflight = true;
    var id = p.orderId;
    apiGet({ action: "status", orderId: id, phone4: p.phone4 }).then(function (res) {
      p.inflight = false;
      if (p.orderId !== id) { if (p.orderId) pollNow(); return; } // 그새 다른 주문으로 이동
      var live = $("#liveLine");
      if (res.ok) {
        var saved = saveOrder(id, { last: mergeLast(savedOrders()[id], res.data) });
        renderOrder(saved.last, saved);
        if (res.data.status === "입금대기") schedulePoll();
        else stopPolling();
        return;
      }
      if (res.error && res.error.code === "NOT_FOUND") {
        stopPolling();
        var all = savedOrders(); delete all[id]; lsSet(KEY_ORDERS, all);
        openLookup("주문을 다시 불러오지 못했어요. 주문하신 성함과 연락처로 찾아 주세요.", false, id);
        return;
      }
      if (live) live.textContent = "연결이 불안정해요. 자동으로 다시 확인하고 있어요.";
      schedulePoll();
    });
  }
  function mergeLast(saved, data) {
    var last = (saved && saved.last) ? JSON.parse(JSON.stringify(saved.last)) : {};
    Object.keys(data).forEach(function (k) { last[k] = data[k]; });
    if (data.status !== "입금대기") delete last.account;
    return last;
  }

  function summaryHtml(d) {
    return '<section class="osum" aria-label="주문 내역"><h2>주문 내역</h2><dl>' +
      "<div><dt>케이크</dt><dd>" + esc(d.productName) + "</dd></div>" +
      "<div><dt>개수</dt><dd>" + esc(d.qty) + "개</dd></div>" +
      "<div><dt>픽업</dt><dd>" + esc(fmtDate(d.pickupDate)) + " " + esc(d.pickupTime) + "</dd></div>" +
      "<div><dt>금액</dt><dd>" + won(d.amount) + "</dd></div>" +
      "</dl></section>";
  }
  // 주문번호는 참고용으로 작게만 보여 준다. 손님은 성함 + 연락처로 다시 찾는다 (API.md 4-1장).
  var RECHECK_TEXT = "주문하신 성함과 연락처로 언제든 다시 확인할 수 있어요.";
  function orderIdLine(id) {
    return '<p class="order-id"><span>주문번호</span><code>' + esc(id) + "</code></p>";
  }
  // 픽업 장소: business.address가 있을 때만. 지도는 네이버 지도 검색 링크.
  function placeHtml() {
    var a = state.catalog && state.catalog.business ? String(state.catalog.business.address || "").trim() : "";
    if (!a) return "";
    return '<span>픽업 장소 <b>' + esc(a) + "</b></span>" +
      '<a href="https://map.naver.com/p/search/' + encodeURIComponent(mapQuery(a)) + '" target="_blank" rel="noopener">지도 보기<span class="sr-only"> (새 창)</span></a>';
  }
  function noticeList() {
    var n = state.catalog && state.catalog.notices;
    return Array.isArray(n) ? n.map(function (s) { return String(s == null ? "" : s).trim(); }).filter(Boolean) : [];
  }
  // 사장님 문구는 글자 그대로 보여 준다(줄바꿈은 CSS pre-line).
  // 이모지(📍 등)로 시작하는 줄에는 목록 점을 붙이지 않아 겹치지 않게 한다.
  var EMOJI_START;
  try { EMOJI_START = new RegExp("^\\p{Extended_Pictographic}", "u"); }
  catch (e) { EMOJI_START = /^(?:[\uD83C-\uD83E][\uDC00-\uDFFF]|[☀-➿])/; }
  function noticeItem(s) {
    return "<li" + (EMOJI_START.test(s) ? ' class="no-dot"' : "") + ">" + esc(s) + "</li>";
  }
  function noticeBox() {
    var n = noticeList();
    if (!n.length) return "";
    return '<section class="osum notice-sum" aria-label="픽업 안내"><h2>픽업 안내</h2><ul class="notices">' +
      n.map(noticeItem).join("") + "</ul></section>";
  }
  function placeBox() {
    var h = placeHtml();
    return h ? '<div class="place-box"><p class="place">' + h + "</p></div>" : "";
  }
  // "마포구 성미산로 29-1 1층 카페 네즈" → "마포구 성미산로 29-1" (층·상호를 빼야 지도 검색이 정확하다)
  function mapQuery(a) {
    var m = /^(.*?(?:로|길|동)\s*\d+(?:-\d+)?)(?:\s|,|$)/.exec(a);
    return m ? m[1] : a;
  }
  function renderPlace(el) {
    var h = placeHtml();
    el.innerHTML = h;
    el.hidden = !h;
  }
  // "2026-12-01T10:00:00+09:00" → "12월 1일 오전 10시" (분이 있으면 10시 30분)
  function fmtOpenAt(iso) {
    var k = new Date(Date.parse(iso) + 9 * 3600 * 1000);
    var h = k.getUTCHours(), mi = k.getUTCMinutes();
    return (k.getUTCMonth() + 1) + "월 " + k.getUTCDate() + "일 " + (h < 12 ? "오전 " : "오후 ") +
      (h % 12 === 0 ? 12 : h % 12) + "시" + (mi ? " " + mi + "분" : "");
  }
  function fmtMonthDay(iso) {
    var k = new Date(Date.parse(iso) + 9 * 3600 * 1000);
    return (k.getUTCMonth() + 1) + "월 " + k.getUTCDate() + "일";
  }

  function bizPhone() {
    var b = state.catalog && state.catalog.business;
    return b && b.phone ? b.phone : "";
  }
  function liveText() {
    return "입금이 확인되면 이 화면이 \"예약 확정\"으로 바뀌어요 · 5초마다 자동 확인";
  }

  function renderOrder(d, saved) {
    var view = $("#orderView");
    var statusChanged = state.poll.lastStatus !== d.status;
    state.poll.lastStatus = d.status;

    // 같은 상태면 남은 시간만 고친다 (복사 버튼 상태 유지)
    if (!statusChanged && view.getAttribute("data-order") === d.orderId) {
      var left = $("#deadlineLeft");
      if (left) left.textContent = timeLeft(d.depositDeadline);
      var live = $("#liveLine");
      if (live) live.textContent = liveText();
      return;
    }

    var html = "";
    if (d.status === "입금대기") {
      var acc = d.account || {};
      var dep = (saved && saved.depositorName) || d.depositorName || "";
      html =
        '<div class="order-head">' +
        '<p class="status-tag"><span class="dot" aria-hidden="true"></span>입금 확인 중</p>' +
        '<h1 class="h-lg">아래 계좌로 입금해 주세요</h1>' +
        orderIdLine(d.orderId) +
        "</div>" +
        '<div class="order-grid"><div class="order-main">' +
        '<div class="paycard"><dl>' +
        '<div class="paycard-row paycard-amount"><div><dt>입금하실 금액</dt><dd>' + won(d.amount) + "</dd></div>" +
        '<button type="button" class="copy" data-copy="' + esc(d.amount) + '" data-copy-label="금액" aria-label="금액 복사">복사</button></div>' +
        '<div class="paycard-row"><div><dt>은행</dt><dd>' + esc(acc.bankName) + "</dd></div></div>" +
        '<div class="paycard-row"><div><dt>계좌번호</dt><dd class="num">' + esc(acc.accountNumber) + "</dd></div>" +
        '<button type="button" class="copy" data-copy="' + esc(digits(acc.accountNumber)) + '" data-copy-label="계좌번호" aria-label="계좌번호 복사">복사</button></div>' +
        '<div class="paycard-row"><div><dt>예금주</dt><dd>' + esc(acc.accountHolder) + "</dd></div></div>" +
        "</dl></div>" +
        '<div class="depbox">' +
        (dep
          ? '<p class="k">입금자명</p><p class="v">' + esc(dep) + '</p><p class="s"><b>이 이름 그대로 입금해야 자동 확정됩니다.</b> 다른 이름으로 보냈다면 카페로 알려 주세요.</p>'
          : '<p class="k">입금자명</p><p class="s"><b>주문할 때 적은 입금자명 그대로 입금해 주세요.</b></p>') +
        "</div>" +
        '<div class="deadline"><p class="k"><span>입금 마감</span><span class="left" id="deadlineLeft">' + esc(timeLeft(d.depositDeadline)) + "</span></p>" +
        '<p class="v">' + esc(fmtDateTime(d.depositDeadline)) + "까지</p></div>" +
        placeBox() +
        '<p class="live" id="liveLine">' + liveText() + "</p>" +
        '</div><div class="order-side">' +
        summaryHtml(d) +
        '<div class="order-actions">' +
        '<p class="tip">' + RECHECK_TEXT + "</p>" +
        "</div></div></div>";
    } else if (d.status === "확정" || d.status === "픽업완료") {
      var done = d.status === "픽업완료";
      html =
        '<div class="narrow"><div class="confirmed-head">' +
        '<div class="stamp" aria-hidden="true"><span><b>' + (done ? "픽업 완료" : "예약 확정") + "</b><small>" + (done ? "고맙습니다" : "메리 크리스마스") + "</small></span></div>" +
        '<h1 class="h-lg">' + (done ? "맛있게 드세요" : "예약이 확정되었어요") + "</h1>" +
        '<p class="muted">' + (done ? "올해도 함께해 주셔서 고마워요." : "입금이 확인되었어요. 픽업하실 때 주문하신 성함과 연락처로 확인해 드려요.") + "</p>" +
        orderIdLine(d.orderId) +
        "</div>" +
        (done ? "" : '<div class="pickup-big"><p class="k">픽업 일시</p><p class="v">' + esc(fmtDate(d.pickupDate)) + " " + esc(d.pickupTime) + "</p></div>" + placeBox()) +
        (done ? "" : noticeBox()) +
        summaryHtml(d) +
        '<div class="order-actions"><p class="tip">' + RECHECK_TEXT + '</p><a class="btn btn-line btn-block" href="#">처음으로</a></div></div>';
    } else {
      var expired = d.status === "만료";
      var phone = bizPhone();
      html =
        '<div class="narrow"><div class="state-msg">' +
        '<div class="icon" aria-hidden="true">' + (expired ? "!" : "×") + "</div>" +
        '<h1 class="h-lg">' + (expired ? "입금 기한이 지나 주문이 취소되었어요" : "취소된 주문이에요") + "</h1>" +
        '<p class="muted">' + (expired
          ? "이미 입금하셨다면 카페로 연락 주세요" + (phone ? " (" + esc(phone) + ")" : "") + ". 확인 후 도와드릴게요."
          : "문의는 카페로 연락 주세요" + (phone ? " (" + esc(phone) + ")" : "") + ".") + "</p>" +
        orderIdLine(d.orderId) +
        "</div>" +
        summaryHtml(d) +
        '<div class="order-actions"><a class="btn btn-solid btn-block" href="#form">새로 주문하기</a></div></div>';
    }
    var cafeName = state.catalog && state.catalog.cafe ? state.catalog.cafe.name : "";
    document.title = (d.status === "입금대기" ? "입금 안내" : d.status === "확정" ? "예약 확정" : "주문 " + d.status) + (cafeName ? " · " + cafeName : "");
    var wasRendered = view.getAttribute("data-order") === d.orderId;
    view.innerHTML = html;
    view.setAttribute("data-order", d.orderId);
    if (wasRendered) window.scrollTo({ top: 0, behavior: "smooth" }); // 상태가 바뀌면 맨 위의 결과를 보여 준다
    if (wasRendered && d.status === "확정") toast("예약이 확정되었어요");
  }

  // ---------------------------------------------------------------- 주문 조회
  // 성함 + 연락처로 찾는다 (POST action=lookup, API.md 4-1장).
  // 찾은 주문은 받은 orderId + 입력한 연락처 뒷 4자리로 이 기기에 저장해 두고,
  // 입금 안내 화면은 지금처럼 status(주문번호 + 뒷 4자리)로 5초마다 자동 조회한다.
  var lookupState = { hits: {}, phone4: "", wantId: null };
  var STATUS_LABEL = { "입금대기": "입금 대기", "확정": "예약 확정", "픽업완료": "픽업 완료", "취소": "취소", "만료": "기한 지남" };

  function orderItem(id, d, pick) {
    d = d || {};
    var when = d.pickupDate ? fmtDate(d.pickupDate) + (d.pickupTime ? " " + d.pickupTime : "") : "";
    var st = d.status ? (STATUS_LABEL[d.status] || d.status) : "";
    return '<a href="#order=' + encodeURIComponent(id) + '"' + (pick ? ' data-pick="' + esc(id) + '"' : "") + ">" +
      '<span class="ol-main"><b>' + esc(when || "주문 보기") + "</b>" +
      "<small>" + (d.qty ? esc(d.qty) + "개 · " : "") + "주문번호 " + esc(id) + "</small></span>" +
      (st ? '<span class="ol-st' + (d.status === "확정" ? " is-ok" : "") + '">' + esc(st) + "</span>" : "") +
      "</a>";
  }

  function lookupMark(name, msg) {
    var input = name === "lkName" ? $("#lookupName") : $("#lookupPhone");
    $('[data-field="' + name + '"]', $("#lookupForm")).classList.toggle("has-error", !!msg);
    $("#err-" + name).textContent = msg || "";
    if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    return msg ? input : null;
  }
  function lookupMessage(msg, isInfo) {
    var err = $("#lookupError");
    err.classList.toggle("is-info", !!isInfo);
    err.setAttribute("role", isInfo ? "status" : "alert");
    if (msg) { err.textContent = msg; err.hidden = false; } else err.hidden = true;
  }

  function openLookup(message, isInfo, wantId) {
    showScreen("lookup");
    lookupMark("lkName", ""); lookupMark("lkPhone", "");
    lookupMessage(message, isInfo);
    lookupState.wantId = wantId || null;
    $("#lookupResults").hidden = true;

    var all = savedOrders();
    var ids = Object.keys(all).filter(function (k) { return all[k].phone4; })
      .sort(function (a, b) { return (all[b].savedAt || 0) - (all[a].savedAt || 0); }).slice(0, 5);
    var list = $("#recentOrders");
    if (ids.length) {
      list.innerHTML = '<p class="ol-title">이 기기에서 넣은 주문</p>' +
        ids.map(function (k) { return orderItem(k, all[k].last); }).join("");
      list.hidden = false;
    } else list.hidden = true;
  }

  // 찾은 주문을 이 기기에 저장 → 입금 안내 화면에서 status로 이어서 자동 조회
  function keepFoundOrder(d, phone4) {
    var prev = savedOrders()[d.orderId];
    saveOrder(d.orderId, {
      phone4: phone4,
      depositorName: d.depositorName || (prev && prev.depositorName) || "",
      last: mergeLast(prev, d)
    });
    state.poll.orderId = null; // 새로 그리기
  }
  function goOrder(id) {
    var target = "#order=" + encodeURIComponent(id);
    if (location.hash === target) route(); else location.hash = target;
  }

  function showLookupResults(orders) {
    var box = $("#lookupResults");
    lookupState.hits = {};
    orders.forEach(function (o) { lookupState.hits[o.orderId] = o; });
    box.innerHTML = '<p class="ol-title" tabindex="-1">주문이 ' + orders.length + "건 있어요. 확인할 주문을 골라 주세요.</p>" +
      orders.map(function (o) { return orderItem(o.orderId, o, true); }).join("");
    box.hidden = false;
    var title = $(".ol-title", box);
    title.focus({ preventScroll: true });
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bindLookup() {
    var lf = $("#lookupForm");
    var nameInput = $("#lookupName"), phoneInput = $("#lookupPhone"), btn = $("#lookupBtn");
    nameInput.addEventListener("input", function () { lookupMark("lkName", ""); });
    phoneInput.addEventListener("input", function () {
      var v = fmtPhone(phoneInput.value);
      if (v !== phoneInput.value) phoneInput.value = v;
      lookupMark("lkPhone", "");
    });
    $("#lookupResults").addEventListener("click", function (e) {
      var a = e.target.closest("[data-pick]");
      if (!a) return;
      var d = lookupState.hits[a.getAttribute("data-pick")];
      if (d) keepFoundOrder(d, lookupState.phone4); // 저장한 뒤 링크(#order=)로 이동
    });

    lf.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (btn.disabled) return;
      var name = nameInput.value.trim(), ph = digits(phoneInput.value);
      var nameLen = name.replace(/\s+/g, "").length;
      var bad = [
        lookupMark("lkName", nameLen >= 1 && nameLen <= 20 ? "" : "주문하실 때 적은 성함을 입력해 주세요."),
        lookupMark("lkPhone", /^01[016789]\d{7,8}$/.test(ph) ? "" : "연락처를 확인해 주세요. 예: 010-1234-5678")
      ].filter(Boolean);
      lookupMessage("");
      $("#lookupResults").hidden = true;
      if (bad.length) { bad[0].focus(); return; }

      btn.disabled = true; btn.classList.add("is-loading");
      apiPost({ action: "lookup", customerName: name, phone: ph }).then(function (res) {
        btn.disabled = false; btn.classList.remove("is-loading");
        var orders = res.ok && res.data && Array.isArray(res.data.orders) ? res.data.orders : null;
        if (!res.ok || !orders || !orders.length) {
          var code = res.error && res.error.code;
          if (res.ok || code === "NOT_FOUND") { lookupMessage("성함과 연락처를 다시 확인해 주세요."); return; }
          if (code === "INVALID_INPUT" && res.error.field === "customerName") { lookupMark("lkName", "성함을 확인해 주세요.").focus(); return; }
          if (code === "INVALID_INPUT" && res.error.field === "phone") { lookupMark("lkPhone", "연락처를 확인해 주세요.").focus(); return; }
          lookupMessage(res.error && res.error.message ? res.error.message : "잠시 문제가 생겼어요. 다시 시도해 주세요.");
          return;
        }
        lookupState.phone4 = ph.slice(-4);
        // 다른 기기에서 연 주문 주소로 들어왔다면 그 주문을 바로 보여 준다
        var want = lookupState.wantId && orders.filter(function (o) { return o.orderId === lookupState.wantId; })[0];
        var pick = want || (orders.length === 1 ? orders[0] : null);
        if (pick) { keepFoundOrder(pick, lookupState.phone4); goOrder(pick.orderId); return; }
        showLookupResults(orders);
      });
    });
  }

  // ---------------------------------------------------------------- 복사
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;";
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length); // iOS
      ok = document.execCommand("copy");
    } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  var sheetReturnFocus = null;
  function openCopySheet(text) {
    var sheet = $("#copySheet"), input = $("#copySheetInput");
    sheetReturnFocus = document.activeElement;
    input.value = text;
    sheet.hidden = false;
    setTimeout(function () { input.focus(); input.select(); try { input.setSelectionRange(0, text.length); } catch (e) { /* 무시 */ } }, 50);
  }
  function closeCopySheet() {
    $("#copySheet").hidden = true;
    if (sheetReturnFocus && sheetReturnFocus.focus) sheetReturnFocus.focus();
  }
  function copyText(text, label, btn) {
    function done() {
      toast((label ? label + " " : "") + "복사했어요");
      if (btn) {
        var orig = btn.getAttribute("data-orig") || btn.textContent;
        btn.setAttribute("data-orig", orig);
        btn.classList.add("is-done");
        btn.textContent = "복사됨";
        setTimeout(function () { btn.classList.remove("is-done"); btn.textContent = orig; }, 1800);
      }
    }
    function fallback() { if (legacyCopy(text)) done(); else openCopySheet(text); }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  }

  var toastTimer;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("is-on"); }, 2000);
  }

  // ---------------------------------------------------------------- 시작
  function bindGlobal() {
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-copy]");
      if (b) { copyText(b.getAttribute("data-copy"), b.getAttribute("data-copy-label"), b); return; }
      var u = e.target.closest("[data-copy-url]");
      if (u) { copyText(location.href, "주소", u); return; }
      if (e.target.closest('[aria-disabled="true"]')) e.preventDefault();
    });
    $("#copySheetClose").addEventListener("click", closeCopySheet);
    $("#copySheet").addEventListener("click", function (e) { if (e.target.id === "copySheet") closeCopySheet(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("#copySheet").hidden) closeCopySheet(); });
    $("#backBtn").addEventListener("click", function () { location.hash = ""; });
    $("#retryLoad").addEventListener("click", route);

    window.addEventListener("hashchange", route);
    // 시간표 열 수가 바뀌는 폭을 넘나들면 빈칸 채움을 다시 계산
    var mq = window.matchMedia("(min-width: 768px)");
    var onMq = function () { if (state.catalog) buildForm(); };
    if (mq.addEventListener) mq.addEventListener("change", onMq); else if (mq.addListener) mq.addListener(onMq);
    // 화면이 다시 보이면(은행 앱에서 돌아오면) 바로 조회
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.poll.orderId) { clearTimeout(state.poll.timer); pollNow(); }
    });
  }

  function boot() {
    route();
    // 주문 조회 화면에서도 하단 사업자 정보와 카페 연락처를 쓰려고 카탈로그를 받아 둔다
    if (!state.catalog && !catalogPromise) {
      catalogPromise = loadCatalog().then(function () {
        catalogPromise = null;
        $("#footer").hidden = state.screen === "loading" || state.screen === "error";
        showScreen(state.screen); // 제목에 카페 이름 반영
      }, function () { catalogPromise = null; });
    }
  }

  bindForm();
  bindLookup();
  bindGlobal();
  boot();
})();
