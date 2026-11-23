/**
 * 웹 앱 입구. 응답 모양은 docs/API.md 1장을 따른다.
 * Apps Script는 항상 HTTP 200을 돌려주므로 성공 여부는 본문의 ok로 알린다.
 */

function doGet(e) {
  return handleRequest_(function () {
    var p = (e && e.parameter) || {};
    switch (p.action) {
      case 'catalog':
        return getCatalog_();
      case 'status':
        return getOrderStatus_(p.orderId, p.phone4);
      default:
        throw apiError_('INVALID_INPUT', '알 수 없는 요청이에요.');
    }
  });
}

function doPost(e) {
  return handleRequest_(function () {
    var body = parsePostBody_(e);
    var action = body.action || (e && e.parameter && e.parameter.action);
    switch (action) {
      case 'order':
        return createOrder_(body);
      case 'deposit':
        return receiveDeposit_(body);
      case 'lookup':
        return lookupOrders_(body);
      default:
        throw apiError_('INVALID_INPUT', '알 수 없는 요청이에요.');
    }
  });
}

/** text/plain과 application/json 모두 e.postData.contents의 JSON 문자열로 읽는다. */
function parsePostBody_(e) {
  var text = e && e.postData && e.postData.contents;
  if (!text) throw apiError_('INVALID_INPUT', '요청 내용이 비어 있어요.');
  var obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw apiError_('INVALID_INPUT', '요청 형식이 올바르지 않아요.');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw apiError_('INVALID_INPUT', '요청 형식이 올바르지 않아요.');
  }
  return obj;
}

function handleRequest_(fn) {
  var out;
  try {
    out = { ok: true, data: fn() };
  } catch (err) {
    if (err instanceof ApiError) {
      var error = { code: err.code, message: err.message };
      if (err.field) error.field = err.field;
      out = { ok: false, error: error };
    } else {
      console.error(err && err.stack ? err.stack : err);
      out = { ok: false, error: { code: 'INTERNAL', message: '일시적인 오류가 생겼어요. 잠시 후 다시 시도해 주세요.' } };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
