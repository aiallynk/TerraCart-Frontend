import React, { useState, useEffect, useRef } from 'react';
import { FaWheelchair } from "react-icons/fa";


const AccessibilityTools = () => {
  const [fontSize, setFontSize] = useState(100);          // percentage
  const contrast = 'normal';
  const [dyslexiaFont, setDyslexiaFont] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  /* ---------- APPLY BODY CLASSES & PREFERENCES ---------- */
  useEffect(() => {
    const body = document.body;
    body.classList.remove('light-contrast', 'dyslexia-font');
    if (dyslexiaFont) body.classList.add('dyslexia-font');
    body.style.fontSize = `${fontSize}%`;

    localStorage.setItem(
      'accessibility-preferences',
      JSON.stringify({ fontSize, contrast, dyslexiaFont })
    );
  }, [fontSize, dyslexiaFont]);

  /* ---------- LOAD PREFERENCES ---------- */
  useEffect(() => {
    const saved = localStorage.getItem('accessibility-preferences');
    if (saved) {
      try {
        const { fontSize: f, dyslexiaFont: d } = JSON.parse(saved);
        setFontSize(f ?? 100);
        setDyslexiaFont(d ?? false);
      } catch { /* ignore */ }
    }
  }, []);

  /* ---------- INJECT STYLES (kept your image/overlay handling) ---------- */
  useEffect(() => {
    const styleId = 'accessibility-styles';
    document.getElementById(styleId)?.remove();

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      body { font-size: ${fontSize}% !important; }
      body *:not(.accessibility-tools *):not([class*="overlay"]):not([style*="position: absolute"]) { font-size: inherit !important; }
      body [style*="position: absolute"],
      body [class*="overlay"],
      body [class*="card"] [class*="title"],
      body [class*="card"] h1,
      body [class*="card"] h2,
      body [class*="card"] h3,
      body [class*="card"] h4,
      body [class*="card"] h5,
      body [class*="card"] h6,
      body img + *,
      body [style*="background-image"] *,
      body .card-overlay,
      body .image-overlay,
      body .food-title,
      body .price-tag {
        font-size: clamp(0.8rem, ${Math.min(fontSize * 0.01, 1.2)}rem, 1.2rem) !important;
        line-height: 1.2 !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
        max-width: 100% !important;
      }
      body [class*="card"] div[style*="position"],
      body [data-testid*="card"] *,
      body .menu-item *,
      body .food-card * {
        font-size: clamp(0.75rem, ${Math.min(fontSize * 0.008, 1)}rem, 1rem) !important;
      }
      body [class*="price"],
      body *:has(> .rupee-text),
      body *:where(:not(.accessibility-tools)):where(:not(script)):where(:not(style)) { }
      body h1:not([class*="card"] h1):not([style*="position"]) { font-size: 2.5em !important; }
      body h2:not([class*="card"] h2):not([style*="position"]) { font-size: 2em !important; }
      body h3:not([class*="card"] h3):not([style*="position"]) { font-size: 1.75em !important; }
      body h4:not([class*="card"] h4):not([style*="position"]) { font-size: 1.5em !important; }
      body h5:not([class*="card"] h5):not([style*="position"]) { font-size: 1.25em !important; }
      body h6:not([class*="card"] h6):not([style*="position"]) { font-size: 1em !important; }

      body button:not(.accessibility-tools button):not([class*="card"] button):not([style*="position"]),
      body input:not(.accessibility-tools input),
      body select:not(.accessibility-tools select),
      body textarea:not(.accessibility-tools textarea) { font-size: inherit !important; }

      .accessibility-tools, .accessibility-tools * { font-size: 12px !important; }

      body.light-contrast {
        background: linear-gradient(135deg, #f8f9ff 0%, #fff8f0 100%) !important;
      }
      body.light-contrast h1, body.light-contrast h2, body.light-contrast h3,
      body.light-contrast h4, body.light-contrast h5, body.light-contrast h6 {
        text-shadow: 2px 2px 4px rgba(0,0,0,0.3) !important;
        font-weight: bolder !important;
      }
      body.light-contrast button:not(.accessibility-tools button) {
        box-shadow: 0 4px 8px rgba(0,0,0,0.2) !important;
        border-width: 2px !important;
        transform: scale(1.02) !important;
      }
      body.light-contrast .accessibility-tools {
        position: fixed !important;
        left: 16px !important;
        bottom: 16px !important;
        z-index: 10000 !important;
        filter: none !important;
        background: rgba(255, 255, 255, 0.95) !important;
        color: #333 !important;
        text-shadow: none !important;
        transform: none !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15) !important;
      }
      body.light-contrast .accessibility-tools * { color: #333 !important; text-shadow: none !important; }

      body.dyslexia-font *:not(.accessibility-tools *) {
        font-family: 'Comic Sans MS', 'Arial', sans-serif !important;
        letter-spacing: 0.05em !important;
        word-spacing: 0.1em !important;
        line-height: 1.5 !important;
      }
    `;
    document.head.appendChild(style);
    return () => document.getElementById(styleId)?.remove();
  }, [fontSize]);

  /* ---------- COLLAPSE BEHAVIOR: click-outside + Esc ---------- */
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setIsOpen(false); };
    const onClick = (e) => {
      if (!panelRef.current) return;
      if (
        !panelRef.current.contains(e.target) &&
        !buttonRef.current?.contains(e.target)
      ) setIsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [isOpen]);

  /* ---------- INLINE STYLES: match footer bar (same height, orange, shadow as View Cart) ---------- */
  const fabWrapStyle = {
    position: 'fixed',
    bottom: '16px',
    left: '16px',
    zIndex: 10000,
    right: 'auto',
    background: 'transparent',
    padding: 0,
    borderRadius: 0,
    boxShadow: 'none',
    backdropFilter: 'none',
  };

  const fabBtnStyle = {
    height: 44,
    width: 44,
    borderRadius: '12px',
    border: 'none',
    background: '#ff6b35',
    color: 'white',
    fontSize: 20,
    cursor: 'pointer',
    boxShadow: '0 4px 6px rgba(255, 107, 53, 0.3)',
    display: 'grid',
    placeItems: 'center',
    transition: 'transform .2s ease, box-shadow .2s ease, background .2s ease',
  };

  const panelStyle = {
    position: 'fixed',
    bottom: 72,
    left: 16,
    background: 'rgba(255,255,255,0.98)',
    borderRadius: 12,
    padding: 10,
    boxShadow: '0 10px 28px rgba(0,0,0,0.2)',
    border: '1px solid rgba(0,0,0,0.08)',
    backdropFilter: 'blur(10px)',
    minWidth: 220,
  };

  const buttonsStyle = {
    display: 'flex',
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  };

  const fontControlStyle = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
  };

  const fontButtonStyle = {
    padding: '4px 8px',
    border: 'none',
    borderRadius: 4,
    background: '#f8f9fa',
    color: '#333',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 'bold',
    minWidth: 30,
    transition: 'all .2s ease',
  };

  const buttonStyle = (isActive) => ({
    display: 'flex',
    alignItems: 'center',
    flexDirection: 'column',
    gap: 4,
    padding: '8px 12px',
    border: 'none',
    borderRadius: 8,
    background: isActive ? '#007bff' : '#f8f9fa',
    color: isActive ? 'white' : '#333',
    cursor: 'pointer',
    fontSize: 12,
    textAlign: 'center',
    fontFamily: 'Arial, sans-serif',
    transition: 'all .3s ease',
    minWidth: 70,
  });

  const iconStyle = { fontSize: 16, fontWeight: 'bold' };
  const textStyle = { fontWeight: 500, fontSize: 10 };
  const modeBadge = contrast === 'light' ? 'L' : 'O'; // Only normal ↔ light

  const increaseFontSize = () => { if (fontSize < 150) setFontSize(fontSize + 10); };
  const decreaseFontSize = () => { if (fontSize > 80) setFontSize(fontSize - 10); };

  return (
    <div className="accessibility-tools" style={fabWrapStyle}>
      {/* FAB: Wheelchair emoji */}
      <button
  ref={buttonRef}
  type="button"
  aria-label={isOpen ? 'Close accessibility tools' : 'Open accessibility tools'}
  aria-expanded={isOpen}
  aria-controls="accessibility-panel"
  onClick={() => setIsOpen(!isOpen)}
  style={{
    ...fabBtnStyle,
    transform: isOpen ? 'rotate(15deg) scale(1.02)' : 'none'
  }}
  onMouseOver={(e) => e.currentTarget.style.boxShadow = '0 6px 10px rgba(255, 107, 53, 0.4)'}
  onMouseOut={(e) => e.currentTarget.style.boxShadow = '0 4px 6px rgba(255, 107, 53, 0.3)'}
>
  <FaWheelchair size={20} color="white" />
</button>


      {/* Collapsible Panel */}
      {isOpen && (
        <div
          id="accessibility-panel"
          ref={panelRef}
          role="dialog"
          aria-label="Accessibility tools"
          style={panelStyle}
          className="accessibility-panel"
        >
          <div style={buttonsStyle}>
            {/* Font Size */}
            <div style={fontControlStyle}>
              <button
                style={fontButtonStyle}
                onClick={increaseFontSize}
                disabled={fontSize >= 150}
                title="Increase font size"
                onMouseOver={(e) => { if (fontSize < 150) e.currentTarget.style.background = '#e9ecef'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = '#f8f9fa'; }}
              >▲</button>

              <div style={{ fontSize: 10, fontWeight: 'bold', textAlign: 'center' }}>
                <div style={iconStyle}>Aa</div>
                <div style={textStyle}>Font Size</div>
                <div style={{ fontSize: 8, color: '#666' }}>{fontSize}%</div>
              </div>

              <button
                style={fontButtonStyle}
                onClick={decreaseFontSize}
                disabled={fontSize <= 80}
                title="Decrease font size"
                onMouseOver={(e) => { if (fontSize > 80) e.currentTarget.style.background = '#e9ecef'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = '#f8f9fa'; }}
              >▼</button>
            </div>

            {/* Contrast (Normal ↔ Light) */}
            {false && (
            <button
              style={buttonStyle(contrast !== 'normal')}
              onClick={cycleContrast}
              aria-pressed={contrast !== 'normal'}
              aria-label={`Contrast: ${contrast}`}
              title={`Contrast mode: ${contrast}`}
              onMouseOver={(e) => {
                if (contrast === 'normal') {
                  e.currentTarget.style.background = '#e9ecef';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }
              }}
              onMouseOut={(e) => {
                if (contrast === 'normal') {
                  e.currentTarget.style.background = '#f8f9fa';
                  e.currentTarget.style.transform = 'translateY(0)';
                }
              }}
            >
              <span style={iconStyle}>◐</span>
              <span style={textStyle}>Contrast</span>
              <span style={{ fontSize: 10, opacity: 0.8 }}>{modeBadge}</span>
            </button>
            )}

            {/* Dyslexia */}
            <button
              style={buttonStyle(dyslexiaFont)}
              onClick={() => setDyslexiaFont(!dyslexiaFont)}
              aria-pressed={dyslexiaFont}
              aria-label={`Dyslexia Font: ${dyslexiaFont ? 'On' : 'Off'}`}
              title={`Dyslexia Font: ${dyslexiaFont ? 'Enabled' : 'Disabled'}`}
              onMouseOver={(e) => {
                if (!dyslexiaFont) {
                  e.currentTarget.style.background = '#e9ecef';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }
              }}
              onMouseOut={(e) => {
                if (!dyslexiaFont) {
                  e.currentTarget.style.background = '#f8f9fa';
                  e.currentTarget.style.transform = 'translateY(0)';
                }
              }}
            >
              <span style={iconStyle}>𝖠𝖺</span>
              <span style={textStyle}>Dyslexia</span>
            </button>

          </div>
        </div>
      )}
    </div>
  );
};

export default AccessibilityTools;
