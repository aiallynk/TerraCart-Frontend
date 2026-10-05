import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Header from "../components/Header";
import { FiArrowLeft, FiMinus, FiPlus, FiTrash2 } from "react-icons/fi";
import fallbackMenuItems from "../data/menuData";
import "./CartPage.css";
import { buildOrderPayload } from "../utils/orderUtils";
import { postWithRetry } from "../utils/fetchWithTimeout";
import ProcessOverlay from "../components/ProcessOverlay";
import restaurantBg from "../assets/images/restaurant-img.jpg"; // reuse if needed or use transparent
import cartTranslations from "../data/translations/cartPage.json";
import {
  getCurrentLanguage,
  subscribeToLanguageChanges,
} from "../utils/language";
import { clearScopedCart, readScopedCart, writeScopedCart } from "../utils/cartStorage";
import { refreshCustomerPushToken } from "../services/customerPushService";
import { ensureAiSessionForCart } from "../utils/aiSessionClient";
import { useMenuPublicQuery } from "../queries/useMenuQuery";
import { useAddonsPublicQuery } from "../queries/useAddonsQuery";
import { queryClient } from "../query/queryClient";
import { queryKeys } from "../query/queryKeys";
import { fetchMenuPublicPayload } from "../services/menuPublicApi";
import { getCustomerApiOrigin } from "../utils/customerApiOrigin";
import { formatINR } from "../utils/currency";
// But let's keep imports minimal

const nodeApi = getCustomerApiOrigin();
const TAKEAWAY_TOKEN_PREVIEW_KEY = "terra_takeaway_token_preview";
const PAYMENT_GATE_ORDER_ID_KEY = "terra_payment_gate_order_id";
const PAYMENT_GATE_MODE_KEY = "terra_payment_gate_mode";
const PAYMENT_GATE_DRAFT_KEY = "terra_payment_gate_order_draft";
const TAKEAWAY_LIKE_SERVICE_TYPES = new Set(["TAKEAWAY", "PICKUP", "DELIVERY"]);
const sanitizeAddonName = (value) => {
  const normalized = String(value || "")
    .replace(/^\(\s*\+\s*\)\s*/u, "")
    .trim();
  return normalized || "Add-on";
};

const parseJsonSafely = (value, fallback = {}) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const hasOfficeQrMetadata = (tableContext) => {
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

const resolveOfficePaymentMode = (tableContext) => {
  if (!hasOfficeQrMetadata(tableContext)) return null;
  const mode = String(tableContext?.officePaymentMode || "")
    .trim()
    .toUpperCase();
  if (mode === "COD" || mode === "BOTH" || mode === "ONLINE") {
    return mode;
  }
  return "ONLINE";
};
const resolveOrderStatusValue = (...candidates) => {
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }
  return "Confirmed";
};

const normalizeServiceType = (value = "DINE_IN") =>
  String(value || "DINE_IN")
    .trim()
    .toUpperCase();

const normalizeMenuItemName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const buildMenuCatalogMap = (menuItems = []) => {
  const byName = {};
  const byNormalizedName = {};
  const source = Array.isArray(menuItems) ? menuItems : [];
  source.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const itemName = String(item.name || "").trim();
    if (!itemName) return;
    byName[itemName] = item;
    const normalizedName = normalizeMenuItemName(itemName);
    if (normalizedName && !byNormalizedName[normalizedName]) {
      byNormalizedName[normalizedName] = item;
    }
  });
  return { byName, byNormalizedName };
};

const mergeMenuWithFallback = (primaryItems = [], fallbackItems = []) => {
  const normalizedPrimaryNames = new Set(
    (Array.isArray(primaryItems) ? primaryItems : [])
      .map((item) => normalizeMenuItemName(item?.name))
      .filter(Boolean),
  );

  const fallbackOnly = (Array.isArray(fallbackItems) ? fallbackItems : []).filter(
    (item) => {
      const normalized = normalizeMenuItemName(item?.name);
      return normalized && !normalizedPrimaryNames.has(normalized);
    },
  );

  // Keep backend/public menu prices authoritative, use fallback only for missing names.
  return [...(Array.isArray(primaryItems) ? primaryItems : []), ...fallbackOnly];
};

function getImageUrl(imagePath) {
  if (!imagePath) return null;
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://"))
    return imagePath;
  if (imagePath.startsWith("/")) return `${nodeApi}${imagePath}`;
  return `${nodeApi}/uploads/${imagePath}`;
}

