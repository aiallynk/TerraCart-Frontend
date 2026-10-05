import Header from "../../components/Header";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { FiMic, FiMicOff } from "react-icons/fi";
import menuPageTranslations from "../../data/translations/MenuPage.json";
import fallbackMenuItems from "../../data/menuData";
import restaurantBg from "../../assets/images/restaurant-img.jpg";
import { HiSpeakerWave } from "react-icons/hi2";
import { motion } from "framer-motion";
import "./MenuPage.css";
import { buildOrderPayload } from "../../utils/orderUtils";
import ProcessOverlay from "../../components/ProcessOverlay";
import OrderStatus from "../../components/OrderStatus";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

import { fetchWithRetry, postWithRetry } from "../../utils/fetchWithTimeout";
import {
  clearAllScopedCarts,
  clearScopedCart,
  readScopedCart,
  writeScopedCart,
} from "../../utils/cartStorage";
import {
  buildSocketIdentityPayload,
  ensureAnonymousSessionId,
} from "../../utils/anonymousSession";
import {
  getCustomerSocket,
  joinCustomerRoomOnce,
  safeCustomerSocketOn,
} from "../../utils/socketManager";
import { refreshCustomerPushToken } from "../../services/customerPushService";
import { ensureAiSessionForCart } from "../../utils/aiSessionClient";
import { queryClient } from "../../query/queryClient";
import { queryKeys } from "../../query/queryKeys";
import { fetchMenuPublicPayload } from "../../services/menuPublicApi";
import { notifyOrderStatusUpdate } from "../../utils/orderStatusNotifications";
import { formatINR, INR_CURRENCY_SYMBOL } from "../../utils/currency";

