/**
 * GET ?action=catalog  (docs/API.md 2장)
 * 다른 고객 정보, 사장님 이메일, 시트 링크, 토큰은 절대 담지 않는다.
 */

function getCatalog_() {
  var cfg = getConfig_();
  var products = getActiveProducts_();
  var orders = readTable_(SHEET.ORDERS).rows;
  var now = new Date();

  return {
    cafe: {
      name: cfg.cafeName,
      tagline: cfg.cafeTagline,
      instagramUrl: cfg.instagramUrl,
      heroImageUrl: cfg.heroImageUrl
    },
    products: products.map(function (p) {
      return { productId: p.productId, name: p.name, price: p.price, description: p.description, imageUrl: p.imageUrl };
    }),
    pickupDates: cfg.pickupDates,
    pickupTimes: cfg.pickupTimes,
    availability: computeAvailability_(cfg, products, orders),
    maxQtyPerOrder: cfg.maxQtyPerOrder,
    lettering: { enabled: cfg.letteringEnabled, maxLength: cfg.letteringMaxLength },
    account: accountInfo_(cfg),
    order: {
      isOpen: isOrderOpen_(cfg, now),
      openAt: toIso_(cfg.orderOpenAt),
      closeAt: toIso_(cfg.orderCloseAt),
      depositDeadlineHours: cfg.depositDeadlineHours
    },
    business: {
      name: cfg.bizName,
      owner: cfg.bizOwner,
      regNo: cfg.bizRegNo,
      address: cfg.bizAddress,
      phone: cfg.bizPhone
    },
    policies: {
      refund: cfg.refundPolicy,
      privacy: cfg.privacyNotice
    }
  };
}

function isOrderOpen_(cfg, now) {
  return now.getTime() >= cfg.orderOpenAt.getTime() && now.getTime() <= cfg.orderCloseAt.getTime();
}

/** Products 탭에서 active인 상품을 sortOrder 순으로. */
function getActiveProducts_() {
  return readTable_(SHEET.PRODUCTS).rows
    .map(function (r) {
      return {
        productId: cellStr_(r.productId),
        name: cellStr_(r.name),
        price: Math.round(cellNum_(r.price)),
        description: cellStr_(r.description),
        imageUrl: cellStr_(r.imageUrl),
        active: cellBool_(r.active),
        sortOrder: cellNum_(r.sortOrder)
      };
    })
    .filter(function (p) { return p.productId && p.active; })
    .sort(function (a, b) { return a.sortOrder - b.sortOrder; });
}

/**
 * availability[날짜][productId] = 그 날짜에 그 케이크를 더 주문할 수 있는 최대 개수.
 * 남은 수량 = 한도 - (입금대기 + 확정 + 픽업완료 주문의 qty 합). 만료·취소는 세지 않는다.
 * capacityMode total: 날짜 합계 한도를 모든 케이크가 함께 쓴다.
 * capacityMode perProduct: capacity[날짜][productId] 한도. 적혀 있지 않으면 0.
 */
function computeAvailability_(cfg, products, orders) {
  var usedByDate = {};
  var usedByDateProduct = {};
  orders.forEach(function (o) {
    if (HOLDING_STATUSES.indexOf(cellStr_(o.status)) < 0) return;
    var d = cellStr_(o.pickupDate);
    var pid = cellStr_(o.productId);
    var q = cellNum_(o.qty);
    usedByDate[d] = (usedByDate[d] || 0) + q;
    usedByDateProduct[d + '|' + pid] = (usedByDateProduct[d + '|' + pid] || 0) + q;
  });

  var result = {};
  cfg.pickupDates.forEach(function (d) {
    result[d] = {};
    products.forEach(function (p) {
      var left;
      if (cfg.capacityMode === 'perProduct') {
        var capD = cfg.capacity[d] || {};
        left = cellNum_(capD[p.productId] || 0) - (usedByDateProduct[d + '|' + p.productId] || 0);
      } else {
        left = cellNum_(cfg.capacity[d] || 0) - (usedByDate[d] || 0);
      }
      result[d][p.productId] = Math.max(0, Math.floor(left));
    });
  });
  return result;
}
