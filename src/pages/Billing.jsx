import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FiEye } from "react-icons/fi";
import Header from "../components/Header";
import restaurantBg from "../assets/images/restaurant-img.jpg";
import translations from "../data/translations/billing.json";
import FloatingPDFButton from "../components/FloatingPDFButton";
import FloatingSignLanguageButton from "../components/FloatingSignLanguageButton";
import floatingButtonTranslations from "../data/translations/floatingButtons.json";
import { getCustomerApiOrigin } from "../utils/customerApiOrigin";
import { formatINR } from "../utils/currency";
import "./Billing.css";

const nodeApi = getCustomerApiOrigin();
const TAKEAWAY_LIKE_SERVICE_TYPES = ["TAKEAWAY", "PICKUP", "DELIVERY"];
const isTakeawayLikeServiceType = (value) =>
  TAKEAWAY_LIKE_SERVICE_TYPES.includes(
    String(value || "DINE_IN")
      .trim()
      .toUpperCase(),
  );

// Convert paise to rupees
const paiseToRupees = (paise) => {
  if (paise === undefined || paise === null) return 0;
  const num = Number(paise);
  if (Number.isNaN(num)) return 0;
  return num / 100;
};

const sanitizeAddonName = (value) => {
  const normalized = String(value || "")
    .replace(/^\(\s*\+\s*\)\s*/u, "")
    .trim();
  return normalized || "Add-on";
};

/* helpers to combine all KOTs (kotLines + selected add-ons) */
function mergeKotLines(kotLines = [], selectedAddons = []) {
  const collapsed = {};
  kotLines.forEach((kot) => {
    (kot?.items || []).forEach((item) => {
      if (!item) return;
      const key = item.name || "Item";
      if (!collapsed[key]) {
        collapsed[key] = {
          name: key,
          quantity: 0,
          returnedQuantity: 0,
          price: item.price || 0, // Price in paise
          returned: false,
        };
      }
      const entry = collapsed[key];
      if (item.returned) {
        entry.returnedQuantity += Number(item.quantity) || 0;
        entry.returned = true;
      } else {
        entry.quantity += Number(item.quantity) || 0;
      }
      if (!entry.price && item.price) {
        entry.price = item.price;
      }
    });
  });

  (selectedAddons || []).forEach((addon) => {
    if (!addon) return;
    const addonName = sanitizeAddonName(addon.name);
    const addonPriceInPaise = Math.round((Number(addon.price) || 0) * 100);
    const qtyValue = Number(addon.quantity);
    const addonQuantity =
      Number.isFinite(qtyValue) && qtyValue > 0 ? Math.floor(qtyValue) : 1;
    const addonId =
      addon.addonId ||
      addon._id ||
      addon.id ||
      `${addonName}-${addonPriceInPaise}`;
    const key = `addon:${addonId}`;

    if (!collapsed[key]) {
      collapsed[key] = {
        name: `+ ${addonName}`,
        quantity: 0,
        returnedQuantity: 0,
        price: addonPriceInPaise, // Stored in paise for a single add-on
        returned: false,
        isAddon: true,
      };
    }

    const entry = collapsed[key];
    entry.quantity += addonQuantity;
    if (!entry.price && addonPriceInPaise) {
      entry.price = addonPriceInPaise;
    }
  });

  return Object.values(collapsed);
}

// Calculate totals from actual items, not from KOT totals (to avoid rounding errors)
function calculateTotalsFromItems(mergedItems) {
  // Calculate subtotal from non-returned items (price is in paise)
  const subtotalInPaise = mergedItems.reduce((sum, item) => {
    const priceInPaise = Number(item.price) || 0;
    const quantity = Number(item.quantity) || 0;
    return sum + priceInPaise * quantity;
  }, 0);

  // Convert to rupees and round to 2 decimal places
  const subtotal = Number((subtotalInPaise / 100).toFixed(2));

  // No GST calculation
  const gst = 0;

  // Total amount equals subtotal (no GST added)
  const totalAmount = subtotal;

  return {
    subtotal,

    totalAmount,
  };
}

