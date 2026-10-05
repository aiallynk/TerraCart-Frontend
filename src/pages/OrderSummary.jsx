import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import OrderStatus from "../components/OrderStatus";
import bgImage from "../assets/images/restaurant-img.jpg";
import translations from "../data/translations/orderSummary.json";
import floatingButtonTranslations from "../data/translations/floatingButtons.json";
import { clearScopedCart } from "../utils/cartStorage";
import {
  buildSocketIdentityPayload,
  ensureAnonymousSessionId,
} from "../utils/anonymousSession";
import {
  getCustomerSocket,
  joinCustomerRoomOnce,
  safeCustomerSocketOn,
} from "../utils/socketManager";
import { notifyOrderStatusUpdate } from "../utils/orderStatusNotifications";
import { getCustomerApiOrigin } from "../utils/customerApiOrigin";
import { formatINR, INR_CURRENCY_SYMBOL } from "../utils/currency";
import "./OrderSummary.css";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

const nodeApi = getCustomerApiOrigin();

/* helpers */
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

const mergeOrderItems = (order = null) => {
  const collapsed = {};
  const kotLines = Array.isArray(order?.kotLines) ? order.kotLines : [];
  kotLines.forEach((kot) => {
    (kot?.items || []).forEach((item) => {
      if (!item) return;
      const key = item.name || "Item";
      const itemPrice = paiseToRupees(item.price || 0);
      if (!collapsed[key]) {
        collapsed[key] = {
          name: key,
          quantity: 0,
          returnedQuantity: 0,
          unitPrice: itemPrice,
          amount: 0,
          returned: false,
        };
      }
      const entry = collapsed[key];
      if (item.returned) {
        entry.returnedQuantity += Number(item.quantity) || 0;
        entry.returned = true;
      } else {
        const qty = Number(item.quantity) || 0;
        entry.quantity += qty;
        entry.amount += itemPrice * qty;
      }
      if (!entry.unitPrice && itemPrice) {
        entry.unitPrice = itemPrice;
      }
    });
  });

  // Add-ons are stored in rupees and should appear in summary + invoice
  const selectedAddons = Array.isArray(order?.selectedAddons)
    ? order.selectedAddons
    : [];
  selectedAddons.forEach((addon) => {
    if (!addon) return;
    const addonName = sanitizeAddonName(addon.name);
    const key = `addon:${addon.addonId || addon._id || addon.id || `${addonName}-${addon.price || 0}`}`;
    const qty = Number(addon.quantity) || 1;
    const addonPrice = Number(addon.price) || 0;
    if (!collapsed[key]) {
      collapsed[key] = {
        name: addonName,
        quantity: 0,
        returnedQuantity: 0,
        unitPrice: addonPrice,
        amount: 0,
        returned: false,
      };
    }
    const entry = collapsed[key];
    entry.quantity += qty;
    entry.amount += addonPrice * qty;
  });

  return Object.values(collapsed);
};

// Calculate totals from actual items, not from KOT totals (to avoid rounding errors)
const calculateTotalsFromItems = (mergedItems) => {
  // Calculate subtotal from non-returned items (amount is already in rupees)
  const subtotal = mergedItems.reduce((sum, item) => {
    const amount = Number(item.amount) || 0;
    return sum + amount;
  }, 0);

  const subtotalRounded = Number(subtotal.toFixed(2));

  // No GST calculation
  const gst = 0;

  // Total amount equals subtotal (no GST added)
  const totalAmount = subtotalRounded;

  return {
    subtotal: subtotalRounded,
    gst,
    totalAmount,
  };
};

const sumTotals = (order = null, mergedItems = null) => {
  const items = Array.isArray(mergedItems) ? mergedItems : mergeOrderItems(order);
  return calculateTotalsFromItems(items);
};

const buildInvoiceId = (order) => {
  if (!order) return "INV-NA";
  const date = new Date(order.createdAt || Date.now())
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  // Use cartId instead of order._id for invoice numbering
  const cartIdTail = (order.cartId || order._id || "").toString().slice(-6).toUpperCase();
  return `INV-${date}-${cartIdTail}`;
};


