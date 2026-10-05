import {
  FEEDBACK_SUBMITTED_ORDERS_KEY,
  INVOICE_EXPORT_WIDTH,
  SPICE_LEVEL_LABELS,
  TAKEAWAY_LIKE_SERVICE_TYPES,
  CANCELLED_OR_RETURNED_STATUS_TOKENS,
  nodeApi,
} from "./menuConstants.js";

export const getImageUrl = (imagePath, apiBase = nodeApi) => {
  if (!imagePath) return "/defaultImg.jpg";
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    return imagePath;
  }
  if (imagePath.startsWith("/")) {
    return `${apiBase}${imagePath}`;
  }
  return `${apiBase}/uploads/${imagePath}`;
};

export const normalizeServiceType = (value = "DINE_IN") =>
  String(value || "DINE_IN")
    .trim()
    .toUpperCase();

export const normalizeOrderStatus = (value) => {
  const token = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
  if (!token) return "PREPARING";
  if (["NEW", "PENDING", "CONFIRMED", "ACCEPT", "ACCEPTED"].includes(token)) {
    return "PREPARING";
  }
  if (["PREPARING", "BEING PREPARED", "BEINGPREPARED"].includes(token)) {
    return "PREPARING";
  }
  if (token === "READY") return "READY";
  if (
    [
      "COMPLETED",
      "SERVED",
      "FINALIZED",
      "PAID",
      "CANCELLED",
      "CANCELED",
      "RETURNED",
      "REJECTED",
      "EXIT",
      "CLOSED",
    ].includes(token)
  ) {
    return "SERVED";
  }
  return "PREPARING";
};

export const normalizePaymentStatus = (value, { status, isPaid } = {}) => {
  const token = String(value || "").trim().toUpperCase();
  if (token === "PAID") return "PAID";
  if (isPaid === true) return "PAID";
  if (String(status || "").trim().toUpperCase() === "PAID") return "PAID";
  return "PENDING";
};

export const isCancelledOrReturnedStatus = (status) =>
  CANCELLED_OR_RETURNED_STATUS_TOKENS.has(
    String(status || "").trim().toUpperCase(),
  );

export const isOrderSettled = ({ status, paymentStatus, isPaid } = {}) =>
  normalizeOrderStatus(status) === "SERVED" &&
  normalizePaymentStatus(paymentStatus, { status, isPaid }) === "PAID";

export const isOrderActiveForCustomer = ({ status, paymentStatus, isPaid } = {}) =>
  !isCancelledOrReturnedStatus(status) &&
  !isOrderSettled({ status, paymentStatus, isPaid });

export const canAddItemsToExistingOrder = ({ status, paymentStatus, isPaid } = {}) =>
  isOrderActiveForCustomer({ status, paymentStatus, isPaid }) &&
  normalizeOrderStatus(status) !== "SERVED";

export const shouldPreserveOrderStateWithoutActiveId = ({
  status,
  paymentStatus,
  isPaid,
} = {}) =>
  isCancelledOrReturnedStatus(status) ||
  normalizeOrderStatus(status) === "SERVED" ||
  isOrderSettled({ status, paymentStatus, isPaid });

export const isTakeawayLikeServiceType = (value) =>
  TAKEAWAY_LIKE_SERVICE_TYPES.includes(normalizeServiceType(value));

export const hasOfficeQrMetadata = (tableContext) => {
  if (!tableContext || typeof tableContext !== "object") return false;
  if (tableContext.qrContextType === "OFFICE") return true;

  const hasOfficeName = String(tableContext.officeName || "").trim().length > 0;
  const hasOfficeAddress =
    String(tableContext.officeAddress || "").trim().length > 0;
  const hasOfficePhone =
    String(tableContext.officePhone || "").trim().length > 0;
  const hasOfficeDeliveryCharge =
    Number(tableContext.officeDeliveryCharge || 0) > 0;

  return (
    hasOfficeName ||
    hasOfficeAddress ||
    hasOfficePhone ||
    hasOfficeDeliveryCharge
  );
};