function sumTotals(kotLines = [], selectedAddons = []) {
  // Merge all items from all KOTs
  const mergedItems = mergeKotLines(kotLines, selectedAddons);

  // Calculate totals from actual items
  return calculateTotalsFromItems(mergedItems);
}

export default function Billing() {
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [accessibilityMode, setAccessibilityMode] = useState(
    localStorage.getItem("accessibilityMode") === "true",
  );
  const [activeModal, setActiveModal] = useState(null);

  // Language + translations
  const language = localStorage.getItem("language") || "en";
  const t = (key) => translations[language]?.[key] || key;
  const floatingButtonT =
    floatingButtonTranslations[language] || floatingButtonTranslations.en;

  const toggleAccessibility = () => {
    const newMode = !accessibilityMode;
    setAccessibilityMode(newMode);
    localStorage.setItem("accessibilityMode", newMode.toString());
  };

  // Load current order by id (service-type aware)
  useEffect(() => {
    const serviceType = localStorage.getItem("terra_serviceType") || "DINE_IN";
    const isTakeawayFlow = isTakeawayLikeServiceType(serviceType);
    const orderId =
      isTakeawayFlow
        ? localStorage.getItem("terra_orderId_TAKEAWAY") ||
          localStorage.getItem("terra_orderId")
        : localStorage.getItem("terra_orderId_DINE_IN") ||
          localStorage.getItem("terra_orderId");
    if (!orderId) {
      setOrder(null);
      setError(t("noOrderFound") || "No active order.");
      setLoading(false);
      return;
    }

    let cancelled = false;
    const loadOrder = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${nodeApi}/api/orders/${orderId}`);
        if (!res.ok) {
          throw new Error("Failed to fetch order");
        }
        const data = await res.json();
        if (!cancelled) {
          setOrder(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(t("fetchFailed") || err.message || "Unable to load order.");
          setOrder(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadOrder();

    return () => {
      cancelled = true;
    };
    // We intentionally depend only on language; t() references the same data for a given language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // Finalize the order on proceed to pay
  const handleProceedToPay = () => {
    const serviceType = localStorage.getItem("terra_serviceType") || "DINE_IN";
    const isTakeawayFlow = isTakeawayLikeServiceType(serviceType);
    const orderId =
      isTakeawayFlow
        ? localStorage.getItem("terra_orderId_TAKEAWAY") ||
          localStorage.getItem("terra_orderId")
        : localStorage.getItem("terra_orderId_DINE_IN") ||
          localStorage.getItem("terra_orderId");
    if (!orderId) {
      alert(t("noOrderFound") || "No order found");
      return;
    }

    if (order?.status === "Paid") {
      alert(t("paymentCompleted") || "Payment already completed.");
      navigate("/payment");
      return;
    }

    navigate("/payment");
  };

  if (loading) {
    return (
      <div className="loading-container">
        <p>{t("loading")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="loading-container">
        <p>{error}</p>
        <button className="proceed-button" onClick={() => navigate("/menu")}>
          {t("returnToMenu") || "Back to menu"}
        </button>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="loading-container">
        <p>{t("noOrderFound") || "No active order."}</p>
        <button className="proceed-button" onClick={() => navigate("/menu")}>
          {t("returnToMenu") || "Back to menu"}
        </button>
      </div>
    );
  }

  // Derive combined items and totals from all kotLines
  // Derive combined items and totals from all kotLines
  const items = mergeKotLines(
    order.kotLines || [],
    order.selectedAddons || [],
  );
  const totals = sumTotals(order.kotLines || [], order.selectedAddons || []);
  const isTakeaway = isTakeawayLikeServiceType(order.serviceType);
  const baseTableNumber = order.table?.number ?? order.tableNumber ?? "—";
  const tableName = order.table?.name;

  return (
    <div
      className={`billing-container ${
        accessibilityMode ? "accessibility-mode" : ""
      }`}
    >
      {/* Background Image */}
      <div className="background-container">
        <img
          src={restaurantBg}
          alt={t("restaurantName")}
          className={`background-image ${
            accessibilityMode ? "accessibility-mode" : ""
          }`}
        />
        <div
          className={`background-overlay ${
            accessibilityMode ? "accessibility-mode" : ""
          }`}
        />
      </div>

      {/* Accessibility Toggle (optional)
      <button
        onClick={toggleAccessibility}
        className={`accessibility-toggle ${accessibilityMode ? "accessibility-mode" : ""}`}
        title="Toggle Accessibility Mode"
      >
        <FiEye size={24} />
      </button>
      */}

      {/* Header */}
      <Header />

      {/* Content */}
      <div className="content-wrapper">
        <div
          className={`billing-card ${
            accessibilityMode ? "accessibility-mode" : ""
          }`}
        >
          {/* Cafe Title */}
          <h1 className="restaurant-title">{t("restaurantName")}</h1>

          {/* Order ID */}
          <h2 className="order-info">
            {t("orderId")}:{" "}
            {order._id ||
              order.id ||
              localStorage.getItem("terra_orderId") ||
              "N/A"}
          </h2>

          {/* Takeaway Token */}
          {isTakeaway && order.takeawayToken && (
            <div
              className="order-info"
              style={{ marginTop: "8px", marginBottom: "8px" }}
            >
              <span style={{ fontWeight: "600", color: "#2563eb" }}>
                Token:{" "}
                <span style={{ fontSize: "1.2em" }}>{order.takeawayToken}</span>
              </span>
            </div>
          )}

          {/* Table Info */}
          <div className="table-info">
            <span>
              {t("serviceType")}: {isTakeaway ? t("takeaway") : t("dineIn")}
            </span>
            {!isTakeaway && (
              <span>
                {t("table")}: {baseTableNumber}
                {tableName ? ` · ${tableName}` : ""}
              </span>
            )}
            {/* Customer information for takeaway orders */}
            {isTakeaway && (order.customerName || order.customerMobile) && (
              <>
                {order.customerName && <span>Name: {order.customerName}</span>}
                {order.customerMobile && (
                  <span>Mobile: {order.customerMobile}</span>
                )}
              </>
            )}
          </div>

          {/* Order Items (all KOTs merged) */}
          <div className="order-items">
            {items.length === 0 ? (
              <div className="order-item empty-state">
                {t("noItems") || "No items on thiis order yet."}
              </div>
            ) : (
              items.map((item, idx) => (
                <div key={idx} className="order-item">
                  <span>
                    {item.name} × {item.quantity}
                  </span>
                  <span>{formatINR(((item.price || 0) / 100) * (item.quantity || 0))}</span>
                </div>
              ))
            )}
          </div>

          {/* Totals (sum of all KOTs) */}
          <div
            className={`totals-section ${
              accessibilityMode ? "accessibility-mode" : ""
            }`}
          >
            <div className="total-row subtotal">
              <span>{t("subtotal")}</span>
              <span>{formatINR(totals.subtotal)}</span>
            </div>

            <div className="total-row final-total">
              <span>{t("total")}</span>
              <span>{formatINR(totals.totalAmount)}</span>
            </div>
          </div>

          {/* Proceed Button */}
          <button
            onClick={handleProceedToPay}
            className={`proceed-button ${
              accessibilityMode ? "accessibility-mode" : ""
            }`}
          >
            {t("proceedToPay")}
          </button>
        </div>
      </div>

      {/* Floating Buttons */}
      {/* 
      <FloatingPDFButton
        accessibilityMode={accessibilityMode}
        activeModal={activeModal}
        setActiveModal={setActiveModal}
        translations={floatingButtonT}
      />

      <FloatingSignLanguageButton
        accessibilityMode={accessibilityMode}
        setAccessibilityMode={setAccessibilityMode}
        activeModal={activeModal}
        setActiveModal={setActiveModal}
        translations={floatingButtonT}
      />
      */}
    </div>
  );
}
