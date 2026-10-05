import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import "./ProcessOverlay.css";

export default function ProcessOverlay({ open, title = "Processing your order", steps = [] }) {
  // Announce updates to screen readers
  useEffect(() => {
    // no-op; component re-render announces via aria-live
  }, [steps]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="process-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          aria-live="polite"
          aria-atomic="true"
        >
          <motion.div
            className="process-panel"
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 30, opacity: 0 }}
            role="dialog"
            aria-label={title}
          >
            <h3 className="process-title">{title}</h3>

            <ul className="process-steps">
              {steps.map((s, i) => (
                <li key={i} className={`process-step ${s.state}`}>
                  <span className="status-circle" aria-hidden="true">
                    {s.state === "done" && (
                      <span className="icon-centering-wrapper">
                        <span className="tick" />
                      </span>
                    )}
                    {s.state === "active" && <span className="dot" aria-hidden="true" />}
                    {s.state === "error" && <span className="cross" aria-hidden="true" />}
                    {s.state === "pending" && <span className="bullet" aria-hidden="true" />}
                  </span>
                  <span className="label">{s.label}</span>
                </li>
              ))}
            </ul>

            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${
                    (steps.filter(s => s.state === "done").length / steps.length) * 100
                  }%`,
                }}
              />
            </div>

            <p className="process-hint">Please wait… we’ll take you to the summary when done.</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