async function getCartId(searchParams) {
  try {
    const tableData = parseJsonSafely(
      localStorage.getItem("terra_selectedTable") ||
        localStorage.getItem("terra_table_selection") ||
        "{}",
      {},
    );
    const isOfficeQrFlow = hasOfficeQrMetadata(tableData);
    const serviceType = (
      localStorage.getItem("terra_serviceType") || "DINE_IN"
    )
      .toString()
      .trim()
      .toUpperCase();
    const isPickupOrDeliveryServiceType =
      serviceType === "PICKUP" || serviceType === "DELIVERY";
    const isPickupOrDeliveryFlow =
      isPickupOrDeliveryServiceType ||
      isOfficeQrFlow;

    // Priority 1: URL parameter "cart" or "cartId" (explicit override)
    const urlCartId = searchParams?.get("cart") || searchParams?.get("cartId");
    if (urlCartId) {
      console.log("[CartPage] getCartId - from URL params:", urlCartId);
      return urlCartId;
    }

    const selectedCartId = localStorage.getItem("terra_selectedCartId");
    if (isPickupOrDeliveryFlow && selectedCartId) {
      console.log(
        "[CartPage] getCartId - from terra_selectedCartId (pickup/delivery):",
        selectedCartId,
      );
      return selectedCartId;
    }

    // Priority 2: check explicit takeaway cart context
    const qrCartId = localStorage.getItem("terra_takeaway_cartId");
    if (qrCartId) {
      console.log(
        "[CartPage] getCartId - from terra_takeaway_cartId:",
        qrCartId,
      );
      return qrCartId;
    }

    // Priority 3: check selected table context
    let id = tableData.cartId || tableData.cafeId || "";
    let finalId = "";
    if (id != null && id !== "") {
      if (typeof id === "string") {
        finalId = id;
      } else if (typeof id === "object") {
        const raw = id._id ?? id.id ?? id;
        finalId = typeof raw === "string" ? raw : raw?.toString?.() || "";
      } else {
        finalId = String(id);
      }
    }

    if (finalId) {
      console.log(
        "[CartPage] getCartId - from table data:",
        finalId,
        "raw:",
        id,
      );
      return finalId;
    }

    // Fallback for non pickup/delivery flow only
    if (!isPickupOrDeliveryFlow && selectedCartId) {
      console.log(
        "[CartPage] getCartId - fallback from terra_selectedCartId:",
        selectedCartId,
      );
      return selectedCartId;
    }

    // Priority 4: if table ID in URL but no cartId, fetch cartId from backend
    const tableId = searchParams?.get("table");
    if (tableId) {
      console.log(
        "[CartPage] getCartId - table ID in URL, fetching cartId from API:",
        tableId,
      );
      try {
        const res = await fetch(
          `${nodeApi}/api/tables/public-cart-id/${encodeURIComponent(tableId)}`,
        );
        if (res.ok) {
          const data = await res.json();
          const fetchedCartId = data.cartId || "";
          if (fetchedCartId) {
            console.log(
              "[CartPage] getCartId - got cartId from table API:",
              fetchedCartId,
            );
            return fetchedCartId;
          }
        }
      } catch (err) {
        console.error(
          "[CartPage] getCartId - failed to fetch cartId by table ID:",
          err,
        );
      }
    }

    console.warn("[CartPage] getCartId - no cartId found anywhere");
    return "";
  } catch (e) {
    console.error("[CartPage] getCartId error:", e);
  }
  return "";
}

