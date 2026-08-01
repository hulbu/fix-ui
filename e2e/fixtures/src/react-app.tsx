import { createRoot } from "react-dom/client";

/**
 * A named component around pickable elements, rendered by a real React from
 * `node_modules` (bundled locally — the suite runs offline, so no CDN).
 *
 * This is what makes `component` in a saved entry mean something: React hangs
 * its fiber off the DOM node as an expando, and the picker walks that fiber up
 * to the nearest named function. The extension proves the hard version of it —
 * the fiber is only visible from the page's own JavaScript world, so the answer
 * has to travel MAIN world → content script before a note is saved.
 */
function PricingCard(): React.JSX.Element {
  return (
    <div className="pricing-card">
      <h2 className="plan-name">Pro</h2>
      <p className="price">$29/mo</p>
      <button id="buy-btn" className="buy" type="button">
        Buy now
      </button>
    </div>
  );
}

const root = document.getElementById("react-root");
if (root) createRoot(root).render(<PricingCard />);