export const resolveOfficePaymentMode = (tableContext) => {
  if (!hasOfficeQrMetadata(tableContext)) return null;
  const mode = String(tableContext?.officePaymentMode || "")
    .trim()
    .toUpperCase();
  if (mode === "COD" || mode === "BOTH" || mode === "ONLINE") {
    return mode;
  }
  return "ONLINE";
};

export const paiseToRupees = (value) => {
  if (value === undefined || value === null) return 0;
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return num / 100;
};

export const getInvoiceCaptureScale = () => {
  if (typeof window === "undefined") return 2;
  const deviceScale = Number(window.devicePixelRatio) || 1;
  return Math.min(Math.max(deviceScale, 1.5), 2);
};

export const isIOSLikeBrowser = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isiOSDevice = /iPad|iPhone|iPod/i.test(ua);
  const isIPadOSDesktopMode =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return isiOSDevice || isIPadOSDesktopMode;
};

export const saveInvoicePdf = (pdf, fileName) => {
  if (!isIOSLikeBrowser()) {
    pdf.save(fileName);
    return;
  }

  const pdfBlob = pdf.output("blob");
  const blobUrl = URL.createObjectURL(pdfBlob);
  const opened = window.open(blobUrl, "_blank", "noopener,noreferrer");

  if (!opened) {
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
};

export const sanitizeAddonName = (value) => {
  const normalized = String(value || "")
    .replace(/^\(\s*\+\s*\)\s*/u, "")
    .trim();
  return normalized || "Add-on";
};

export const getAssignedStaffFromOrder = () => null;

export const buildInvoiceId = (order) => {
  if (!order) return "INV-NA";
  const date = new Date(order.createdAt || Date.now())
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  const cartIdTail = (order.cartId || order._id || "")
    .toString()
    .slice(-6)
    .toUpperCase();
  return `INV-${date}-${cartIdTail}`;
};

export const getLatestKot = (order) => {
  if (!order) return null;
  const lines = Array.isArray(order.kotLines) ? order.kotLines : [];
  if (!lines.length) return null;
  return lines[lines.length - 1];
};

export const aggregateOrderItems = (order) => {
  if (!order) return [];
  const map = new Map();
  const lines = Array.isArray(order.kotLines) ? order.kotLines : [];
  lines.forEach((kot) => {
    (kot?.items || []).forEach((item) => {
      if (!item) return;
      const name = item.name || "Item";
      const quantity = Number(item.quantity) || 0;
      const unitPrice = paiseToRupees(item.price || 0);
      const returned = Boolean(item.returned);
      if (!map.has(name)) {
        map.set(name, {
          name,
          unitPrice,
          activeQuantity: 0,
          returnedQuantity: 0,
          totalQuantity: 0,
          amount: 0,
          returned: false,
        });
      }
      const entry = map.get(name);
      entry.totalQuantity += quantity;
      if (returned) {
        entry.returnedQuantity += quantity;
        entry.returned = true;
      } else {
        entry.activeQuantity += quantity;
        entry.amount += unitPrice * quantity;
      }
      if (!entry.unitPrice) {
        entry.unitPrice = unitPrice;
      }
    });
  });

  const addons = order.selectedAddons || [];
  addons.forEach((addon) => {
    if (!addon) return;
    const addonName = sanitizeAddonName(addon.name);
    const addonIdRaw =
      addon.addonId || addon._id || addon.id || `${addonName}-${addon.price || 0}`;
    const addonId =
      addonIdRaw && typeof addonIdRaw.toString === "function"
        ? addonIdRaw.toString()
        : addonIdRaw;
    const addonKey = `addon:${addonId}`;
    const qtyValue = Number(addon.quantity);
    const quantity =
      Number.isFinite(qtyValue) && qtyValue > 0 ? Math.floor(qtyValue) : 1;
    const unitPrice = Number(addon.price) || 0;

    if (!map.has(addonKey)) {
      map.set(addonKey, {
        name: addonName,
        unitPrice,
        activeQuantity: 0,
        returnedQuantity: 0,
        totalQuantity: 0,
        amount: 0,
        returned: false,
      });
    }
    const entry = map.get(addonKey);
    entry.totalQuantity += quantity;
    entry.activeQuantity += quantity;
    entry.amount += unitPrice * quantity;
  });
  return Array.from(map.values()).map((entry) => ({
    ...entry,
    quantity: entry.activeQuantity,
  }));
};

export const computeOrderTotals = (order, aggregatedItems) => {
  if (!order) {
    return {
      subtotal: 0,
      gst: 0,
      officeDeliveryCharge: 0,
      totalAmount: 0,
      totalItems: 0,
    };
  }
  const items = Array.isArray(aggregatedItems)
    ? aggregatedItems
    : aggregateOrderItems(order) || [];

  const subtotal = items.reduce((sum, item) => {
    if (!item) return sum;
    const amount = Number(item.amount) || 0;
    return sum + amount;
  }, 0);

  const subtotalRounded = Number(subtotal.toFixed(2));

  const gst = 0;
  const officeDeliveryChargeRaw = Number(order?.officeDeliveryCharge);
  const officeDeliveryCharge =
    Number.isFinite(officeDeliveryChargeRaw) && officeDeliveryChargeRaw > 0
      ? Number(officeDeliveryChargeRaw.toFixed(2))
      : 0;

  const totalAmount = Number((subtotalRounded + officeDeliveryCharge).toFixed(2));

  return {
    subtotal: subtotalRounded,
    gst: gst,
    officeDeliveryCharge,
    totalAmount: totalAmount,
    totalItems: items.reduce((sum, item) => {
      if (!item) return sum;
      return sum + (Number(item.quantity) || 0);
    }, 0),
  };
};

export const resolveOrderTimestamp = (order) => {
  if (!order) return null;
  const timestamp = order.paidAt || order.updatedAt || order.createdAt;
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const getSubmittedFeedbackOrderIds = () => {
  try {
    const raw = localStorage.getItem(FEEDBACK_SUBMITTED_ORDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((id) => (id === null || id === undefined ? "" : String(id).trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
};

export const hasSubmittedFeedbackForOrder = (orderId) => {
  if (!orderId) return false;
  const normalizedOrderId = String(orderId).trim();
  if (!normalizedOrderId) return false;
  return getSubmittedFeedbackOrderIds().includes(normalizedOrderId);
};

export const buildCategoriesFromFlatItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  const grouped = items.reduce((acc, item) => {
    if (!item) return acc;
    const categoryName = item.category || "Menu";
    if (!acc[categoryName]) {
      acc[categoryName] = {
        _id: categoryName,
        name: categoryName,
        description: "",
        sortOrder: 0,
        isActive: true,
        items: [],
      };
    }
    acc[categoryName].items.push({
      ...item,
      isAvailable: item.isAvailable !== false,
      categoryName,
      _id:
        item._id ||
        `${categoryName}-${item.name || "Item"}`.replace(/\s+/g, "-"),
    });
    return acc;
  }, {});
  return Object.values(grouped);
};

export const buildCatalogFromCategories = (categories) => {
  const catalog = {};
  categories.forEach((category) => {
    (category.items || []).forEach((item) => {
      catalog[item.name] = item;
    });
  });
  return catalog;
};

export const getSpiceLevelValue = (item) => {
  const level = String(item?.spiceLevel || "")
    .trim()
    .toUpperCase();
  return SPICE_LEVEL_LABELS[level] ? level : "";
};

export const toTranslationLookupKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

export { INVOICE_EXPORT_WIDTH, SPICE_LEVEL_LABELS };