import {
  nodeApi,
  TAP_TO_ORDER_AI_ENDPOINT,
  TAP_TO_ORDER_TRANSCRIBE_ENDPOINT,
  MENU_PAGE_TRANSLATION_ENDPOINT,
  MENU_BACK_PRESERVE_KEY,
  MENU_SESSION_MARKER_KEY,
  TAP_TO_ORDER_MAX_RECORD_MS,
  TAP_TO_ORDER_SILENCE_STOP_MS,
  TAP_TO_ORDER_AUDIO_LEVEL_THRESHOLD,
  SERVICE_TYPE_KEY,
  TABLE_SELECTION_KEY,
  FEEDBACK_SUBMITTED_ORDERS_KEY,
  TAKEAWAY_TOKEN_PREVIEW_KEY,
  INVOICE_EXPORT_WIDTH,
  STATIC_MENU_TEXT_TRANSLATION_KEYS,
} from "./menuConstants.js";
import {
  getImageUrl,
  normalizeServiceType,
  normalizeOrderStatus,
  normalizePaymentStatus,
  isCancelledOrReturnedStatus,
  isOrderSettled,
  isOrderActiveForCustomer,
  canAddItemsToExistingOrder,
  shouldPreserveOrderStateWithoutActiveId,
  isTakeawayLikeServiceType,
  hasOfficeQrMetadata,
  resolveOfficePaymentMode,
  paiseToRupees,
  getInvoiceCaptureScale,
  isIOSLikeBrowser,
  saveInvoicePdf,
  sanitizeAddonName,
  getAssignedStaffFromOrder,
  buildInvoiceId,
  getLatestKot,
  aggregateOrderItems,
  computeOrderTotals,
  resolveOrderTimestamp,
  getSubmittedFeedbackOrderIds,
  hasSubmittedFeedbackForOrder,
  buildCategoriesFromFlatItems,
  buildCatalogFromCategories,
  toTranslationLookupKey,
} from "./menuHelpers.js";
import { MenuItemCard } from "./components/MenuItemCard.jsx";
import { MenuCategoryBlock } from "./components/MenuCategoryBlock.jsx";
import { TranslatedSummaryItem } from "./components/TranslatedSummaryItem.jsx";
import { useDebouncedScopedCartWrite } from "./hooks/useCartSync.js";
import { getMenuBootstrapIdentity } from "./hooks/useMenuBootstrap.js";
export default function MenuPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const anonymousSessionId = useMemo(() => ensureAnonymousSessionId(), []);
  const supportedLangs = ["en", "hi", "mr", "gu"];
  const normalizeLang = (stored) =>
    supportedLangs.includes(stored) ? stored : "en";
  const [lang, setLang] = useState(() =>
    normalizeLang(localStorage.getItem("language") || "en")
  );
  const [menuTranslations, setMenuTranslations] = useState({});
  const menuTranslationCacheRef = useRef(new Map());

  // Listen for storage changes to update language (no remount - menu stays loaded)
  useEffect(() => {
    const handleStorageChange = () => {
      setLang(normalizeLang(localStorage.getItem("language") || "en"));
    };
    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("language-change", handleStorageChange);
    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("language-change", handleStorageChange);
    };
  }, []);

  useEffect(() => {
    try {
      // Same-tab marker used by Landing to safely resume menu session if user goes home.
      sessionStorage.setItem(MENU_SESSION_MARKER_KEY, "1");
    } catch {
      // Ignore sessionStorage failures.
    }
  }, []);

  const t = (key, fallback) => {
    if (!key) return fallback;
    const keys = key.split(".");
    const langSource =
      menuPageTranslations[lang] ?? menuPageTranslations.en ?? {};
    let value = langSource;
    for (const k of keys) {
      value = value?.[k];
    }
    return value ?? fallback;
  };

  const initialProcessSteps = [
    {
      label: t("processSteps.checkingOrder", "Checking your order"),
      state: "pending",
    },
    {
      label: t("processSteps.confirmingItems", "Confirming items & price"),
      state: "pending",
    },
    {
      label: t("processSteps.placingOrder", "Placing your order"),
      state: "pending",
    },
    {
      label: t("processSteps.sendingToKitchen", "Sending to kitchen"),
      state: "pending",
    },
    {
      label: t("processSteps.preparingDetails", "Preparing order details"),
      state: "pending",
    },
  ];

  const [processOpen, setProcessOpen] = useState(false);
  const [processSteps, setProcessSteps] = useState(initialProcessSteps);

  const setStepState = (index, state) =>
    setProcessSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, state } : s)),
    );

  const [accessibilityMode, setAccessibilityMode] = useState(
    localStorage.getItem("accessibilityMode") === "true",
  );

  const toggleAccessibility = () => {
    const newMode = !accessibilityMode;
    setAccessibilityMode(newMode);
    localStorage.setItem("accessibilityMode", newMode.toString());
  };

  const [cart, setCart] = useState(() => readScopedCart());
  const cartRef = useRef(cart);
  const placeOrderInFlightRef = useRef(false);
  const lastSuccessfulMenuBootstrapKeyRef = useRef("");

  const persistScopedCart = useCallback((payload) => {
    writeScopedCart(payload.cart, payload.serviceType);
  }, []);

  const { schedule: scheduleCartPersist, flush: flushCartPersist } =
    useDebouncedScopedCartWrite(persistScopedCart, 220);

  const [recording, setRecording] = useState(false);
  const [blindListening, setBlindListening] = useState(false);
  const [orderText, setOrderText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState(false);
  const [isOrderingMore, setIsOrderingMore] = useState(false);
  const [openCategory, setOpenCategory] = useState(null);
  const [showCart, setShowCart] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [menuCategories, setMenuCategories] = useState([]);
  const [menuCatalog, setMenuCatalog] = useState({});
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState(null);
  const [cartContact, setCartContact] = useState(null);
  const [hasCartContext, setHasCartContext] = useState(false);
  const [contactCartId, setContactCartId] = useState("");
  const flatMenuItems = useMemo(() => {
    if (!Array.isArray(menuCategories) || menuCategories.length === 0)
      return [];
    return menuCategories.flatMap((category) => {
      if (!category) return [];
      return (Array.isArray(category.items) ? category.items : []).map(
        (item) => ({
          ...item,
          categoryName: category?.name || "Menu",
        }),
      );
    });
  }, [menuCategories]);

  const { cartTotal, cartItemCount } = useMemo(() => {
    let total = 0;
    let count = 0;
    Object.entries(cart).forEach(([itemName, qty]) => {
      count += qty;
      const item = flatMenuItems.find((i) => i.name === itemName);
      if (item) {
        total += (item.price || 0) * qty;
      }
    });
    return { cartTotal: total, cartItemCount: count };
  }, [cart, flatMenuItems]);

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    if (!Array.isArray(flatMenuItems) || flatMenuItems.length === 0) return [];
    return flatMenuItems.filter((item) => {
      if (!item?.name) return false;
      return (
        item.name.toLowerCase().includes(query) ||
        (item.description || "").toLowerCase().includes(query) ||
        (item.tags || []).some(
          (tag) => tag && tag.toLowerCase().includes(query),
        )
      );
    });
  }, [flatMenuItems, searchQuery]);

  const translateMenuText = useCallback(
    (text, _type = "item") => {
      const source = String(text || "").trim();
      if (!source) return source;
      if (lang === "en") return source;

      const key = toTranslationLookupKey(source);
      const staticTranslationKey = STATIC_MENU_TEXT_TRANSLATION_KEYS[key];
      if (staticTranslationKey) {
        return t(staticTranslationKey, source);
      }

      const aiTranslated = menuTranslations[key];
      if (aiTranslated) return aiTranslated;

      return source;
    },
    [lang, menuTranslations, t],
  );

  useEffect(() => {
    let cancelled = false;

    const loadMenuTranslations = async () => {
      if (lang === "en") {
        setMenuTranslations({});
        return;
      }
      if (!Array.isArray(menuCategories) || menuCategories.length === 0) {
        setMenuTranslations({});
        return;
      }

      const textSet = new Set();
      menuCategories.forEach((category) => {
        const categoryName = String(category?.name || "").trim();
        if (categoryName) textSet.add(categoryName);
        (Array.isArray(category?.items) ? category.items : []).forEach((item) => {
          const itemName = String(item?.name || "").trim();
          if (itemName) textSet.add(itemName);
        });
      });

      const allTexts = Array.from(textSet);
      if (!allTexts.length) {
        setMenuTranslations({});
        return;
      }

      const cacheKey = `${lang}::${allTexts.join("||")}`;
      const cachedTranslations = menuTranslationCacheRef.current.get(cacheKey);
      if (cachedTranslations) {
        setMenuTranslations(cachedTranslations);
        return;
      }

      try {
        const res = await postWithRetry(
          MENU_PAGE_TRANSLATION_ENDPOINT,
          {
            targetLang: lang,
            texts: allTexts,
          },
          {},
          {
            maxRetries: 1,
            timeout: 30000,
          },
        );
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload?.message || "Failed to load menu translations");
        }

        const incoming = payload?.translations || {};
        const normalized = {};
        Object.entries(incoming).forEach(([source, translated]) => {
          const sourceText = String(source || "").trim();
          const translatedText = String(translated || "").trim();
          if (!sourceText) return;
          normalized[toTranslationLookupKey(sourceText)] =
            translatedText || sourceText;
        });

        if (cancelled) return;
        setMenuTranslations(normalized);
        menuTranslationCacheRef.current.set(cacheKey, normalized);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn("[Menu] Menu translation fetch failed:", error?.message || error);
        }
        if (!cancelled) {
          setMenuTranslations({});
        }
      }
    };

    loadMenuTranslations();
    return () => {
      cancelled = true;
    };
  }, [lang, menuCategories]);

  const recognitionRef = useRef(null);
  const blindRecognitionRef = useRef(null);
  const tapAudioRecorderRef = useRef(null);
  const tapAudioStreamRef = useRef(null);
  const tapAudioStopTimerRef = useRef(null);
  const tapAudioContextRef = useRef(null);
  const tapAudioSourceNodeRef = useRef(null);
  const tapAudioAnalyserRef = useRef(null);
  const tapAudioSilenceIntervalRef = useRef(null);
  const tapAudioSilenceMsRef = useRef(0);
  const tapAudioSpokeRef = useRef(false);
  const invoiceRef = useRef(null);
  const [activeOrderId, setActiveOrderId] = useState(() => {
    // Check service type specific order ID ONLY - never mix TAKEAWAY and DINE_IN orders
    const serviceType = normalizeServiceType(
      localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
    );
    let stored = null;
    if (isTakeawayLikeServiceType(serviceType)) {
      // For takeaway-like flows, use takeaway-scoped key first.
      stored =
        localStorage.getItem("terra_orderId_TAKEAWAY") ||
        localStorage.getItem("terra_orderId");
    } else {
      // For DINE_IN: Read from DINE_IN-specific key first, fallback to generic for backward compatibility
      stored =
        localStorage.getItem("terra_orderId_DINE_IN") ||
        localStorage.getItem("terra_orderId");
    }
    return stored || null;
  });
  const [orderStatus, setOrderStatus] = useState(() => {
    // Check service type specific status first, then fallback to general
    const serviceType = normalizeServiceType(
      localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
    );
    const stored =
      isTakeawayLikeServiceType(serviceType)
        ? localStorage.getItem("terra_orderStatus_TAKEAWAY") ||
          localStorage.getItem("terra_orderStatus")
        : localStorage.getItem("terra_orderStatus_DINE_IN") ||
          localStorage.getItem("terra_orderStatus");
    return stored ? normalizeOrderStatus(stored) : null;
  });
  const [orderPaymentStatus, setOrderPaymentStatus] = useState(() => {
    const stored = localStorage.getItem("terra_orderPaymentStatus");
    return normalizePaymentStatus(stored);
  });
  const [orderStatusUpdatedAt, setOrderStatusUpdatedAt] = useState(() => {
    // Check service type specific updatedAt first, then fallback to general
    const serviceType = normalizeServiceType(
      localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
    );
    const stored =
      isTakeawayLikeServiceType(serviceType)
        ? localStorage.getItem("terra_orderStatusUpdatedAt_TAKEAWAY") ||
          localStorage.getItem("terra_orderStatusUpdatedAt")
        : localStorage.getItem("terra_orderStatusUpdatedAt_DINE_IN") ||
          localStorage.getItem("terra_orderStatusUpdatedAt");
    return stored || null;
  });

  const [serviceType, setServiceType] = useState(() => {
    // Check if this is a takeaway-only QR flow
    const takeawayOnly = localStorage.getItem("terra_takeaway_only") === "true";
    if (takeawayOnly) {
      return "TAKEAWAY";
    }
    return localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN";
  });
  const [tableInfo, setTableInfo] = useState(() => {
    try {
      const stored = localStorage.getItem(TABLE_SELECTION_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch (err) {
      console.warn("Invalid table selection cache", err);
      return null;
    }
  });
  const [sessionToken, setSessionToken] = useState(() =>
    localStorage.getItem("terra_sessionToken"),
  );
  const isOfficeQrFlow = hasOfficeQrMetadata(tableInfo);

  // Office QR is takeaway-only. Enforce takeaway service mode and clear waitlist state.
  useEffect(() => {
    if (!isOfficeQrFlow) return;
    if (serviceType !== "TAKEAWAY") {
      setServiceType("TAKEAWAY");
    }
    localStorage.setItem(SERVICE_TYPE_KEY, "TAKEAWAY");
    localStorage.removeItem("terra_orderType");
    localStorage.removeItem("terra_waitToken");
  }, [isOfficeQrFlow, serviceType]);

  useEffect(() => {
    const scopedCart = readScopedCart(serviceType);
    setCart(scopedCart);
    cartRef.current = scopedCart;
  }, [serviceType]);

  useEffect(() => {
    scheduleCartPersist({ cart, serviceType });
    cartRef.current = cart;
  }, [cart, serviceType, scheduleCartPersist]);

  useEffect(() => {
    const flushOnHide = () => {
      flushCartPersist();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushCartPersist();
    };
    window.addEventListener("beforeunload", flushOnHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flushOnHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flushCartPersist();
    };
  }, [flushCartPersist]);

  // Effect to verify active order belongs to current session on mount
  useEffect(() => {
    const verifyActiveOrderSession = async () => {
      // Only run this strict session check for DINE_IN flows.
      // For takeaway-like flows we rely on dedicated session handling elsewhere.
      const currentServiceType = normalizeServiceType(
        localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
      );
      if (isTakeawayLikeServiceType(currentServiceType)) {
        return;
      }

      const storedOrderId = localStorage.getItem("terra_orderId");
      const currentSessionToken = localStorage.getItem("terra_sessionToken");

      // If no active order or no session token, nothing to verify
      if (!storedOrderId || !currentSessionToken) {
        return;
      }

      try {
        // Fetch the order to check its sessionToken
        const res = await fetch(`${nodeApi}/api/orders/${storedOrderId}`);
        if (!res.ok) {
          // Only clear if order truly doesn't exist (404), not on other errors
          if (res.status === 404) {
            console.log(
              "[Menu] Active order not found (404), clearing order data",
            );
            localStorage.removeItem("terra_orderId");
            localStorage.removeItem("terra_orderStatus");
            localStorage.removeItem("terra_orderStatusUpdatedAt");
            setActiveOrderId(null);
            setOrderStatus(null);
            setOrderStatusUpdatedAt(null);
          } else {
            // For other errors, keep existing order status
            console.warn(
              "[Menu] Error verifying order (non-404), keeping existing status:",
              res.status,
            );
          }
          return;
        }

        let order;
        try {
          order = await res.json();
        } catch (jsonError) {
          console.error(
            "[Menu] Failed to parse order response as JSON:",
            jsonError,
          );
          // If JSON parsing fails, treat as if order doesn't exist
          return;
        }

        if (!order) return;

        // If order exists but sessionToken doesn't match, clear it (belongs to old session)
        if (order.sessionToken && order.sessionToken !== currentSessionToken) {
          console.log(
            "[Menu] Clearing stale dine-in order data for old session",
          );
          localStorage.removeItem("terra_orderId");
          localStorage.removeItem("terra_orderStatus");
          localStorage.removeItem("terra_orderStatusUpdatedAt");
          localStorage.removeItem("terra_previousOrder");
          localStorage.removeItem("terra_previousOrderDetail");
          setActiveOrderId(null);
          setOrderStatus(null);
          setOrderStatusUpdatedAt(null);
          // Update state directly - setters are available from useState above
          // Note: We can't call persistPreviousOrder functions here as they're defined later,
          // but the state setters are available and localStorage is already cleared
        }
      } catch (err) {
        console.warn(
          "[Menu] Error verifying active order session (network error), keeping existing status:",
          err,
        );
        // Don't clear order data on network errors - keep existing status from localStorage
        // The order status will be verified again when the fetchStatus runs
      }
    };

    // Run verification on mount
    verifyActiveOrderSession();
  }, []); // Only run once on mount

  // Effect to detect sessionToken changes and clear old order data
  // Note: This useEffect is placed before persistPreviousOrder/persistPreviousOrderDetail definitions,
  // so we only use localStorage directly here (not the helper functions)
  useEffect(() => {
    const currentToken = localStorage.getItem("terra_sessionToken");
    const storedToken = sessionToken;
    const currentServiceType = normalizeServiceType(
      localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
    );

    // If sessionToken changed (different from state), clear old DINE_IN order data only
    // IMPORTANT: Do NOT clear takeaway order data - takeaway uses separate sessionToken
    if (currentToken && storedToken && currentToken !== storedToken) {
      // Only clear dine-in order data, not takeaway
      if (!isTakeawayLikeServiceType(currentServiceType)) {
        console.log(
          "[Menu] SessionToken changed - clearing old dine-in order data",
        );
        localStorage.removeItem("terra_orderId");
        localStorage.removeItem("terra_orderStatus");
        localStorage.removeItem("terra_orderStatusUpdatedAt");
        localStorage.removeItem("terra_previousOrder");
        localStorage.removeItem("terra_previousOrderDetail");
        localStorage.removeItem("terra_lastPaidOrderId");
        clearScopedCart("DINE_IN");
        localStorage.removeItem("terra_orderId_DINE_IN");
        localStorage.removeItem("terra_orderStatus_DINE_IN");
        localStorage.removeItem("terra_orderStatusUpdatedAt_DINE_IN");
        setActiveOrderId(null);
        setOrderStatus(null);
        setOrderStatusUpdatedAt(null);
      }
      // Update state to match localStorage
      setSessionToken(currentToken);
    }
  }, [sessionToken]); // Removed persistPreviousOrder and persistPreviousOrderDetail from dependencies

  // Sync activeOrderId when serviceType changes or on mount
  useEffect(() => {
    const currentServiceType = normalizeServiceType(
      localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
    );

    // CRITICAL: Only read from service-type-specific keys, never mix TAKEAWAY and DINE_IN orders
    let orderId = null;
    if (isTakeawayLikeServiceType(currentServiceType)) {
      // For takeaway-like flows, prefer takeaway key.
      orderId =
        localStorage.getItem("terra_orderId_TAKEAWAY") ||
        localStorage.getItem("terra_orderId");
    } else {
      // For DINE_IN: Read from DINE_IN-specific key first, fallback to generic for backward compatibility
      orderId =
        localStorage.getItem("terra_orderId_DINE_IN") ||
        localStorage.getItem("terra_orderId");
    }

    if (orderId && orderId !== activeOrderId) {
      setActiveOrderId(orderId);
    } else if (!orderId && activeOrderId) {
      setActiveOrderId(null);
    }
  }, [serviceType, activeOrderId]);

  useEffect(() => {
    if (!isTakeawayLikeServiceType(serviceType)) {
      setTakeawayTokenPreview(null);
      return;
    }

    if (activeOrderId) {
      setTakeawayTokenPreview(null);
      localStorage.removeItem(TAKEAWAY_TOKEN_PREVIEW_KEY);
      return;
    }

    const resolveTakeawayCartId = () => {
      const selectedCartId = localStorage.getItem("terra_selectedCartId");
      if (selectedCartId) return selectedCartId;

      const takeawayCartId = localStorage.getItem("terra_takeaway_cartId");
      if (takeawayCartId) return takeawayCartId;

      try {
        const tableData = JSON.parse(
          localStorage.getItem(TABLE_SELECTION_KEY) || "{}",
        );
        const rawCartId = tableData.cartId || tableData.cafeId || null;
        if (!rawCartId) return null;
        if (typeof rawCartId === "string") return rawCartId;
        if (typeof rawCartId === "object") {
          const nestedId = rawCartId._id || rawCartId.id;
          return nestedId ? String(nestedId) : null;
        }
        return String(rawCartId);
      } catch {
        return null;
      }
    };

    const cartId = resolveTakeawayCartId();
    if (!cartId) return;

    let takeawaySessionToken =
      localStorage.getItem("terra_takeaway_sessionToken");
    if (!takeawaySessionToken) {
      takeawaySessionToken = `TAKEAWAY-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 11)}`;
      localStorage.setItem("terra_takeaway_sessionToken", takeawaySessionToken);
    }

    let cancelled = false;

    const fetchTakeawayTokenPreview = async () => {
      try {
        const params = new URLSearchParams({ cartId });
        if (takeawaySessionToken) {
          params.set("sessionToken", takeawaySessionToken);
        }

        const res = await fetch(
          `${nodeApi}/api/orders/takeaway-token/next?${params.toString()}`,
        );
        if (!res.ok) return;

        const payload = await res.json();
        const token = Number(payload?.token);
        if (!cancelled && Number.isInteger(token) && token > 0) {
          setTakeawayTokenPreview(token);
          localStorage.setItem(TAKEAWAY_TOKEN_PREVIEW_KEY, String(token));
        }
      } catch (err) {
        console.warn("[Menu] Failed to fetch takeaway token preview:", err);
      }
    };

    fetchTakeawayTokenPreview();

    return () => {
      cancelled = true;
    };
  }, [serviceType, activeOrderId]);

  // Customer name form removed for all takeaway flows (global takeaway, normal link, table takeaway) - no redirect
  useEffect(() => {
    if (serviceType === "DINE_IN") return;
    return;
  }, [serviceType, navigate]);

  // Customer info for takeaway orders (optional) - loaded from localStorage
  const [customerName] = useState(
    () => localStorage.getItem("terra_takeaway_customerName") || "",
  );
  const [customerMobile] = useState(
    () => localStorage.getItem("terra_takeaway_customerMobile") || "",
  );
  const [customerEmail] = useState(
    () => localStorage.getItem("terra_takeaway_customerEmail") || "",
  );
  const [previousOrder, setPreviousOrder] = useState(() => {
    try {
      const stored = localStorage.getItem("terra_previousOrder");
      return stored ? JSON.parse(stored) : null;
    } catch (err) {
      console.warn("Invalid previous order cache", err);
      localStorage.removeItem("terra_previousOrder");
      return null;
    }
  });
  const [previousOrderDetail, setPreviousOrderDetail] = useState(() => {
    try {
      const stored = localStorage.getItem("terra_previousOrderDetail");
      return stored ? JSON.parse(stored) : null;
    } catch (err) {
      console.warn("Invalid previous order detail cache", err);
      localStorage.removeItem("terra_previousOrderDetail");
      return null;
    }
  });
  const [currentOrderDetail, setCurrentOrderDetail] = useState(null);
  const [takeawayTokenPreview, setTakeawayTokenPreview] = useState(() => {
    const stored = Number(localStorage.getItem(TAKEAWAY_TOKEN_PREVIEW_KEY));
    return Number.isInteger(stored) && stored > 0 ? stored : null;
  });
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceOrder, setInvoiceOrder] = useState(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [printingInvoice, setPrintingInvoice] = useState(false);
  const [downloadingInvoice, setDownloadingInvoice] = useState(false);

  // Reason Modal State
  const [showReasonModal, setShowReasonModal] = useState(false);
  const [reasonAction, setReasonAction] = useState(null); // "Cancel" or "Return"
  const [reasonText, setReasonText] = useState("");
  const [submittingReason, setSubmittingReason] = useState(false);

  const persistPreviousOrder = useCallback((data) => {
    if (data) {
      setPreviousOrder(data);
      localStorage.setItem("terra_previousOrder", JSON.stringify(data));
    } else {
      setPreviousOrder(null);
      localStorage.removeItem("terra_previousOrder");
    }
  }, []);

  const persistPreviousOrderDetail = useCallback((order) => {
    if (order) {
      setPreviousOrderDetail(order);
      localStorage.setItem("terra_previousOrderDetail", JSON.stringify(order));
    } else {
      setPreviousOrderDetail(null);
      localStorage.removeItem("terra_previousOrderDetail");
    }
  }, []);

  const capturePreviousOrder = useCallback(
    (overrides = {}) => {
      const resolvedOrderId = overrides.orderId || activeOrderId;
      if (!resolvedOrderId) return;

      const resolvedStatus = normalizeOrderStatus(
        overrides.status || orderStatus || "NEW",
      );
      const resolvedUpdatedAt =
        overrides.updatedAt || orderStatusUpdatedAt || new Date().toISOString();

      const tableSource =
        overrides.tableInfo ||
        tableInfo ||
        (() => {
          try {
            const stored = localStorage.getItem(TABLE_SELECTION_KEY);
            return stored ? JSON.parse(stored) : null;
          } catch {
            return null;
          }
        })();

      const resolvedTableNumber =
        overrides.tableNumber ??
        tableSource?.number ??
        tableSource?.tableNumber ??
        null;

      const resolvedSlug =
        overrides.tableSlug ??
        tableSource?.qrSlug ??
        localStorage.getItem("terra_scanToken") ??
        null;

      persistPreviousOrder({
        orderId: resolvedOrderId,
        status: resolvedStatus,
        updatedAt: resolvedUpdatedAt,
        tableNumber: resolvedTableNumber,
        tableSlug: resolvedSlug,
      });
    },
    [
      activeOrderId,
      orderStatus,
      orderStatusUpdatedAt,
      tableInfo,
      persistPreviousOrder,
    ],
  );

  const invoiceId = useMemo(
    () => (invoiceOrder ? buildInvoiceId(invoiceOrder) : null),
    [invoiceOrder],
  );

  const invoiceItems = useMemo(
    () => aggregateOrderItems(invoiceOrder),
    [invoiceOrder],
  );

  const invoiceTotals = useMemo(
    () =>
      invoiceOrder
        ? computeOrderTotals(invoiceOrder, invoiceItems)
        : {
            subtotal: 0,
            gst: 0,
            officeDeliveryCharge: 0,
            totalAmount: 0,
            totalItems: 0,
          },
    [invoiceOrder, invoiceItems],
  );

  const invoiceServiceLabel = useMemo(() => {
    if (!invoiceOrder) return "";
    return isTakeawayLikeServiceType(invoiceOrder.serviceType)
      ? "Takeaway"
      : "Dine-In";
  }, [invoiceOrder]);

  const invoiceTableNumber =
    invoiceOrder?.table?.number ?? invoiceOrder?.tableNumber ?? null;
  const invoiceTableName = invoiceOrder?.table?.name ?? null;
  const invoiceTimestamp = useMemo(
    () => resolveOrderTimestamp(invoiceOrder),
    [invoiceOrder],
  );

  const previousDetailItems = useMemo(
    () => aggregateOrderItems(previousOrderDetail),
    [previousOrderDetail],
  );

  const previousDetailTotals = useMemo(
    () =>
      previousOrderDetail
        ? computeOrderTotals(previousOrderDetail, previousDetailItems)
        : {
            subtotal: 0,
            gst: 0,
            officeDeliveryCharge: 0,
            totalAmount: 0,
            totalItems: 0,
          },
    [previousOrderDetail, previousDetailItems],
  );

  const previousDetailTimestamp = useMemo(
    () => resolveOrderTimestamp(previousOrderDetail),
    [previousOrderDetail],
  );

  const previousDetailInvoiceId = useMemo(
    () => (previousOrderDetail ? buildInvoiceId(previousOrderDetail) : null),
    [previousOrderDetail],
  );
  /*
  const activeAssignedStaff = useMemo(
    () => getAssignedStaffFromOrder(currentOrderDetail),
    [currentOrderDetail],
  );
  const previousAssignedStaff = useMemo(
    () => getAssignedStaffFromOrder(previousOrderDetail),
    [previousOrderDetail],
  );
  */
  const activeAssignedStaff = null;
  const previousAssignedStaff = null;
  const helplineNumber = useMemo(() => {
    const primaryFromCurrent =
      currentOrderDetail?.cafe?.primaryEmergencyContact?.phone;
    const primaryFromPrevious =
      previousOrderDetail?.cafe?.primaryEmergencyContact?.phone;
    return (
      currentOrderDetail?.cafe?.managerHelplineNumber ||
      currentOrderDetail?.cafe?.phone ||
      primaryFromCurrent ||
      previousOrderDetail?.cafe?.managerHelplineNumber ||
      previousOrderDetail?.cafe?.phone ||
      primaryFromPrevious ||
      null
    );
  }, [currentOrderDetail, previousOrderDetail]);
  const takeawayTokenForDisplay = useMemo(() => {
    const token =
      currentOrderDetail?.takeawayToken ??
      previousOrderDetail?.takeawayToken;
    if ((token === undefined || token === null || token === "") && !orderStatus) {
      return null;
    }
    const fallbackPreview =
      takeawayTokenPreview !== undefined &&
      takeawayTokenPreview !== null &&
      takeawayTokenPreview !== ""
        ? takeawayTokenPreview
        : null;
    const resolvedToken = token ?? fallbackPreview;
    return resolvedToken !== undefined &&
      resolvedToken !== null &&
      resolvedToken !== ""
      ? resolvedToken
      : null;
  }, [
    currentOrderDetail,
    previousOrderDetail,
    orderStatus,
    takeawayTokenPreview,
  ]);
  const menuHeading = t("manualEntry", "Menu");
  const smartServe = t("smartServe", "Smart Serve");
  const aiOrdered = t("aiOrdered", "AI Ordered:");
  const orderSummary = t("orderSummary", "Order Summary:");
  const confirmBtn = t("confirm", "Confirm");
  const speakBtn = t("speakOrder", "Speak Order");
  const processingText = t("processingVoice", "Processing your voice...");
  const cartEmptyText = t("cartEmpty", "Cart is empty");
  const resetBtn = t("resetOrderBtn", "Reset Order");
  const tapToOrder = t("tapToOrder", "Tap to Order");
  const tapToStop = t("tapToStop", "Tap to Stop");
  const searchPlaceholder = t("searchPlaceholder", "Search item...");
  const recordVoiceAria = t("recordVoiceAria", "Record voice order");

  useEffect(() => {
    if (orderStatus) {
      localStorage.setItem("terra_orderStatus", orderStatus);
    } else {
      localStorage.removeItem("terra_orderStatus");
    }
    if (orderPaymentStatus) {
      localStorage.setItem("terra_orderPaymentStatus", orderPaymentStatus);
    } else {
      localStorage.removeItem("terra_orderPaymentStatus");
    }
    if (orderStatusUpdatedAt) {
      localStorage.setItem("terra_orderStatusUpdatedAt", orderStatusUpdatedAt);
    } else {
      localStorage.removeItem("terra_orderStatusUpdatedAt");
    }
  }, [orderStatus, orderPaymentStatus, orderStatusUpdatedAt]);

  useEffect(() => {
    if (!orderStatus) {
      setOrderPaymentStatus("PENDING");
      localStorage.removeItem("terra_orderPaymentStatus");
    }
  }, [orderStatus]);

  useEffect(() => {
    if (orderStatus && activeOrderId && previousOrder) {
      persistPreviousOrder(null);
    }
    if (orderStatus && activeOrderId && previousOrderDetail) {
      persistPreviousOrderDetail(null);
    }
  }, [
    orderStatus,
    activeOrderId,
    previousOrder,
    previousOrderDetail,
    persistPreviousOrder,
    persistPreviousOrderDetail,
  ]);

  useEffect(() => {
    if (!previousOrder && !previousOrderDetail) return;
    const currentSlug = localStorage.getItem("terra_scanToken");
    const previousSlug = previousOrder?.tableSlug;
    if (previousSlug && currentSlug && previousSlug !== currentSlug) {
      persistPreviousOrder(null);
      persistPreviousOrderDetail(null);
      return;
    }
    if (
      !previousSlug &&
      previousOrderDetail?.table?.qrSlug &&
      currentSlug &&
      previousOrderDetail.table.qrSlug !== currentSlug
    ) {
      persistPreviousOrder(null);
      persistPreviousOrderDetail(null);
    }
  }, [
    previousOrder,
    previousOrderDetail,
    persistPreviousOrder,
    persistPreviousOrderDetail,
  ]);

  useEffect(() => {
    // CRITICAL: On mount/refresh, check localStorage first to preserve serviceType
    // This ensures takeaway mode is maintained across page refreshes
    const storedServiceType = normalizeServiceType(
      localStorage.getItem(SERVICE_TYPE_KEY),
    );
    const takeawayOnly = localStorage.getItem("terra_takeaway_only") === "true";
    const hasTakeawayOrder = localStorage.getItem("terra_orderId_TAKEAWAY");

    // If we have a takeaway order but no takeaway-like service type, recover safely.
    if (
      (hasTakeawayOrder || takeawayOnly) &&
      !isTakeawayLikeServiceType(storedServiceType)
    ) {
      console.log(
        "[Menu] Detected takeaway order or takeaway-only mode on refresh, setting serviceType to TAKEAWAY",
      );
      setServiceType("TAKEAWAY");
      localStorage.setItem(SERVICE_TYPE_KEY, "TAKEAWAY");
      return; // Don't override with location.state if we have takeaway data
    }

    if (location.state?.serviceType) {
      setServiceType(location.state.serviceType);
      localStorage.setItem(SERVICE_TYPE_KEY, location.state.serviceType);
    } else if (storedServiceType) {
      // Restore serviceType from localStorage on refresh
      setServiceType(storedServiceType);
    } else {
      // If no serviceType in state or localStorage, check if this is a takeaway-only QR flow
      if (takeawayOnly) {
        console.log(
          "[Menu] Detected takeaway-only QR flow, setting serviceType to TAKEAWAY",
        );
        setServiceType("TAKEAWAY");
        localStorage.setItem(SERVICE_TYPE_KEY, "TAKEAWAY");
      }
    }

    if (location.state?.table) {
      setTableInfo(location.state.table);
      localStorage.setItem(
        TABLE_SELECTION_KEY,
        JSON.stringify(location.state.table),
      );
    }
  }, [location.state, setServiceType]);

  useEffect(() => {
    let cancelled = false;

    // CRITICAL: Check waitlist status - block access if user is in WAITING status
    const checkWaitlistAccess = async () => {
      const selectedTableRaw = localStorage.getItem("terra_selectedTable");
      if (selectedTableRaw) {
        try {
          const selectedTable = JSON.parse(selectedTableRaw);
          if (hasOfficeQrMetadata(selectedTable)) {
            localStorage.setItem(SERVICE_TYPE_KEY, "TAKEAWAY");
            localStorage.removeItem("terra_waitToken");
            return true;
          }
        } catch {
          // Ignore parse errors and continue with default flow
        }
      }

      const currentServiceType =
        localStorage.getItem(SERVICE_TYPE_KEY) ||
        location.state?.serviceType ||
        "DINE_IN";

      // Only check waitlist for DINE_IN orders
      if (currentServiceType !== "DINE_IN") {
        return true; // Allow access for takeaway
      }

      // CRITICAL: First check if user has an active order - verify on backend
      // This handles cases where user was seated and has an order
      const existingOrderId =
        localStorage.getItem("terra_orderId") ||
        localStorage.getItem("terra_orderId_DINE_IN");
      const existingOrderStatus =
        localStorage.getItem("terra_orderStatus") ||
        localStorage.getItem("terra_orderStatus_DINE_IN");
      const existingOrderPaymentStatus =
        localStorage.getItem("terra_orderPaymentStatus") || "PENDING";
      const hasActiveOrderInStorage =
        existingOrderId &&
        isOrderActiveForCustomer({
          status: existingOrderStatus,
          paymentStatus: existingOrderPaymentStatus,
        });

      // If we have an order ID in storage, verify it exists on backend.
      if (existingOrderId) {
        try {
          const orderRes = await fetch(
            `${nodeApi}/api/orders/${existingOrderId}`,
          );
          if (orderRes.ok) {
            const orderData = await orderRes.json();
            // Verify order is still active using canonical status + payment state.
            if (isOrderActiveForCustomer(orderData)) {
              console.log(
                "[Menu] User has verified active order - allowing access, skipping waitlist check",
              );
              return true; // User has verified active order, allow access
            }
          }
        } catch (err) {
          console.warn("[Menu] Failed to verify order on backend:", err);
          // If verification fails but we have order in storage, still allow access
          // (don't block on network errors)
          if (hasActiveOrderInStorage) {
            console.log(
              "[Menu] Order verification failed but order exists in storage - allowing access",
            );
            return true;
          }
        }
      }

      // CRITICAL: Also check if user has sessionToken matching table
      // This indicates they own the table session
      const sessionToken = localStorage.getItem("terra_sessionToken");
      const selectedTable = localStorage.getItem("terra_selectedTable");
      if (sessionToken && selectedTable) {
        try {
          const tableData = JSON.parse(selectedTable);
          // Check if sessionToken matches OR if table has an active order for this session
          if (tableData.sessionToken === sessionToken) {
            console.log(
              "[Menu] User has matching sessionToken - allowing access, skipping waitlist check",
            );
            return true; // User owns the table session, allow access
          }

          // Also verify on backend that this session owns the table
          const slug =
            tableData.qrSlug || localStorage.getItem("terra_scanToken");
          if (slug) {
            try {
              const tableRes = await fetch(
                `${nodeApi}/api/tables/lookup/${slug}?sessionToken=${sessionToken}`,
              );
              if (tableRes.ok) {
                const tablePayload = await tableRes.json();
                const tableSessionToken = tablePayload?.table?.sessionToken;
                // If table sessionToken matches OR table has active order for this session
                if (
                  tableSessionToken === sessionToken ||
                  tablePayload?.table?.activeOrder
                ) {
                  console.log(
                    "[Menu] Backend confirms user owns table session - allowing access",
                  );
                  return true;
                }
              }
            } catch (tableErr) {
              console.warn(
                "[Menu] Failed to verify table session on backend:",
                tableErr,
              );
              // If verification fails but sessionToken matches locally, still allow
              if (tableData.sessionToken === sessionToken) {
                return true;
              }
            }
          }
        } catch (err) {
          console.warn("[Menu] Failed to check sessionToken:", err);
        }
      }

      // Only check waitlist if user doesn't have active order or session
      // CRITICAL: Clear waitlist token if user has active order (they shouldn't be in waitlist)
      const waitlistToken = localStorage.getItem("terra_waitToken");
      if (hasActiveOrderInStorage && waitlistToken) {
        console.log(
          "[Menu] User has active order but also has waitlist token - clearing waitlist token",
        );
        localStorage.removeItem("terra_waitToken");
        return true; // User has active order, allow access
      }

      if (!waitlistToken) {
        return true; // No waitlist token, allow access
      }

      try {
        const res = await fetch(
          `${nodeApi}/api/waitlist/status?token=${waitlistToken}`,
        );
        if (res.ok) {
          const waitlistData = await res.json();
          // Only allow access if status is NOTIFIED or SEATED
          // Block access if status is WAITING
          if (waitlistData.status === "WAITING") {
            console.log(
              "[Menu] User is in WAITING status - blocking menu access",
            );
            alert(
              "You are currently in the waitlist. Please wait for your turn. You will be notified when the table is ready.",
            );
            navigate("/secondpage");
            return false;
          }
          // Allow access for NOTIFIED or SEATED
          if (
            waitlistData.status === "NOTIFIED" ||
            waitlistData.status === "SEATED"
          ) {
            return true;
          }
        }
      } catch (err) {
        console.error("[Menu] Failed to check waitlist status:", err);
        // If check fails, allow access (don't block on network errors)
      }

      return true; // Default: allow access
    };

    // CRITICAL: Mark table as OCCUPIED ONLY when user enters menu page for DINE_IN (not on landing/second page)
    const markTableOccupied = async () => {
      try {
        const selectedTableRaw = localStorage.getItem("terra_selectedTable");
        if (selectedTableRaw) {
          try {
            const selectedTable = JSON.parse(selectedTableRaw);
            if (hasOfficeQrMetadata(selectedTable)) {
              localStorage.setItem(SERVICE_TYPE_KEY, "TAKEAWAY");
              localStorage.removeItem("terra_waitToken");
              return;
            }
          } catch {
            // Ignore parse errors and continue with default flow
          }
        }

        // IMPORTANT: Only mark table as occupied for DINE_IN orders.
        const currentServiceType = normalizeServiceType(
          localStorage.getItem(SERVICE_TYPE_KEY) ||
            location.state?.serviceType ||
            "DINE_IN",
        );
        if (isTakeawayLikeServiceType(currentServiceType)) {
          return; // Don't mark table as occupied for takeaway-like orders
        }

        const selectedTable = localStorage.getItem("terra_selectedTable");
        // CRITICAL: Always use the latest sessionToken from localStorage
        // This ensures we use the token that might have been updated by table refresh
        let sessionToken = localStorage.getItem("terra_sessionToken");
        const scanToken = localStorage.getItem("terra_scanToken");

        if (!selectedTable || !scanToken) {
          return; // No table selected, skip
        }

        const tableData = JSON.parse(selectedTable);
        const tableId = tableData.id || tableData._id;

        if (!tableId) {
          return;
        }

        // CRITICAL: Refresh table status from backend to get the latest sessionToken
        // This prevents "Invalid session token" errors
        let shouldMarkOccupied = true;
        try {
          const slug = tableData.qrSlug || scanToken;
          if (slug) {
            // NOTE: 423 (Locked) responses are EXPECTED when table is occupied
            // Browser console may show this as an error, but it's normal behavior
            const refreshRes = await fetch(
              `${nodeApi}/api/tables/lookup/${slug}${
                sessionToken ? `?sessionToken=${sessionToken}` : ""
              }`,
            ).catch((fetchErr) => {
              // Only log actual network errors, not 423 status codes
              console.warn(
                "[Menu] Network error during table lookup:",
                fetchErr,
              );
              throw fetchErr; // Re-throw to be handled by outer catch
            });

            // Handle 423 (Locked) response - table is occupied
            // NOTE: 423 is EXPECTED when table is occupied - browser console shows this as an error
            // but it's normal behavior and is handled gracefully below
            if (refreshRes.status === 423) {
              let lockedPayload = {};
              try {
                lockedPayload = await refreshRes.json();
              } catch (parseErr) {
                // Silently handle parse errors for 423 - it's expected behavior
                console.warn(
                  "[Menu] Failed to parse 423 response (expected for occupied tables):",
                  parseErr,
                );
              }
              // Log that we're handling 423 (this is expected, not an error)
              console.log(
                "[Menu] Table lookup returned 423 (Locked - expected for occupied tables) - handling gracefully",
              );

              // Check if we have an active order for this table
              const existingOrderId =
                localStorage.getItem("terra_orderId") ||
                localStorage.getItem("terra_orderId_DINE_IN");

              if (existingOrderId) {
                try {
                  const orderRes = await fetch(
                    `${nodeApi}/api/orders/${existingOrderId}`,
                  );
                  if (orderRes.ok) {
                    const orderData = await orderRes.json();
                    const orderTableId =
                      orderData.table?.toString() ||
                      orderData.tableId?.toString();

                    if (orderTableId === tableId?.toString()) {
                      // Order belongs to this table - use order's sessionToken
                      if (orderData.sessionToken) {
                        sessionToken = orderData.sessionToken;
                        localStorage.setItem(
                          "terra_sessionToken",
                          sessionToken,
                        );
                        setSessionToken(sessionToken);
                        console.log(
                          "[Menu] Table is locked but user has active order - using order's sessionToken:",
                          sessionToken,
                        );
                      }
                      // Table is already occupied by this user's order - skip marking as occupied
                      console.log(
                        "[Menu] Table is already occupied by user's active order - skipping markTableOccupied",
                      );
                      shouldMarkOccupied = false;
                      return; // Skip marking as occupied
                    }
                  }
                } catch (orderErr) {
                  console.warn(
                    "[Menu] Failed to verify order when table is locked:",
                    orderErr,
                  );
                }
              }

              // Table is locked and user has no active order for this table
              // Try to extract table data from 423 response if available
              if (lockedPayload?.table) {
                // Update table data even from 423 response
                const updatedTableData = {
                  ...tableData,
                  ...lockedPayload.table,
                  qrSlug: tableData.qrSlug || lockedPayload.table.qrSlug,
                };
                localStorage.setItem(
                  "terra_selectedTable",
                  JSON.stringify(updatedTableData),
                );

                // If 423 response has sessionToken, check if it matches ours
                if (lockedPayload.table.sessionToken) {
                  const tableSessionToken = lockedPayload.table.sessionToken;
                  if (tableSessionToken === sessionToken) {
                    // Session matches - we own this table, can proceed
                    console.log(
                      "[Menu] Table is locked but sessionToken matches - we own this table",
                    );
                    // Update sessionToken to ensure it's in sync
                    localStorage.setItem("terra_sessionToken", sessionToken);
                    setSessionToken(sessionToken);
                    // Continue with marking as occupied since we own it
                    shouldMarkOccupied = true;
                  } else {
                    // Session doesn't match - but check if we have a sessionToken in localStorage
                    // that might be valid (user might have just scanned and got a new token)
                    const storedToken =
                      localStorage.getItem("terra_sessionToken");
                    if (storedToken && storedToken === tableSessionToken) {
                      // Our stored token matches table's token - we own it
                      console.log(
                        "[Menu] Table is locked but stored sessionToken matches table's token - we own this table",
                      );
                      sessionToken = storedToken;
                      localStorage.setItem("terra_sessionToken", sessionToken);
                      setSessionToken(sessionToken);
                      shouldMarkOccupied = true;
                    } else {
                      // Session doesn't match - table is occupied by another user
                      console.warn(
                        "[Menu] Table is locked and sessionToken doesn't match - table belongs to another user",
                      );
                      shouldMarkOccupied = false;
                      return; // Skip marking as occupied
                    }
                  }
                } else {
                  // No sessionToken in 423 response - check if we have one in localStorage
                  // If we have a sessionToken, it might be valid (table might not have sent it in response)
                  if (sessionToken) {
                    // We have a sessionToken - try to proceed (backend will validate)
                    console.log(
                      "[Menu] Table is locked and no sessionToken in response, but we have one - proceeding (backend will validate)",
                    );
                    // Continue with marking as occupied - backend will check if token is valid
                    shouldMarkOccupied = true;
                  } else {
                    // No sessionToken at all - table is occupied by another user
                    console.warn(
                      "[Menu] Table is locked and no sessionToken available - table belongs to another user",
                    );
                    shouldMarkOccupied = false;
                    return; // Skip marking as occupied
                  }
                }
              } else {
                // No table data in 423 response - check if we have sessionToken
                if (sessionToken) {
                  // We have a sessionToken - try to proceed (backend will validate)
                  console.log(
                    "[Menu] Table is locked and no table data in response, but we have sessionToken - proceeding (backend will validate)",
                  );
                  shouldMarkOccupied = true;
                } else {
                  // No table data and no sessionToken - table is occupied by another user
                  console.warn(
                    "[Menu] Table is locked and user has no active order for this table - skipping markTableOccupied",
                  );
                  shouldMarkOccupied = false;
                  return; // Skip marking as occupied
                }
              }
            }

            if (refreshRes.ok) {
              const refreshPayload = await refreshRes.json();
              if (refreshPayload?.table) {
                const backendTable = refreshPayload.table;
                const backendSessionToken = backendTable.sessionToken;

                // Update local table data with backend data
                const updatedTableData = {
                  ...tableData,
                  ...backendTable,
                  qrSlug: tableData.qrSlug || backendTable.qrSlug,
                };
                localStorage.setItem(
                  "terra_selectedTable",
                  JSON.stringify(updatedTableData),
                );

                // If backend table has a sessionToken that doesn't match ours
                if (
                  backendSessionToken &&
                  backendSessionToken !== sessionToken
                ) {
                  // Check if we have an active order for this table
                  const existingOrderId =
                    localStorage.getItem("terra_orderId") ||
                    localStorage.getItem("terra_orderId_DINE_IN");

                  if (existingOrderId) {
                    try {
                      const orderRes = await fetch(
                        `${nodeApi}/api/orders/${existingOrderId}`,
                      );
                      if (orderRes.ok) {
                        const orderData = await orderRes.json();
                        const orderTableId =
                          orderData.table?.toString() ||
                          orderData.tableId?.toString();
                        if (orderTableId === tableId?.toString()) {
                          // Order belongs to this table - use order's sessionToken
                          if (orderData.sessionToken) {
                            sessionToken = orderData.sessionToken;
                            localStorage.setItem(
                              "terra_sessionToken",
                              sessionToken,
                            );
                            setSessionToken(sessionToken);
                            console.log(
                              "[Menu] Using order's sessionToken:",
                              sessionToken,
                            );
                          } else {
                            // Use backend table's sessionToken
                            sessionToken = backendSessionToken;
                            localStorage.setItem(
                              "terra_sessionToken",
                              sessionToken,
                            );
                            setSessionToken(sessionToken);
                            console.log(
                              "[Menu] Using backend table's sessionToken:",
                              sessionToken,
                            );
                          }
                        } else {
                          // Order doesn't belong to this table - skip marking as occupied
                          console.warn(
                            "[Menu] User has order but not for this table - skipping markTableOccupied",
                          );
                          shouldMarkOccupied = false;
                        }
                      }
                    } catch (err) {
                      console.warn("[Menu] Failed to verify order:", err);
                      // If verification fails, use backend table's sessionToken
                      sessionToken = backendSessionToken;
                      localStorage.setItem("terra_sessionToken", sessionToken);
                      setSessionToken(sessionToken);
                    }
                  } else {
                    // No active order and table has different sessionToken
                    // Table is occupied by someone else - don't mark as occupied
                    console.warn(
                      "[Menu] Table has different sessionToken and user has no active order - skipping markTableOccupied",
                    );
                    shouldMarkOccupied = false;
                  }
                } else if (
                  backendSessionToken &&
                  backendSessionToken === sessionToken
                ) {
                  // SessionToken matches - proceed
                  console.log(
                    "[Menu] SessionToken matches - proceeding with markTableOccupied",
                  );
                } else if (!backendSessionToken) {
                  // Table has no sessionToken - it's available, proceed
                  console.log(
                    "[Menu] Table has no sessionToken - proceeding with markTableOccupied",
                  );
                }
              }
            }
            // Note: 423 status is already handled above in the first if block
            // No need for duplicate else if check here
          }
        } catch (refreshErr) {
          // Only log actual errors, not expected 423 responses
          // 423 responses are handled above and don't throw errors
          if (refreshErr?.status !== 423) {
            console.warn(
              "[Menu] Failed to refresh table status before markTableOccupied:",
              refreshErr,
            );
          }
          // Continue with marking as occupied if refresh fails (unless it was a 423)
          // 423 responses are already handled above and set shouldMarkOccupied appropriately
        }

        // If we determined we shouldn't mark as occupied, return early
        if (!shouldMarkOccupied) {
          return;
        }

        // CRITICAL: Before marking table as occupied, check if user already has an active order
        // If they do, we don't need to mark it as occupied again (it's already occupied by them)
        const existingOrderId =
          localStorage.getItem("terra_orderId") ||
          localStorage.getItem("terra_orderId_DINE_IN");
        const existingOrderStatus =
          localStorage.getItem("terra_orderStatus") ||
          localStorage.getItem("terra_orderStatus_DINE_IN");
        const existingOrderPaymentStatus =
          localStorage.getItem("terra_orderPaymentStatus") || "PENDING";
        const hasActiveOrder =
          existingOrderId &&
          isOrderActiveForCustomer({
            status: existingOrderStatus,
            paymentStatus: existingOrderPaymentStatus,
          });

        // If user has active order, verify it's still valid before skipping occupy call
        if (hasActiveOrder && existingOrderId) {
          try {
            const orderRes = await fetch(
              `${nodeApi}/api/orders/${existingOrderId}`,
            );
            if (orderRes.ok) {
              const orderData = await orderRes.json();
              // If order is still active and belongs to this table, skip marking as occupied
              if (
                isOrderActiveForCustomer(orderData) &&
                (orderData.table?.toString() === tableId?.toString() ||
                  orderData.tableId?.toString() === tableId?.toString())
              ) {
                console.log(
                  "[Menu] User has active order for this table - skipping markTableOccupied",
                );
                // Still update sessionToken if order has one
                if (orderData.sessionToken) {
                  localStorage.setItem(
                    "terra_sessionToken",
                    orderData.sessionToken,
                  );
                  setSessionToken(orderData.sessionToken);
                }
                return; // Skip marking as occupied - already occupied by this user's order
              }
            }
          } catch (err) {
            console.warn(
              "[Menu] Failed to verify order before markTableOccupied:",
              err,
            );
            // Continue with marking as occupied if verification fails
          }
        }

        // Call API to mark table as occupied when entering menu page
        // Even if local status isn't AVAILABLE, ensure backend marks OCCUPIED so admin sees it
        // Use retry logic for better reliability in deployment scenarios
        let res;
        try {
          res = await postWithRetry(
            `${nodeApi}/api/tables/${tableId}/occupy`,
            {
              sessionToken: sessionToken || undefined,
            },
            {
              headers: {
                "Content-Type": "application/json",
              },
            },
            {
              maxRetries: 2,
              retryDelay: 1000,
              timeout: 15000, // 15 second timeout for table occupation
              shouldRetry: (error, attempt) => {
                // Retry on network errors, timeouts, or 5xx errors
                if (
                  error.message?.includes("timeout") ||
                  error.message?.includes("Network error") ||
                  error.message?.includes("Failed to fetch") ||
                  error.message?.includes("CORS")
                ) {
                  return true;
                }
                // Don't retry on 4xx errors (client errors)
                if (error.status >= 400 && error.status < 500) {
                  return false;
                }
                // Retry on 5xx errors (server errors)
                if (error.status >= 500) {
                  return true;
                }
                return attempt < 1;
              },
            },
          );
        } catch (fetchError) {
          console.warn(
            "[Menu] Failed to mark table as occupied after retries:",
            fetchError,
          );
          // Create a mock response for error handling
          res = {
            ok: false,
            status: 0,
            json: async () => ({}),
            text: async () => fetchError.message || "Network error",
          };
        }

        if (res.ok) {
          // Update local table data to reflect occupied status
          const updatedTable = await res.json().catch(() => null);
          if (updatedTable?.table) {
            const newSessionToken =
              updatedTable.table.sessionToken || sessionToken;
            const updatedTableData = {
              ...tableData,
              status: updatedTable.table.status || "OCCUPIED",
              sessionToken: newSessionToken,
            };
            localStorage.setItem(
              "terra_selectedTable",
              JSON.stringify(updatedTableData),
            );
            // CRITICAL: Update sessionToken in localStorage and state
            // This ensures subsequent table lookups use the correct token
            if (newSessionToken && newSessionToken !== sessionToken) {
              localStorage.setItem("terra_sessionToken", newSessionToken);
              setSessionToken(newSessionToken);
              console.log(
                "[Menu] Updated sessionToken after marking table occupied:",
                newSessionToken,
              );
            }
          } else {
            // Fallback: update status locally
            tableData.status = "OCCUPIED";
            localStorage.setItem(
              "terra_selectedTable",
              JSON.stringify(tableData),
            );
          }
        } else {
          const errorText = await res.text().catch(() => "Unknown error");
          console.warn("Failed to mark table as occupied:", errorText);

          // If the error is 423 (table already occupied), check if it's occupied by us
          if (res.status === 423) {
            // Try to refresh table status to get the current sessionToken
            try {
              const slug =
                tableData.qrSlug || localStorage.getItem("terra_scanToken");
              if (slug) {
                const refreshRes = await fetch(
                  `${nodeApi}/api/tables/lookup/${slug}?sessionToken=${
                    sessionToken || ""
                  }`,
                );
                if (refreshRes.ok) {
                  const refreshPayload = await refreshRes
                    .json()
                    .catch(() => ({}));
                  if (refreshPayload?.table?.sessionToken) {
                    // Table is occupied by us - update sessionToken
                    const newSessionToken = refreshPayload.table.sessionToken;
                    localStorage.setItem("terra_sessionToken", newSessionToken);
                    setSessionToken(newSessionToken);
                    console.log(
                      "[Menu] Table already occupied by us, updated sessionToken:",
                      newSessionToken,
                    );
                  }
                }
              }
            } catch (refreshErr) {
              console.warn("Failed to refresh table status:", refreshErr);
            }
          }
        }
      } catch (err) {
        console.warn("Error marking table as occupied:", err);
        // Don't block menu loading if this fails
      }
    };

    const loadMenu = async () => {
      try {
        setMenuLoading(true);
        setMenuError(null);

        // Check waitlist access first - block if user is in WAITING status
        const hasAccess = await checkWaitlistAccess();
        if (!hasAccess) {
          setMenuLoading(false);
          return; // Blocked - user will be redirected
        }

        // Mark table as occupied when menu page loads
        await markTableOccupied();

        // Get cartId to filter menu.
        // Use terra_selectedCartId only for pickup/delivery flows to avoid stale cart mixups.
        let cartId = "";
        const currentServiceType = normalizeServiceType(
          localStorage.getItem(SERVICE_TYPE_KEY) || serviceType || "DINE_IN",
        );
        const isPickupOrDeliveryFlow =
          currentServiceType === "PICKUP" ||
          currentServiceType === "DELIVERY";

        const selectedCartId = localStorage.getItem("terra_selectedCartId");
        const qrCartId = localStorage.getItem("terra_takeaway_cartId");

        if (isPickupOrDeliveryFlow && selectedCartId) {
          cartId = selectedCartId;
          console.log(
            "[Menu] Using selected cart ID for pickup/delivery menu:",
            cartId,
          );
        } else if (qrCartId) {
          cartId = qrCartId;
          console.log("[Menu] Using takeaway QR cart ID for menu:", cartId);
        } else {
          // Fallback to table data - check both terra_selectedTable and TABLE_SELECTION_KEY
          try {
            // Try terra_selectedTable first (set by Landing.jsx)
            let tableDataStr = localStorage.getItem("terra_selectedTable");
            if (!tableDataStr) {
              // Fallback to TABLE_SELECTION_KEY if terra_selectedTable doesn't exist
              tableDataStr =
                localStorage.getItem(TABLE_SELECTION_KEY) || "{}";
            }

            const tableData = JSON.parse(tableDataStr);
            const rawCartId = tableData.cartId || tableData.cafeId || "";
            // Normalize: backend may return populated cart object
            if (typeof rawCartId === "string") {
              cartId = rawCartId;
            } else if (
              rawCartId &&
              typeof rawCartId === "object" &&
              (rawCartId._id || rawCartId.id)
            ) {
              cartId = String(rawCartId._id || rawCartId.id);
            } else {
              cartId = rawCartId ? String(rawCartId) : "";
            }

            // Fallback: if table payload missed cartId, resolve it via table id.
            if (!cartId && (tableData.id || tableData._id)) {
              try {
                const tableId = tableData.id || tableData._id;
                const cartIdRes = await fetch(
                  `${nodeApi}/api/tables/public-cart-id/${encodeURIComponent(tableId)}`,
                );
                if (cartIdRes.ok) {
                  const cartIdJson = await cartIdRes.json().catch(() => ({}));
                  if (cartIdJson?.success && cartIdJson?.cartId) {
                    cartId = String(cartIdJson.cartId);
                  }
                }
              } catch (lookupErr) {
                console.warn(
                  "[Menu] Failed to resolve cartId from table id:",
                  lookupErr,
                );
              }
            }

            // Non pickup/delivery fallback only: use selected cart if nothing else resolved.
            if (!cartId && !isPickupOrDeliveryFlow && selectedCartId) {
              cartId = selectedCartId;
            }

            console.log("[Menu] Table data for cartId lookup:", {
              hasTableData: !!tableDataStr,
              tableDataKeys: tableData ? Object.keys(tableData) : [],
              cartId: tableData.cartId,
              cafeId: tableData.cafeId,
              foundCartId: cartId,
            });

            if (cartId) {
              console.log("[Menu] Using table cart ID for menu:", cartId);
            } else {
              console.warn(
                "[Menu] No cartId or cafeId found in table data:",
                tableData,
              );
            }
          } catch (e) {
            // Could not get cartId from table data
            console.error("[Menu] Error parsing table data:", e);
            console.log("[Menu] No cart ID found, loading default menu");
          }
        }

        const cartIdForApi = typeof cartId === "string" ? cartId : (cartId && (cartId._id || cartId.id) ? String(cartId._id || cartId.id) : "");

        console.log("[Menu] Loading menu (TanStack cache)", {
          hasCartId: !!cartId,
          cartId: cartId,
          serviceType: serviceType,
        });

        const menuBootstrapKey = getMenuBootstrapIdentity(
          cartIdForApi,
          currentServiceType,
        );
        const menuQueryKey = queryKeys.menu.public(cartIdForApi || "");
        let payload = queryClient.getQueryData(menuQueryKey);
        const canReuseCachedMenu =
          lastSuccessfulMenuBootstrapKeyRef.current === menuBootstrapKey &&
          payload !== undefined;

        try {
          if (!canReuseCachedMenu) {
            payload = await queryClient.fetchQuery({
              queryKey: menuQueryKey,
              queryFn: () => fetchMenuPublicPayload(cartIdForApi || undefined),
            });
          }
        } catch (fetchErr) {
          console.error("[Menu] Menu fetch failed:", fetchErr);
          lastSuccessfulMenuBootstrapKeyRef.current = "";
          throw fetchErr;
        }
        if (cancelled) return;
        const categories = (Array.isArray(payload) ? payload : [])
          .map((category) => {
            if (!category) return null;
            return {
              ...category,
              name: category.name || "Menu",
              items: (Array.isArray(category.items) ? category.items : [])
                .map((item) => {
                  if (!item) return null;
                  return {
                    ...item,
                    isAvailable: item.isAvailable !== false,
                    categoryName: category.name || "Menu",
                  };
                })
                .filter(Boolean),
            };
          })
          .filter(Boolean);
        const catalog = buildCatalogFromCategories(categories);
        setMenuCategories(categories);
        setMenuCatalog(catalog);
        lastSuccessfulMenuBootstrapKeyRef.current = menuBootstrapKey;
        // Only set open category if categories exist and current is not set
        setOpenCategory((prev) => {
          if (prev) return prev; // Keep existing if set
          return Array.isArray(categories) && categories.length > 0
            ? categories[0]?.name || null
            : null;
        });
        // Fetch cart contact (phone/email) for Contact us
        const cartIdForContact = typeof cartId === "string" ? cartId : (cartId && (cartId._id || cartId.id) ? String(cartId._id || cartId.id) : "");
        if (cartIdForContact && !cancelled) {
          setHasCartContext(true);
          setContactCartId(cartIdForContact);
          try {
            const contactRes = await fetch(
              `${nodeApi}/api/carts/public-contact?cartId=${encodeURIComponent(cartIdForContact)}`
            );
            const contactJson = await contactRes.json();
            if (contactJson?.success && contactJson?.data) {
              setCartContact(contactJson.data);
            } else {
              setCartContact(null);
            }
          } catch (_) {
            setCartContact(null);
          }
        } else {
          setHasCartContext(!!cartIdForApi);
          setContactCartId(cartIdForApi || "");
          setCartContact(null);
        }

        if (cartIdForApi && !cancelled) {
          await ensureAiSessionForCart(cartIdForApi, nodeApi).catch(() => {
            /* optional until AI_REQUIRE_CUSTOMER_SESSION */
          });
        }
      } catch (err) {
        console.error("Menu fetch error", err);
        lastSuccessfulMenuBootstrapKeyRef.current = "";
        if (cancelled) return;
        // Do NOT show fallback menu when backend is not reachable.
        // Instead, keep menu empty and show a connection message.
        setMenuCategories([]);
        setMenuCatalog({});
        setOpenCategory(null);
        setCartContact(null);
        setHasCartContext(false);
        setContactCartId("");
        setMenuError(
          "Trying to connect to live menu... please check your network or ask staff.",
        );
      } finally {
        if (!cancelled) {
          setMenuLoading(false);
        }
      }
    };

    loadMenu();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAdd = (menuItem) => {
    const name = typeof menuItem === "string" ? menuItem : menuItem?.name;
    if (!name) return;
    const meta = menuCatalog[name] || menuItem;
    if (meta && meta.isAvailable === false) {
      alert(`${meta.name} is currently unavailable.`);
      return;
    }
    setCart((prev) => ({ ...prev, [name]: (prev[name] || 0) + 1 }));
  };

  const handleRemove = (name) => {
    setCart((prev) => {
      const newCount = (prev[name] || 0) - 1;
      if (newCount <= 0) {
        const { [name]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [name]: newCount };
    });
  };

  // ADD: helper for step delays
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Optional: tweak durations per step (ms)
  const DUR = {
    validate: 1000, // time to show "Validating cart"
    order: 1000, // "Order processing"
    beforeSend: 1000, // brief pause before sending to backend
    kitchen: 1000, // "Routing to kitchen"
    summary: 1000, // "Loading order summary"
    error: 1000, // how long to keep error visible
  };

  // CRITICAL: Centralized session token recovery function
  // Tries multiple sources in priority order to recover session token
  const recoverSessionToken = async (options = {}) => {
    const {
      existingOrderId = null,
      tableInfo: providedTableInfo = null,
      refreshedTableInfo: providedRefreshedTableInfo = null,
      performTableLookup = false,
    } = options;

    // recoverSessionToken called

    // Priority 1: Try to get sessionToken from existing active order
    if (existingOrderId) {
      try {
        const orderRes = await fetch(
          `${nodeApi}/api/orders/${existingOrderId}`,
        );
        if (orderRes.ok) {
          const orderData = await orderRes.json();
          if (orderData?.sessionToken) {
            console.log(
              "[Menu] recoverSessionToken: Found in existing order:",
              orderData.sessionToken,
            );
            localStorage.setItem("terra_sessionToken", orderData.sessionToken);
            setSessionToken(orderData.sessionToken);
            return orderData.sessionToken;
          }
        }
      } catch (err) {
        console.warn(
          "[Menu] recoverSessionToken: Failed to get from existing order:",
          err,
        );
      }
    }

    // Priority 2: Try refreshedTableInfo (from recent table lookup)
    if (providedRefreshedTableInfo?.sessionToken) {
      console.log(
        "[Menu] recoverSessionToken: Found in refreshedTableInfo:",
        providedRefreshedTableInfo.sessionToken,
      );
      localStorage.setItem(
        "terra_sessionToken",
        providedRefreshedTableInfo.sessionToken,
      );
      setSessionToken(providedRefreshedTableInfo.sessionToken);
      return providedRefreshedTableInfo.sessionToken;
    }

    // Priority 3: Try tableInfo state
    const currentTableInfo = providedTableInfo || tableInfo;
    if (currentTableInfo?.sessionToken) {
      console.log(
        "[Menu] recoverSessionToken: Found in tableInfo:",
        currentTableInfo.sessionToken,
      );
      localStorage.setItem("terra_sessionToken", currentTableInfo.sessionToken);
      setSessionToken(currentTableInfo.sessionToken);
      return currentTableInfo.sessionToken;
    }

    // Priority 4: Try localStorage.terra_sessionToken
    const storedToken = localStorage.getItem("terra_sessionToken");
    if (storedToken) {
      console.log(
        "[Menu] recoverSessionToken: Found in localStorage:",
        storedToken,
      );
      return storedToken;
    }

    // Priority 5: Try localStorage.terra_selectedTable
    try {
      const selectedTable = localStorage.getItem("terra_selectedTable");
      if (selectedTable) {
        const tableData = JSON.parse(selectedTable);
        if (tableData?.sessionToken) {
          console.log(
            "[Menu] recoverSessionToken: Found in terra_selectedTable:",
            tableData.sessionToken,
          );
          localStorage.setItem("terra_sessionToken", tableData.sessionToken);
          setSessionToken(tableData.sessionToken);
          return tableData.sessionToken;
        }
      }
    } catch (e) {
      console.warn(
        "[Menu] recoverSessionToken: Failed to parse terra_selectedTable:",
        e,
      );
    }

    // Priority 6: Perform fresh table lookup if requested
    if (performTableLookup) {
      try {
        const slug =
          currentTableInfo?.qrSlug || localStorage.getItem("terra_scanToken");
        if (slug) {
          const lookupRes = await fetch(`${nodeApi}/api/tables/lookup/${slug}`);
          let lookupPayload = null;
          if (lookupRes.ok) {
            lookupPayload = await lookupRes.json();
          } else if (lookupRes.status === 423) {
            // 423 is expected - extract table data anyway
            try {
              lookupPayload = await lookupRes.json();
            } catch (e) {
              console.warn(
                "[Menu] recoverSessionToken: Failed to parse 423 response:",
                e,
              );
            }
          }

          if (lookupPayload?.table?.sessionToken) {
            console.log(
              "[Menu] recoverSessionToken: Found in fresh table lookup:",
              lookupPayload.table.sessionToken,
            );
            localStorage.setItem(
              "terra_sessionToken",
              lookupPayload.table.sessionToken,
            );
            setSessionToken(lookupPayload.table.sessionToken);
            return lookupPayload.table.sessionToken;
          }
        }
      } catch (err) {
        console.warn(
          "[Menu] recoverSessionToken: Failed to perform table lookup:",
          err,
        );
      }
    }

    console.warn("[Menu] recoverSessionToken: No sessionToken found");
    return null;
  };

  // CRITICAL: Get session token with multi-source retrieval
  // This function tries multiple sources in priority order
  const getSessionToken = async (options = {}) => {
    const {
      existingOrderId = null,
      refreshedTableInfo: providedRefreshedTableInfo = null,
      tableInfo: providedTableInfo = null,
    } = options;

    // For DINE_IN orders, we need a sessionToken
    if (serviceType === "DINE_IN") {
      // Try recoverSessionToken first
      const recoveredToken = await recoverSessionToken({
        existingOrderId,
        tableInfo: providedTableInfo || tableInfo,
        refreshedTableInfo: providedRefreshedTableInfo,
        performTableLookup: false, // Don't do lookup here, do it explicitly if needed
      });

      if (recoveredToken) {
        return recoveredToken;
      }

      // If still no token, try one more table lookup
      const finalToken = await recoverSessionToken({
        existingOrderId,
        tableInfo: providedTableInfo || tableInfo,
        refreshedTableInfo: providedRefreshedTableInfo,
        performTableLookup: true,
      });

      return finalToken;
    }

    // For TAKEAWAY orders, sessionToken is optional
    return (
      localStorage.getItem("terra_takeaway_sessionToken") ||
      localStorage.getItem("terra_sessionToken") ||
      null
    );
  };

  // REPLACE the whole handleContinue with this
  const handleContinue = async () => {
    if (placeOrderInFlightRef.current) return;
    placeOrderInFlightRef.current = true;

    try {
      if (Object.keys(cartRef.current || {}).length === 0) {
        setProcessOpen(false); // Ensure overlay is closed if validation fails
        return alert(cartEmptyText);
      }

      const existingId = activeOrderId;

      if (serviceType === "DINE_IN" && !existingId && !tableInfo) {
        setProcessOpen(false); // Ensure overlay is closed if validation fails
        alert(
          "We couldn't detect your table. Please scan the table QR again or contact staff before placing an order.",
        );
        return;
      }

      // OFFICE QR: enforce checkout/payment from View Cart flow.
      if (isOfficeQrFlow) {
        setProcessOpen(false);
        navigate("/cart");
        return;
      }

      // Proceed with order creation
      await proceedWithOrder();
    } finally {
      placeOrderInFlightRef.current = false;
    }
  };

  const proceedWithOrder = async () => {
    let existingId = activeOrderId;
    const isTakeawayLikeFlow = isTakeawayLikeServiceType(serviceType);

    // Check if existing order can accept new items.
    // Do not add to settled/cancelled/returned/completed orders.
    if (existingId) {
      try {
        const orderRes = await fetch(`${nodeApi}/api/orders/${existingId}`);
        if (orderRes.ok) {
          const existingOrder = await orderRes.json();
          if (!canAddItemsToExistingOrder(existingOrder)) {
            console.log(
              "[Menu] Existing order is not eligible for add-items, creating new order instead:",
              {
                status: normalizeOrderStatus(existingOrder.status),
                paymentStatus: normalizePaymentStatus(
                  existingOrder.paymentStatus,
                  {
                    status: existingOrder.status,
                    isPaid: existingOrder.isPaid,
                  },
                ),
              },
            );
            // Clear the active order ID so we create a new order
            existingId = null;
            setActiveOrderId(null);
            // Clear service-type-specific keys
            if (isTakeawayLikeFlow) {
              localStorage.removeItem("terra_orderId_TAKEAWAY");
              localStorage.removeItem("terra_orderStatus_TAKEAWAY");
              localStorage.removeItem("terra_orderStatusUpdatedAt_TAKEAWAY");
            } else {
              localStorage.removeItem("terra_orderId");
              localStorage.removeItem("terra_orderId_DINE_IN");
              localStorage.removeItem("terra_orderStatus");
              localStorage.removeItem("terra_orderStatus_DINE_IN");
              localStorage.removeItem("terra_orderStatusUpdatedAt");
              localStorage.removeItem("terra_orderStatusUpdatedAt_DINE_IN");
            }
          }
        } else {
          // Order not found or error, create new order
          console.log(
            "[Menu] Could not fetch existing order, creating new order",
          );
          existingId = null;
          setActiveOrderId(null);
          // Clear service-type-specific keys
          if (isTakeawayLikeFlow) {
            localStorage.removeItem("terra_orderId_TAKEAWAY");
            localStorage.removeItem("terra_orderStatus_TAKEAWAY");
            localStorage.removeItem("terra_orderStatusUpdatedAt_TAKEAWAY");
          } else {
            localStorage.removeItem("terra_orderId");
            localStorage.removeItem("terra_orderId_DINE_IN");
            localStorage.removeItem("terra_orderStatus");
            localStorage.removeItem("terra_orderStatus_DINE_IN");
            localStorage.removeItem("terra_orderStatusUpdatedAt");
            localStorage.removeItem("terra_orderStatusUpdatedAt_DINE_IN");
          }
        }
      } catch (err) {
        console.warn(
          "[Menu] Error checking existing order, creating new order:",
          err,
        );
        existingId = null;
        setActiveOrderId(null);
        // Clear service-type-specific keys
        if (isTakeawayLikeFlow) {
          localStorage.removeItem("terra_orderId_TAKEAWAY");
          localStorage.removeItem("terra_orderStatus_TAKEAWAY");
          localStorage.removeItem("terra_orderStatusUpdatedAt_TAKEAWAY");
        } else {
          localStorage.removeItem("terra_orderId");
          localStorage.removeItem("terra_orderId_DINE_IN");
          localStorage.removeItem("terra_orderStatus");
          localStorage.removeItem("terra_orderStatus_DINE_IN");
          localStorage.removeItem("terra_orderStatusUpdatedAt");
          localStorage.removeItem("terra_orderStatusUpdatedAt_DINE_IN");
        }
      }
    }

    // Reset & open overlay
    setProcessSteps(
      initialProcessSteps.map((s, index) => {
        // Re-translate using latest state
        let label = s.label;
        switch (index) {
          case 0:
            label = t("processSteps.checkingOrder", "Checking your order");
            break;
          case 1:
            label = t(
              "processSteps.confirmingItems",
              "Confirming items & price",
            );
            break;
          case 2:
            label = t("processSteps.placingOrder", "Placing your order");
            break;
          case 3:
            label = t("processSteps.sendingToKitchen", "Sending to kitchen");
            break;
          case 4:
            label = t(
              "processSteps.preparingDetails",
              "Preparing order details",
            );
            break;
        }
        return { ...s, label, state: "pending" };
      }),
    );
    setProcessOpen(true);

    try {
      // Step 0: Validating cart
      setStepState(0, "active");
      await wait(DUR.validate);
      setStepState(0, "done");

      // Step 1: Order processing
      setStepState(1, "active");
      await wait(DUR.order);
      setStepState(1, "done");

      // Step 2: Sending to backend (active before fetch)
      setStepState(2, "active");
      await wait(DUR.beforeSend);

      // Use existing tableInfo - no complex refresh logic
      let refreshedTableInfo = tableInfo;

      // Get order type and location for PICKUP/DELIVERY (only for non-DINE_IN orders)
      // CRITICAL: Only read orderType for TAKEAWAY/PICKUP/DELIVERY, not for DINE_IN
      // This prevents leftover orderType values from previous orders affecting DINE_IN orders
      const isPickupOrDeliveryServiceType =
        serviceType === "PICKUP" || serviceType === "DELIVERY";
      const storedOrderType =
        isPickupOrDeliveryServiceType
          ? localStorage.getItem("terra_orderType") || null
          : null; // PICKUP or DELIVERY (only for pickup/delivery flow)
      // Robust fallback: preserve subtype from serviceType if localStorage orderType is missing.
      const effectiveOrderType =
        storedOrderType === "PICKUP" || storedOrderType === "DELIVERY"
          ? storedOrderType
          : isPickupOrDeliveryServiceType
            ? serviceType
            : null;
      const isTakeawayServiceMode =
        serviceType === "TAKEAWAY" || isPickupOrDeliveryServiceType;
      const tableContextForOrder =
        refreshedTableInfo ||
        tableInfo ||
        (() => {
          try {
            const raw = localStorage.getItem(TABLE_SELECTION_KEY);
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        })();
      const isOfficeQrFlow = hasOfficeQrMetadata(tableContextForOrder);
      const officePaymentMode = resolveOfficePaymentMode(tableContextForOrder);
      const requiresImmediatePayment =
        effectiveOrderType === "PICKUP" ||
        effectiveOrderType === "DELIVERY" ||
        (isOfficeQrFlow && officePaymentMode === "ONLINE");
      const shouldIncludeCustomerLocation =
        effectiveOrderType === "PICKUP" ||
        effectiveOrderType === "DELIVERY" ||
        isOfficeQrFlow;
      const customerLocationStr = shouldIncludeCustomerLocation
        ? localStorage.getItem("terra_customerLocation")
        : null;
      let customerLocation = null;
      if (customerLocationStr) {
        try {
          customerLocation = JSON.parse(customerLocationStr);
        } catch (e) {
          console.warn(
            "[Menu] Failed to parse customerLocation from localStorage:",
            e,
          );
          customerLocation = null;
        }
      }

      // Get customer info from localStorage for takeaway/pickup/delivery orders
      // CRITICAL: Check for both serviceType === "TAKEAWAY" AND orderType === "PICKUP"/"DELIVERY"
      // CRITICAL: For DINE_IN orders, isTakeawayType should always be false
      const isTakeawayType =
        isTakeawayServiceMode ||
        effectiveOrderType === "PICKUP" ||
        effectiveOrderType === "DELIVERY";
      const shouldIncludeCustomerInfo =
        effectiveOrderType === "PICKUP" ||
        effectiveOrderType === "DELIVERY" ||
        isOfficeQrFlow;
      const storedCustomerName = isTakeawayType
        ? localStorage.getItem("terra_takeaway_customerName") || ""
        : "";
      const storedCustomerMobile = isTakeawayType
        ? localStorage.getItem("terra_takeaway_customerMobile") || ""
        : "";
      const storedCustomerEmail = isTakeawayType
        ? localStorage.getItem("terra_takeaway_customerEmail") || ""
        : "";

      // Get cartId for takeaway orders:
      // 1) Prefer explicit cartId from takeaway QR (terra_takeaway_cartId)
      // 2) Fallback to cartId/cafeId from table selection if available
      let cartId = null;
      if (isTakeawayServiceMode) {
        const qrCartId = localStorage.getItem("terra_takeaway_cartId");
        if (qrCartId) {
          cartId = qrCartId;
          // Using cartId from takeaway QR
        } else {
          try {
            const tableData = JSON.parse(
              localStorage.getItem(TABLE_SELECTION_KEY) || "{}",
            );
            let rawCartId = tableData.cartId || tableData.cafeId || null;
            // Handle case where cartId might be an object (populated from MongoDB)
            if (rawCartId) {
              if (typeof rawCartId === "object" && rawCartId._id) {
                cartId = rawCartId._id;
              } else if (typeof rawCartId === "string") {
                cartId = rawCartId;
              } else {
                cartId = String(rawCartId);
              }
            }
            console.log(
              "[Menu] Using cartId from table data for takeaway:",
              cartId,
            );
          } catch (e) {
            console.warn(
              "[Menu] Could not get cartId from table data for takeaway order:",
              e,
            );
          }
        }
      }

      // Customer info is optional for takeaway orders - no validation needed

      // Get sessionToken from localStorage - unified approach for both table QR and takeaway-only QR
      // CRITICAL: Both takeaway flows (table QR and takeaway-only QR) must use the same sessionToken logic
      let finalSessionToken = null;
      if (isTakeawayServiceMode) {
        // For TAKEAWAY: Always use takeaway-specific sessionToken (works for both table QR and takeaway-only QR)
        // This ensures both flows work identically - same sessionToken generation and usage
        finalSessionToken = localStorage.getItem("terra_takeaway_sessionToken");

        // If no takeaway sessionToken exists, generate one (same format as SecondPage)
        // This happens when user skips customer info or if sessionToken wasn't set
        if (!finalSessionToken) {
          finalSessionToken = `TAKEAWAY-${Date.now()}-${Math.random()
            .toString(36)
            .substr(2, 9)}`;
          localStorage.setItem(
            "terra_takeaway_sessionToken",
            finalSessionToken,
          );
          console.log(
            "[Menu] Generated new takeaway sessionToken (unified for both flows):",
            finalSessionToken,
          );
        } else {
          console.log(
            "[Menu] Using existing takeaway sessionToken (unified for both flows):",
            finalSessionToken,
          );
        }
      } else {
        // For DINE_IN: Use regular sessionToken
        finalSessionToken = localStorage.getItem("terra_sessionToken");

        // If no sessionToken exists for DINE_IN, generate a simple one
        if (!finalSessionToken) {
          finalSessionToken = `session_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`;
          localStorage.setItem("terra_sessionToken", finalSessionToken);
          setSessionToken(finalSessionToken);
          console.log(
            "[Menu] Generated new DINE_IN sessionToken:",
            finalSessionToken,
          );
        }
      }

      // Get special instructions and cartId (orderType and customerLocation already retrieved above)
      const specialInstructions =
        localStorage.getItem("terra_specialInstructions") || null;
      const storedSelectedCartId = localStorage.getItem("terra_selectedCartId");
      const selectedCartId =
        requiresImmediatePayment && storedSelectedCartId
          ? storedSelectedCartId
          : null;
      const effectiveCartId =
        selectedCartId ||
        cartId ||
        (() => {
          try {
            const tableData = JSON.parse(
              localStorage.getItem(TABLE_SELECTION_KEY) || "{}",
            );
            const raw = tableData.cartId || tableData.cafeId;
            if (typeof raw === "string") return raw;
            if (raw && typeof raw === "object" && raw._id) return raw._id;
            if (raw != null) return String(raw);
          } catch (_) {}
          return "";
        })();

      // Prepare Add-ons (scoped by cartId so extras don't mix between carts)
      const addonsRaw = localStorage.getItem("terra_cart_addons") || "{}";
      let savedAddOnsIDs = [];
      const expandAddonSelection = (selection) => {
        if (Array.isArray(selection)) {
          return selection
            .map((id) => (id == null ? "" : String(id)))
            .filter(Boolean);
        }
        if (!selection || typeof selection !== "object") return [];

        const expanded = [];
        Object.entries(selection).forEach(([addonId, qty]) => {
          const id = addonId == null ? "" : String(addonId).trim();
          if (!id) return;
          const qtyValue = Number(qty);
          const quantity =
            Number.isFinite(qtyValue) && qtyValue > 0
              ? Math.floor(qtyValue)
              : 0;
          for (let index = 0; index < quantity; index += 1) {
            expanded.push(id);
          }
        });
        return expanded;
      };
      try {
        const parsed = JSON.parse(addonsRaw);
        if (Array.isArray(parsed)) {
          savedAddOnsIDs = expandAddonSelection(parsed);
        } else if (parsed && typeof parsed === "object") {
          const scopedSelection =
            effectiveCartId && Object.prototype.hasOwnProperty.call(parsed, effectiveCartId)
              ? parsed[effectiveCartId]
              : null;
          savedAddOnsIDs = expandAddonSelection(scopedSelection);
        }
      } catch (_) {
        savedAddOnsIDs = [];
      }
      const globalAddons = JSON.parse(
        localStorage.getItem("terra_global_addons") || "[]",
      );
      const addonLookupList = Array.isArray(globalAddons) ? globalAddons : [];

      const resolvedAddons = savedAddOnsIDs
        .map((id) => {
          const meta = addonLookupList.find((a) => a.id === id);
          return meta
            ? {
                addonId: id,
                name: sanitizeAddonName(meta.name),
                price: meta.price,
              }
            : null;
        })
        .filter(Boolean);

      const orderPayload = buildOrderPayload(cartRef.current, {
        serviceType: effectiveOrderType
          ? effectiveOrderType === "PICKUP"
            ? "PICKUP"
            : "DELIVERY"
          : serviceType,
        // CRITICAL: Only pass orderType if it's actually PICKUP or DELIVERY
        // For regular TAKEAWAY orders, orderType should be undefined to prevent validation errors
        orderType:
          effectiveOrderType === "PICKUP" || effectiveOrderType === "DELIVERY"
            ? effectiveOrderType
            : undefined,
        tableId:
          refreshedTableInfo?.id ||
          refreshedTableInfo?._id ||
          tableInfo?.id ||
          tableInfo?._id,
        tableNumber:
          refreshedTableInfo?.number ??
          refreshedTableInfo?.tableNumber ??
          tableInfo?.number ??
          tableInfo?.tableNumber,
        menuCatalog,
        // CRITICAL: Use the latest sessionToken we just determined
        sessionToken: finalSessionToken,
        // Customer info - required for PICKUP/DELIVERY
        customerName:
          shouldIncludeCustomerInfo && storedCustomerName?.trim()
            ? storedCustomerName.trim()
            : undefined,
        customerMobile:
          shouldIncludeCustomerInfo && storedCustomerMobile?.trim()
            ? storedCustomerMobile.trim()
            : undefined,
        customerEmail:
          shouldIncludeCustomerInfo && storedCustomerEmail?.trim()
            ? storedCustomerEmail.trim()
            : undefined,
        sourceQrType: isOfficeQrFlow ? "OFFICE" : "TABLE",
        officeName: isOfficeQrFlow
          ? String(tableContextForOrder?.officeName || "").trim() || undefined
          : undefined,
        officeAddress: isOfficeQrFlow
          ? String(tableContextForOrder?.officeAddress || "").trim() || undefined
          : undefined,
        officePhone: isOfficeQrFlow
          ? String(tableContextForOrder?.officePhone || "").trim() || undefined
          : undefined,
        officeDeliveryCharge: isOfficeQrFlow
          ? Number(tableContextForOrder?.officeDeliveryCharge || 0)
          : undefined,
        officePaymentMode: officePaymentMode || undefined,
        isVIP: isOfficeQrFlow ? tableContextForOrder?.isVIP === true : undefined,
        // Include cartId for takeaway/pickup/delivery orders
        cartId:
          isTakeawayType || effectiveOrderType
            ? effectiveCartId || undefined
            : undefined,
        // Include customer location for PICKUP/DELIVERY
        customerLocation: customerLocation,
        // Include special instructions
        specialInstructions: specialInstructions,
        selectedAddons: resolvedAddons,
        anonymousSessionId: anonymousSessionId || undefined,
        sourceQrContext:
          refreshedTableInfo?.qrContextType ||
          refreshedTableInfo?.sourceQrContext ||
          tableInfo?.qrContextType ||
          tableInfo?.sourceQrContext ||
          undefined,
      });

      const previewTakeawayToken = Number(
        localStorage.getItem(TAKEAWAY_TOKEN_PREVIEW_KEY),
      );
      if (
        isTakeawayServiceMode &&
        effectiveOrderType !== "DELIVERY" &&
        !existingId &&
        Number.isInteger(previewTakeawayToken) &&
        previewTakeawayToken > 0
      ) {
        orderPayload.takeawayToken = previewTakeawayToken;
      }

      // Addons handled by buildOrderPayload logic now

      // CRITICAL: Validate order payload before sending
      if (
        !orderPayload.items ||
        !Array.isArray(orderPayload.items) ||
        orderPayload.items.length === 0
      ) {
        console.error("[Menu] Invalid order payload - no items:", orderPayload);
        alert(
          "âŒ Your cart is empty. Please add items before placing an order.",
        );
        setStepState(2, "error");
        await wait(DUR.error);
        setProcessOpen(false);
        return;
      }

      // Validate each item has required fields
      const invalidItems = orderPayload.items.filter(
        (item) =>
          !item.name ||
          typeof item.quantity !== "number" ||
          item.quantity <= 0 ||
          typeof item.price !== "number" ||
          item.price < 0,
      );
      if (invalidItems.length > 0) {
        console.error(
          "[Menu] Invalid order payload - invalid items:",
          invalidItems,
        );
        alert(
          "âŒ Some items in your cart are invalid. Please refresh the page and try again.",
        );
        setStepState(2, "error");
        await wait(DUR.error);
        setProcessOpen(false);
        return;
      }

      // Simple validation for DINE_IN orders - just ensure sessionToken exists
      if (
        orderPayload.serviceType === "DINE_IN" &&
        !orderPayload.sessionToken
      ) {
        // Use the finalSessionToken we already determined
        if (finalSessionToken) {
          orderPayload.sessionToken = finalSessionToken;
        } else {
          // Generate a new one if still missing
          orderPayload.sessionToken = `session_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`;
          localStorage.setItem("terra_sessionToken", orderPayload.sessionToken);
          setSessionToken(orderPayload.sessionToken);
        }
      }

      // VALIDATION: Check customer info for PICKUP/DELIVERY orders before placing order
      // CRITICAL: Only validate for PICKUP/DELIVERY orders, NOT for DINE_IN or regular TAKEAWAY orders
      // Explicitly exclude DINE_IN and TAKEAWAY to prevent false positives
      const isPickupOrDelivery =
        orderPayload.serviceType === "PICKUP" ||
        orderPayload.serviceType === "DELIVERY" ||
        orderPayload.orderType === "PICKUP" ||
        orderPayload.orderType === "DELIVERY";

      if (isPickupOrDelivery) {
        if (!orderPayload.customerName || !orderPayload.customerName.trim()) {
          alert(
            "âŒ Customer name is required for " +
              (orderPayload.orderType || orderPayload.serviceType) +
              " orders. Please provide your name.",
          );
          setStepState(2, "error");
          await wait(DUR.error);
          setProcessOpen(false);
          return;
        }
        if (
          !orderPayload.customerMobile ||
          !orderPayload.customerMobile.trim()
        ) {
          alert(
            "âŒ Customer mobile number is required for " +
              (orderPayload.orderType || orderPayload.serviceType) +
              " orders. Please provide your mobile number.",
          );
          setStepState(2, "error");
          await wait(DUR.error);
          setProcessOpen(false);
          return;
        }
      }

      // VALIDATION: Check delivery availability for DELIVERY orders before placing order
      if (
        orderPayload.serviceType === "DELIVERY" ||
        orderPayload.orderType === "DELIVERY"
      ) {
        if (
          !orderPayload.customerLocation ||
          !orderPayload.customerLocation.latitude ||
          !orderPayload.customerLocation.longitude
        ) {
          alert(
            "âŒ Delivery location is required. Please go back and provide your delivery address.",
          );
          setStepState(2, "error");
          await wait(DUR.error);
          setProcessOpen(false);
          return;
        }

        if (!orderPayload.cartId) {
          alert(
            "âŒ Store selection is required for delivery. Please go back and select a store.",
          );
          setStepState(2, "error");
          await wait(DUR.error);
          setProcessOpen(false);
          return;
        }

        // Fetch cart details to check delivery availability
        try {
          const cartResponse = await fetch(
            `${nodeApi}/api/carts/${orderPayload.cartId}?latitude=${orderPayload.customerLocation.latitude}&longitude=${orderPayload.customerLocation.longitude}&orderType=DELIVERY`,
          );

          if (cartResponse.ok) {
            const cartData = await cartResponse.json();
            if (cartData.success && cartData.data) {
              const cart = cartData.data;

              // Check if delivery is available
              if (!cart.canDeliver) {
                let errorMessage = "âŒ Delivery not available!\n\n";
                if (cart.distance !== null) {
                  errorMessage += `You are ${cart.distance.toFixed(2)} km away, but maximum delivery radius is ${cart.deliveryRadius || 5} km.\n\n`;
                } else {
                  errorMessage +=
                    "Delivery is not enabled for this store or the store location is not configured.\n\n";
                }
                errorMessage +=
                  "Please select a different store or choose Pickup instead.";

                alert(errorMessage);
                setStepState(2, "error");
                await wait(DUR.error);
                setProcessOpen(false);
                return;
              }
            }
          }
        } catch (error) {
          console.error("[Menu] Error checking delivery availability:", error);
          // Continue with order placement - backend will validate
        }
      }

      // Order payload prepared
      const requestIdempotencyKey = `ord-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 11)}`;
      orderPayload.idempotencyKey = requestIdempotencyKey;

      const url = existingId
        ? `${nodeApi}/api/orders/${existingId}/kot`
        : `${nodeApi}/api/orders`;

      // Use fetch with retry for order creation to handle network issues
      let res;
      try {
        res = await postWithRetry(
          url,
          orderPayload,
          {},
          {
            maxRetries: 2, // Retry order creation up to 2 times
            retryDelay: 1500,
            timeout: 30000, // 30 second timeout for order creation
            shouldRetry: (error, attempt) => {
              // Retry on network errors, timeouts, or 5xx errors
              if (
                error.message?.includes("timeout") ||
                error.message?.includes("Network error") ||
                error.message?.includes("Failed to fetch") ||
                error.message?.includes("CORS")
              ) {
                console.log(
                  `[Menu] Retrying order creation (attempt ${attempt + 1}/2)...`,
                );
                return true;
              }
              // Don't retry on 4xx errors (client errors like validation failures)
              if (error.status >= 400 && error.status < 500) {
                return false;
              }
              // Retry on 5xx errors (server errors)
              if (error.status >= 500) {
                return true;
              }
              return attempt < 1;
            },
          },
        );
      } catch (fetchError) {
        console.error(
          "[Menu] Order creation failed after retries:",
          fetchError,
        );
        // Create a mock response object for error handling
        const errorMessage =
          fetchError.message ||
          "Failed to create order. Please check your connection and try again.";
        res = {
          ok: false,
          status: 0,
          statusText: "Network Error",
          json: async () => ({
            message: errorMessage,
          }),
          text: async () => errorMessage,
          headers: new Headers(),
        };
      }

      let data;
      try {
        // Try to parse JSON response
        const contentType = res.headers?.get?.("content-type") || "";
        if (contentType.includes("application/json")) {
          data = await res.json();
        } else {
          // If not JSON, try to get text
          const text = await res.text().catch(() => "");
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              data = { message: text || "Unknown error" };
            }
          } else {
            data = { message: "No response from server" };
          }
        }
      } catch (jsonError) {
        console.error("[Menu] Failed to parse response:", jsonError);
        // Try to get text as fallback
        try {
          const text = await res.text().catch(() => "Unknown error");
          data = { message: text || "Failed to parse server response" };
        } catch {
          data = { message: "Failed to parse server response" };
        }
      }

      // Check if order was successfully created
      const orderCreated = res.ok && data?._id;

      console.log("[Menu] Order creation response:", {
        ok: res.ok,
        status: res.status,
        hasOrderId: !!data?._id,
        orderId: data?._id,
        orderCreated,
      });

      // If order was successfully created, proceed with success flow
      if (orderCreated) {
        console.log("[Menu] Order created successfully:", data._id);
        // Continue to success flow below
      } else {
        // Backend failed -> mark error on step 2
        setStepState(2, "error");

        // Handle 403 Forbidden errors
        if (res.status === 403) {
          const errorMessage =
            data?.message || "Access denied. Please try refreshing the page.";

          // If error is about table assignment and retry didn't work
          if (
            errorMessage.includes("assigned to another guest") ||
            errorMessage.includes("table")
          ) {
            alert(
              `âš ï¸ ${errorMessage}\n\nPlease scan the table QR code again or contact staff for assistance.`,
            );
          } else {
            alert(`âŒ ${errorMessage}`);
          }
        } else if (res.status === 400) {
          // 400 Bad Request - show detailed error with payload info
          const errorMessage =
            data?.message ||
            data?.error ||
            "Invalid request. Please check your order and try again.";
          console.error("[Menu] Order save failed (400 Bad Request):", {
            status: res.status,
            statusText: res.statusText,
            error: data,
            payload: orderPayload,
            itemsCount: orderPayload.items?.length,
            serviceType: orderPayload.serviceType,
            hasSessionToken: !!orderPayload.sessionToken,
            hasTableId: !!orderPayload.tableId,
            hasTableNumber: !!orderPayload.tableNumber,
          });
          // Show more helpful error message
          let userMessage = errorMessage;
          if (data?.message?.includes("No items supplied")) {
            userMessage =
              "Your cart is empty. Please add items before placing an order.";
          } else if (data?.message?.includes("Session token is required")) {
            userMessage =
              "Session token is missing. Please scan the table QR code again.";
          } else if (data?.message?.includes("Table selection is required")) {
            userMessage =
              "Table information is missing. Please scan the table QR code again.";
          } else if (data?.message?.includes("Invalid order items")) {
            userMessage =
              "Some items in your cart are invalid. Please refresh the page and try again.";
          }
          alert(`âŒ ${userMessage}`);
        } else {
          // Show more detailed error message from backend if available
          const errorMessage =
            data?.message || data?.error || "Failed to save order.";
          console.error("[Menu] Order save failed:", {
            status: res.status,
            statusText: res.statusText,
            error: data,
            payload: orderPayload,
          });
          alert(`âŒ ${errorMessage}`);
        }

        await wait(DUR.error);
        setProcessOpen(false);
        setIsOrderingMore(false);
        return;
      }

      // Order created successfully - proceed with success flow
      console.log(
        "[Menu] Proceeding with order success flow for order:",
        data._id,
      );

      // Backend OK
      setStepState(2, "done");

      // Step 3: Routing to kitchen
      setStepState(3, "active");
      await wait(DUR.kitchen);
      setStepState(3, "done");

      // Persist & clear cart
      // CRITICAL: Store order ID in service-type-specific keys ONLY to prevent mixing TAKEAWAY and DINE_IN orders
      if (isTakeawayServiceMode) {
        // For TAKEAWAY: Only set takeaway-specific key, do NOT set generic terra_orderId
        localStorage.setItem("terra_orderId_TAKEAWAY", data._id);
        localStorage.removeItem(TAKEAWAY_TOKEN_PREVIEW_KEY);
        setTakeawayTokenPreview(null);
        // Clear any DINE_IN order data to prevent confusion
        localStorage.removeItem("terra_orderId");
        localStorage.removeItem("terra_orderId_DINE_IN");
        // Store takeaway session token to prevent cross-order updates
        // CRITICAL: Always store sessionToken for takeaway orders (works for both table QR and takeaway-only QR)
        if (data.sessionToken) {
          localStorage.setItem(
            "terra_takeaway_sessionToken",
            data.sessionToken,
          );
          console.log(
            "[Menu] Stored takeaway sessionToken from order response:",
            data.sessionToken,
          );
        } else if (finalSessionToken) {
          // If backend didn't return sessionToken but we generated one, store it
          localStorage.setItem(
            "terra_takeaway_sessionToken",
            finalSessionToken,
          );
          console.log(
            "[Menu] Stored generated takeaway sessionToken:",
            finalSessionToken,
          );
        }
      } else {
        // For DINE_IN: Set both generic and DINE_IN-specific keys
        localStorage.setItem("terra_orderId", data._id);
        localStorage.setItem("terra_orderId_DINE_IN", data._id);
        // Clear any TAKEAWAY order data to prevent confusion
        localStorage.removeItem("terra_orderId_TAKEAWAY");
      }
      setActiveOrderId(data._id);
      const normalizedStatus = normalizeOrderStatus(data.status || "NEW");
      const normalizedPaymentStatus = normalizePaymentStatus(
        data.paymentStatus,
        {
          status: data.status,
          isPaid: data.isPaid,
        },
      );
      setOrderStatus(normalizedStatus);
      setOrderPaymentStatus(normalizedPaymentStatus);
      setOrderStatusUpdatedAt(new Date().toISOString());
      setCurrentOrderDetail(data);
      refreshCustomerPushToken().catch(() => {
        // Best effort only; order flow must not fail for push setup issues.
      });
      queryClient.invalidateQueries({ queryKey: ["menu"] });
      queryClient.invalidateQueries({ queryKey: ["addons"] });

      // Store status in service-type-specific keys
      if (isTakeawayServiceMode) {
        localStorage.setItem(
          "terra_orderStatus_TAKEAWAY",
          normalizedStatus,
        );
        localStorage.setItem(
          "terra_orderStatusUpdatedAt_TAKEAWAY",
          new Date().toISOString(),
        );
      } else {
        localStorage.setItem(
          "terra_orderStatus_DINE_IN",
          normalizedStatus,
        );
        localStorage.setItem(
          "terra_orderStatusUpdatedAt_DINE_IN",
          new Date().toISOString(),
        );
      }

      // Store order detail including takeaway token for takeaway orders
      if (data && (data.takeawayToken || isTakeawayLikeServiceType(data.serviceType))) {
        persistPreviousOrderDetail(data);
      }

      // Keep cart for payment-first flows until payment page completes.
      if (!requiresImmediatePayment) {
        setCart({});
        clearScopedCart(serviceType);
      }
      setIsOrderingMore(false);

      console.log("[Menu] Order created and stored:", {
        orderId: data._id,
        serviceType,
        storedInLocalStorage: {
          generic:
            serviceType === "DINE_IN"
              ? localStorage.getItem("terra_orderId")
              : null,
          dineIn:
            serviceType === "DINE_IN"
              ? localStorage.getItem("terra_orderId_DINE_IN")
              : null,
          takeaway:
            isTakeawayServiceMode
              ? localStorage.getItem("terra_orderId_TAKEAWAY")
              : null,
        },
      });

      // Step 4: Loading order summary
      setStepState(4, "active");
      // await wait(DUR.summary);
      setStepState(4, "done");

      // For payment-first takeaway/delivery flows, move to payment page.
      if (requiresImmediatePayment) {
        setProcessOpen(false);
        navigate("/payment");
        return;
      }
      // Dine-in and non-payment-first flows stay on Menu page.
      setProcessOpen(false);
    } catch (err) {
      // Network or unexpected error -> mark backend step as error
      setStepState(2, "error");
      alert("âŒ Server Error");
      console.error(err);
      await wait(DUR.error);
      setProcessOpen(false);
      setIsOrderingMore(false);
    }
  };

  const clearTapAudioStopTimer = () => {
    if (tapAudioStopTimerRef.current) {
      clearTimeout(tapAudioStopTimerRef.current);
      tapAudioStopTimerRef.current = null;
    }
  };

  const stopTapAudioSilenceMonitor = () => {
    if (tapAudioSilenceIntervalRef.current) {
      clearInterval(tapAudioSilenceIntervalRef.current);
      tapAudioSilenceIntervalRef.current = null;
    }

    tapAudioSilenceMsRef.current = 0;
    tapAudioSpokeRef.current = false;

    if (tapAudioSourceNodeRef.current) {
      try {
        tapAudioSourceNodeRef.current.disconnect();
      } catch {}
      tapAudioSourceNodeRef.current = null;
    }
    tapAudioAnalyserRef.current = null;

    if (tapAudioContextRef.current) {
      const activeContext = tapAudioContextRef.current;
      tapAudioContextRef.current = null;
      try {
        if (activeContext.state !== "closed") {
          void activeContext.close();
        }
      } catch {}
    }
  };

  const startTapAudioSilenceMonitor = (stream) => {
    if (
      typeof window === "undefined" ||
      (!window.AudioContext && !window.webkitAudioContext) ||
      !stream
    ) {
      return;
    }

    try {
      stopTapAudioSilenceMonitor();
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextCtor();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();

      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.2;
      sourceNode.connect(analyser);

      tapAudioContextRef.current = audioContext;
      tapAudioSourceNodeRef.current = sourceNode;
      tapAudioAnalyserRef.current = analyser;
      tapAudioSilenceMsRef.current = 0;
      tapAudioSpokeRef.current = false;

      const sampleIntervalMs = 120;
      const sampleBuffer = new Float32Array(analyser.fftSize);

      tapAudioSilenceIntervalRef.current = setInterval(() => {
        const recorder = tapAudioRecorderRef.current;
        if (!recorder || recorder.state !== "recording") return;

        analyser.getFloatTimeDomainData(sampleBuffer);
        let sumSquares = 0;
        for (let i = 0; i < sampleBuffer.length; i += 1) {
          const sample = sampleBuffer[i];
          sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / sampleBuffer.length);

        if (rms >= TAP_TO_ORDER_AUDIO_LEVEL_THRESHOLD) {
          tapAudioSpokeRef.current = true;
          tapAudioSilenceMsRef.current = 0;
          return;
        }

        if (!tapAudioSpokeRef.current) return;
        tapAudioSilenceMsRef.current += sampleIntervalMs;

        if (tapAudioSilenceMsRef.current >= TAP_TO_ORDER_SILENCE_STOP_MS) {
          try {
            stopTapAudioCapture();
          } catch {}
        }
      }, sampleIntervalMs);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn("[Menu] Failed to start silence monitor:", err);
      }
      stopTapAudioSilenceMonitor();
    }
  };

  const stopTapAudioStream = () => {
    stopTapAudioSilenceMonitor();
    if (!tapAudioStreamRef.current) return;
    tapAudioStreamRef.current.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {}
    });
    tapAudioStreamRef.current = null;
  };

  const stopTapAudioCapture = () => {
    const recorder = tapAudioRecorderRef.current;
    if (!recorder) return false;
    if (recorder.state !== "inactive") {
      recorder.stop();
      return true;
    }
    return false;
  };

  const handleVoiceOrder = async () => {
    if (recording) {
      try {
        stopTapAudioCapture();
      } catch (err) {
        console.warn("Error stopping voice capture:", err);
      }
      return;
    }

    if (
      typeof window === "undefined" ||
      !navigator?.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      alert(
        "Voice recording is not supported on this browser. Please use menu buttons to order.",
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tapAudioStreamRef.current = stream;

      const preferredMimeTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ];
      const selectedMimeType = preferredMimeTypes.find((mime) =>
        MediaRecorder.isTypeSupported(mime),
      );
      const recorder = selectedMimeType
        ? new MediaRecorder(stream, { mimeType: selectedMimeType })
        : new MediaRecorder(stream);
      const audioChunks = [];

      tapAudioRecorderRef.current = recorder;
      recognitionRef.current = { stop: () => stopTapAudioCapture() };

      recorder.onstart = () => {
        setRecording(true);
        setOrderText("");
        startTapAudioSilenceMonitor(stream);
        clearTapAudioStopTimer();
        tapAudioStopTimerRef.current = setTimeout(() => {
          try {
            stopTapAudioCapture();
          } catch (err) {
            if (import.meta.env.DEV) {
              console.warn("[Menu] Failed to auto-stop tap-to-order recording:", err);
            }
          }
        }, TAP_TO_ORDER_MAX_RECORD_MS);
      };

      recorder.ondataavailable = (event) => {
        if (event?.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        if (import.meta.env.DEV) {
          console.error("[Menu] Tap-to-order recorder error:", event);
        }
        clearTapAudioStopTimer();
        setRecording(false);
        setIsProcessing(false);
        tapAudioRecorderRef.current = null;
        recognitionRef.current = null;
        stopTapAudioStream();
        alert("Voice recording failed. Please try again or use menu buttons.");
      };

      recorder.onstop = async () => {
        clearTapAudioStopTimer();
        setRecording(false);
        tapAudioRecorderRef.current = null;
        recognitionRef.current = null;
        stopTapAudioStream();

        const mimeType = recorder.mimeType || selectedMimeType || "audio/webm";
        const audioBlob = audioChunks.length
          ? new Blob(audioChunks, { type: mimeType })
          : null;

        if (!audioBlob || audioBlob.size === 0) {
          alert("No speech detected. Please try again.");
          return;
        }

        setIsProcessing(true);
        try {
          const transcript = await transcribeTapToOrderAudio(audioBlob);
          setOrderText(transcript);

          if (!transcript) {
            alert("No speech detected. Please try again.");
            return;
          }

          try {
            await executeTapToOrderWithOpenAI(transcript);
          } catch (err) {
            if (import.meta.env.DEV) {
              console.error("[Menu] Voice action execution error:", err);
            }
            await executeVoiceAction(transcript, { speakFeedback: false });
          }
        } catch (err) {
          const message =
            err?.message ||
            "Failed to process voice input. Please try again or use menu buttons.";
          alert(message);
        } finally {
          setIsProcessing(false);
        }
      };

      recorder.start(250);
    } catch (err) {
      clearTapAudioStopTimer();
      stopTapAudioStream();
      tapAudioRecorderRef.current = null;
      recognitionRef.current = null;
      setRecording(false);
      console.error("Error starting voice recording:", err);
      alert(
        "Failed to start voice input. Please check microphone permission and try again.",
      );
    }
  };
  const stopBlindListening = ({ silent = false } = {}) => {
    if (blindRecognitionRef.current) {
      try {
        blindRecognitionRef.current.onresult = null;
        blindRecognitionRef.current.onerror = null;
        blindRecognitionRef.current.onend = null;
        blindRecognitionRef.current.stop();
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn("[Menu] Failed to stop blind recognition:", err);
        }
      }
      blindRecognitionRef.current = null;
    }
    setBlindListening(false);
    if (!silent) {
      speakBlindFeedback("Blind assistant stopped.");
    }
  };

  const handleBlindAssistantTap = async () => {
    if (blindListening) {
      stopBlindListening();
      return;
    }

    if (
      !("webkitSpeechRecognition" in window) &&
      !("SpeechRecognition" in window)
    ) {
      const message =
        "Your browser doesn't support voice input. Please use the menu buttons to order.";
      alert(message);
      speakBlindFeedback(message);
      return;
    }

    try {
      // Prevent overlap with the regular mic flow.
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
        setRecording(false);
      }

      const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      blindRecognitionRef.current = recognition;

      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 3;
      recognition.lang = getVoiceRecognitionLang();

      recognition.onstart = () => {
        setBlindListening(true);
        setIsProcessing(true);
      };

      recognition.onresult = async (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript || "";
        const cleanTranscript = transcript.trim();
        if (!cleanTranscript) {
          speakBlindFeedback("I did not hear anything. Please try again.");
          return;
        }
        setOrderText(cleanTranscript);
        const result = await executeVoiceAction(cleanTranscript, {
          speakFeedback: true,
          allowStop: true,
        });
        if (result?.type === "stop") {
          stopBlindListening({ silent: true });
        }
      };

      recognition.onerror = (event) => {
        setBlindListening(false);
        setIsProcessing(false);
        blindRecognitionRef.current = null;
        if (event.error === "not-allowed") {
          const msg = "Microphone permission denied. Please allow microphone access.";
          alert(msg);
          speakBlindFeedback(msg);
        } else if (event.error === "no-speech") {
          speakBlindFeedback("No speech detected. Tap the blind assistant button and try again.");
        } else if (event.error !== "aborted") {
          const msg = "Voice recognition error. Please try again.";
          alert(msg);
          speakBlindFeedback(msg);
        }
      };

      recognition.onend = () => {
        setBlindListening(false);
        setIsProcessing(false);
        blindRecognitionRef.current = null;
      };

      speakBlindFeedback(
        "Blind assistant is active. Speak now. You can say add two vada pav, place order, show cart, or clear cart.",
        () => {
          try {
            recognition.start();
          } catch (err) {
            if (import.meta.env.DEV) {
              console.error("[Menu] Failed to start blind recognition:", err);
            }
            setBlindListening(false);
            setIsProcessing(false);
            blindRecognitionRef.current = null;
            alert("Failed to start blind assistant. Please try again.");
          }
        },
      );
    } catch (err) {
      if (import.meta.env.DEV) {
        console.error("[Menu] Blind assistant setup error:", err);
      }
      setBlindListening(false);
      setIsProcessing(false);
      blindRecognitionRef.current = null;
      alert("Unable to start blind assistant. Please try again.");
    }
  };

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
        recognitionRef.current = null;
      }
      if (blindRecognitionRef.current) {
        try {
          blindRecognitionRef.current.stop();
        } catch {}
        blindRecognitionRef.current = null;
      }
      clearTapAudioStopTimer();
      if (tapAudioRecorderRef.current) {
        try {
          tapAudioRecorderRef.current.stop();
        } catch {}
        tapAudioRecorderRef.current = null;
      }
      stopTapAudioStream();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const handleResetCart = () => {
    setCart({});
    clearScopedCart(serviceType);
  };

  const handleOrderAgain = async () => {
    if (!orderStatus || reordering) return;
    setIsOrderingMore(true);
    setReordering(true);
    try {
      // Check service type
      const currentServiceType = normalizeServiceType(
        localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
      );

      // For takeaway-like orders, skip table lookup - just allow adding more items
      if (isTakeawayLikeServiceType(currentServiceType)) {
        // For takeaway, we just need the order ID and session token
        const takeawayOrderId =
          activeOrderId ||
          localStorage.getItem("terra_orderId_TAKEAWAY") ||
          localStorage.getItem("terra_orderId");

        const takeawaySessionToken =
          localStorage.getItem("terra_takeaway_sessionToken") ||
          localStorage.getItem("terra_sessionToken");

        if (!takeawayOrderId) {
          alert("No active order found. Please create a new order.");
          return;
        }

        // Verify the order still exists and is active
        try {
          const orderRes = await fetch(
            `${nodeApi}/api/orders/${takeawayOrderId}`,
          );
          if (orderRes.ok) {
            const orderData = await orderRes.json();
            // Keep order visible/active until it is both completed and paid.
            if (isOrderSettled(orderData)) {
              setActiveOrderId(null);
              setOrderStatus(null);
              setOrderPaymentStatus("PENDING");
              setOrderStatusUpdatedAt(null);
              setCurrentOrderDetail(null);
              localStorage.removeItem("terra_orderId");
              localStorage.removeItem("terra_orderId_DINE_IN");
              localStorage.removeItem("terra_orderId_TAKEAWAY");
              localStorage.removeItem("terra_orderStatus");
              localStorage.removeItem("terra_orderStatus_DINE_IN");
              localStorage.removeItem("terra_orderStatus_TAKEAWAY");
              localStorage.removeItem("terra_orderStatusUpdatedAt");
              localStorage.removeItem("terra_orderStatusUpdatedAt_DINE_IN");
              localStorage.removeItem("terra_orderStatusUpdatedAt_TAKEAWAY");
              localStorage.removeItem("terra_orderPaymentStatus");
              setCart({});
              clearScopedCart(currentServiceType);
              alert("Previous order is settled. You can place a new order now.");
              return;
            }

            // Order is active - allow adding more items
            setActiveOrderId(takeawayOrderId);
            localStorage.setItem("terra_orderId_TAKEAWAY", takeawayOrderId);
            localStorage.removeItem("terra_orderId"); // Clear generic orderId
            localStorage.removeItem("terra_orderId_DINE_IN"); // Clear DINE_IN orderId
            setOrderStatus(
              normalizeOrderStatus(orderData.status || orderStatus || "NEW"),
            );
            setOrderPaymentStatus(
              normalizePaymentStatus(orderData.paymentStatus, {
                status: orderData.status,
                isPaid: orderData.isPaid,
              }),
            );
            localStorage.setItem(
              "terra_orderStatus_TAKEAWAY",
              normalizeOrderStatus(orderData.status || orderStatus || "NEW"),
            );

            if (orderData.updatedAt) {
              setOrderStatusUpdatedAt(orderData.updatedAt);
              localStorage.setItem(
                "terra_orderStatusUpdatedAt_TAKEAWAY",
                orderData.updatedAt,
              );
            }

            // Clear cart so user can add new items
            setCart({});
            clearScopedCart(currentServiceType);

            alert("You can continue adding items to your takeaway order.");
            return;
          } else {
            alert("Order not found. Please create a new order.");
            return;
          }
        } catch (err) {
          if (import.meta.env.DEV) {
            console.error("Failed to verify takeaway order:", err);
          }
          alert("Unable to verify order. Please try again or contact staff.");
          return;
        }
      }

      // For DINE_IN orders, use the existing table lookup logic
      const storedTable = localStorage.getItem("terra_selectedTable");
      const storedSession =
        sessionToken || localStorage.getItem("terra_sessionToken");
      if (!storedTable || !storedSession) {
        alert(
          "We couldn't detect your table. Please scan the table QR again or contact staff.",
        );
        return;
      }

      let previousDetailForDisplay = null;
      if (activeOrderId) {
        try {
          const prevRes = await fetch(`${nodeApi}/api/orders/${activeOrderId}`);
          if (prevRes.ok) {
            previousDetailForDisplay = await prevRes.json();
          }
        } catch (err) {
          if (import.meta.env.DEV) {
            console.warn("Failed to load previous order detail", err);
          }
        }
      }

      const table = JSON.parse(storedTable);
      const slug = table.qrSlug || localStorage.getItem("terra_scanToken");

      // CRITICAL: Always use the latest sessionToken from localStorage
      // This ensures we use the token that was updated by markTableOccupied()
      const latestSessionToken =
        localStorage.getItem("terra_sessionToken") || storedSession;

      const params = new URLSearchParams();
      if (latestSessionToken) {
        params.set("sessionToken", latestSessionToken);
      }
      const url = `${nodeApi}/api/tables/lookup/${slug}${
        params.toString() ? `?${params.toString()}` : ""
      }`;
      let res = await fetch(url);
      let payload = await res.json().catch(() => ({}));

      if (res.status === 423) {
        // Check if table is actually occupied by us (same sessionToken)
        const tableSessionToken = payload?.table?.sessionToken;
        if (tableSessionToken && tableSessionToken === latestSessionToken) {
          // Table is occupied by us - this is fine, continue
          console.log(
            "[Menu] Table is occupied by current session, proceeding",
          );
        } else {
          // Table is occupied by someone else
          const lockedMessage =
            payload?.message || "Table is currently assigned to another guest.";

          if (latestSessionToken) {
            // Session might be stale (table released). Try once without the old token.
            console.warn(
              "Stale session detected, retrying table lookup without session token.",
            );
            localStorage.removeItem("terra_sessionToken");
            setSessionToken(null);

            const retryParams = new URLSearchParams();
            const retryQuery = retryParams.toString();
            const retryUrl = `${nodeApi}/api/tables/lookup/${slug}${
              retryQuery ? `?${retryQuery}` : ""
            }`;
            const retryRes = await fetch(retryUrl);
            const retryPayload = await retryRes.json().catch(() => ({}));

            if (!retryRes.ok) {
              throw new Error(
                retryPayload?.message ||
                  lockedMessage ||
                  "Unable to refresh table session. Please ask staff for help.",
              );
            }

            res = retryRes;
            payload = retryPayload;
          } else {
            throw new Error(lockedMessage);
          }
        }
      } else if (!res.ok) {
        throw new Error(
          payload?.message ||
            "Failed to refresh table session. Please ask staff for help.",
        );
      }

      // CRITICAL: Check if sessionToken changed - if so, clear all old order data
      if (payload.sessionToken) {
        const oldSessionToken =
          sessionToken || localStorage.getItem("terra_sessionToken");
        const newSessionToken = payload.sessionToken;

        if (newSessionToken !== oldSessionToken) {
          // Session changed - clear all old order data from previous session
          // SessionToken changed - clearing old order data
          localStorage.removeItem("terra_orderId");
          localStorage.removeItem("terra_orderStatus");
          localStorage.removeItem("terra_orderStatusUpdatedAt");
          localStorage.removeItem("terra_previousOrder");
          localStorage.removeItem("terra_previousOrderDetail");
          localStorage.removeItem("terra_lastPaidOrderId");
          setActiveOrderId(null);
          setOrderStatus(null);
          setOrderStatusUpdatedAt(null);
          persistPreviousOrder(null);
          persistPreviousOrderDetail(null);
          clearAllScopedCarts();
          ["DINE_IN", "TAKEAWAY"].forEach((serviceType) => {
            localStorage.removeItem(`terra_orderId_${serviceType}`);
            localStorage.removeItem(`terra_orderStatus_${serviceType}`);
            localStorage.removeItem(
              `terra_orderStatusUpdatedAt_${serviceType}`,
            );
          });
        }

        localStorage.setItem("terra_sessionToken", newSessionToken);
        setSessionToken(newSessionToken);
      }
      if (payload.table) {
        localStorage.setItem(
          "terra_selectedTable",
          JSON.stringify(payload.table),
        );
        setTableInfo(payload.table);
      }
      // CRITICAL: Only store waitlist token if table is NOT available
      const tableStatus = payload.table?.status || "AVAILABLE";
      if (tableStatus === "AVAILABLE") {
        // Table is available - clear waitlist token (no waitlist logic)
        localStorage.removeItem("terra_waitToken");
      } else if (payload.waitlist?.token) {
        // Table is NOT available - store waitlist token
        localStorage.setItem("terra_waitToken", payload.waitlist.token);
      } else {
        localStorage.removeItem("terra_waitToken");
      }

      const resolvedTable = payload.table || table;

      if (payload.order) {
        // CRITICAL: Verify order serviceType matches current serviceType before processing
        const currentServiceType = normalizeServiceType(
          localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
        );
        const payloadServiceType = normalizeServiceType(
          payload.order.serviceType || currentServiceType,
        );
        const serviceTypeMismatch =
          payloadServiceType !== currentServiceType &&
          !(
            isTakeawayLikeServiceType(payloadServiceType) &&
            isTakeawayLikeServiceType(currentServiceType)
          );
        if (
          payload.order.serviceType &&
          serviceTypeMismatch
        ) {
          console.log(
            `[Menu] Ignoring order from table lookup - serviceType mismatch: order is ${payload.order.serviceType}, current is ${currentServiceType}`,
          );
          return; // Don't process order if serviceType doesn't match
        }

        setActiveOrderId(payload.order._id);
        // CRITICAL: Store order ID based on service type to prevent mixing TAKEAWAY and DINE_IN
        if (isTakeawayLikeServiceType(currentServiceType)) {
          localStorage.setItem("terra_orderId_TAKEAWAY", payload.order._id);
          localStorage.removeItem("terra_orderId");
          localStorage.removeItem("terra_orderId_DINE_IN");
        } else {
          localStorage.setItem("terra_orderId", payload.order._id);
          localStorage.setItem("terra_orderId_DINE_IN", payload.order._id);
          localStorage.removeItem("terra_orderId_TAKEAWAY");
        }
        setOrderStatus(
          normalizeOrderStatus(payload.order.status || orderStatus || "NEW"),
        );
        setOrderPaymentStatus(
          normalizePaymentStatus(payload.order.paymentStatus, {
            status: payload.order.status,
            isPaid: payload.order.isPaid,
          }),
        );
        if (payload.order.updatedAt) {
          setOrderStatusUpdatedAt(payload.order.updatedAt);
          localStorage.setItem(
            "terra_orderStatusUpdatedAt",
            payload.order.updatedAt,
          );
        }
        persistPreviousOrder(null);
      } else {
        // If no order returned but we have an activeOrderId, keep the existing order status
        // Don't clear it - the user might be ordering more items to the same order
        if (
          activeOrderId &&
          !isOrderSettled({
            status: orderStatus,
            paymentStatus: orderPaymentStatus,
            isPaid: currentOrderDetail?.isPaid,
          })
        ) {
          // Keep existing order status - user is adding more items to existing order
          console.log(
            "No order returned from table lookup, keeping existing order status",
          );
        } else {
          // Only clear if we don't have an active order
          capturePreviousOrder({
            status: orderStatus || "SERVED",
            updatedAt: orderStatusUpdatedAt || new Date().toISOString(),
            tableNumber:
              resolvedTable?.number ?? resolvedTable?.tableNumber ?? null,
            tableSlug: resolvedTable?.qrSlug ?? slug ?? null,
            tableInfo: resolvedTable,
          });
          setOrderStatus(null);
          setOrderStatusUpdatedAt(null);
          setActiveOrderId(null);
          localStorage.removeItem("terra_orderId");
          localStorage.removeItem("terra_orderStatus");
          localStorage.removeItem("terra_orderStatusUpdatedAt");
        }
      }

      if (previousDetailForDisplay) {
        persistPreviousOrderDetail(previousDetailForDisplay);
      }

      alert("You can continue adding items to your order.");
    } catch (err) {
      console.error("handleOrderAgain error", err);
      alert(err.message || "Unable to resume ordering. Please contact staff.");
    } finally {
      setReordering(false);
      setIsOrderingMore(false);
    }
  };

  const handleCancelOrder = () => {
    const isTakeawayLike = isTakeawayLikeServiceType(serviceType);
    // Get order ID - check service-type-specific first, then general
    const orderId =
      isTakeawayLike
        ? activeOrderId ||
          localStorage.getItem("terra_orderId_TAKEAWAY") ||
          localStorage.getItem("terra_orderId")
        : activeOrderId || localStorage.getItem("terra_orderId");

    if (!orderId) {
      alert("No active order found.");
      return;
    }

    setReasonAction("Cancel");
    setReasonText("");
    setShowReasonModal(true);
  };

  const handleReturnOrder = () => {
    if (!activeOrderId) {
      alert("No active order found.");
      return;
    }
    setReasonAction("Return");
    setReasonText("");
    setShowReasonModal(true);
  };

  const submitReasonAction = async () => {
    if (!reasonText.trim()) {
      alert("Please enter a reason.");
      return;
    }

    setSubmittingReason(true);

    try {
      const isTakeawayLike = isTakeawayLikeServiceType(serviceType);
      if (reasonAction === "Cancel") {
        setCancelling(true);
        // Get order ID
        const orderId =
          isTakeawayLike
            ? activeOrderId ||
              localStorage.getItem("terra_orderId_TAKEAWAY") ||
              localStorage.getItem("terra_orderId")
            : activeOrderId || localStorage.getItem("terra_orderId");

        // Get appropriate session token based on service type
        let sessionToken = null;
        if (isTakeawayLike) {
          // Try takeaway-specific token first, then fallback to generic
          sessionToken =
            localStorage.getItem("terra_takeaway_sessionToken") ||
            localStorage.getItem("terra_sessionToken");

          // If still no token, try to get it from the order itself (for backward compatibility)
          if (!sessionToken) {
            try {
              const orderRes = await fetch(`${nodeApi}/api/orders/${orderId}`);
              if (orderRes.ok) {
                const orderData = await orderRes.json();
                if (orderData?.sessionToken) {
                  sessionToken = orderData.sessionToken;
                  // Store it for future use
                  localStorage.setItem(
                    "terra_takeaway_sessionToken",
                    sessionToken,
                  );
                }
              }
            } catch (err) {
              console.warn(
                "[Menu] Failed to fetch order to get sessionToken:",
                err,
              );
            }
          }
        } else {
          sessionToken = localStorage.getItem("terra_sessionToken");
        }

        const res = await fetch(
          `${nodeApi}/api/orders/${orderId}/customer-status`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "CANCELLED",
              sessionToken: sessionToken || undefined,
              reason: reasonText,
            }),
          },
        );

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.message || "Failed to cancel order");
        }

        const updatedOrder = data?._id ? data : null;
        const updatedAt = updatedOrder?.updatedAt || new Date().toISOString();

        capturePreviousOrder({
          orderId: updatedOrder?._id,
          status: "CANCELLED",
          updatedAt,
          tableNumber:
            updatedOrder?.tableNumber ??
            tableInfo?.number ??
            tableInfo?.tableNumber ??
            null,
          tableSlug:
            updatedOrder?.table?.qrSlug ??
            tableInfo?.qrSlug ??
            localStorage.getItem("terra_scanToken") ??
            null,
          tableInfo: updatedOrder?.table || tableInfo,
        });

        if (updatedOrder) {
          persistPreviousOrderDetail(updatedOrder);
        }

        setOrderStatus("CANCELLED");
        setOrderPaymentStatus("PENDING");
        setOrderStatusUpdatedAt(updatedAt);
        setCurrentOrderDetail(
          updatedOrder || {
            status: "CANCELLED",
            cancellationReason: reasonText,
            updatedAt,
            serviceType,
          },
        );
        setActiveOrderId(null);

        // Clear order data based on service type
        if (isTakeawayLike) {
          localStorage.removeItem("terra_orderId_TAKEAWAY");
          localStorage.setItem("terra_orderStatus_TAKEAWAY", "CANCELLED");
          localStorage.setItem("terra_orderStatusUpdatedAt_TAKEAWAY", updatedAt);
          clearScopedCart("TAKEAWAY");
          localStorage.setItem("terra_orderStatus", "CANCELLED");
          localStorage.setItem("terra_orderPaymentStatus", "PENDING");
          localStorage.setItem("terra_orderStatusUpdatedAt", updatedAt);

          // CRITICAL: Clear takeaway customer data when order is cancelled
          localStorage.removeItem("terra_takeaway_customerName");
          localStorage.removeItem("terra_takeaway_customerMobile");
          localStorage.removeItem("terra_takeaway_customerEmail");
          console.log(
            "[Menu] Cleared takeaway customer data after order cancellation",
          );
        } else {
          localStorage.removeItem("terra_orderId");
          localStorage.removeItem("terra_orderId_DINE_IN");
          localStorage.setItem("terra_orderStatus", "CANCELLED");
          localStorage.setItem("terra_orderPaymentStatus", "PENDING");
          localStorage.setItem("terra_orderStatusUpdatedAt", updatedAt);
          localStorage.setItem("terra_orderStatus_DINE_IN", "CANCELLED");
          localStorage.setItem("terra_orderStatusUpdatedAt_DINE_IN", updatedAt);
          clearScopedCart("DINE_IN");
        }

        // Also clear general order id data
        localStorage.removeItem("terra_orderId");

        // CRITICAL: If this is a takeaway order, clear waitlist state
        if (isTakeawayLike) {
          localStorage.removeItem("terra_waitToken");
          console.log(
            "[Menu] Cleared waitlist state for cancelled takeaway order",
          );
        }

        setCart({});
        setIsOrderingMore(false);
        alert("Your order has been cancelled.");
        setCancelling(false);
      } else if (reasonAction === "Return") {
        setReturning(true);
        const orderId =
          isTakeawayLike
            ? activeOrderId ||
              localStorage.getItem("terra_orderId_TAKEAWAY") ||
              localStorage.getItem("terra_orderId")
            : activeOrderId || localStorage.getItem("terra_orderId");

        let sessionToken = null;
        if (isTakeawayLike) {
          sessionToken =
            localStorage.getItem("terra_takeaway_sessionToken") ||
            localStorage.getItem("terra_sessionToken");

          if (!sessionToken && orderId) {
            try {
              const orderRes = await fetch(`${nodeApi}/api/orders/${orderId}`);
              if (orderRes.ok) {
                const orderData = await orderRes.json();
                if (orderData?.sessionToken) {
                  sessionToken = orderData.sessionToken;
                  localStorage.setItem(
                    "terra_takeaway_sessionToken",
                    sessionToken,
                  );
                }
              }
            } catch (err) {
              console.warn(
                "[Menu] Failed to fetch order to get sessionToken for return:",
                err,
              );
            }
          }
        } else {
          sessionToken = localStorage.getItem("terra_sessionToken");
        }

        const res = await fetch(
          `${nodeApi}/api/orders/${orderId}/customer-status`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "RETURNED",
              sessionToken: sessionToken || undefined,
              reason: reasonText,
            }),
          },
        );

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.message || "Failed to return order");
        }

        const updatedOrder = data?._id ? data : null;
        const updatedAt = updatedOrder?.updatedAt || new Date().toISOString();

        capturePreviousOrder({
          orderId: updatedOrder?._id,
          status: "RETURNED",
          updatedAt,
          tableNumber:
            updatedOrder?.tableNumber ??
            tableInfo?.number ??
            tableInfo?.tableNumber ??
            null,
          tableSlug:
            updatedOrder?.table?.qrSlug ??
            tableInfo?.qrSlug ??
            localStorage.getItem("terra_scanToken") ??
            null,
          tableInfo: updatedOrder?.table || tableInfo,
        });

        if (updatedOrder) {
          persistPreviousOrderDetail(updatedOrder);
        }

        setOrderStatus("RETURNED");
        setOrderPaymentStatus("PENDING");
        setOrderStatusUpdatedAt(updatedAt);
        setCurrentOrderDetail(
          updatedOrder || {
            status: "RETURNED",
            cancellationReason: reasonText,
            updatedAt,
            serviceType,
          },
        );
        setActiveOrderId(null);

        // Clear order IDs based on service type
        if (isTakeawayLike) {
          localStorage.removeItem("terra_orderId_TAKEAWAY");
          localStorage.setItem("terra_orderStatus_TAKEAWAY", "RETURNED");
          localStorage.setItem("terra_orderStatusUpdatedAt_TAKEAWAY", updatedAt);
          localStorage.setItem("terra_orderStatus", "RETURNED");
          localStorage.setItem("terra_orderPaymentStatus", "PENDING");
          localStorage.setItem("terra_orderStatusUpdatedAt", updatedAt);
        } else {
          localStorage.removeItem("terra_orderId");
          localStorage.removeItem("terra_orderId_DINE_IN");
          localStorage.setItem("terra_orderStatus", "RETURNED");
          localStorage.setItem("terra_orderPaymentStatus", "PENDING");
          localStorage.setItem("terra_orderStatusUpdatedAt", updatedAt);
          localStorage.setItem("terra_orderStatus_DINE_IN", "RETURNED");
          localStorage.setItem("terra_orderStatusUpdatedAt_DINE_IN", updatedAt);
        }

        clearScopedCart(isTakeawayLike ? "TAKEAWAY" : "DINE_IN");
        setCart({});
        setIsOrderingMore(false);

        // CRITICAL: If this is a takeaway order, clear waitlist state
        if (isTakeawayLike) {
          localStorage.removeItem("terra_waitToken");

          // CRITICAL: Clear takeaway customer data when order is returned
          localStorage.removeItem("terra_takeaway_customerName");
          localStorage.removeItem("terra_takeaway_customerMobile");
          localStorage.removeItem("terra_takeaway_customerEmail");
        }

        alert("Your order has been marked as returned.");
        setReturning(false);
      }

      setShowReasonModal(false);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.error(`${reasonAction} error`, err);
      }
      alert(err.message || `Unable to ${reasonAction.toLowerCase()} order.`);
      // Reset loading states on error
      if (reasonAction === "Cancel") setCancelling(false);
      if (reasonAction === "Return") setReturning(false);
    } finally {
      setSubmittingReason(false);
    }
  };

  const handleViewInvoice = useCallback(async () => {
    if (!activeOrderId) {
      alert("We couldn't locate your order. Please contact staff.");
      return;
    }
    try {
      setInvoiceLoading(true);
      const res = await fetch(`${nodeApi}/api/orders/${activeOrderId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || "Failed to load invoice details.");
      }

      // Debug logging
      console.log("Ã°Å¸â€œâ€ž Invoice order data:", {
        orderId: data._id,
        franchiseId: data.franchiseId,
        cafeId: data.cafeId,
        franchise: data.franchise,
        cafe: data.cafe,
      });

      setInvoiceOrder(data);
      setShowInvoiceModal(true);
    } catch (err) {
      console.error("Invoice fetch failed", err);
      alert(err.message || "Unable to load invoice. Please contact staff.");
    } finally {
      setInvoiceLoading(false);
    }
  }, [activeOrderId]);

  const closeInvoiceModal = useCallback(() => {
    setShowInvoiceModal(false);
    setInvoiceOrder(null);
    setPrintingInvoice(false);
    setDownloadingInvoice(false);
    setInvoiceLoading(false);
  }, []);

  const handlePrintInvoice = useCallback(() => {
    if (!invoiceRef.current || !invoiceOrder || printingInvoice) return;
    setPrintingInvoice(true);

    try {
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.style.visibility = "hidden";

      // Add sandbox attribute for better security in production
      iframe.setAttribute(
        "sandbox",
        "allow-same-origin allow-scripts allow-modals",
      );

      document.body.appendChild(iframe);
      const doc = iframe.contentWindow?.document;

      if (!doc) {
        setPrintingInvoice(false);
        document.body.removeChild(iframe);
        alert(
          "Print preview failed to open. Please check your browser settings.",
        );
        return;
      }

      doc.open();
      doc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${invoiceId || "Invoice"}</title>
          <style>
            * { box-sizing: border-box; }
            body {
              font-family: 'Segoe UI', Arial, sans-serif;
              margin: 0;
              padding: 32px;
              background: #ffffff;
              color: #1f2933;
            }
            h1, h2, h3, h4 { margin: 0; }
            table { border-collapse: collapse; width: 100%; }
            th, td { padding: 8px; border-bottom: 1px solid #e5e7eb; }
            th { text-align: left; color: #475569; font-weight: 600; }
            .invoice-shell {
              max-width: 720px;
              margin: 0 auto;
              padding: 24px;
              border: 1px solid #d2d6dc;
              border-radius: 12px;
            }
            @media print {
              body { padding: 0; }
              .invoice-shell { border: none; }
            }
          </style>
        </head>
        <body>
          <div class="invoice-shell">
            ${invoiceRef.current.innerHTML}
          </div>
        </body>
      </html>
    `);
      doc.close();

      // Use longer timeout for production to ensure resources load
      iframe.onload = function () {
        setTimeout(() => {
          try {
            iframe.contentWindow?.focus();
            iframe.contentWindow?.print();
          } catch (printError) {
            console.error("Print failed:", printError);
            alert(
              "Print failed. Please try using your browser's print function (Ctrl+P).",
            );
          } finally {
            // Clean up after print dialog closes or fails
            setTimeout(() => {
              if (document.body.contains(iframe)) {
                document.body.removeChild(iframe);
              }
              setPrintingInvoice(false);
            }, 500);
          }
        }, 250); // Increased timeout for production
      };

      // Fallback timeout in case onload never fires
      setTimeout(() => {
        if (printingInvoice && document.body.contains(iframe)) {
          document.body.removeChild(iframe);
          setPrintingInvoice(false);
          console.warn("Print timeout - iframe failed to load");
        }
      }, 5000);
    } catch (error) {
      console.error("Print setup failed:", error);
      setPrintingInvoice(false);
      alert("Failed to initialize print. Please try again or use Ctrl+P.");
    }
  }, [invoiceId, invoiceOrder, printingInvoice]);

  const handleDownloadInvoice = useCallback(async () => {
    if (!invoiceRef.current || !invoiceOrder || downloadingInvoice) return;
    setDownloadingInvoice(true);
    let exportContainer = null;
    try {
      exportContainer = document.createElement("div");
      exportContainer.style.position = "fixed";
      exportContainer.style.left = "-10000px";
      exportContainer.style.top = "0";
      exportContainer.style.width = `${INVOICE_EXPORT_WIDTH}px`;
      exportContainer.style.background = "#ffffff";
      exportContainer.style.padding = "0";
      exportContainer.style.margin = "0";
      exportContainer.style.pointerEvents = "none";
      exportContainer.style.opacity = "0";
      exportContainer.style.zIndex = "-1";

      const exportInvoiceNode = invoiceRef.current.cloneNode(true);
      exportInvoiceNode.style.width = "100%";
      exportInvoiceNode.style.maxWidth = "100%";
      exportInvoiceNode.style.margin = "0";
      exportInvoiceNode.style.borderRadius = "0";
      exportInvoiceNode.style.boxShadow = "none";

      exportContainer.appendChild(exportInvoiceNode);
      document.body.appendChild(exportContainer);

      await new Promise((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });

      const captureWidth =
        exportInvoiceNode.scrollWidth ||
        exportContainer.scrollWidth ||
        INVOICE_EXPORT_WIDTH;
      const captureHeight = Math.max(
        exportInvoiceNode.scrollHeight || exportContainer.scrollHeight || 1,
        1,
      );

      const canvas = await html2canvas(exportInvoiceNode, {
        scale: getInvoiceCaptureScale(),
        useCORS: true,
        logging: false,
        backgroundColor: "#ffffff",
        scrollX: 0,
        scrollY: 0,
        windowWidth: captureWidth,
        windowHeight: captureHeight,
        width: captureWidth,
        height: captureHeight,
        onclone: (clonedDoc) => {
          const allElements = clonedDoc.querySelectorAll(
            ".invoice-preview, .invoice-preview *",
          );
          allElements.forEach((el) => {
            const computedStyle = window.getComputedStyle(el);
            ["color", "backgroundColor", "borderColor"].forEach((prop) => {
              const value = computedStyle[prop];
              if (value && value.includes("oklch")) {
                el.style[prop] = "#000000";
                if (prop === "backgroundColor") {
                  el.style[prop] = "transparent";
                }
              }
            });
          });
        },
      });
      const imageData = canvas.toDataURL("image/png");
      const pdf = new jsPDF("p", "mm", "a4");
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const margin = 10;
      const usableWidth = pdfWidth - margin * 2;
      const imgProps = pdf.getImageProperties(imageData);
      const imgRatio = imgProps.height / imgProps.width;
      const imgHeight = usableWidth * imgRatio;

      let heightLeft = imgHeight;
      let position = margin;

      pdf.addImage(imageData, "PNG", margin, position, usableWidth, imgHeight);
      heightLeft -= pdfHeight - margin * 2;

      while (heightLeft > 0) {
        pdf.addPage();
        position = margin - (imgHeight - heightLeft);
        pdf.addImage(
          imageData,
          "PNG",
          margin,
          position,
          usableWidth,
          imgHeight,
        );
        heightLeft -= pdfHeight - margin * 2;
      }

      saveInvoicePdf(pdf, `${invoiceId || "invoice"}.pdf`);
    } catch (err) {
      console.error("Invoice download failed", err);
      alert("Failed to generate invoice PDF. Please try again.");
    } finally {
      if (exportContainer && document.body.contains(exportContainer)) {
        document.body.removeChild(exportContainer);
      }
      setDownloadingInvoice(false);
    }
  }, [invoiceId, invoiceOrder, downloadingInvoice]);

  const handleBillingClick = useCallback(async () => {
    const normalizedStatus = normalizeOrderStatus(orderStatus);
    if (normalizedStatus === "PREPARING" || normalizedStatus === "READY") {
      await handleViewInvoice();
      return;
    }

    if (isCancelledOrReturnedStatus(orderStatus)) {
      alert(
        String(orderStatus || "").trim().toUpperCase() === "RETURNED"
          ? "This order has already been returned."
          : "This order has been cancelled.",
      );
      return;
    }

    // For Confirmed and other statuses, navigate to billing page
    navigate("/billing");
  }, [orderStatus, handleViewInvoice, navigate]);

  const handleViewPreviousInvoice = useCallback(() => {
    if (!previousOrderDetail) return;
    setInvoiceLoading(false);
    setInvoiceOrder(previousOrderDetail);
    setShowInvoiceModal(true);
  }, [previousOrderDetail]);

  const getVoiceRecognitionLang = () => {
    const language = localStorage.getItem("language") || "en";
    if (language === "hi") return "hi-IN";
    if (language === "mr") return "mr-IN";
    if (language === "gu") return "gu-IN";
    return "en-IN";
  };

  const speakBlindFeedback = (text, onEnd) => {
    if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) {
      if (typeof onEnd === "function") onEnd();
      return;
    }
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = getVoiceRecognitionLang();
      utterance.rate = 0.95;
      utterance.pitch = 1;
      utterance.onend = () => {
        if (typeof onEnd === "function") onEnd();
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn("[Menu] Failed to speak blind feedback:", err);
      }
      if (typeof onEnd === "function") onEnd();
    }
  };

  const normalizeVoiceText = (value) =>
    (value || "")
      .toLowerCase()
      .replace(/[.,!?]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const pickPreferredFemaleVoice = () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!Array.isArray(voices) || voices.length === 0) return null;

    const femaleHint = /(female|woman|zira|samantha|susan|karen|moira|sonia|heera|google uk english female)/i;
    return (
      voices.find((voice) => femaleHint.test(String(voice?.name || ""))) ||
      voices.find((voice) => String(voice?.lang || "").startsWith("en")) ||
      voices[0] ||
      null
    );
  };

  const speakTapToOrderAssistant = (text) => {
    if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = getVoiceRecognitionLang();
      utterance.rate = 0.95;
      utterance.pitch = 1.05;
      const voice = pickPreferredFemaleVoice();
      if (voice) {
        utterance.voice = voice;
      }
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn("[Menu] Failed to speak tap-to-order assistant feedback:", err);
      }
    }
  };

  // Word-to-number for voice fallback parsing (e.g. "two chai" -> 2)
  const wordToNumber = (word) => {
    const map = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
      ek: 1,
      do: 2,
      teen: 3,
      char: 4,
      paanch: 5,
      che: 6,
      saat: 7,
      aath: 8,
      nau: 9,
      das: 10,
    };
    const w = normalizeVoiceText(word);
    if (map[w] !== undefined) return map[w];
    const n = parseInt(w, 10);
    return Number.isNaN(n) ? 0 : n;
  };

  const processVoiceOrder = (text) => {
    const result = { addedItems: [], notFound: [] };
    if (!text) return result;

    const updatedCart = { ...(cartRef.current || {}) };
    const itemsToMatch =
      Array.isArray(flatMenuItems) && flatMenuItems.length > 0
        ? flatMenuItems
        : Object.values(menuCatalog).length > 0
          ? Object.values(menuCatalog)
          : fallbackMenuItems.map((item) => ({ ...item, isAvailable: true }));

    const entries = text
      .replace(/\b(and|aur|plus|with)\b/gi, ",")
      .replace(/[;|]/g, ",")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    const normalizeName = (value) =>
      normalizeVoiceText(value).replace(/[^a-z0-9\s]/g, "");

    entries.forEach((entry) => {
      let qty = 1;
      let itemName = entry
        .replace(
          /^(add|order|please add|please|i want|give me|mujhe|mala|mane)\s+/i,
          "",
        )
        .trim();

      const numericMatch = itemName.match(/^(\d+)\s*(x|times)?\s+(.+)$/i);
      if (numericMatch) {
        qty = parseInt(numericMatch[1], 10) || 1;
        itemName = numericMatch[3].trim();
      } else {
        const wordNumMatch = itemName.match(
          /^(one|two|three|four|five|six|seven|eight|nine|ten|ek|do|teen|char|paanch|che|saat|aath|nau|das)\s+(.+)$/i,
        );
        if (wordNumMatch) {
          qty = wordToNumber(wordNumMatch[1]) || 1;
          itemName = wordNumMatch[2].trim();
        }
      }

      if (!itemName) return;

      const normalizedRequested = normalizeName(itemName);
      const matchedItem =
        itemsToMatch.find(
          (item) =>
            item?.name && normalizeName(item.name) === normalizedRequested,
        ) ||
        itemsToMatch.find((item) => {
          if (!item?.name) return false;
          const normalizedItemName = normalizeName(item.name);
          return (
            normalizedItemName.includes(normalizedRequested) ||
            normalizedRequested.includes(normalizedItemName)
          );
        });

      if (matchedItem && matchedItem.isAvailable !== false) {
        updatedCart[matchedItem.name] = (updatedCart[matchedItem.name] || 0) + qty;
        result.addedItems.push({ name: matchedItem.name, qty });
      } else {
        result.notFound.push(itemName);
      }
    });

    cartRef.current = updatedCart;
    setCart(updatedCart);
    return result;
  };

  const getTapToOrderMenuItems = () => {
    const sourceItems =
      Array.isArray(flatMenuItems) && flatMenuItems.length > 0
        ? flatMenuItems
        : Object.values(menuCatalog).length > 0
          ? Object.values(menuCatalog)
          : fallbackMenuItems.map((item) => ({ ...item, isAvailable: true }));

    const seen = new Set();
    const menuItems = [];
    sourceItems.forEach((item) => {
      if (!item?.name || item.isAvailable === false) return;
      const key = String(item.name).trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      menuItems.push({ name: String(item.name).trim() });
    });
    return menuItems;
  };

  const applyTapToOrderAiItems = (items) => {
    const result = { addedItems: [], notFound: [] };
    if (!Array.isArray(items) || items.length === 0) return result;

    const sourceItems =
      Array.isArray(flatMenuItems) && flatMenuItems.length > 0
        ? flatMenuItems
        : Object.values(menuCatalog).length > 0
          ? Object.values(menuCatalog)
          : fallbackMenuItems.map((item) => ({ ...item, isAvailable: true }));

    const normalizeName = (value) =>
      normalizeVoiceText(value).replace(/[^a-z0-9\s]/g, "");
    const availableItems = sourceItems.filter(
      (item) => item?.name && item.isAvailable !== false,
    );
    const updatedCart = { ...(cartRef.current || {}) };

    items.forEach((entry) => {
      const requestedName = String(entry?.name || "").trim();
      if (!requestedName) return;
      const quantityRaw = Number(entry?.quantity);
      const qty = Number.isFinite(quantityRaw)
        ? Math.max(1, Math.min(20, Math.round(quantityRaw)))
        : 1;
      const normalizedRequested = normalizeName(requestedName);

      const matchedItem =
        availableItems.find(
          (item) => normalizeName(item.name) === normalizedRequested,
        ) ||
        availableItems.find((item) => {
          const normalizedItemName = normalizeName(item.name);
          return (
            normalizedItemName.includes(normalizedRequested) ||
            normalizedRequested.includes(normalizedItemName)
          );
        });

      if (!matchedItem) {
        result.notFound.push(requestedName);
        return;
      }

      updatedCart[matchedItem.name] = (updatedCart[matchedItem.name] || 0) + qty;
      result.addedItems.push({ name: matchedItem.name, qty });
    });

    cartRef.current = updatedCart;
    setCart(updatedCart);
    return result;
  };

  const transcribeTapToOrderAudio = async (audioBlob) => {
    if (!audioBlob || audioBlob.size <= 0) {
      throw new Error("No audio captured for transcription");
    }

    const mimeType = String(audioBlob.type || "audio/webm").toLowerCase();
    const extension = mimeType.includes("ogg")
      ? "ogg"
      : mimeType.includes("mp4")
        ? "mp4"
        : mimeType.includes("mpeg")
          ? "mp3"
          : mimeType.includes("wav")
            ? "wav"
            : "webm";

    const formData = new FormData();
    formData.append(
      "audio",
      new File([audioBlob], `tap-to-order.${extension}`, {
        type: audioBlob.type || "audio/webm",
      }),
    );
    formData.append("locale", getVoiceRecognitionLang());

    const response = await fetchWithRetry(
      TAP_TO_ORDER_TRANSCRIBE_ENDPOINT,
      {
        method: "POST",
        body: formData,
      },
      {
        maxRetries: 1,
        timeout: 45000,
      },
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.message || "Whisper transcription request failed");
    }

    return String(payload?.transcript || "").trim();
  };

  const executeTapToOrderWithOpenAI = async (transcript) => {
    const menuItems = getTapToOrderMenuItems();
    if (!menuItems.length) {
      throw new Error("Menu not loaded for tap-to-order AI");
    }

    const response = await postWithRetry(
      TAP_TO_ORDER_AI_ENDPOINT,
      {
        transcript,
        menuItems,
        locale: getVoiceRecognitionLang(),
      },
      {},
      {
        maxRetries: 1,
        timeout: 20000,
      },
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.message || "Tap-to-order AI request failed");
    }

    const action = String(payload?.action || "NONE").toUpperCase();
    const assistantReply = String(payload?.assistantReply || "").trim();
    const aiNotFound = Array.isArray(payload?.notFound)
      ? payload.notFound.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];

    if (action === "CLEAR_CART") {
      handleResetCart();
      setOrderText("");
      speakTapToOrderAssistant(assistantReply || "I cleared your cart.");
      return { type: "clear" };
    }

    if (action === "SHOW_CART") {
      speakTapToOrderAssistant(assistantReply || "Opening your cart.");
      navigate("/cart");
      return { type: "cart" };
    }

    if (action === "PLACE_ORDER") {
      if (Object.keys(cartRef.current || {}).length === 0) {
        speakTapToOrderAssistant(
          assistantReply || cartEmptyText || "Your cart is empty.",
        );
        return { type: "place-empty" };
      }
      speakTapToOrderAssistant(assistantReply || "Placing your order now.");
      await handleContinue();
      return { type: "place" };
    }

    if (action === "ADD_ITEMS") {
      const { addedItems, notFound } = applyTapToOrderAiItems(payload?.items);
      const mergedNotFound = [...new Set([...notFound, ...aiNotFound])];
      const formattedOrder = addedItems
        .map(({ name, qty }) => `${qty}x ${name}`)
        .join(", ");
      if (formattedOrder) {
        setOrderText(formattedOrder);
      }

      if (addedItems.length > 0) {
        speakTapToOrderAssistant(
          assistantReply ||
            `Added ${addedItems.length} item${addedItems.length > 1 ? "s" : ""} to your cart.`,
        );
      } else if (mergedNotFound.length > 0) {
        speakTapToOrderAssistant(
          assistantReply ||
            `I could not find these in the menu: ${mergedNotFound.join(", ")}.`,
        );
      } else {
        speakTapToOrderAssistant(
          assistantReply || "Please tell me which item you want to order.",
        );
      }

      return { type: "items", addedItems, notFound: mergedNotFound };
    }

    speakTapToOrderAssistant(
      assistantReply || "Please say your order clearly and try again.",
    );
    return { type: "none" };
  };

  const executeVoiceAction = async (transcript, { speakFeedback = false, allowStop = false } = {}) => {
    const normalized = normalizeVoiceText(transcript);
    if (!normalized) {
      if (speakFeedback) {
        speakBlindFeedback("I could not hear you clearly. Please try again.");
      }
      return { type: "empty" };
    }

    const contains = (keywords) => keywords.some((keyword) => normalized.includes(keyword));
    const stopKeywords = ["stop", "assistant stop", "close assistant", "stop listening"];
    const placeOrderKeywords = [
      "confirm order",
      "place order",
      "order now",
      "checkout",
      "submit order",
      "confirm my order",
      "Ã Â¤â€˜Ã Â¤Â°Ã Â¥ÂÃ Â¤Â¡Ã Â¤Â° Ã Â¤â€¢Ã Â¤Â¨Ã Â¥ÂÃ Â¤Â«Ã Â¤Â°Ã Â¥ÂÃ Â¤Â®",
      "Ã Â¤â€˜Ã Â¤Â°Ã Â¥ÂÃ Â¤Â¡Ã Â¤Â° Ã Â¤â€¢Ã Â¤Â°Ã Â¥â€¹",
      "Ã Â¤â€˜Ã Â¤Â°Ã Â¥ÂÃ Â¤Â¡Ã Â¤Â° Ã Â¤ÂªÃ Â¥ÂÃ Â¤Â²Ã Â¥â€¡Ã Â¤Â¸",
      "Ã Â¤â€˜Ã ÂªÂ°Ã Â«ÂÃ ÂªÂ¡Ã ÂªÂ° Ã Â¤â€¢Ã ÂªÂ¨Ã Â«ÂÃ ÂªÂ«Ã ÂªÂ°Ã Â«ÂÃ ÂªÂ®",
      "Ã Âªâ€œÃ ÂªÂ°Ã Â«ÂÃ ÂªÂ¡Ã ÂªÂ° Ã ÂªÂ®Ã Â«â€šÃ Âªâ€¢Ã Â«â€¹",
    ];
    const cartKeywords = ["open cart", "show cart", "go to cart", "cart kholo", "Ã Â¤â€¢Ã Â¤Â¾Ã Â¤Â°Ã Â¥ÂÃ Â¤Å¸", "Ã Âªâ€¢Ã ÂªÂ¾Ã ÂªÂ°Ã Â«ÂÃ ÂªÅ¸"];
    const clearCartKeywords = [
      "clear cart",
      "empty cart",
      "reset cart",
      "remove all",
      "cart clear",
      "Ã Â¤â€¢Ã Â¤Â¾Ã Â¤Â°Ã Â¥ÂÃ Â¤Å¸ Ã Â¤â€“Ã Â¤Â¾Ã Â¤Â²Ã Â¥â‚¬",
      "Ã Âªâ€¢Ã ÂªÂ¾Ã ÂªÂ°Ã Â«ÂÃ ÂªÅ¸ Ã Âªâ€“Ã ÂªÂ¾Ã ÂªÂ²Ã Â«â‚¬",
    ];

    if (allowStop && contains(stopKeywords)) {
      if (speakFeedback) {
        speakBlindFeedback("Blind assistant stopped.");
      }
      return { type: "stop" };
    }

    if (contains(clearCartKeywords)) {
      handleResetCart();
      setOrderText("");
      if (speakFeedback) {
        speakBlindFeedback("Cart has been cleared.");
      } else {
        alert("Cart cleared.");
      }
      return { type: "clear" };
    }

    if (contains(cartKeywords)) {
      if (speakFeedback) {
        speakBlindFeedback("Opening cart.");
      }
      navigate("/cart");
      return { type: "cart" };
    }

    if (contains(placeOrderKeywords)) {
      if (Object.keys(cartRef.current || {}).length === 0) {
        if (speakFeedback) {
          speakBlindFeedback(cartEmptyText || "Your cart is empty.");
        } else {
          alert(cartEmptyText);
        }
        return { type: "place-empty" };
      }
      if (speakFeedback) {
        speakBlindFeedback("Placing your order now.");
      }
      await handleContinue();
      return { type: "place" };
    }

    const { addedItems, notFound } = processVoiceOrder(transcript);
    const addedCount = addedItems.length;
    const formattedOrder = addedItems
      .map(({ name, qty }) => `${qty}x ${name}`)
      .join(", ");
    if (formattedOrder) setOrderText(formattedOrder);

    if (addedCount > 0) {
      if (speakFeedback) {
        speakBlindFeedback(
          `Added ${addedCount} item${addedCount > 1 ? "s" : ""} to your cart.`,
        );
      } else if (notFound.length > 0) {
        alert(
          `âœ… Added ${addedCount} item(s) to cart.\nâš ï¸ Not found in menu: ${notFound.join(", ")}`,
        );
      }
    } else if (notFound.length > 0) {
      const message = `Could not find in menu: ${notFound.join(", ")}. Try saying item names as shown in the menu.`;
      if (speakFeedback) {
        speakBlindFeedback(message);
      } else {
        alert(message);
      }
    }

    return { type: "items", addedItems, notFound };
  };

  const speakOrderSummary = () => {
    if (Object.keys(cart).length === 0) return alert(cartEmptyText);
    const synth = window.speechSynthesis;
    let speechText = "You have ordered: ";
    Object.entries(cart).forEach(([item, quantity]) => {
      speechText += `${quantity} ${item}, `;
    });
    const utter = new SpeechSynthesisUtterance(speechText);
    utter.rate = 0.9;
    utter.pitch = 1;
    synth.speak(utter);
  };

  useEffect(() => {
    // Get order ID - check service-type-specific ONLY, never mix TAKEAWAY and DINE_IN
    const currentServiceType = normalizeServiceType(
      localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
    );
    const isTakeaway = isTakeawayLikeServiceType(currentServiceType);
    let orderId = null;
    if (isTakeaway) {
      // For takeaway-like flows: prefer takeaway key.
      orderId =
        activeOrderId ||
        localStorage.getItem("terra_orderId_TAKEAWAY") ||
        localStorage.getItem("terra_orderId");
    } else {
      // For DINE_IN: Read from DINE_IN-specific key first, fallback to generic for backward compatibility
      orderId =
        activeOrderId ||
        localStorage.getItem("terra_orderId_DINE_IN") ||
        localStorage.getItem("terra_orderId");
    }

    if (!orderId) {
      const storedStatus = isTakeaway
        ? localStorage.getItem("terra_orderStatus_TAKEAWAY") ||
          localStorage.getItem("terra_orderStatus")
        : localStorage.getItem("terra_orderStatus_DINE_IN") ||
          localStorage.getItem("terra_orderStatus");
      const storedPaymentStatus =
        localStorage.getItem("terra_orderPaymentStatus") || "PENDING";
      const storedUpdatedAt = isTakeaway
        ? localStorage.getItem("terra_orderStatusUpdatedAt_TAKEAWAY") ||
          localStorage.getItem("terra_orderStatusUpdatedAt")
        : localStorage.getItem("terra_orderStatusUpdatedAt_DINE_IN") ||
          localStorage.getItem("terra_orderStatusUpdatedAt");

      if (
        shouldPreserveOrderStateWithoutActiveId({
          status: storedStatus,
          paymentStatus: storedPaymentStatus,
        })
      ) {
        setOrderStatus(normalizeOrderStatus(storedStatus));
        setOrderPaymentStatus(
          normalizePaymentStatus(storedPaymentStatus, { status: storedStatus }),
        );
        setOrderStatusUpdatedAt(storedUpdatedAt || null);
      } else {
        setOrderStatus(null);
        setOrderPaymentStatus("PENDING");
        setOrderStatusUpdatedAt(null);
      }
      setCurrentOrderDetail(null);
      return;
    }

    if (isOrderingMore) {
      return;
    }

    let socket;
    // Track if we've already logged connection error - must be outside function to persist
    let connectionErrorLogged = false;
    let joinedCartId = null;
    let joinedAnonymousSessionId = null;
    let handleSocketConnected = null;
    let handleSocketReconnect = null;
    let handleSocketConnectError = null;

    const normalizeCartId = (cartId) => {
      if (cartId == null) return null;
      if (typeof cartId === "string") return cartId;
      if (typeof cartId === "object" && cartId._id) return String(cartId._id);
      return String(cartId);
    };

    const joinCartRoom = (cartId) => {
      if (!socket || cartId == null) return;
      const normalizedCartId = normalizeCartId(cartId);
      if (!normalizedCartId || joinedCartId === normalizedCartId) return;
      joinCustomerRoomOnce("join:cart", normalizedCartId);
      joinedCartId = normalizedCartId;
    };

    const getFallbackCartId = () => {
      const cartIdFromTakeaway = localStorage.getItem("terra_takeaway_cartId");
      if (cartIdFromTakeaway) return cartIdFromTakeaway;
      try {
        const tableData = JSON.parse(
          localStorage.getItem(TABLE_SELECTION_KEY) || "{}",
        );
        const rawCartId = tableData.cartId || tableData.cafeId;
        if (rawCartId != null) {
          return normalizeCartId(rawCartId);
        }
      } catch {
        // ignore parse errors
      }
      try {
        const selectedTableRaw = localStorage.getItem("terra_selectedTable");
        if (selectedTableRaw) {
          const selectedTable = JSON.parse(selectedTableRaw);
          const rawCartId =
            selectedTable?.cartId?._id ||
            selectedTable?.cartId ||
            selectedTable?.cafeId?._id ||
            selectedTable?.cafeId;
          if (rawCartId != null) {
            return normalizeCartId(rawCartId);
          }
        }
      } catch {
        // ignore parse errors
      }
      return null;
    };

    const joinIdentityRoom = () => {
      if (!socket) return;
      const identityPayload = buildSocketIdentityPayload();
      if (!identityPayload?.anonymousSessionId) return;
      if (joinedAnonymousSessionId === identityPayload.anonymousSessionId) return;
      joinCustomerRoomOnce("join_room", identityPayload);
      joinedAnonymousSessionId = identityPayload.anonymousSessionId;
      if (import.meta.env.DEV) {
        console.debug(
          "[Menu] Joined identity room:",
          identityPayload.anonymousSessionId
        );
      }
    };

    const fetchStatus = async () => {
      try {
        // Get order ID - check service-type-specific ONLY, never mix TAKEAWAY and DINE_IN
        const currentServiceType = normalizeServiceType(
          localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
        );
        const isTakeawayFlow = isTakeawayLikeServiceType(currentServiceType);
        let orderId = null;
        if (isTakeawayFlow) {
          // For takeaway-like flows: prefer takeaway key.
          orderId =
            activeOrderId ||
            localStorage.getItem("terra_orderId_TAKEAWAY") ||
            localStorage.getItem("terra_orderId");
        } else {
          // For DINE_IN: Read from DINE_IN-specific key first, fallback to generic for backward compatibility
          orderId =
            activeOrderId ||
            localStorage.getItem("terra_orderId_DINE_IN") ||
            localStorage.getItem("terra_orderId");
        }

        if (!orderId) {
          setCurrentOrderDetail(null);
          return;
        }

        const currentSessionToken = localStorage.getItem("terra_sessionToken");

        let res;
        try {
          res = await fetch(`${nodeApi}/api/orders/${orderId}`, {
            signal: AbortSignal.timeout(5000), // 5 second timeout
          });
        } catch (fetchError) {
          // Handle network errors (connection refused, timeout, etc.)
          // Only log once to avoid console spam
          if (!connectionErrorLogged) {
            console.warn(
              "[Menu] Backend server appears to be offline. Will retry automatically.",
            );
            connectionErrorLogged = true;
          }
          // Keep existing order status from localStorage - don't clear it
          return;
        }

        // Reset error flag on successful HTTP response (even if 404/500 - means server is online)
        if (connectionErrorLogged) {
          connectionErrorLogged = false;
        }

        if (!res.ok) {
          // Only clear order data if order truly doesn't exist (404)
          // Don't clear on other errors (network issues, 500, etc.) - keep existing status
          if (res.status === 404) {
            console.warn("Order not found (404), clearing order data");
            // Clear service-type-specific keys
            if (isTakeawayFlow) {
              localStorage.removeItem("terra_orderId_TAKEAWAY");
              localStorage.removeItem("terra_orderStatus_TAKEAWAY");
              localStorage.removeItem("terra_orderStatusUpdatedAt_TAKEAWAY");
            } else {
              localStorage.removeItem("terra_orderId");
              localStorage.removeItem("terra_orderId_DINE_IN");
              localStorage.removeItem("terra_orderStatus");
              localStorage.removeItem("terra_orderStatus_DINE_IN");
              localStorage.removeItem("terra_orderStatusUpdatedAt");
              localStorage.removeItem("terra_orderStatusUpdatedAt_DINE_IN");
            }
            setActiveOrderId(null);
            setOrderStatus(null);
            setOrderStatusUpdatedAt(null);
            setCurrentOrderDetail(null);
          }
          return;
        }
        let data;
        try {
          data = await res.json();
        } catch (jsonError) {
          console.error(
            "[Menu] Failed to parse order status response as JSON:",
            jsonError,
          );
          // Keep existing status on JSON parse error
          return;
        }

        if (!data) return;

        // CRITICAL: Verify order serviceType matches current serviceType to prevent mixing TAKEAWAY and DINE_IN
        const serviceType = normalizeServiceType(
          localStorage.getItem("terra_serviceType") || "DINE_IN",
        );
        const isTakeaway = isTakeawayLikeServiceType(serviceType);
        const orderServiceType = normalizeServiceType(
          data.serviceType || serviceType,
        );
        const serviceTypeMismatch =
          orderServiceType !== serviceType &&
          !(
            isTakeawayLikeServiceType(orderServiceType) &&
            isTakeawayLikeServiceType(serviceType)
          );

        // If order serviceType doesn't match current serviceType, ignore it
        if (data.serviceType && serviceTypeMismatch) {
          console.log(
            `[Menu] Ignoring order update - serviceType mismatch: order is ${data.serviceType}, current is ${serviceType}`,
          );
          return;
        }

        // Get appropriate session token based on service type
        const expectedSessionToken = isTakeaway
          ? localStorage.getItem("terra_takeaway_sessionToken") ||
            currentSessionToken
          : currentSessionToken;

        // Verify sessionToken matches for both DINE_IN and TAKEAWAY orders
        // CRITICAL: For takeaway, be more lenient - only check if both tokens exist
        if (isTakeaway) {
          // For takeaway, only verify if we have both tokens
          if (
            expectedSessionToken &&
            data.sessionToken &&
            data.sessionToken !== expectedSessionToken
          ) {
            // Order belongs to different session - ignore update but don't clear (might be from another customer)
            return;
          }
        } else {
          // For dine-in, strict verification
          if (
            expectedSessionToken &&
            data.sessionToken &&
            data.sessionToken !== expectedSessionToken
          ) {
            // Order belongs to old session - clear DINE_IN order data
            localStorage.removeItem("terra_orderId");
            localStorage.removeItem("terra_orderId_DINE_IN");
            localStorage.removeItem("terra_orderStatus");
            localStorage.removeItem("terra_orderStatus_DINE_IN");
            localStorage.removeItem("terra_orderStatusUpdatedAt");
            localStorage.removeItem("terra_orderStatusUpdatedAt_DINE_IN");
            clearScopedCart("DINE_IN");
            localStorage.removeItem("terra_previousOrder");
            localStorage.removeItem("terra_previousOrderDetail");
            setActiveOrderId(null);
            setOrderStatus(null);
            setOrderStatusUpdatedAt(null);
            setCurrentOrderDetail(null);
            persistPreviousOrder(null);
            persistPreviousOrderDetail(null);
            return;
          }
        }

        setCurrentOrderDetail(data);
        if (data.cartId) {
          joinCartRoom(data.cartId);
        }

        // For takeaway orders, persist full order detail (including token) for dashboard display
        if (isTakeaway) {
          persistPreviousOrderDetail(data);
        }

        // Update order status and sync with localStorage
        if (data?.status) {
          // Check current status from service-type-specific key to avoid duplicate updates
          const currentStatus = isTakeaway
            ? localStorage.getItem("terra_orderStatus_TAKEAWAY") ||
              localStorage.getItem("terra_orderStatus")
            : localStorage.getItem("terra_orderStatus_DINE_IN") ||
              localStorage.getItem("terra_orderStatus");

          // Avoid duplicate updates if status hasn't changed
          const normalizedStatus = normalizeOrderStatus(data.status);
          const normalizedPaymentStatus = normalizePaymentStatus(
            data.paymentStatus,
            {
              status: data.status,
              isPaid: data.isPaid,
            },
          );
          if (currentStatus === normalizedStatus && orderStatus === normalizedStatus) {
            return;
          }

          const nowIso = new Date().toISOString();
          setOrderStatus(normalizedStatus);
          setOrderPaymentStatus(normalizedPaymentStatus);
          setOrderStatusUpdatedAt(nowIso);

          // Update service-type-specific keys (primary storage)
          if (isTakeaway) {
            localStorage.setItem("terra_orderStatus_TAKEAWAY", normalizedStatus);
            localStorage.setItem("terra_orderStatusUpdatedAt_TAKEAWAY", nowIso);
            // Also update generic key for backward compatibility
            localStorage.setItem("terra_orderStatus", normalizedStatus);
            localStorage.setItem("terra_orderStatusUpdatedAt", nowIso);
          } else {
            localStorage.setItem("terra_orderStatus_DINE_IN", normalizedStatus);
            localStorage.setItem("terra_orderStatusUpdatedAt_DINE_IN", nowIso);
            // Also update generic key for backward compatibility
            localStorage.setItem("terra_orderStatus", normalizedStatus);
            localStorage.setItem("terra_orderStatusUpdatedAt", nowIso);
          }
          localStorage.setItem(
            "terra_orderPaymentStatus",
            normalizedPaymentStatus,
          );
        }
      } catch (err) {
        // Don't clear order data on network errors - keep existing status from localStorage
        // Error already handled in fetch catch block above, so just return silently
        // Keep the order status from localStorage - don't clear it
      }
    };

    // Bootstrap once, then rely on realtime socket updates (no polling).
    fetchStatus();

    // Create socket connection with proper error handling
    try {
      socket = getCustomerSocket();

      // Track if we've already logged socket error - must be outside function to persist
      let socketErrorLogged = false;

      handleSocketConnected = () => {
        socketErrorLogged = false;
        connectionErrorLogged = false;
        joinedAnonymousSessionId = null;
        joinIdentityRoom();
        joinCartRoom(
          currentOrderDetail?.cartId ||
            localStorage.getItem("terra_takeaway_cartId") ||
            getFallbackCartId(),
        );
        fetchStatus();
      };

      handleSocketReconnect = () => {
        joinedCartId = null;
        joinedAnonymousSessionId = null;
        joinIdentityRoom();
        joinCartRoom(
          currentOrderDetail?.cartId ||
            localStorage.getItem("terra_takeaway_cartId") ||
            getFallbackCartId(),
        );
        fetchStatus();
      };

      handleSocketConnectError = () => {
        if (!socketErrorLogged) {
          console.warn(
            "[Menu] Socket connection error - backend may be offline. Will retry automatically.",
          );
          socketErrorLogged = true;
        }
      };

      safeCustomerSocketOn("connect", handleSocketConnected);
      safeCustomerSocketOn("reconnect", handleSocketReconnect);
      safeCustomerSocketOn("connect_error", handleSocketConnectError);
    } catch (err) {
      console.warn("[Menu] Failed to create socket connection:", err);
      socket = null;
    }

    // Define event handlers
    const handleOrderUpdated = (payload) => {
      if (!payload || typeof payload !== "object") return;

      // Get order ID - check service-type-specific ONLY, never mix TAKEAWAY and DINE_IN
      const currentServiceType = normalizeServiceType(
        localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
      );
      const isTakeawayFlow = isTakeawayLikeServiceType(currentServiceType);
      let orderId = null;
      if (isTakeawayFlow) {
        // For takeaway-like flows: prefer takeaway key.
        orderId =
          activeOrderId ||
          localStorage.getItem("terra_orderId_TAKEAWAY") ||
          localStorage.getItem("terra_orderId");
      } else {
        // For DINE_IN: Read from DINE_IN-specific key first, fallback to generic for backward compatibility
        orderId =
          activeOrderId ||
          localStorage.getItem("terra_orderId_DINE_IN") ||
          localStorage.getItem("terra_orderId");
      }

      // CRITICAL: Only process if this is our order and status actually changed
      // Also verify serviceType matches to prevent TAKEAWAY orders appearing in DINE_IN mode
      const payloadOrderId = payload?._id || payload?.id || payload?.orderId;
      const payloadServiceType = normalizeServiceType(
        payload?.serviceType || currentServiceType,
      );
      const serviceTypeMismatch =
        payloadServiceType !== currentServiceType &&
        !(
          isTakeawayLikeServiceType(payloadServiceType) &&
          isTakeawayLikeServiceType(currentServiceType)
        );
      if (
        String(payloadOrderId || "") === String(orderId || "") &&
        payload?.status &&
        !serviceTypeMismatch
      ) {
        const currentStatus = localStorage.getItem("terra_orderStatus");
        const nextStatus = normalizeOrderStatus(payload.status);
        // Avoid duplicate updates if status hasn't changed
        if (
          currentStatus === nextStatus &&
          orderStatus === nextStatus
        ) {
          return;
        }

        // CRITICAL: For takeaway orders, verify sessionToken matches to prevent cross-order updates
        if (isTakeawayFlow && payload.sessionToken) {
          const expectedSessionToken =
            localStorage.getItem("terra_takeaway_sessionToken") ||
            localStorage.getItem("terra_sessionToken");
          if (
            expectedSessionToken &&
            payload.sessionToken !== expectedSessionToken
          ) {
            // Order belongs to different session - ignore update
            return;
          }
        }

        if (isTakeawayFlow && payload.anonymousSessionId) {
          const expectedAnonymousSessionId =
            anonymousSessionId || ensureAnonymousSessionId();
          if (
            expectedAnonymousSessionId &&
            payload.anonymousSessionId !== expectedAnonymousSessionId
          ) {
            return;
          }
        }

        const nowIso = new Date().toISOString();
        const normalizedStatus = nextStatus;
        const normalizedPaymentStatus = normalizePaymentStatus(
          payload.paymentStatus,
          {
            status: payload.status,
            isPaid: payload.isPaid,
          },
        );
        if (import.meta.env.DEV) {
          console.debug("[Menu] Realtime order status update", {
            orderId: payloadOrderId,
            status: normalizedStatus,
            paymentStatus: normalizedPaymentStatus,
            serviceType: payload.serviceType || currentServiceType,
          });
        }
        console.log("[Menu] recv order_status_updated", {
          orderId: payloadOrderId,
          status: normalizedStatus,
          paymentStatus: normalizedPaymentStatus,
          updatedAt: payload.updatedAt || nowIso,
        });
        setOrderStatus(normalizedStatus);
        setOrderPaymentStatus(normalizedPaymentStatus);
        setOrderStatusUpdatedAt(nowIso);
        notifyOrderStatusUpdate({
          orderId: payloadOrderId || orderId,
          status: normalizedStatus,
          paymentStatus: normalizedPaymentStatus,
          serviceType: payload.serviceType || currentServiceType,
        });
        const hasRichOrderShape =
          Array.isArray(payload.kotLines) ||
          payload.table ||
          payload.customerName ||
          payload.customerMobile ||
          payload.createdAt;
        if (hasRichOrderShape) {
          setCurrentOrderDetail(payload);
        } else {
          setCurrentOrderDetail((prev) => ({
            ...(prev || {}),
            _id: payloadOrderId || prev?._id || null,
            status: normalizedStatus,
            paymentStatus:
              normalizedPaymentStatus || prev?.paymentStatus || "PENDING",
            isPaid: normalizedPaymentStatus === "PAID",
            updatedAt: payload.updatedAt || nowIso,
            orderType: payload.orderType || prev?.orderType || null,
            serviceType: payload.serviceType || prev?.serviceType || null,
            cartId: payload.cartId || prev?.cartId || null,
          }));
        }
        if (payload.cartId) {
          joinCartRoom(payload.cartId);
        }
        // Also update localStorage to keep it in sync
        localStorage.setItem("terra_orderStatus", normalizedStatus);
        localStorage.setItem(
          "terra_orderPaymentStatus",
          normalizedPaymentStatus,
        );
        localStorage.setItem("terra_orderStatusUpdatedAt", nowIso);
        // Update service-type-specific keys
        if (isTakeawayFlow) {
          localStorage.setItem("terra_orderStatus_TAKEAWAY", normalizedStatus);
          localStorage.setItem("terra_orderStatusUpdatedAt_TAKEAWAY", nowIso);
        } else {
          localStorage.setItem("terra_orderStatus_DINE_IN", normalizedStatus);
          localStorage.setItem("terra_orderStatusUpdatedAt_DINE_IN", nowIso);
        }
      }
    };

    const handleOrderAccepted = (payload) => {
      if (!payload) return;

      const currentServiceType = normalizeServiceType(
        localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
      );
      const isTakeawayFlow = isTakeawayLikeServiceType(currentServiceType);
      let orderId = null;
      if (isTakeawayFlow) {
        orderId =
          activeOrderId ||
          localStorage.getItem("terra_orderId_TAKEAWAY") ||
          localStorage.getItem("terra_orderId");
      } else {
        orderId =
          activeOrderId ||
          localStorage.getItem("terra_orderId_DINE_IN") ||
          localStorage.getItem("terra_orderId");
      }

      const acceptedOrderId = payload.orderId || payload.order?._id;
      if (
        !acceptedOrderId ||
        String(acceptedOrderId) !== String(orderId || "")
      ) {
        return;
      }

      const acceptedStatus = normalizeOrderStatus(
        payload.status || payload.order?.status || "NEW",
      );
      const acceptedPaymentStatus = normalizePaymentStatus(
        payload.paymentStatus || payload.order?.paymentStatus,
        {
          status: payload.status || payload.order?.status,
          isPaid: payload.isPaid || payload.order?.isPaid,
        },
      );
      const nowIso = new Date().toISOString();
      setOrderStatus(acceptedStatus);
      setOrderPaymentStatus(acceptedPaymentStatus);
      setOrderStatusUpdatedAt(nowIso);

      localStorage.setItem("terra_orderStatus", acceptedStatus);
      localStorage.setItem("terra_orderPaymentStatus", acceptedPaymentStatus);
      localStorage.setItem("terra_orderStatusUpdatedAt", nowIso);
      if (isTakeawayFlow) {
        localStorage.setItem("terra_orderStatus_TAKEAWAY", acceptedStatus);
        localStorage.setItem("terra_orderStatusUpdatedAt_TAKEAWAY", nowIso);
      } else {
        localStorage.setItem("terra_orderStatus_DINE_IN", acceptedStatus);
        localStorage.setItem("terra_orderStatusUpdatedAt_DINE_IN", nowIso);
      }

      if (payload.order && typeof payload.order === "object") {
        setCurrentOrderDetail(payload.order);
        if (payload.order.cartId) {
          joinCartRoom(payload.order.cartId);
        }
        return;
      }

      /*
      if (payload.assignedStaff) {
        setCurrentOrderDetail((prev) => {
          const next = prev ? { ...prev } : { _id: acceptedOrderId };
          next.status = acceptedStatus;
          next.assignedStaff = payload.assignedStaff;
          if (!next.acceptedBy) {
            next.acceptedBy = {
              employeeId: payload.assignedStaff.id || null,
              employeeName: payload.assignedStaff.name || null,
              employeeRole: payload.assignedStaff.role || null,
              disability: {
                hasDisability: Boolean(payload.assignedStaff.disability),
                type: payload.assignedStaff.disability || null,
              },
            };
          }
          return next;
        });
      }
      */
    };

    const handleOrderDeleted = (payload) => {
      // Get order ID - check service-type-specific ONLY, never mix TAKEAWAY and DINE_IN
      const currentServiceType = normalizeServiceType(
        localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
      );
      const isTakeawayFlow = isTakeawayLikeServiceType(currentServiceType);
      let orderId = null;
      if (isTakeawayFlow) {
        // For takeaway-like flows: prefer takeaway key.
        orderId =
          activeOrderId ||
          localStorage.getItem("terra_orderId_TAKEAWAY") ||
          localStorage.getItem("terra_orderId");
      } else {
        // For DINE_IN: Read from DINE_IN-specific key first, fallback to generic for backward compatibility
        orderId =
          activeOrderId ||
          localStorage.getItem("terra_orderId_DINE_IN") ||
          localStorage.getItem("terra_orderId");
      }

      if (payload?.id === orderId) {
        setOrderStatus(null);
        setActiveOrderId(null);
        setCurrentOrderDetail(null);
        // Clear service-type-specific keys
        if (isTakeawayFlow) {
          localStorage.removeItem("terra_orderId_TAKEAWAY");
          localStorage.removeItem("terra_orderStatus_TAKEAWAY");
          localStorage.removeItem("terra_orderStatusUpdatedAt_TAKEAWAY");
        } else {
          localStorage.removeItem("terra_orderId");
          localStorage.removeItem("terra_orderId_DINE_IN");
          localStorage.removeItem("terra_orderStatus");
          localStorage.removeItem("terra_orderStatus_DINE_IN");
          localStorage.removeItem("terra_orderStatusUpdatedAt");
          localStorage.removeItem("terra_orderStatusUpdatedAt_DINE_IN");
        }
      }
    };

    // CRITICAL: Listen for table status updates to sync with admin panel
    // When table becomes AVAILABLE, clear any waitlist state
    const handleTableStatusUpdated = (updatedTable) => {
      // Get current table info from state or localStorage (use latest)
      const currentTableInfo =
        tableInfo ||
        (() => {
          try {
            const stored = localStorage.getItem("terra_selectedTable");
            return stored ? JSON.parse(stored) : null;
          } catch {
            return null;
          }
        })();

      // Only update if this is the same table
      if (!currentTableInfo) {
        return; // No table info to compare
      }

      // Get IDs from both sources (handle both id and _id)
      const updatedTableId = updatedTable.id || updatedTable._id;
      const currentTableId = currentTableInfo.id || currentTableInfo._id;

      // Compare as strings to handle ObjectId vs string mismatches
      const isSameTable =
        updatedTableId &&
        currentTableId &&
        String(updatedTableId) === String(currentTableId);

      // Also check by table number as fallback
      const isSameTableByNumber =
        updatedTable.number &&
        currentTableInfo.number &&
        String(updatedTable.number) === String(currentTableInfo.number);

      if (!isSameTable && !isSameTableByNumber) {
        return; // Different table, ignore update
      }

      console.log(
        "[Menu] Table status updated via socket:",
        updatedTable.status,
        "Previous status:",
        currentTableInfo.status,
      );

      // Update table info with new status
      const updatedTableInfo = {
        ...currentTableInfo,
        status: updatedTable.status,
        currentOrder: updatedTable.currentOrder || null,
        sessionToken:
          updatedTable.sessionToken || currentTableInfo.sessionToken,
      };
      setTableInfo(updatedTableInfo);
      // Update localStorage to persist the change
      localStorage.setItem(
        "terra_selectedTable",
        JSON.stringify(updatedTableInfo),
      );

      // CRITICAL: If table becomes AVAILABLE, clear waitlist state and order data
      // This ensures customer frontend syncs with admin panel and new customers don't see old orders
      // BUT: Only clear if user doesn't have an active order (to prevent clearing current customer's order)
      const existingOrderId =
        localStorage.getItem("terra_orderId") ||
        localStorage.getItem("terra_orderId_DINE_IN");
      const existingOrderStatus =
        localStorage.getItem("terra_orderStatus") ||
        localStorage.getItem("terra_orderStatus_DINE_IN");
      const existingOrderPaymentStatus =
        localStorage.getItem("terra_orderPaymentStatus") || "PENDING";
      const hasActiveOrder =
        existingOrderId &&
        isOrderActiveForCustomer({
          status: existingOrderStatus,
          paymentStatus: existingOrderPaymentStatus,
        });
      const shouldPreserveTerminalStatus = shouldPreserveOrderStateWithoutActiveId(
        {
          status: existingOrderStatus,
          paymentStatus: existingOrderPaymentStatus,
        },
      );

      if (updatedTable.status === "AVAILABLE") {
        // Only clear order data if user doesn't have an active order
        // This prevents clearing current customer's order when admin makes table available
        if (!hasActiveOrder && !shouldPreserveTerminalStatus) {
          console.log(
            "[Menu] Table became AVAILABLE via socket - clearing waitlist state and order data (user has no active order)",
          );
          // Clear waitlist token and info
          localStorage.removeItem("terra_waitToken");
          // CRITICAL: Clear all previous customer order data when table becomes available
          // This ensures new customers don't see previous customer's orders
          localStorage.removeItem("terra_orderId");
          clearAllScopedCarts();
          localStorage.removeItem("terra_orderStatus");
          localStorage.removeItem("terra_orderStatusUpdatedAt");
          localStorage.removeItem("terra_previousOrder");
          localStorage.removeItem("terra_previousOrderDetail");
          ["DINE_IN", "TAKEAWAY"].forEach((serviceType) => {
            localStorage.removeItem(`terra_orderId_${serviceType}`);
            localStorage.removeItem(`terra_orderStatus_${serviceType}`);
            localStorage.removeItem(
              `terra_orderStatusUpdatedAt_${serviceType}`,
            );
          });
          // Clear order state in component
          setActiveOrderId(null);
          setOrderStatus(null);
          setCurrentOrderDetail(null);
          console.log("[Menu] Cleared all order data for new customer");
        } else if (shouldPreserveTerminalStatus) {
          console.log(
            "[Menu] Table became AVAILABLE but preserving final customer order status",
          );
        } else {
          console.log(
            "[Menu] Table became AVAILABLE but user has active order - preserving order data",
          );
        }
      }
    };

    // Register canonical real-time listeners.
    if (socket) {
      safeCustomerSocketOn("order.updated", handleOrderUpdated);
      safeCustomerSocketOn("order_status_updated", handleOrderUpdated);
      safeCustomerSocketOn("ORDER_ACCEPTED", handleOrderAccepted);
      safeCustomerSocketOn("orderDeleted", handleOrderDeleted);
      safeCustomerSocketOn("table:status:updated", handleTableStatusUpdated);
    }

    return () => {
      // Remove event listeners only; shared socket remains connected.
      if (socket) {
        if (handleSocketConnected) {
          socket.off("connect", handleSocketConnected);
        }
        if (handleSocketReconnect) {
          socket.off("reconnect", handleSocketReconnect);
        }
        if (handleSocketConnectError) {
          socket.off("connect_error", handleSocketConnectError);
        }
        socket.off("order.updated", handleOrderUpdated);
        socket.off("order_status_updated", handleOrderUpdated);
        socket.off("ORDER_ACCEPTED", handleOrderAccepted);
        socket.off("orderDeleted", handleOrderDeleted);
        socket.off("table:status:updated", handleTableStatusUpdated);
      }
    };
  }, [activeOrderId, anonymousSessionId, isOrderingMore, serviceType]);

  // Sync orderStatus from localStorage when component mounts or activeOrderId changes
  // This ensures that when user navigates back from payment page or refreshes, the status is synced
  useEffect(() => {
    // Get order ID - check service-type-specific first, then general
    const currentServiceType = normalizeServiceType(
      localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
    );
    const isTakeawayFlow = isTakeawayLikeServiceType(currentServiceType);
    const orderId =
      isTakeawayFlow
        ? activeOrderId ||
          localStorage.getItem("terra_orderId_TAKEAWAY") ||
          localStorage.getItem("terra_orderId")
        : activeOrderId ||
          localStorage.getItem("terra_orderId_DINE_IN") ||
          localStorage.getItem("terra_orderId");

    if (orderId) {
      // Check service-type-specific keys for takeaway orders
      const storedStatus =
        isTakeawayFlow
          ? localStorage.getItem("terra_orderStatus_TAKEAWAY") ||
            localStorage.getItem("terra_orderStatus")
          : localStorage.getItem("terra_orderStatus_DINE_IN") ||
            localStorage.getItem("terra_orderStatus");
      const storedUpdatedAt =
        isTakeawayFlow
          ? localStorage.getItem("terra_orderStatusUpdatedAt_TAKEAWAY") ||
            localStorage.getItem("terra_orderStatusUpdatedAt")
          : localStorage.getItem("terra_orderStatusUpdatedAt_DINE_IN") ||
            localStorage.getItem("terra_orderStatusUpdatedAt");

      if (storedStatus) {
        // Always restore status from localStorage if it exists, even if state already has it
        // This ensures status is shown immediately on page refresh
        if (storedStatus !== orderStatus) {
          console.log(
            "[Menu] Syncing orderStatus from localStorage:",
            storedStatus,
          );
          setOrderStatus(normalizeOrderStatus(storedStatus));
          setOrderPaymentStatus(
            normalizePaymentStatus(
              localStorage.getItem("terra_orderPaymentStatus"),
              {
                status: storedStatus,
              },
            ),
          );
        }
        if (storedUpdatedAt && storedUpdatedAt !== orderStatusUpdatedAt) {
          setOrderStatusUpdatedAt(storedUpdatedAt);
        }
      }
    }
  }, [activeOrderId, orderStatus, orderStatusUpdatedAt]); // Run when activeOrderId or status changes

  // Also restore order status and activeOrderId immediately on mount
  useEffect(() => {
    const currentServiceType = normalizeServiceType(
      localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN",
    );
    const isTakeawayFlow = isTakeawayLikeServiceType(currentServiceType);
    // CRITICAL: Only read from service-type-specific keys, never mix TAKEAWAY and DINE_IN
    let storedOrderId = null;
    if (isTakeawayFlow) {
      // For takeaway-like flows, use takeaway key first.
      storedOrderId =
        localStorage.getItem("terra_orderId_TAKEAWAY") ||
        localStorage.getItem("terra_orderId");
    } else {
      // For DINE_IN: Read from DINE_IN-specific key first, fallback to generic for backward compatibility
      storedOrderId =
        localStorage.getItem("terra_orderId_DINE_IN") ||
        localStorage.getItem("terra_orderId");
    }

    // Restore activeOrderId if it exists in localStorage but not in state
    if (storedOrderId && storedOrderId !== activeOrderId) {
      console.log(
        "[Menu] Restoring activeOrderId on mount:",
        storedOrderId,
        "serviceType:",
        currentServiceType,
      );
      setActiveOrderId(storedOrderId);
    }

    // Restore order status if it exists
    if (storedOrderId && !orderStatus) {
      const storedStatus =
        isTakeawayFlow
          ? localStorage.getItem("terra_orderStatus_TAKEAWAY") ||
            localStorage.getItem("terra_orderStatus")
          : localStorage.getItem("terra_orderStatus_DINE_IN") ||
            localStorage.getItem("terra_orderStatus");
      const storedUpdatedAt =
        isTakeawayFlow
          ? localStorage.getItem("terra_orderStatusUpdatedAt_TAKEAWAY") ||
            localStorage.getItem("terra_orderStatusUpdatedAt")
          : localStorage.getItem("terra_orderStatusUpdatedAt_DINE_IN") ||
            localStorage.getItem("terra_orderStatusUpdatedAt");

      if (storedStatus) {
        // Restoring order status on mount
        setOrderStatus(normalizeOrderStatus(storedStatus));
        setOrderPaymentStatus(
          normalizePaymentStatus(localStorage.getItem("terra_orderPaymentStatus"), {
            status: storedStatus,
          }),
        );
        if (storedUpdatedAt) {
          setOrderStatusUpdatedAt(storedUpdatedAt);
        }
      }
    }
  }, []); // Only run once on mount

  useEffect(() => {
    if (!activeOrderId) {
      setCurrentOrderDetail(null);
      return;
    }

    let cancelled = false;
    const loadCurrentOrderDetail = async () => {
      try {
        const res = await fetch(`${nodeApi}/api/orders/${activeOrderId}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data) return;

        const currentServiceType =
          normalizeServiceType(localStorage.getItem(SERVICE_TYPE_KEY) || "DINE_IN");
        const orderServiceType = normalizeServiceType(
          data.serviceType || currentServiceType,
        );
        const serviceTypeMismatch =
          orderServiceType !== currentServiceType &&
          !(
            isTakeawayLikeServiceType(orderServiceType) &&
            isTakeawayLikeServiceType(currentServiceType)
          );
        if (data.serviceType && serviceTypeMismatch) {
          return;
        }
        setCurrentOrderDetail(data);
      } catch {
        // Keep existing detail state on transient fetch errors.
      }
    };

    loadCurrentOrderDetail();
    return () => {
      cancelled = true;
    };
  }, [activeOrderId, serviceType]);

  useEffect(() => {
    // CRITICAL: Wait for menu to fully load before processing confirm action
    // This prevents creating orders with 0 prices due to empty menuCatalog
    if (searchParams.get("action") === "confirm" && !menuLoading) {
      // Safety check: ensure we actually have prices before confirming
      if (menuError || Object.keys(menuCatalog).length === 0) {
        console.error(
          "[Menu] Auto-confirm aborted: Menu data missing or error",
          { menuCatalogSize: Object.keys(menuCatalog).length, menuError },
        );
        // Clean URL to prevent loop, user will see the menu (or error state)
        const newParams = new URLSearchParams(searchParams);
        newParams.delete("action");
        setSearchParams(newParams);

        if (menuError) {
          alert("Cannot place order automatically: " + menuError);
        } else {
          alert(
            "Cannot place order automatically: Menu prices not loaded. Please try again manually.",
          );
        }
        return;
      }

      const newParams = new URLSearchParams(searchParams);
      newParams.delete("action");
      setSearchParams(newParams);

      // Open overlay immediately to prevent flash/gap
      setProcessOpen(true);
      handleContinue();
    }
  }, [searchParams, menuLoading, menuCatalog, menuError]);

  const handleMenuBack = useCallback(() => {
    try {
      sessionStorage.setItem(MENU_BACK_PRESERVE_KEY, "1");
    } catch {
      // Ignore sessionStorage failures.
    }
    navigate("/", { replace: true });
  }, [navigate]);

  return (
    <div
      className={`menu-root ${accessibilityMode ? "accessibility-mode" : ""}`}
    >
      {/* Background image + overlay */}
      <div
        className="background-image"
        style={{ backgroundImage: `url(${restaurantBg})` }}
      ></div>

      <div className="overlay"></div>

      <Header
        accessibilityMode={accessibilityMode}
        onBack={handleMenuBack}
        onClickCart={() => navigate("/cart")}
        cartCount={cartItemCount}
      />

      <div className="content-wrapper">
        <div className="main-container">
          <div className="panels-container">
            {/* Left Panel - Smart Serve */}
            <div className="left-panel">
              {/* Header Section with Table Info and Guest Count */}
              <div className="order-header-section">
                <div className="order-header-info">
                  <div className="order-header-badge">
                    {serviceType === "DINE_IN" ? (
                      <>
                        <span className="order-header-icon">Ã°Å¸â€œÂ</span>
                        <span>
                          {tableInfo?.number
                            ? `${t("dineIn", "Dine-In")} - ${t("table", "Table")} ${tableInfo.number}`
                            : t("dineIn", "Dine-In")}
                        </span>
                      </>
                    ) : (
                      <span>{t("takeaway", "Takeaway")}</span>
                    )}
                  </div>
                  {serviceType === "DINE_IN" && (
                    <div className="guest-count-badge">
                      <span className="guest-icon">Ã°Å¸â€˜Â¥</span>
                      <span>
                        {tableInfo?.seats || tableInfo?.capacity || 2}
                      </span>
                    </div>
                  )}
                </div>
                {/* Prominent takeaway token badge for better UX */}
                {serviceType === "TAKEAWAY" && takeawayTokenForDisplay && (
                    <span className="token-badge">
                      {t("token", "Token")}:{" "}
                      <strong>{takeawayTokenForDisplay}</strong>
                    </span>
                  )}
              </div>

              <button
                type="button"
                onClick={handleVoiceOrder}
                className={`voice-button ${recording ? "recording" : ""}`}
                aria-pressed={recording}
                aria-label={recordVoiceAria}
                disabled={menuLoading}
              >
                {recording ? <FiMicOff /> : <FiMic />}
              </button>

              <p className="instruction-text">
                {menuLoading
                  ? (t("loadingMenu", "Loading menu...") || "Loading menu...")
                  : isProcessing
                    ? processingText
                    : recording
                      ? tapToStop
                      : tapToOrder}
              </p>

              {/* Follow us entry point */}
              {!menuLoading && (
                <div className="contact-us-row" style={{ marginTop: "8px", fontSize: "13px", display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() =>
                      window.open(
                        "https://www.instagram.com/terracarts/",
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                    className="action-button"
                    style={{ minWidth: "160px", padding: "8px 14px" }}
                  >
                    Follow us
                  </button>
                </div>
              )}

              {/* Service request buttons removed from Menu UI as requested */}

              {orderText && (
                <p className="ai-ordered-text">
                  {aiOrdered}{" "}
                  <span className="order-text-italic">{orderText}</span>
                </p>
              )}

              {/* Cart Overlay Removed - using /cart page */}

              {orderStatus && (
                <div className="order-status-card">
                  <h4 className="order-summary-title">Order Status</h4>
                  {/* Show takeaway token for takeaway orders */}
                  {serviceType === "TAKEAWAY" && takeawayTokenForDisplay && (
                      <div className="mb-3 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                        <div className="text-sm font-semibold text-blue-700">
                          Your Token:{" "}
                          <span className="text-lg font-bold">
                            {takeawayTokenForDisplay}
                          </span>
                        </div>
                        <div className="text-xs text-blue-600 mt-1">
                          Please keep this token for reference
                        </div>
                      </div>
                    )}
                  <div className="order-status-section">
                    <OrderStatus
                      status={orderStatus}
                      paymentStatus={orderPaymentStatus}
                      isPaid={currentOrderDetail?.isPaid === true}
                      updatedAt={orderStatusUpdatedAt}
                      reason={
                        currentOrderDetail?.cancellationReason ||
                        previousOrderDetail?.cancellationReason
                      }
                      serviceType={serviceType}
                      tableLabel={
                        serviceType === "DINE_IN" && tableInfo?.number
                          ? `Dine-In | Table ${tableInfo.number}`
                          : null
                      }
                    />
                  </div>
                  {/*
                  {activeAssignedStaff?.name && (
                    <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg text-center">
                      <p className="text-green-800 font-medium">
                        Your order is being handled by {activeAssignedStaff.name}
                      </p>
                      {activeAssignedStaff.role && (
                        <p className="text-sm text-gray-700 mt-1">
                          Role: {activeAssignedStaff.role}
                        </p>
                      )}
                      {activeAssignedStaff.disability && (
                        <p className="text-sm text-gray-600 mt-1">
                          Disability Support: {activeAssignedStaff.disability}
                        </p>
                      )}
                    </div>
                  )}
                  */}
                  {helplineNumber && (
                    <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg text-center">
                      <p className="text-blue-800 font-medium">
                        Helpline (Manager): {helplineNumber}
                      </p>
                    </div>
                  )}
                  <div className="button-group status-actions">
                    {/* Row 1, Col 1: Cancel Order Button */}
                    {(() => {
                      const normalizedStatus = normalizeOrderStatus(orderStatus);
                      const normalizedPaymentStatus = normalizePaymentStatus(
                        orderPaymentStatus,
                        {
                          status: orderStatus,
                          isPaid: currentOrderDetail?.isPaid,
                        },
                      );
                      const isSettled = isOrderSettled({
                        status: normalizedStatus,
                        paymentStatus: normalizedPaymentStatus,
                        isPaid: currentOrderDetail?.isPaid,
                      });
                      const rawToken = String(orderStatus || "")
                        .trim()
                        .toUpperCase();
                      const isCancelledOrReturned =
                        isCancelledOrReturnedStatus(orderStatus);

                      if (
                        normalizedStatus === "SERVED" &&
                        normalizedPaymentStatus === "PAID"
                      ) {
                        return (
                          <button
                            className="reset-button return-button"
                            onClick={handleReturnOrder}
                            disabled={returning}
                          >
                            {returning ? "Processing..." : "Return Order"}
                          </button>
                        );
                      }
                      if (
                        !isCancelledOrReturned &&
                        !isSettled &&
                        normalizedStatus !== "SERVED"
                      ) {
                        return (
                          <button
                            className="reset-button cancel-button"
                            onClick={handleCancelOrder}
                            disabled={cancelling}
                          >
                            {cancelling ? "Cancelling..." : "Cancel Order"}
                          </button>
                        );
                      }
                      if (isCancelledOrReturned) {
                        return (
                          <button
                            className="billing-button billing-button-disabled"
                            disabled
                          >
                            {rawToken === "RETURNED"
                              ? "Order Returned"
                              : "Order Cancelled"}
                          </button>
                        );
                      }
                      return null;
                    })()}

                    {/* Row 1, Col 2: View Invoice Button */}
                    {orderStatus ? (
                      <button
                        className="billing-button"
                        onClick={handleViewInvoice}
                        disabled={invoiceLoading}
                      >
                        {invoiceLoading ? "Opening..." : "View Invoice"}
                      </button>
                    ) : null}

                    {/* Row 2, Col 1: Order More Button */}
                    <button
                      className="confirm-button"
                      onClick={handleOrderAgain}
                      disabled={reordering}
                    >
                      {reordering ? "Please wait..." : "Order More"}
                    </button>

                    <button
                      className="billing-button"
                      type="button"
                    onClick={() =>
                        navigate(
                          `/contact-us${contactCartId ? `?cartId=${encodeURIComponent(contactCartId)}` : ""}`,
                          {
                            state: {
                              cartId: contactCartId || null,
                              contact: cartContact || null,
                              hasCartContext,
                            },
                          },
                        )
                      }
                    >
                      {t("contactUs", "Contact us")}
                    </button>

                    {/* Row 2, Col 2: Post-settlement action */}
                    {(() => {
                      const normalizedStatus = normalizeOrderStatus(orderStatus);
                      const normalizedPaymentStatus = normalizePaymentStatus(
                        orderPaymentStatus,
                        {
                          status: orderStatus,
                          isPaid: currentOrderDetail?.isPaid,
                        },
                      );
                      const isCancelledOrReturned =
                        isCancelledOrReturnedStatus(orderStatus);
                      const isSettled = isOrderSettled({
                        status: normalizedStatus,
                        paymentStatus: normalizedPaymentStatus,
                        isPaid: currentOrderDetail?.isPaid,
                      });

                      if (!isCancelledOrReturned && !isSettled) return null;
                      if (isSettled) {
                        const orderId =
                          activeOrderId ||
                          localStorage.getItem("terra_orderId") ||
                          localStorage.getItem("terra_lastPaidOrderId");
                        if (hasSubmittedFeedbackForOrder(orderId)) {
                          return null;
                        }
                        return (
                          <button
                            className="feedback-button"
                            onClick={() => {
                              navigate("/feedback", { state: { orderId } });
                            }}
                          >
                            Share Feedback
                          </button>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </div>
              )}

              {previousOrderDetail && (
                <div
                  className="order-status-card previous-order-detail-card"
                  style={{ padding: "12px", fontSize: "0.9rem" }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "8px",
                    }}
                  >
                    <h4
                      className="order-summary-title"
                      style={{ margin: 0, fontSize: "1rem" }}
                    >
                      Last Order
                    </h4>
                    {previousOrderDetail.status && (
                      <span
                        className="meta-chip status-chip"
                        style={{ fontSize: "0.75rem", padding: "4px 8px" }}
                      >
                        {previousOrderDetail.status}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      marginBottom: "8px",
                      flexWrap: "wrap",
                      fontSize: "0.8rem",
                    }}
                  >
                    {previousDetailInvoiceId && (
                      <span
                        className="meta-chip"
                        style={{ fontSize: "0.75rem", padding: "2px 6px" }}
                      >
                        {previousDetailInvoiceId}
                      </span>
                    )}
                    {previousDetailTimestamp && (
                      <span
                        className="meta-chip"
                        style={{ fontSize: "0.75rem", padding: "2px 6px" }}
                      >
                        {previousDetailTimestamp
                          ? previousDetailTimestamp.toLocaleDateString()
                          : "N/A"}
                      </span>
                    )}
                  </div>
                  {/*
                  {previousAssignedStaff?.name && (
                    <div
                      style={{
                        marginBottom: "8px",
                        padding: "8px",
                        borderRadius: "8px",
                        background: "#ecfdf5",
                        border: "1px solid #bbf7d0",
                        fontSize: "0.8rem",
                      }}
                    >
                      <strong>Handled by:</strong> {previousAssignedStaff.name}
                      {previousAssignedStaff.role && (
                        <span> ({previousAssignedStaff.role})</span>
                      )}
                    </div>
                  )}
                  */}
                  <div style={{ marginBottom: "8px", fontSize: "0.85rem" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontWeight: "600",
                      }}
                    >
                      <span>
                        Total: {formatINR(previousDetailTotals?.totalAmount || 0)}
                      </span>
                      <span>{previousDetailTotals?.totalItems || 0} items</span>
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      className="invoice-action-btn download w-full sm:w-auto"
                      onClick={handleViewPreviousInvoice}
                      style={{
                        padding: "6px 12px",
                        fontSize: "0.85rem",
                      }}
                    >
                      View Invoice
                    </button>
                    {/* Always allow feedback for last order, regardless of final status */}
                    {previousOrderDetail._id &&
                      !hasSubmittedFeedbackForOrder(previousOrderDetail._id) && (
                      <button
                        className="feedback-button w-full sm:w-auto"
                        onClick={() => {
                          const orderId = previousOrderDetail._id;
                          navigate("/feedback", { state: { orderId } });
                        }}
                        style={{
                          backgroundColor: "#10b981",
                          color: "#ffffff",
                          border: "1px solid #059669",
                          fontWeight: "600",
                          padding: "6px 12px",
                          fontSize: "0.85rem",
                        }}
                      >
                        Feedback
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Right Panel - Manual / Menu */}
            <div className="right-panel">
              <h3 className="manual-entry-title">{menuHeading}</h3>

              {/* Search Bar */}
              <input
                type="text"
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="search-input"
              />

              {/* Filter Pills */}
              {/* Filter Pills - Commented out as per request */}
              {/* <div className="filter-pills-container">
                <button className="filter-pill veg-filter">
                  <span className="filter-icon">Ã°Å¸Å’Â¿</span>
                  <span>{t("vegOnly", "Veg Only")}</span>
                </button>
                <button className="filter-pill popular-filter">
                  <span className="filter-icon">â­</span>
                  <span>{t("popular", "Popular")}</span>

                </button>
                <button className="filter-pill spicy-filter">
                  <span className="filter-icon">Ã°Å¸Å’Â¶Ã¯Â¸Â</span>
                  <span>{t("spicy", "Spicy")}</span>
                </button>
              </div> */}

              {menuError && !menuLoading && (
                <div className="menu-warning">{menuError}</div>
              )}

              {menuLoading ? (
                <div className="menu-loading-message">
                  Loading menu, please wait...
                </div>
              ) : searchQuery.trim() ? (
                filteredItems.length > 0 ? (
                  <div className="search-results">
                    {filteredItems.map((item) => (
                      <MenuItemCard
                        key={item._id || item.name}
                        item={item}
                        onAdd={handleAdd}
                        onRemove={handleRemove}
                        count={cart[item.name] || 0}
                        translateText={translateMenuText}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="search-no-results">
                    No matching items found. Try another keyword.
                  </div>
                )
              ) : (
                <div className="category-container">
                  {menuCategories.length === 0 ? (
                    <div className="search-no-results">
                      Menu is not configured yet. Please contact the
                      administrator.
                    </div>
                  ) : (
                    <>
                      {(Array.isArray(menuCategories)
                        ? menuCategories
                        : []
                      ).map((category, index) => (
                        <MenuCategoryBlock
                          key={category?._id || category?.name || Math.random()}
                          defaultOpen={index === 0}
                          category={category?.name || "Unnamed Category"}
                          items={
                            Array.isArray(category?.items) ? category.items : []
                          }
                          cart={cart}
                          onAdd={handleAdd}
                          onRemove={handleRemove}
                          translateText={translateMenuText}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {showInvoiceModal && (
        <div className="invoice-modal-overlay" onClick={closeInvoiceModal}>
          <div
            className="invoice-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="invoice-modal-header">
              <div>
                <h3>Invoice</h3>
                {invoiceOrder && (
                  <div className="invoice-meta">
                    <span>{`Order #${invoiceOrder._id || "â€”"}`}</span>
                    {invoiceTimestamp && (
                      <span>{invoiceTimestamp.toLocaleString()}</span>
                    )}
                  </div>
                )}
              </div>
              <div className="invoice-modal-actions">
                <button
                  onClick={handleDownloadInvoice}
                  disabled={!invoiceOrder || downloadingInvoice}
                  className="invoice-action-btn download"
                >
                  {downloadingInvoice ? "Preparing..." : "Download"}
                </button>
                <button
                  onClick={closeInvoiceModal}
                  className="invoice-close-btn"
                  aria-label="Close invoice modal"
                >
                  âœ•
                </button>
              </div>
            </div>

            <div ref={invoiceRef} className="invoice-preview">
              <div className="invoice-top">
                <div>
                  <div className="brand-name">
                    {invoiceOrder?.cafe?.cafeName ||
                      invoiceOrder?.cafe?.name ||
                      "Terra Cart"}
                  </div>
                  <div className="brand-address">
                    {invoiceOrder?.cafe?.address ||
                      invoiceOrder?.franchise?.address ||
                      "â€”"}
                  </div>
                  {(invoiceOrder?.franchise?.fssaiNumber ||
                    invoiceOrder?.franchise?.fssai ||
                    invoiceOrder?.cafe?.fssaiNumber ||
                    invoiceOrder?.cafe?.fssai) && (
                    <div className="brand-address">
                      FSSAI No:{" "}
                      {invoiceOrder.franchise?.fssaiNumber ||
                        invoiceOrder.franchise?.fssai ||
                        invoiceOrder.cafe?.fssaiNumber ||
                        invoiceOrder.cafe?.fssai}
                    </div>
                  )}
                  {(invoiceOrder?.franchise?.gstNumber ||
                    invoiceOrder?.cafe?.gstNumber) && (
                    <div className="brand-address">
                      FSSAI No:{" "}
                      {invoiceOrder.franchise?.gstNumber ||
                        invoiceOrder.cafe?.gstNumber}
                    </div>
                  )}
                </div>
                <div className="invoice-meta-block">
                  <div className="meta-line">
                    <span>Invoice No:</span>
                    <span>{invoiceId || "â€”"}</span>
                  </div>
                  {invoiceOrder?.serviceType === "TAKEAWAY" &&
                    invoiceOrder?.takeawayToken && (
                      <div className="meta-line">
                        <span>Token:</span>
                        <span className="font-bold text-blue-600">
                          {invoiceOrder.takeawayToken}
                        </span>
                      </div>
                    )}
                  {invoiceTimestamp && (
                    <>
                      <div className="meta-line">
                        <span>Date:</span>
                        <span>{invoiceTimestamp.toLocaleDateString()}</span>
                      </div>
                      <div className="meta-line">
                        <span>Time:</span>
                        <span>{invoiceTimestamp.toLocaleTimeString()}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="invoice-billed">
                <div className="meta-line">
                  <span>Service:</span>
                  <span>{invoiceServiceLabel}</span>
                </div>
                <div className="meta-line">
                  <span>Table:</span>
                  <span>
                    {invoiceOrder?.serviceType === "TAKEAWAY"
                      ? "Takeaway Counter"
                      : invoiceTableNumber || "â€”"}
                    {invoiceTableName ? ` Â· ${invoiceTableName}` : ""}
                  </span>
                </div>
                {/* Customer information is optional - only show if provided */}
                {invoiceOrder?.serviceType === "TAKEAWAY" &&
                  (invoiceOrder.customerName ||
                    invoiceOrder.customerMobile) && (
                    <>
                      {invoiceOrder.customerName && (
                        <div className="meta-line">
                          <span>Customer Name:</span>
                          <span>{invoiceOrder.customerName}</span>
                        </div>
                      )}
                      {invoiceOrder.customerMobile && (
                        <div className="meta-line">
                          <span>Mobile Number:</span>
                          <span>{invoiceOrder.customerMobile}</span>
                        </div>
                      )}
                      {invoiceOrder.customerLocation?.address && (
                        <div className="meta-line">
                          <span>Address:</span>
                          <span>{invoiceOrder.customerLocation.address}</span>
                        </div>
                      )}
                    </>
                  )}

                {invoiceOrder?.specialInstructions && (
                  <div
                    className="meta-line"
                    style={{
                      marginTop: "8px",
                      borderTop: "1px dashed #e5e7eb",
                      paddingTop: "4px",
                    }}
                  >
                    <span style={{ color: "#d97706", fontWeight: "bold" }}>
                      Note:
                    </span>
                    <span style={{ fontStyle: "italic" }}>
                      {invoiceOrder.specialInstructions}
                    </span>
                  </div>
                )}
              </div>

              <table className="invoice-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Price ({INR_CURRENCY_SYMBOL})</th>
                    <th className="align-right">Amount ({INR_CURRENCY_SYMBOL})</th>
                  </tr>
                </thead>
                <tbody>
                  {invoiceItems.length > 0 ? (
                    invoiceItems.map((item) => (
                      <tr key={item.name}>
                        <td>
                          <div className="flex flex-col gap-0.5">
                            <span>{translateMenuText(item.name, "item")}</span>
                            {item.returned && (
                              <span className="invoice-returned-note">
                                Returned {item.returnedQuantity}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>{item.quantity > 0 ? item.quantity : "â€”"}</td>
                        <td>{formatINR(item.unitPrice)}</td>
                        <td className="align-right">
                          {item.quantity > 0
                            ? formatINR(item.amount)
                            : "Returned"}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="empty-row">
                        No items found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div className="invoice-totals">
                <div className="meta-line">
                  <span>Total Items</span>
                  <span>{invoiceTotals.totalItems}</span>
                </div>
                <div className="meta-line">
                  <span>Subtotal</span>
                  <span>{formatINR(invoiceTotals.subtotal)}</span>
                </div>
                {Number(invoiceTotals.officeDeliveryCharge || 0) > 0 && (
                  <div className="meta-line">
                    <span>Delivery Charge</span>
                    <span>{formatINR(invoiceTotals.officeDeliveryCharge)}</span>
                  </div>
                )}

                <div className="meta-line total">
                  <span>Total</span>
                  <span>{formatINR(invoiceTotals.totalAmount)}</span>
                </div>
              </div>

              <div className="invoice-footer">
                Thank you for dining with Terra Cart. We hope to see you again!
              </div>
            </div>
          </div>
        </div>
      )}

      {showReasonModal && (
        <div
          className="invoice-modal-overlay"
          onClick={() => setShowReasonModal(false)}
        >
          <div
            className="invoice-modal reason-modal"
            style={{ maxWidth: "24rem", maxHeight: "auto", height: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="invoice-modal-header">
              <div>
                <h3>
                  {reasonAction === "Cancel" ? "Cancel Order" : "Return Order"}
                </h3>
              </div>
              <button
                onClick={() => setShowReasonModal(false)}
                className="invoice-close-btn"
              >
                âœ•
              </button>
            </div>
            <div style={{ paddingTop: "0.25rem" }}>
              <p
                style={{
                  marginTop: 0,
                  marginBottom: "0.5rem",
                  fontSize: "0.9rem",
                  color: "#666",
                }}
              >
                Please provide a reason:
              </p>
              <textarea
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  border: "1px solid #ddd",
                  borderRadius: "0.5rem",
                  minHeight: "100px",
                  fontSize: "0.9rem",
                  marginBottom: "1rem",
                  fontFamily: "inherit",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
                placeholder="e.g. Changed my mind, Taking too long..."
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.5rem",
                }}
              >
                <button
                  className="reset-button"
                  style={{ width: "auto", flex: "1" }}
                  onClick={() => setShowReasonModal(false)}
                  disabled={submittingReason}
                >
                  Close
                </button>
                <button
                  className="confirm-button"
                  style={{ width: "auto", flex: "1" }}
                  onClick={submitReasonAction}
                  disabled={submittingReason}
                >
                  {submittingReason ? "Processing..." : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating Cart Footer - content centered so not stretched apart */}
      {Object.keys(cart).length > 0 && !showCart && (
        <div className="menu-cart-footer">
          <div className="menu-cart-footer-inner">
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontWeight: "bold",
                  fontSize: "1.1rem",
                  color: "#333",
                }}
              >
                {cartItemCount} Items
              </span>
              <span style={{ color: "#666", fontSize: "0.9rem" }}>
                Total: {formatINR(cartTotal)}
              </span>
            </div>
            <button
              onClick={() => navigate("/cart")}
              style={{
                backgroundColor: "#ff6b35",
                color: "white",
                padding: "12px 24px",
                borderRadius: "50px",
                fontWeight: "bold",
                fontSize: "1rem",
                border: "none",
                cursor: "pointer",
                boxShadow: "0 4px 6px rgba(255, 107, 53, 0.3)",
              }}
            >
              View Cart &rarr;
            </button>
          </div>
        </div>
      )}

      <ProcessOverlay
        open={processOpen}
        steps={processSteps}
        title="Processing your order"
      />
    </div>
  );
}