export default function CartPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlCartKey =
    searchParams.get("cart") || searchParams.get("cartId") || "";
  const urlTableKey = searchParams.get("table") || "";
  const [language, setLanguage] = useState(getCurrentLanguage());
  const t = (key) =>
    cartTranslations[language]?.[key] || cartTranslations.en?.[key] || key;
  const formatText = (key, params = {}) => {
    let message = t(key);
    Object.entries(params).forEach(([token, value]) => {
      message = message.replace(new RegExp(`\\{${token}\\}`, "g"), String(value));
    });
    return message;
  };
  const [, setCartScopeServiceType] = useState(() => {
    const tableContext = parseJsonSafely(
      localStorage.getItem("terra_selectedTable") || "{}",
      {},
    );
    if (hasOfficeQrMetadata(tableContext)) return "TAKEAWAY";
    const currentServiceType = normalizeServiceType(
      localStorage.getItem("terra_serviceType") || "DINE_IN",
    );
    return TAKEAWAY_LIKE_SERVICE_TYPES.has(currentServiceType)
      ? currentServiceType
      : "DINE_IN";
  });
  const [cart, setCart] = useState(() => {
    try {
      const tableContext = parseJsonSafely(
        localStorage.getItem("terra_selectedTable") || "{}",
        {},
      );
      const currentServiceType = hasOfficeQrMetadata(tableContext)
        ? "TAKEAWAY"
        : normalizeServiceType(localStorage.getItem("terra_serviceType") || "DINE_IN");
      const scopedServiceType = TAKEAWAY_LIKE_SERVICE_TYPES.has(currentServiceType)
        ? currentServiceType
        : "DINE_IN";
      return readScopedCart(scopedServiceType);
    } catch {
      return {};
    }
  });
  const [menuCatalog, setMenuCatalog] = useState(
    Array.isArray(fallbackMenuItems) ? fallbackMenuItems : [],
  );
  const [accessibilityMode, setAccessibilityMode] = useState(
    localStorage.getItem("accessibilityMode") === "true",
  );
  const [selectedAddOns, setSelectedAddOns] = useState([]);
  const [addonList, setAddonList] = useState([]); // Start empty, will be set by fetchAddons
  const [addonsLoading, setAddonsLoading] = useState(true);
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [cartId, setCartId] = useState(""); // Current cart id – add-ons are scoped per cart

  const menuQuery = useMenuPublicQuery(cartId, { enabled: true });
  const addonsQuery = useAddonsPublicQuery(cartId, urlTableKey, {
    enabled: Boolean(cartId || urlTableKey),
  });

  // Process Overlay State
  const initialProcessSteps = () => [
    { label: t("stepCheckingOrder"), state: "pending" },
    { label: t("stepConfirmingItems"), state: "pending" },
    { label: t("stepPlacingOrder"), state: "pending" },
    { label: t("stepSendingKitchen"), state: "pending" },
    { label: t("stepPreparingDetails"), state: "pending" },
  ];
  const [processOpen, setProcessOpen] = useState(false);
  const [processSteps, setProcessSteps] = useState(initialProcessSteps);
  const placeOrderInFlightRef = useRef(false);

  const setStepState = (index, state) =>
    setProcessSteps((steps) =>
      steps.map((s, i) => (i === index ? { ...s, state } : s)),
    );

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const DUR = {
    validate: 1500,
    order: 1500,
    beforeSend: 1000,
    kitchen: 1500,
    error: 2000,
  };

  const resolveCurrentCartScopeServiceType = useCallback(() => {
    const tableContext = parseJsonSafely(
      localStorage.getItem("terra_selectedTable") || "{}",
      {},
    );
    if (hasOfficeQrMetadata(tableContext)) return "TAKEAWAY";
    const currentServiceType = normalizeServiceType(
      localStorage.getItem("terra_serviceType") || "DINE_IN",
    );
    return TAKEAWAY_LIKE_SERVICE_TYPES.has(currentServiceType)
      ? currentServiceType
      : "DINE_IN";
  }, []);

  const readLatestScopedCart = useCallback(() => {
    const scope = resolveCurrentCartScopeServiceType();
    try {
      return {
        scope,
        scopedCart: readScopedCart(scope),
      };
    } catch (error) {
      console.error("[CartPage] Failed to read scoped cart:", error);
      return {
        scope,
        scopedCart: {},
      };
    }
  }, [resolveCurrentCartScopeServiceType]);

  const fetchMenuCatalog = useCallback(async (resolvedCartId) => {
    try {
      const raw = await queryClient.fetchQuery({
        queryKey: queryKeys.menu.public(
          resolvedCartId ? String(resolvedCartId) : "",
        ),
        queryFn: () => fetchMenuPublicPayload(resolvedCartId),
      });
      const items = [];
      if (Array.isArray(raw)) {
        raw.forEach((cat) => {
          if (Array.isArray(cat?.items)) items.push(...cat.items);
        });
      }
      const merged = mergeMenuWithFallback(items, fallbackMenuItems);
      setMenuCatalog(merged);
      return merged;
    } catch (err) {
      console.error("Failed to fetch menu", err);
      return [];
    }
  }, []);

  useEffect(() => {
    if (menuQuery.isError || menuQuery.data === undefined) return;
    const data = menuQuery.data;
    const items = [];
    if (Array.isArray(data)) {
      data.forEach((cat) => {
        if (Array.isArray(cat?.items)) items.push(...cat.items);
      });
    }
    setMenuCatalog(mergeMenuWithFallback(items, fallbackMenuItems));
  }, [menuQuery.data, menuQuery.isError]);

  useEffect(() => {
    if (!cartId && !urlTableKey) {
      setAddonsLoading(false);
      return;
    }
    setAddonsLoading(
      addonsQuery.isLoading || addonsQuery.isFetching,
    );
  }, [
    cartId,
    urlTableKey,
    addonsQuery.isLoading,
    addonsQuery.isFetching,
  ]);

  useEffect(() => {
    if (!cartId && !urlTableKey) {
      setAddonList([]);
      try {
        localStorage.removeItem("terra_global_addons");
      } catch (_) {
        /* ignore */
      }
      return;
    }
    if (addonsQuery.isError) {
      setAddonList([]);
      try {
        localStorage.removeItem("terra_global_addons");
      } catch (_) {
        /* ignore */
      }
      return;
    }
    if (addonsQuery.data === undefined) return;
    const json = addonsQuery.data;
    if (json && json.success === false) {
      setAddonList([]);
      try {
        localStorage.removeItem("terra_global_addons");
      } catch (_) {
        /* ignore */
      }
      return;
    }
    const rawList = json?.data ?? json ?? [];
    const list = (Array.isArray(rawList) ? rawList : []).map((a) => ({
      id: (a._id || a.id || "").toString(),
      name: sanitizeAddonName(a.name),
      price: Number(a.price) || 0,
      icon: a.icon || "",
    }));
    setAddonList(list);
    try {
      if (list.length > 0) {
        localStorage.setItem("terra_global_addons", JSON.stringify(list));
      } else {
        localStorage.removeItem("terra_global_addons");
      }
    } catch (_) {
      /* ignore */
    }
  }, [addonsQuery.data, addonsQuery.isError, cartId, urlTableKey]);

  useEffect(() => {
    const unsubscribe = subscribeToLanguageChanges((lang) => {
      setLanguage(lang);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    setProcessSteps(initialProcessSteps());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  useEffect(() => {
    const syncCartFromStorage = () => {
      const { scope, scopedCart } = readLatestScopedCart();
      setCartScopeServiceType(scope);
      setCart(scopedCart);
    };
    syncCartFromStorage();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncCartFromStorage();
      }
    };

    getCartId(searchParams).then((resolvedCartId) => {
      setCartId(resolvedCartId);
      console.log("[CartPage] Using cartId:", resolvedCartId);
      if (resolvedCartId) {
        ensureAiSessionForCart(resolvedCartId, nodeApi).catch(() => {});
      }
    });

    window.addEventListener("focus", syncCartFromStorage);
    window.addEventListener("storage", syncCartFromStorage);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", syncCartFromStorage);
      window.removeEventListener("storage", syncCartFromStorage);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [readLatestScopedCart, urlCartKey, urlTableKey]);

  const updateCart = (newCart) => {
    const { scope } = readLatestScopedCart();
    setCartScopeServiceType(scope);
    setCart(newCart);
    writeScopedCart(newCart, scope);
  };

  const menuCatalogMap = useMemo(
    () => buildMenuCatalogMap(menuCatalog),
    [menuCatalog],
  );

  const saveAddonsForCart = (addonIds) => {
    const raw = localStorage.getItem("terra_cart_addons") || "{}";
    let obj = {};
    try {
      const p = JSON.parse(raw);
      obj = Array.isArray(p) ? {} : p;
    } catch (_) {}
    if (cartId) {
      obj[cartId] = addonIds;
    } else {
      localStorage.setItem("terra_cart_addons", JSON.stringify(addonIds));
      return;
    }
    localStorage.setItem("terra_cart_addons", JSON.stringify(obj));
  };

  const clearAddonsForCart = () => {
    if (!cartId) {
      localStorage.removeItem("terra_cart_addons");
      return;
    }
    const raw = localStorage.getItem("terra_cart_addons") || "{}";
    try {
      const obj = JSON.parse(raw);
      if (Array.isArray(obj)) return;
      delete obj[cartId];
      localStorage.setItem("terra_cart_addons", JSON.stringify(obj));
    } catch (_) {}
  };

  const handleUpdateQty = (itemName, delta) => {
    const newCart = { ...cart };
    const currentQty = newCart[itemName] || 0;
    const newQty = currentQty + delta;

    if (newQty <= 0) {
      delete newCart[itemName];
    } else {
      newCart[itemName] = newQty;
    }
    updateCart(newCart);
  };

  const handleReset = () => {
    if (window.confirm(t("clearCartConfirm"))) {
      updateCart({});
      setSelectedAddOns([]);
      clearAddonsForCart();
    }
  };

  const handleConfirm = async () => {
    if (placeOrderInFlightRef.current) return;
    if (processOpen) return;

    const { scope: latestCartScope, scopedCart: latestScopedCart } =
      readLatestScopedCart();
    const cartSnapshot =
      latestScopedCart && Object.keys(latestScopedCart).length > 0
        ? latestScopedCart
        : cart;
    if (!cartSnapshot || Object.keys(cartSnapshot).length === 0) {
      return alert(t("cartEmpty"));
    }
    setCartScopeServiceType(latestCartScope);
    if (Object.keys(cart).length === 0 && Object.keys(cartSnapshot).length > 0) {
      setCart(cartSnapshot);
    }

    placeOrderInFlightRef.current = true;

    let requiresPaymentChoiceStep = false;
    try {
      const tableContext = parseJsonSafely(
        localStorage.getItem("terra_selectedTable") || "{}",
        {},
      );
      const isOfficeQrFlow = hasOfficeQrMetadata(tableContext);
      const currentServiceType = (
        localStorage.getItem("terra_serviceType") || "DINE_IN"
      )
        .toString()
        .trim()
        .toUpperCase();
      const isPickupOrDeliveryFlow =
        currentServiceType === "PICKUP" ||
        currentServiceType === "DELIVERY";
      const isTakeawayLikeFlow =
        currentServiceType === "TAKEAWAY" || isPickupOrDeliveryFlow;
      const activeOrderId = isTakeawayLikeFlow
        ? localStorage.getItem("terra_orderId_TAKEAWAY")
        : localStorage.getItem("terra_orderId_DINE_IN") ||
          localStorage.getItem("terra_orderId");
      const activeOrderStatus = isTakeawayLikeFlow
        ? localStorage.getItem("terra_orderStatus_TAKEAWAY")
        : localStorage.getItem("terra_orderStatus_DINE_IN") ||
          localStorage.getItem("terra_orderStatus");
      const blockedStatuses = new Set([
        "Paid",
        "Cancelled",
        "Returned",
        "Served",
        "Completed",
        "Finalized",
      ]);
      const isFreshOrderFlow =
        !activeOrderId || blockedStatuses.has(activeOrderStatus);
      requiresPaymentChoiceStep =
        !isOfficeQrFlow &&
        !isPickupOrDeliveryFlow &&
        isFreshOrderFlow &&
        currentServiceType === "TAKEAWAY";
    } catch (paymentChoiceErr) {
      console.warn("[CartPage] Failed to resolve payment choice flow:", paymentChoiceErr);
    }

    saveAddonsForCart(selectedAddOns);

    // Reset Steps
    setProcessSteps(
      initialProcessSteps().map((step) => ({ ...step, state: "pending" })),
    );
    setProcessOpen(true);

    try {
      // Step 0: Validating
      setStepState(0, "active");
      await wait(DUR.validate);
      setStepState(0, "done");

      // Step 1: Processing
      setStepState(1, "active");
      await wait(DUR.order);
      setStepState(1, "done");

      // Step 2: Sending
      setStepState(2, "active");
      await wait(DUR.beforeSend);

      // --- AGGREGATE ORDER CONTEXT ---
      let tableInfo = parseJsonSafely(
        localStorage.getItem("terra_selectedTable") || "{}",
        {},
      );
      const isOfficeQrFlow = hasOfficeQrMetadata(tableInfo);
      let serviceType = (
        localStorage.getItem("terra_serviceType") || "DINE_IN"
      )
        .toString()
        .trim()
        .toUpperCase();
      if (isOfficeQrFlow && serviceType === "DINE_IN") {
        serviceType = "TAKEAWAY";
        localStorage.setItem("terra_serviceType", "TAKEAWAY");
        localStorage.removeItem("terra_orderType");
        localStorage.removeItem("terra_waitToken");
      }
      // Ignore stale pickup/delivery subtype when current flow is DINE_IN.
      const isPickupOrDeliveryServiceType =
        serviceType === "PICKUP" || serviceType === "DELIVERY";
      const storedOrderType =
        isPickupOrDeliveryServiceType
          ? localStorage.getItem("terra_orderType")
          : null;
      const effectiveOrderType =
        storedOrderType === "PICKUP" || storedOrderType === "DELIVERY"
          ? storedOrderType
          : isPickupOrDeliveryServiceType
            ? serviceType
            : undefined;
      const isTakeawayLike =
        isOfficeQrFlow ||
        serviceType === "TAKEAWAY" ||
        isPickupOrDeliveryServiceType;
      if (isOfficeQrFlow) {
        const officeSlug =
          tableInfo?.qrSlug ||
          localStorage.getItem("terra_scanToken") ||
          searchParams?.get("table");
        const officeSessionToken =
          localStorage.getItem("terra_takeaway_sessionToken") || "";
        if (officeSlug) {
          try {
            const params = new URLSearchParams();
            if (officeSessionToken) {
              params.set("sessionToken", officeSessionToken);
            }
            const lookupUrl = `${nodeApi}/api/tables/lookup/${encodeURIComponent(
              officeSlug,
            )}${params.toString() ? `?${params.toString()}` : ""}`;
            const lookupRes = await fetch(lookupUrl);
            if (lookupRes.ok || lookupRes.status === 423) {
              const lookupPayload = await lookupRes.json();
              if (lookupPayload?.table) {
                tableInfo = { ...tableInfo, ...lookupPayload.table };
                localStorage.setItem(
                  "terra_selectedTable",
                  JSON.stringify(tableInfo),
                );
              }
            }
          } catch (officeLookupErr) {
            console.warn(
              "[CartPage] Failed to refresh office table context:",
              officeLookupErr,
            );
          }
        }
      }

      const officePaymentMode = resolveOfficePaymentMode(tableInfo);
      const officePaymentGateMode = isOfficeQrFlow
        ? officePaymentMode === "COD"
          ? "CASH"
          : officePaymentMode === "BOTH"
            ? "CHOICE"
            : "ONLINE"
        : null;
      const requiresNonOfficePaymentChoiceBeforePlacement =
        requiresPaymentChoiceStep &&
        !isOfficeQrFlow &&
        !isPickupOrDeliveryServiceType &&
        serviceType === "TAKEAWAY";
      const requiresPaymentChoiceBeforePlacement =
        requiresNonOfficePaymentChoiceBeforePlacement ||
        officePaymentGateMode === "CHOICE";
      const requiresImmediatePayment =
        effectiveOrderType === "PICKUP" ||
        effectiveOrderType === "DELIVERY" ||
        Boolean(officePaymentGateMode) ||
        requiresNonOfficePaymentChoiceBeforePlacement;
      const shouldIncludeCustomerInfo =
        effectiveOrderType === "PICKUP" ||
        effectiveOrderType === "DELIVERY" ||
        isOfficeQrFlow;
      const activeOrderId =
        isTakeawayLike
          ? localStorage.getItem("terra_orderId_TAKEAWAY")
          : localStorage.getItem("terra_orderId_DINE_IN") ||
            localStorage.getItem("terra_orderId");

      let sessionToken = "";
      if (isTakeawayLike) {
        sessionToken = localStorage.getItem("terra_takeaway_sessionToken");
        if (!sessionToken) {
          sessionToken = `TAKEAWAY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          localStorage.setItem("terra_takeaway_sessionToken", sessionToken);
        }
      } else {
        sessionToken =
          localStorage.getItem("terra_sessionToken") || tableInfo?.sessionToken || "";

        // Refresh table/session context from lookup when possible.
        const tableSlug =
          tableInfo?.qrSlug ||
          localStorage.getItem("terra_scanToken") ||
          searchParams?.get("table");
        const hasTableIdentity = !!(
          tableInfo?.id ||
          tableInfo?._id ||
          tableInfo?.number ||
          tableInfo?.tableNumber
        );

        if (tableSlug && (!sessionToken || !hasTableIdentity)) {
          try {
            const params = new URLSearchParams();
            if (sessionToken) params.set("sessionToken", sessionToken);
            const lookupUrl = `${nodeApi}/api/tables/lookup/${encodeURIComponent(tableSlug)}${
              params.toString() ? `?${params.toString()}` : ""
            }`;
            const lookupRes = await fetch(lookupUrl);
            if (lookupRes.ok || lookupRes.status === 423) {
              const lookupPayload = await lookupRes.json();
              if (lookupPayload?.table) {
                tableInfo = { ...tableInfo, ...lookupPayload.table };
                localStorage.setItem(
                  "terra_selectedTable",
                  JSON.stringify(tableInfo),
                );
              }
              if (lookupPayload?.sessionToken || lookupPayload?.table?.sessionToken) {
                sessionToken =
                  lookupPayload.sessionToken || lookupPayload.table.sessionToken;
                localStorage.setItem("terra_sessionToken", sessionToken);
              }
            }
          } catch (lookupErr) {
            console.warn("[CartPage] Failed to refresh table/session lookup:", lookupErr);
          }
        }

        if (!sessionToken) {
          throw new Error(
            "Session expired. Please scan the table QR code again and retry.",
          );
        }
      }

      let customerLocation = null;
      const shouldIncludeCustomerLocation =
        effectiveOrderType === "PICKUP" ||
        effectiveOrderType === "DELIVERY" ||
        isOfficeQrFlow;
      const customerLocationStr = shouldIncludeCustomerLocation
        ? localStorage.getItem("terra_customerLocation")
        : null;
      if (customerLocationStr) {
        try {
          customerLocation = JSON.parse(customerLocationStr);
        } catch (parseError) {
          console.warn(
            "[CartPage] Failed to parse terra_customerLocation:",
            parseError,
          );
          customerLocation = null;
        }
      }

      // Prepare Add-ons
      const globalAddons = JSON.parse(
        localStorage.getItem("terra_global_addons") || "[]",
      );
      const addonLookupList = Array.isArray(globalAddons) ? globalAddons : [];
      const resolvedAddons = selectedAddOns
        .map((id) => {
          const meta = addonLookupList.find((a) => a.id === id);
          return meta
            ? { addonId: id, name: sanitizeAddonName(meta.name), price: meta.price }
            : null;
        })
        .filter(Boolean);

      // CartId
      const cartId = await getCartId(searchParams);
      const effectiveSpecialInstructions =
        specialInstructions?.trim() ||
        localStorage.getItem("terra_specialInstructions") ||
        "";

      let menuCatalogForPayload = menuCatalogMap.byName;
      const hasPricedCartItem = Object.entries(cartSnapshot).some(
        ([itemName, quantity]) => {
          const qtyValue = Number(quantity);
          if (!Number.isFinite(qtyValue) || qtyValue <= 0) return false;
          const normalizedItemName = normalizeMenuItemName(itemName);
          const itemMeta =
            menuCatalogMap.byName[itemName] ||
            menuCatalogMap.byNormalizedName[normalizedItemName];
          const itemPrice = Number(itemMeta?.price);
          return Number.isFinite(itemPrice) && itemPrice > 0;
        },
      );
      if (!hasPricedCartItem) {
        const refreshedCatalog = await fetchMenuCatalog(cartId);
        const refreshedCatalogMap = buildMenuCatalogMap(refreshedCatalog);
        if (Object.keys(refreshedCatalogMap.byName).length > 0) {
          menuCatalogForPayload = refreshedCatalogMap.byName;
        }
      }

      const orderPayload = buildOrderPayload(cartSnapshot, {
        serviceType:
          effectiveOrderType === "PICKUP" || effectiveOrderType === "DELIVERY"
            ? effectiveOrderType
            : serviceType,
        orderType:
          effectiveOrderType === "PICKUP" || effectiveOrderType === "DELIVERY"
            ? effectiveOrderType
            : undefined,
        tableId: tableInfo.id || tableInfo._id,
        tableNumber: tableInfo.number || tableInfo.tableNumber,
        menuCatalog: menuCatalogForPayload,
        sessionToken: sessionToken,
        // Customer fields (required for PICKUP/DELIVERY)
        customerName: shouldIncludeCustomerInfo
          ? localStorage.getItem("terra_takeaway_customerName")
          : undefined,
        customerMobile: shouldIncludeCustomerInfo
          ? localStorage.getItem("terra_takeaway_customerMobile")
          : undefined,
        customerLocation: customerLocation,
        sourceQrType: isOfficeQrFlow ? "OFFICE" : "TABLE",
        officeName: isOfficeQrFlow
          ? String(tableInfo?.officeName || "").trim() || undefined
          : undefined,
        officeAddress: isOfficeQrFlow
          ? String(tableInfo?.officeAddress || "").trim() || undefined
          : undefined,
        officePhone: isOfficeQrFlow
          ? String(tableInfo?.officePhone || "").trim() || undefined
          : undefined,
        officeDeliveryCharge: isOfficeQrFlow
          ? Number(tableInfo?.officeDeliveryCharge || 0)
          : undefined,
        officePaymentMode: officePaymentMode || undefined,
        isVIP: isOfficeQrFlow ? tableInfo?.isVIP === true : undefined,
        paymentRequiredBeforeProceeding: requiresPaymentChoiceBeforePlacement,
        cartId: cartId,
        specialInstructions: effectiveSpecialInstructions,
        selectedAddons: resolvedAddons,
      });
      // Simple Validation
      if (!orderPayload.items || orderPayload.items.length === 0) {
        throw new Error(t("cartInvalidItems"));
      }
      if (
        !Number.isFinite(Number(orderPayload.totalAmount)) ||
        Number(orderPayload.totalAmount) <= 0
      ) {
        throw new Error(
          "Order amount is not ready yet. Please wait a moment and confirm again.",
        );
      }

      const isPickupOrDeliveryOrder =
        orderPayload.serviceType === "PICKUP" ||
        orderPayload.serviceType === "DELIVERY" ||
        orderPayload.orderType === "PICKUP" ||
        orderPayload.orderType === "DELIVERY";
      const isDeliveryOrder =
        orderPayload.serviceType === "DELIVERY" ||
        orderPayload.orderType === "DELIVERY";

      if (isPickupOrDeliveryOrder) {
        if (!orderPayload.customerName || !orderPayload.customerName.trim()) {
          throw new Error(t("customerNameRequired"));
        }
        if (
          !orderPayload.customerMobile ||
          !orderPayload.customerMobile.trim()
        ) {
          throw new Error(t("customerMobileRequired"));
        }
        if (!orderPayload.cartId) {
          throw new Error(t("storeSelectionMissing"));
        }
      }

      if (isDeliveryOrder) {
        const lat = Number(orderPayload?.customerLocation?.latitude);
        const lon = Number(orderPayload?.customerLocation?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new Error(t("deliveryLocationMissing"));
        }
        orderPayload.customerLocation = {
          ...orderPayload.customerLocation,
          latitude: lat,
          longitude: lon,
        };
      }

      // Check if existing order is finalized/paid - if so, start new order
      const activeOrderStatus =
        isTakeawayLike
          ? localStorage.getItem("terra_orderStatus_TAKEAWAY")
          : localStorage.getItem("terra_orderStatus_DINE_IN") ||
            localStorage.getItem("terra_orderStatus");

      const blockedStatuses = [
        "Paid",
        "Cancelled",
        "Returned",
        "Served",
        "Completed",
        "Finalized",
      ];
      let finalActiveOrderId = activeOrderId;

      if (activeOrderId && blockedStatuses.includes(activeOrderStatus)) {
        console.log(
          "[CartPage] Previous order status is",
          activeOrderStatus,
          "- starting new order",
        );
        finalActiveOrderId = null;
      }

      const previewTakeawayToken = Number(
        localStorage.getItem(TAKEAWAY_TOKEN_PREVIEW_KEY),
      );
      if (
        isTakeawayLike &&
        effectiveOrderType !== "DELIVERY" &&
        !finalActiveOrderId &&
        Number.isInteger(previewTakeawayToken) &&
        previewTakeawayToken > 0
      ) {
        orderPayload.takeawayToken = previewTakeawayToken;
      }
      const requestIdempotencyKey = `ord-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 11)}`;
      orderPayload.idempotencyKey = requestIdempotencyKey;
      const paymentGateMode =
        officePaymentGateMode ||
        (requiresNonOfficePaymentChoiceBeforePlacement ? "CHOICE" : null);

      if (requiresImmediatePayment) {
        const deferredOrderDraft = {
          orderPayload,
          finalActiveOrderId: finalActiveOrderId || null,
          isTakeawayLike: Boolean(isTakeawayLike),
          activeOrderStatus: activeOrderStatus || "",
          paymentGateMode: paymentGateMode || null,
          createdAt: new Date().toISOString(),
        };

        localStorage.setItem(
          PAYMENT_GATE_DRAFT_KEY,
          JSON.stringify(deferredOrderDraft),
        );

        if (paymentGateMode) {
          localStorage.setItem(PAYMENT_GATE_MODE_KEY, paymentGateMode);
          localStorage.removeItem(PAYMENT_GATE_ORDER_ID_KEY);
        } else {
          localStorage.removeItem(PAYMENT_GATE_ORDER_ID_KEY);
          localStorage.removeItem(PAYMENT_GATE_MODE_KEY);
        }

        setStepState(2, "done");
        setStepState(3, "done");
        navigate("/payment");
        return;
      }

      localStorage.removeItem(PAYMENT_GATE_DRAFT_KEY);

      // API Call
      const url = finalActiveOrderId
        ? `${nodeApi}/api/orders/${finalActiveOrderId}/kot`
        : `${nodeApi}/api/orders`;

      const res = await postWithRetry(
        url,
        orderPayload,
        {},
        { maxRetries: 2, timeout: 30000 },
      );

      let data;
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : {};
      } catch (e) {
        data = {};
      }

      if (!res.ok) {
        const msg = data.message || data.error || t("failedCreateOrder");
        throw new Error(msg);
      }

      // Success!
      setStepState(2, "done");

      // Step 3: Kitchen
      setStepState(3, "active");
      await wait(DUR.kitchen);
      setStepState(3, "done");

      // Update LocalStorage to reflect new order state for Menu.jsx
      if (data._id) {
        refreshCustomerPushToken().catch(() => {
          // Best effort only; order flow should continue even if push setup fails.
        });
        queryClient.invalidateQueries({ queryKey: ["menu"] });
        queryClient.invalidateQueries({ queryKey: ["addons"] });
        const resolvedOrderStatus = resolveOrderStatusValue(
          data.status,
          activeOrderStatus,
        );
        if (isTakeawayLike) {
          localStorage.setItem("terra_orderId_TAKEAWAY", data._id);
          localStorage.removeItem(TAKEAWAY_TOKEN_PREVIEW_KEY);
          localStorage.setItem(
            "terra_orderStatus_TAKEAWAY",
            resolvedOrderStatus,
          );
          localStorage.setItem(
            "terra_orderStatusUpdatedAt_TAKEAWAY",
            new Date().toISOString(),
          );
        } else {
          localStorage.setItem("terra_orderId", data._id);
          localStorage.setItem("terra_orderId_DINE_IN", data._id);
          localStorage.setItem("terra_orderStatus", resolvedOrderStatus);
          localStorage.setItem(
            "terra_orderStatus_DINE_IN",
            resolvedOrderStatus,
          );
          localStorage.setItem(
            "terra_orderStatusUpdatedAt",
            new Date().toISOString(),
          );
          localStorage.setItem(
            "terra_orderStatusUpdatedAt_DINE_IN",
            new Date().toISOString(),
          );
        }
        if (paymentGateMode) {
          localStorage.setItem(PAYMENT_GATE_ORDER_ID_KEY, data._id);
          localStorage.setItem(PAYMENT_GATE_MODE_KEY, paymentGateMode);
        } else {
          localStorage.removeItem(PAYMENT_GATE_ORDER_ID_KEY);
          localStorage.removeItem(PAYMENT_GATE_MODE_KEY);
        }
        // For pickup/delivery, keep cart until payment completes so back-from-payment shows items
        if (!requiresImmediatePayment) {
          clearScopedCart(serviceType);
          setCart({});
        }
      }

      // DONE - Navigate
      // For pickup/delivery: payment is compulsory — go to Payment page
      if (requiresImmediatePayment) {
        navigate("/payment");
      } else {
        navigate("/menu");
      }
    } catch (err) {
      console.error("Order processing failed:", err);
      setStepState(2, "error");
      await wait(DUR.error);
      alert(`${t("errorPrefix")} ${err.message}`);
      setProcessOpen(false);
    } finally {
      placeOrderInFlightRef.current = false;
    }
  };

  const getAddonQuantity = (id) =>
    selectedAddOns.filter((item) => item === id).length;

  const addAddOn = (id) => {
    const next = [...selectedAddOns, id];
    setSelectedAddOns(next);
    saveAddonsForCart(next);
  };

  const removeAddOn = (id) => {
    const idx = selectedAddOns.indexOf(id);
    if (idx === -1) return;
    const next = selectedAddOns.filter((_, i) => i !== idx);
    setSelectedAddOns(next);
    saveAddonsForCart(next);
  };

  // Calculate items with details
  const cartItemsParams = Object.entries(cart)
    .map(([name, qty]) => {
      // Robust matching: case insensitive
      const normalizedName = normalizeMenuItemName(name);
      const meta =
        menuCatalogMap.byName[name] ||
        menuCatalogMap.byNormalizedName[normalizedName];
      return {
        name,
        qty,
        price: meta ? meta.price : 0, // Price in Rupees
        image: meta ? meta.image || meta.imageUrl : null,
      };
    })
    .filter((item) => item.qty > 0);

  const totalAmount = cartItemsParams.reduce(
    (sum, item) => sum + item.price * item.qty,
    0,
  );
  const addOnsTotal = selectedAddOns.reduce((sum, id) => {
    const addon = addonList.find((a) => a.id === id);
    return sum + (addon ? addon.price : 0);
  }, 0);
  const finalTotal = totalAmount + addOnsTotal;

  return (
    <div
      className={`cart-page ${accessibilityMode ? "accessibility-mode" : ""}`}
    >
      <Header
        accessibilityMode={accessibilityMode}
        onClickCart={() => {}} // Already on cart page
        cartCount={Object.values(cart).reduce((a, b) => a + b, 0)}
      />

      <div className="cart-content">
        <div className="cart-header-row">
          <button onClick={() => navigate("/menu")} className="back-btn">
            <FiArrowLeft size={24} />
          </button>
          <h2>{t("yourCart")}</h2>
        </div>

        <div className="cart-list">
          {cartItemsParams.length === 0 ? (
            <div className="empty-msg">
              {t("cartEmptyMessage")} <br />
              <span
                onClick={() => navigate("/menu")}
                style={{ color: "#fc8019", cursor: "pointer" }}
              >
                {t("goToMenu")}
              </span>
              {selectedAddOns.length > 0 && (
                <div style={{ marginTop: "10px", color: "#888", fontSize: 12 }}>
                  {t("addonsRequireMenuItem")}
                </div>
              )}
            </div>
          ) : (
            cartItemsParams.map((item) => (
              <div key={item.name} className="cart-item-card">
                {item.image && (
                  <div className="cart-item-image-wrap">
                    <img
                      src={getImageUrl(item.image)}
                      alt={item.name}
                      className="cart-item-image"
                    />
                  </div>
                )}
                <div className="item-details">
                  <h3>{item.name}</h3>
                  <div className="item-price">{formatINR(item.price)}</div>
                </div>
                <div className="qty-controls">
                  <button
                    onClick={() => handleUpdateQty(item.name, -1)}
                    className="ctrl-btn"
                  >
                    {item.qty === 1 ? (
                      <FiTrash2 size={16} />
                    ) : (
                      <FiMinus size={18} />
                    )}
                  </button>
                  <span className="qty-val">{item.qty}</span>
                  <button
                    onClick={() => handleUpdateQty(item.name, 1)}
                    className="ctrl-btn"
                  >
                    <FiPlus size={18} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {cartItemsParams.length > 0 && (
          <div className="cart-footer">
            <div className="cart-footer-content">
              <div className="total-row final-total-row">
                <span>{t("total")}</span>
                <span>{formatINR(finalTotal)}</span>
              </div>
              <div className="action-buttons">
                <button onClick={handleReset} className="reset-btn">
                  {t("reset")}
                </button>
                <button onClick={handleConfirm} className="confirm-btn">
                  {t("confirmOrder")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Keep add-ons visible even if cart is empty (user may want to add/remove add-ons first). */}
        <div className="addons-section">
          <h3>{t("customizationsExtras")}</h3>
          {addonsLoading ? (
            <div
              style={{
                padding: "20px",
                textAlign: "center",
                color: "#666",
              }}
            >
              {t("loadingAddons")}
            </div>
          ) : addonList.length === 0 ? (
            <div
              style={{
                padding: "20px",
                textAlign: "center",
                color: "#999",
                fontSize: "14px",
              }}
            >
              {t("noAddonsAvailable")}
            </div>
          ) : (
            <div className="addons-grid">
              {addonList.map((addon) => {
                const qty = getAddonQuantity(addon.id);
                return (
                  <div
                    key={addon.id}
                    className={`addon-card ${qty > 0 ? "active" : ""}`}
                  >
                    <div className="addon-info">
                      <div className="addon-text">
                        <span className="addon-name">{sanitizeAddonName(addon.name)}</span>
                        {addon.price > 0 && (
                          <span className="addon-price">{formatINR(addon.price)}</span>
                        )}
                      </div>
                    </div>
                    <div className="addon-qty-controls">
                      <button
                        type="button"
                        className="addon-ctrl-btn"
                        onClick={() => removeAddOn(addon.id)}
                        disabled={qty === 0}
                        aria-label={formatText("removeAddonAria", {
                          name: sanitizeAddonName(addon.name),
                        })}
                      >
                        {qty === 1 ? (
                          <FiTrash2 size={16} />
                        ) : (
                          <FiMinus size={18} />
                        )}
                      </button>
                      <span className="addon-qty-val">{qty}</span>
                      <button
                        type="button"
                        className="addon-ctrl-btn"
                        onClick={() => addAddOn(addon.id)}
                        aria-label={formatText("addAddonAria", {
                          name: sanitizeAddonName(addon.name),
                        })}
                      >
                        <FiPlus size={18} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          className="instructions-section"
          style={{ marginTop: "20px", padding: "0 16px 20px" }}
        >
          <h3
            style={{
              fontSize: "18px",
              marginBottom: "10px",
              color: "#333",
            }}
          >
            {t("specialInstructionsTitle")}
          </h3>
          <textarea
            placeholder={t("specialInstructionsPlaceholder")}
            value={specialInstructions}
            onChange={(e) => {
              setSpecialInstructions(e.target.value);
              // localStorage.setItem("terra_specialInstructions", e.target.value); // Removed persistence
            }}
            style={{
              width: "100%",
              minHeight: "80px",
              padding: "12px",
              borderRadius: "12px",
              border: "1px solid #ddd",
              fontSize: "14px",
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
        </div>
      </div>
      <ProcessOverlay
        open={processOpen}
        steps={processSteps}
        title={t("processOrderTitle")}
      />
    </div>
  );
}
