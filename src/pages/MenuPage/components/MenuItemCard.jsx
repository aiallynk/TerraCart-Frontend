import { motion } from "framer-motion";
import { getImageUrl, getSpiceLevelValue } from "../menuHelpers.js";
import { SPICE_LEVEL_LABELS } from "../menuConstants.js";
import { formatINR } from "../../../utils/currency";

/** Presentational menu tile (formerly TranslatedItem). */
export function MenuItemCard({
  item,
  onAdd,
  onRemove,
  count,
  translateText,
}) {
  if (!item) return null;
  const translatedName =
    typeof translateText === "function"
      ? translateText(item?.name || "", "item")
      : item?.name || "";
  const isAvailable = item.isAvailable !== false;
  const isSpecial = item?.isFeatured === true;
  const spiceLevel = getSpiceLevelValue(item);
  const spiceLabel = spiceLevel ? SPICE_LEVEL_LABELS[spiceLevel] : "";

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5 }}
      className={`item-card group ${!isAvailable ? "unavailable" : ""}`}
    >
      <div className="item-image-container">
        <img
          src={getImageUrl(item?.image)}
          alt={item?.name || "Menu item"}
          className="item-image"
        />
        {isSpecial && (
          <span className="special-corner-badge" aria-label="Special item">
            Special
          </span>
        )}
      </div>

      <div className="item-info-section">
        <h4 className="item-name">
          {translatedName || item?.name || "Unnamed Item"}
        </h4>
        <div className="item-price-row">
          <p className="item-price">{formatINR(item?.price)}</p>
          {spiceLevel && (
            <span
              className={`item-spice-badge spice-${spiceLevel.toLowerCase()}`}
              title={`Spice level: ${spiceLabel} Spicy`}
            >
              <span className="item-spice-primary">{spiceLabel}</span>
              <span className="item-spice-secondary">Spicy</span>
            </span>
          )}
        </div>
        {!isAvailable && (
          <div className="item-meta-row">
            <span className="item-status-badge unavailable">Not available</span>
          </div>
        )}
      </div>

      <div className="item-footer">
        <div className="item-controls">
          <button
            aria-label={`Remove one ${item?.name || "item"}`}
            className="quantity-button"
            onClick={() => item?.name && onRemove(item.name)}
            disabled={!count}
          >
            -
          </button>

          <span className="item-count">{count || 0}</span>

          <button
            aria-label={`Add one ${item?.name || "item"}`}
            className={`quantity-button ${!isAvailable ? "disabled" : ""}`}
            onClick={() => item && onAdd(item)}
            disabled={!isAvailable}
            title={!isAvailable ? "Currently unavailable" : undefined}
          >
            +
          </button>
        </div>
      </div>
    </motion.div>
  );
}