const normalizeOrderStatus = (value) => {
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
  if (token === "PAID") return "PAID";
  if (
    [
      "COMPLETED",
      "SERVED",
      "FINALIZED",
      "CANCELLED",
      "CANCELED",
      "RETURNED",
      "EXIT",
      "CLOSED",
      "REJECTED",
    ].includes(token)
  ) {
    return "SERVED";
  }
  return "PREPARING";
};

const normalizePaymentStatus = (value, { status, isPaid } = {}) => {
  const token = String(value || "").trim().toUpperCase();
  if (token === "PAID") return "PAID";
  if (isPaid === true) return "PAID";
  if (String(status || "").trim().toUpperCase() === "PAID") return "PAID";
  return "PENDING";
};

/*
const toAcceptedByFromAssignedStaff = (assignedStaff) => {
  if (!assignedStaff || !assignedStaff.id) return null;
  return {
    employeeId: assignedStaff.id,
    employeeName: assignedStaff.name || null,
    employeeRole: assignedStaff.role || null,
    disability: {
      hasDisability: Boolean(assignedStaff.disability),
      type: assignedStaff.disability || null,
    },
    acceptedAt: assignedStaff.acceptedAt || null,
  };
};
*/
const toAcceptedByFromAssignedStaff = () => null;

const resolveAssignmentDisplayType = (orderLike) => {
  const explicit = orderLike?.assignmentDisplayType;
  if (explicit === "TEAM" || explicit === "INDIVIDUAL") return explicit;

  const role = orderLike?.assignedStaff?.role || orderLike?.acceptedBy?.employeeRole;
  return String(role || "").toUpperCase() === "ADMIN" ? "TEAM" : "INDIVIDUAL";
};

export default function OrderSummary() {
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [showBill, setShowBill] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const invoiceRef = useRef(null);
  const [accessibility] = useState(
    localStorage.getItem("accessibilityMode") === "true"
  );

  const statusMessages = {
    PREPARING: "Your food is being prepared",
    READY: "Your food is ready",
    SERVED: "Order served",
    PAID: "Order paid",
    CANCELLED: "Order has been cancelled",
    RETURNED:
      "Order has been returned. Please contact staff if you need assistance.",
  };

  const language = localStorage.getItem("language") || "en";
  const t = (k) => translations[language]?.[k] || k;
  const bt =
    floatingButtonTranslations[language] || floatingButtonTranslations.en;

  // Read current order ID from localStorage (service-type aware)
  const serviceType = localStorage.getItem("terra_serviceType") || "DINE_IN";
  const orderId =
    serviceType === "TAKEAWAY"
      ? localStorage.getItem("terra_orderId_TAKEAWAY") ||
        localStorage.getItem("terra_orderId")
      : localStorage.getItem("terra_orderId_DINE_IN") ||
        localStorage.getItem("terra_orderId");

  console.log("[OrderSummary] Loading order:", {
    serviceType,
    orderId,
    fromStorage: {
      generic: localStorage.getItem("terra_orderId"),
      dineIn: localStorage.getItem("terra_orderId_DINE_IN"),
      takeaway: localStorage.getItem("terra_orderId_TAKEAWAY"),
    },
  });

  // Listen for real-time order updates
  useEffect(() => {
    if (!orderId) return;

    const persistTerminalOrderStatus = (orderData) => {
      if (!orderData?.status) return;

      const terminalServiceType =
        orderData.serviceType || localStorage.getItem("terra_serviceType") || "DINE_IN";
      const terminalStatus = orderData.status;
      const updatedAt = orderData.updatedAt || new Date().toISOString();

      localStorage.setItem("terra_orderStatus", terminalStatus);
      localStorage.setItem("terra_orderStatusUpdatedAt", updatedAt);

      if (terminalServiceType === "TAKEAWAY") {
        localStorage.setItem("terra_orderStatus_TAKEAWAY", terminalStatus);
        localStorage.setItem("terra_orderStatusUpdatedAt_TAKEAWAY", updatedAt);
        localStorage.removeItem("terra_orderId_TAKEAWAY");
      } else {
        localStorage.setItem("terra_orderStatus_DINE_IN", terminalStatus);
        localStorage.setItem("terra_orderStatusUpdatedAt_DINE_IN", updatedAt);
        localStorage.removeItem("terra_orderId_DINE_IN");
      }

      localStorage.removeItem("terra_orderId");
      clearScopedCart(terminalServiceType);
    };

    // Initial order fetch
    const fetchOrder = async () => {
      try {
        const res = await fetch(`${nodeApi}/api/orders/${orderId}`);
        if (!res.ok) {
          if (res.status === 404) {
            alert(translations[language]?.noOrderFound || "No order found");
            navigate("/menu");
            return null;
          }
          throw new Error(`Failed to fetch order: ${res.status}`);
        }
        const data = await res.json();
        if (!data) {
          alert(translations[language]?.noOrderFound || "No order found");
          return null;
        }
        const normalizedStatus = normalizeOrderStatus(data?.status);
        const normalizedPaymentStatus = normalizePaymentStatus(
          data?.paymentStatus,
          {
            status: data?.status,
            isPaid: data?.isPaid,
          },
        );
        setOrder({
          ...data,
          status: normalizedStatus,
          lifecycleStatus: normalizedStatus,
          paymentStatus: normalizedPaymentStatus,
          isPaid: normalizedPaymentStatus === "PAID",
        });

        // Keep terminal statuses visible on customer frontend
        const terminalStatus = String(data?.status || "").toUpperCase();
        if (terminalStatus === "CANCELLED" || terminalStatus === "RETURNED") {
          persistTerminalOrderStatus({ ...data, status: terminalStatus });
        }
        return data;
      } catch (err) {
        console.error("Error fetching order:", err);
        alert(translations[language]?.noOrderFound || "No order found");
        return null;
      }
    };

    // Define event handler
    const handleOrderUpdated = (updatedOrder) => {
      const expectedAnonymousSessionId = ensureAnonymousSessionId();
      if (
        updatedOrder?.anonymousSessionId &&
        expectedAnonymousSessionId &&
        updatedOrder.anonymousSessionId !== expectedAnonymousSessionId
      ) {
        return;
      }

      const payloadOrderId =
        updatedOrder?._id || updatedOrder?.id || updatedOrder?.orderId;
      if (String(payloadOrderId || "") === String(orderId || "")) {
        console.log("[OrderSummary] recv order_status_updated", {
          orderId: payloadOrderId,
          status: updatedOrder?.status || null,
          paymentStatus: updatedOrder?.paymentStatus || null,
          updatedAt: updatedOrder?.updatedAt || null,
        });

        const normalizedStatus = normalizeOrderStatus(updatedOrder?.status);
        const normalizedPaymentStatus = normalizePaymentStatus(
          updatedOrder?.paymentStatus,
          {
            status: updatedOrder?.status,
            isPaid: updatedOrder?.isPaid,
          },
        );
        const hasRichOrderShape =
          Array.isArray(updatedOrder?.kotLines) ||
          updatedOrder?.table ||
          updatedOrder?.customerName ||
          updatedOrder?.customerMobile ||
          updatedOrder?.createdAt;
        if (hasRichOrderShape) {
          setOrder({
            ...updatedOrder,
            status: normalizedStatus,
            lifecycleStatus: normalizedStatus,
            paymentStatus: normalizedPaymentStatus,
            isPaid: normalizedPaymentStatus === "PAID",
          });
        } else {
          setOrder((prev) => ({
            ...(prev || {}),
            _id: payloadOrderId || prev?._id || null,
            status: normalizedStatus || prev?.status || "NEW",
            lifecycleStatus: normalizedStatus || prev?.lifecycleStatus || "NEW",
            paymentStatus: normalizedPaymentStatus || prev?.paymentStatus || "PENDING",
            isPaid: normalizedPaymentStatus === "PAID",
            updatedAt: updatedOrder?.updatedAt || prev?.updatedAt || null,
            orderType: updatedOrder?.orderType || prev?.orderType || null,
            serviceType:
              updatedOrder?.serviceType || prev?.serviceType || null,
            cartId: updatedOrder?.cartId || prev?.cartId || null,
          }));
        }
        notifyOrderStatusUpdate({
          orderId: payloadOrderId || orderId,
          status: normalizedStatus,
          paymentStatus: normalizedPaymentStatus,
          serviceType: updatedOrder?.serviceType || "DINE_IN",
        });

        // Handle cancellation / return
        const terminalStatus = String(updatedOrder?.status || "").toUpperCase();
        if (terminalStatus === "CANCELLED" || terminalStatus === "RETURNED") {
          persistTerminalOrderStatus({
            ...updatedOrder,
            status: terminalStatus,
          });
        }
      }
    };

    // Create socket connection for order updates (only when needed)
    let orderSocket = null;
    let joinedCartId = null;
    let joinedAnonymousSessionId = null;
    ensureAnonymousSessionId();
    const normalizeCartId = (value) => {
      if (value == null) return null;
      if (typeof value === "string") return value;
      if (typeof value === "object" && value._id) return String(value._id);
      return String(value);
    };
    const joinCartRoom = (cartId) => {
      if (!orderSocket) return;
      const normalized = normalizeCartId(cartId);
      if (!normalized || normalized === joinedCartId) return;
      joinCustomerRoomOnce("join:cart", normalized);
      joinedCartId = normalized;
      if (import.meta.env.DEV) {
        console.log("[OrderSummary] Joined cart room:", normalized);
      }
    };
    const joinIdentityRoom = () => {
      if (!orderSocket) return;
      const identityPayload = buildSocketIdentityPayload();
      if (!identityPayload?.anonymousSessionId) return;
      if (joinedAnonymousSessionId === identityPayload.anonymousSessionId) {
        return;
      }
      joinCustomerRoomOnce("join_room", identityPayload);
      joinedAnonymousSessionId = identityPayload.anonymousSessionId;
      if (import.meta.env.DEV) {
        console.log(
          "[OrderSummary] Joined identity room:",
          identityPayload.anonymousSessionId
        );
      }
    };
    const getFallbackCartId = () => {
      const takeawayCartId = localStorage.getItem("terra_takeaway_cartId");
      if (takeawayCartId) return takeawayCartId;
      try {
        const tableSelection = JSON.parse(
          localStorage.getItem("terra_selectedTable") || "{}",
        );
        return (
          tableSelection?.cartId?._id ||
          tableSelection?.cartId ||
          tableSelection?.cafeId?._id ||
          tableSelection?.cafeId ||
          null
        );
      } catch {
        return null;
      }
    };
    const handleSocketConnected = () => {
      joinedAnonymousSessionId = null;
      joinIdentityRoom();
      joinCartRoom(getFallbackCartId());
      fetchOrder().then((orderData) => {
        if (orderData?.cartId) {
          joinCartRoom(orderData.cartId);
        }
      });
    };

    const handleSocketReconnect = () => {
      joinedCartId = null;
      joinedAnonymousSessionId = null;
      joinIdentityRoom();
      joinCartRoom(getFallbackCartId());
      fetchOrder().then((orderData) => {
        if (orderData?.cartId) {
          joinCartRoom(orderData.cartId);
        }
      });
    };

    const handleSocketConnectError = (error) => {
      if (error.message && !error.message.includes("xhr poll error")) {
        console.warn(
          "[OrderSummary] Socket connection error:",
          error.message
        );
      }
    };

    try {
      orderSocket = getCustomerSocket();

      safeCustomerSocketOn("connect", handleSocketConnected);
      safeCustomerSocketOn("reconnect", handleSocketReconnect);

      // Fetch order and join cart room for real-time status updates
      fetchOrder().then((orderData) => {
        if (orderData?.cartId) {
          joinCartRoom(orderData.cartId);
        }
      });

      safeCustomerSocketOn("connect_error", handleSocketConnectError);
      safeCustomerSocketOn("order.updated", handleOrderUpdated);
      safeCustomerSocketOn("order_status_updated", handleOrderUpdated);
    } catch (err) {
      console.warn("[OrderSummary] Failed to create socket connection:", err);
    }

    // Cleanup: remove listeners only, keep shared socket connected.
    return () => {
      if (orderSocket) {
        orderSocket.off("order.updated", handleOrderUpdated);
        orderSocket.off("order_status_updated", handleOrderUpdated);
        orderSocket.off("connect", handleSocketConnected);
        orderSocket.off("reconnect", handleSocketReconnect);
        orderSocket.off("connect_error", handleSocketConnectError);
        orderSocket = null;
      }
    };
  }, [orderId, language, navigate]);

  if (!order) {
    return (
      <div className="order-summary-page loading-screen">{t("loading")}</div>
    );
  }

  const combinedItems = mergeOrderItems(order);
  const rawStatusToken = String(order.status || "").trim().toUpperCase();
  const isCancelledOrReturned =
    rawStatusToken === "CANCELLED" ||
    rawStatusToken === "CANCELED" ||
    rawStatusToken === "RETURNED";
  const displayStatus = isCancelledOrReturned
    ? rawStatusToken === "CANCELED"
      ? "CANCELLED"
      : rawStatusToken
    : normalizeOrderStatus(order.status);
  const totals = sumTotals(order, combinedItems);
  const totalQty = combinedItems.reduce((n, i) => n + i.quantity, 0);
  const isTakeaway = order.serviceType === "TAKEAWAY";
  const baseTableNumber = order.table?.number ?? order.tableNumber ?? "—";
  const tableName = order.table?.name;
  const serviceValue = isTakeaway ? t("takeawayLabel") : t("dineInLabel");
  const invoiceId = buildInvoiceId(order);
  const assignmentDisplayType = resolveAssignmentDisplayType(order);
  const showTeamAssignmentMessage = assignmentDisplayType === "TEAM";
  /*
  const acceptedStaffName =
    order.acceptedBy?.employeeName || order.assignedStaff?.name;
  const acceptedStaffRole =
    order.assignedStaff?.role || order.acceptedBy?.employeeRole;
  const disabilitySupport =
    order.acceptedBy?.disability?.type || order.assignedStaff?.disability;
  */
  const acceptedStaffName = null;
  const acceptedStaffRole = null;
  const disabilitySupport = null;
  const helplineNumber =
    order.cafe?.managerHelplineNumber ||
    order.cafe?.phone ||
    order.cafe?.primaryEmergencyContact?.phone ||
    null;
  const terminalReason =
    typeof order.cancellationReason === "string"
      ? order.cancellationReason.trim()
      : "";

  const handlePrintInvoice = () => {
    if (!invoiceRef.current || printing) return;
    setPrinting(true);
    
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
      iframe.setAttribute("sandbox", "allow-same-origin allow-scripts allow-modals");
      
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow?.document;
      
      if (!doc) {
        setPrinting(false);
        alert("Print preview failed to open. Please check your browser settings.");
        return;
      }
      
      doc.open();
      doc.write(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${invoiceId}</title>
            <style>
              * { box-sizing: border-box; }
              @media print {
                @page {
                  size: 80mm auto;
                  margin: 0;
                }
                body {
                  margin: 0;
                  padding: 0;
                }
              }
              body {
                font-family: 'Courier New', monospace;
                margin: 0;
                padding: 8px;
                background: #ffffff;
                color: #000;
                width: 80mm;
                max-width: 302px;
                font-size: 11px;
              }
              h1, h2, h3, h4 { margin: 0; }
              table { border-collapse: collapse; width: 100%; font-size: 9px; }
              th, td { padding: 3px 2px; border-bottom: 1px dashed #000; }
              th { text-align: left; color: #000; font-weight: 600; font-size: 9px; }
              .invoice-shell {
                width: 80mm;
                max-width: 302px;
                margin: 0 auto;
                padding: 8px;
              }
              .invoice-flex {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
              }
              .invoice-flex + .invoice-flex {
                margin-top: 8px;
              }
              .totals-row {
                display: flex;
                justify-content: space-between;
                margin-top: 4px;
                font-size: 10px;
              }
              .totals-row:last-child {
                font-weight: 700;
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
            alert("Print failed. Please try using your browser's print function (Ctrl+P).");
          } finally {
            // Clean up after print dialog closes or fails
            setTimeout(() => {
              if (document.body.contains(iframe)) {
                document.body.removeChild(iframe);
              }
              setPrinting(false);
            }, 500);
          }
        }, 250); // Increased timeout for production
      };
      
      // Fallback timeout in case onload never fires
      setTimeout(() => {
        if (printing && document.body.contains(iframe)) {
          document.body.removeChild(iframe);
          setPrinting(false);
          console.warn("Print timeout - iframe failed to load");
        }
      }, 5000);
      
    } catch (error) {
      console.error("Print setup failed:", error);
      setPrinting(false);
      alert("Failed to initialize print. Please try again or use Ctrl+P.");
    }
  };

  const handleDownloadInvoice = async () => {
    if (!invoiceRef.current || downloading) return;
    setDownloading(true);
    try {
      const canvas = await html2canvas(invoiceRef.current, {
        scale: 2, // Fixed scale for consistency
        useCORS: true,
        logging: false, // Disable verbose logging
        backgroundColor: "#ffffff",
        // Handle unsupported color functions like oklch()
        onclone: (clonedDoc) => {
          // Convert any oklch() colors to fallback colors
          const allElements = clonedDoc.querySelectorAll('*');
          allElements.forEach((el) => {
            const computedStyle = window.getComputedStyle(el);
            // Check for oklch in various properties
            ['color', 'backgroundColor', 'borderColor'].forEach((prop) => {
              const value = computedStyle[prop];
              if (value && value.includes('oklch')) {
                // Set a fallback color
                el.style[prop] = '#000000'; // Default to black for text
                if (prop === 'backgroundColor') {
                  el.style[prop] = 'transparent';
                }
              }
            });
          });
        }
      });
      
      const imgData = canvas.toDataURL("image/png");
      
      // Calculate dimensions
      // PDF Width = 80mm
      const pdfWidth = 80;
      const margin = 4;
      const usableWidth = pdfWidth - (margin * 2);
      
      // Calculate corresponding height keeping aspect ratio
      const imgWidthPx = canvas.width;
      const imgHeightPx = canvas.height;
      const ratio = imgHeightPx / imgWidthPx;
      const pdfHeight = (usableWidth * ratio) + (margin * 2); // Add margins to height too
      
      // Initialize jsPDF with calculated height
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: [pdfWidth, pdfHeight],
      });
      
      // Add image
      pdf.addImage(imgData, "PNG", margin, margin, usableWidth, usableWidth * ratio);
      
      pdf.save(`${invoiceId}.pdf`);
    } catch (err) {
      console.error("Invoice download failed (Detailed):", err);
      alert(`Failed to generate PDF: ${err.message || "Unknown error"}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className={`order-summary-page ${accessibility ? "accessibility" : ""}`}
    >
      <div className="background-container">
        <img
          src={bgImage}
          alt={t("restaurantName")}
          className="background-image"
        />
        <div className="background-overlay" />
      </div>

      <div className="content-wrapper">
        <Header />

        <div className="main-content">
          <div className="summary-card">
            <h2 className="summary-title">{t("orderSummary")}</h2>

            <div className="order-meta">
              <div className="order-meta-row">
                <span>{t("orderId")}</span>
                <span>{order._id || "—"}</span>
              </div>
              {isTakeaway && order.takeawayToken && (
                <div
                  className="order-meta-row"
                  style={{
                    backgroundColor: "#dbeafe",
                    padding: "8px",
                    borderRadius: "8px",
                    marginBottom: "8px",
                  }}
                >
                  <span style={{ fontWeight: "600", color: "#1e40af" }}>
                    Token:
                  </span>
                  <span
                    style={{
                      fontSize: "1.2em",
                      fontWeight: "bold",
                      color: "#2563eb",
                    }}
                  >
                    {order.takeawayToken}
                  </span>
                </div>
              )}
              {/* Service type label - only show for dine-in orders */}
              {!isTakeaway && (
                <div className="order-meta-row">
                  <span>{t("serviceTypeLabel")}</span>
                  <span>{serviceValue}</span>
                </div>
              )}
              {!isTakeaway && (
                <div className="order-meta-row">
                  <span>{t("tableLabel")}</span>
                  <span>
                    {baseTableNumber}
                    {tableName ? ` · ${tableName}` : ""}
                  </span>
                </div>
              )}
              {/* Customer information for takeaway orders */}
              {isTakeaway && (order.customerName || order.customerMobile) && (
                <>
                  {order.customerName && (
                    <div className="order-meta-row">
                      <span>Customer Name:</span>
                      <span>{order.customerName}</span>
                    </div>
                  )}
                  {order.customerMobile && (
                    <div className="order-meta-row">
                      <span>Mobile:</span>
                      <span>{order.customerMobile}</span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Order Status */}
            <div className="mb-6">
              <OrderStatus
                status={order.status}
                paymentStatus={order.paymentStatus}
                isPaid={order.isPaid}
                updatedAt={order.updatedAt}
                reason={terminalReason}
                className="mb-2"
              />
              <p className="text-lg text-center font-medium text-gray-700">
                {statusMessages[displayStatus] ||
                  statusMessages.CANCELLED}
              </p>
              {order.isPaid === true && displayStatus !== "PAID" && (
                <p className="text-sm text-center text-green-700 mt-1">
                  Payment already received
                </p>
              )}
              {terminalReason && (
                <p className="text-sm text-center text-gray-600 mt-1">
                  Reason: {terminalReason}
                </p>
              )}
              {/*
              {showTeamAssignmentMessage && (
                <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg text-center">
                  <p className="text-green-800 font-medium">
                    Your order has been confirmed and is being prepared by our team.
                  </p>
                </div>
              )}
              {!showTeamAssignmentMessage && acceptedStaffName && (
                <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg text-center">
                  <p className="text-green-800 font-medium">
                    Your order has been accepted by {acceptedStaffName}
                  </p>
                  {acceptedStaffRole && (
                    <p className="text-sm text-gray-700 mt-1">
                      Role: {acceptedStaffRole}
                    </p>
                  )}
                  {disabilitySupport && (
                    <p className="text-sm text-gray-600 mt-1">
                      Your server has indicated: {disabilitySupport}
                    </p>
                  )}
                  {helplineNumber && (
                    <p className="text-sm text-blue-700 mt-1">
                      Helpline (Manager): {helplineNumber}
                    </p>
                  )}
                </div>
              )}
              */}
            </div>

            <div className="items-list">
              {combinedItems.map((it) => {
                const unitPrice = Number(it.unitPrice) || 0;
                const amount =
                  Number(it.amount) || unitPrice * (Number(it.quantity) || 0);
                return (
                  <div key={it.name} className="item-row">
                    <span className="flex flex-wrap items-center gap-2">
                      <span>
                        {it.name}
                        {it.quantity > 0 ? ` × ${it.quantity}` : ""}
                      </span>
                      {it.returned && (
                        <span className="meta-chip returned-chip">
                          Returned {it.returnedQuantity}
                        </span>
                      )}
                    </span>
                    <span>
                      {it.quantity > 0 ? formatINR(amount) : "Returned"}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="summary-totals">
              <div className="total-row">
                <span>{t("totalItems")}</span>
                <span>{totalQty}</span>
              </div>
              <div className="total-row">
                <span>{t("subtotal")}</span>
                <span>{formatINR(totals.subtotal)}</span>
              </div>

              <div className="total-row total-bold">
                <span>{t("total")}</span>
                <span>{formatINR(totals.totalAmount)}</span>
              </div>
            </div>

            <div className="buttons-row">
              {/* Confirm order and go back to menu */}
              <button onClick={() => navigate("/menu")} className="primary-btn">
                {t("confirmOrder")}
              </button>
              <button
                onClick={() => setShowBill(true)}
                className="secondary-btn"
              >
                {t("viewBill")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Bill Popup Modal */}
      {showBill && (
        <div className="bill-modal-overlay">
          <div className="bill-modal">
            <div className="bill-modal-header">
              <div>
                <h3>Invoice</h3>
                <p className="invoice-meta">
                  <span>
                    {t("orderId")} {order._id}
                  </span>
                  <span>{new Date(order.createdAt).toLocaleString()}</span>
                </p>
              </div>
              <div className="bill-modal-actions">
                <button
                  onClick={handleDownloadInvoice}
                  disabled={downloading}
                  className="invoice-action-btn download"
                >
                  {downloading ? "Preparing…" : "Download"}
                </button>
                <button
                  onClick={() => setShowBill(false)}
                  className="invoice-close-btn"
                >
                  ✕
                </button>
              </div>
            </div>

            <div ref={invoiceRef} className="invoice-preview">
              <div className="invoice-top">
                <div>
                  <div className="brand-name">
                    {order.cafe?.cafeName || order.cafe?.name || "Terra Cart"}
                  </div>
                  <div className="brand-address">
                    {order.cafe?.address ||
                      order.franchise?.address ||
                      "—"}
                  </div>
                  {(order.franchise?.fssaiNumber ||
                    order.franchise?.fssai ||
                    order.cafe?.fssaiNumber ||
                    order.cafe?.fssai) && (
                    <div className="brand-address">
                      FSSAI No:{" "}
                      {order.franchise?.fssaiNumber ||
                        order.franchise?.fssai ||
                        order.cafe?.fssaiNumber ||
                        order.cafe?.fssai}
                    </div>
                  )}
                  {(order.franchise?.gstNumber || order.cafe?.gstNumber) && (
                    <div className="brand-address">
                      FSSAI No:{" "}
                      {order.franchise?.gstNumber || order.cafe?.gstNumber}
                    </div>
                  )}
                </div>
                <div className="invoice-meta-block">
                  <div className="meta-line">
                    <span>Invoice No:</span>
                    <span>{invoiceId}</span>
                  </div>
                  {isTakeaway && order.takeawayToken && (
                    <div className="meta-line">
                      <span>Token:</span>
                      <span className="font-bold text-blue-600">
                        {order.takeawayToken}
                      </span>
                    </div>
                  )}
                  <div className="meta-line">
                    <span>Date:</span>
                    <span>
                      {new Date(
                        order.paidAt || order.updatedAt || order.createdAt
                      ).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="meta-line">
                    <span>Time:</span>
                    <span>
                      {new Date(
                        order.paidAt || order.updatedAt || order.createdAt
                      ).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </div>

              <div className="invoice-billed">
                {/* Service type label - only show for dine-in invoices */}
                {!isTakeaway && (
                  <div className="meta-line">
                    <span>{t("serviceTypeLabel")}:</span>
                    <span>{serviceValue}</span>
                  </div>
                )}
                {/* Show table only for dine-in invoices */}
                {!isTakeaway && (
                  <div className="meta-line">
                    <span>{t("tableLabel")}:</span>
                    <span>
                      {baseTableNumber}
                      {tableName ? ` · ${tableName}` : ""}
                    </span>
                  </div>
                )}
                {/* Customer information is optional - only show if provided (takeaway only) */}
                {isTakeaway && (order.customerName || order.customerMobile) && (
                  <>
                    {order.customerName && (
                      <div className="meta-line">
                        <span>Customer Name:</span>
                        <span>{order.customerName}</span>
                      </div>
                    )}
                    {order.customerMobile && (
                      <div className="meta-line">
                        <span>Mobile Number:</span>
                        <span>{order.customerMobile}</span>
                      </div>
                    )}
                  </>
                )}
              </div>

              <table className="invoice-table">
                <thead>
                  <tr>
                    <th>{t("itemHeader") || "Item"}</th>
                    <th>{t("quantityHeader") || "Qty"}</th>
                    <th>{t("priceHeader") || `Price (${INR_CURRENCY_SYMBOL})`}</th>
                    <th className="align-right">
                      {t("amountHeader") || `Amount (${INR_CURRENCY_SYMBOL})`}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {combinedItems.length > 0 ? (
                    combinedItems.map((it) => {
                      const unitPrice = Number(it.unitPrice) || 0;
                      const amount =
                        Number(it.amount) ||
                        unitPrice * (Number(it.quantity) || 0);
                      return (
                        <tr key={it.name}>
                          <td>
                            <div className="flex flex-col gap-0.5">
                              <span>{it.name}</span>
                              {it.returned && (
                                <span className="invoice-returned-note">
                                  Returned {it.returnedQuantity}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>{it.quantity > 0 ? it.quantity : "—"}</td>
                          <td>{formatINR(unitPrice)}</td>
                          <td className="align-right">
                            {it.quantity > 0
                              ? formatINR(amount)
                              : "Returned"}
                          </td>
                        </tr>
                      );
                    })
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
                  <span>{t("totalItems")}</span>
                  <span>{totalQty}</span>
                </div>
                <div className="meta-line">
                  <span>{t("subtotal")}</span>
                  <span>{formatINR(totals.subtotal)}</span>
                </div>

                <div className="meta-line total">
                  <span>{t("total")}</span>
                  <span>{formatINR(totals.totalAmount)}</span>
                </div>
              </div>

              <div className="invoice-footer">
                Thank you for dining with Terra Cart. We hope to see you again!
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
