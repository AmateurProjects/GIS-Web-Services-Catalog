// ui-fx.js — UI animation / FX helpers (ES module)

export function animatePanel(el, durationMs = 650) {
  if (!el) return;

  // Hide scrollbars globally during the animation (prevents transient page scrollbars)
  document.documentElement.classList.add('fx-no-scroll');
  document.body.classList.add('fx-no-scroll');
  el.classList.add('fx-animating');

  // Re-trigger CSS animation by toggling a class
  el.classList.remove('fx-enter');
  void el.offsetWidth; // Force reflow so the browser restarts the animation
  el.classList.add('fx-enter');

  // Always clean up (animationend may fire on child cards, not on the panel itself)
  window.setTimeout(() => {
    el.classList.remove('fx-animating');
    document.documentElement.classList.remove('fx-no-scroll');
    document.body.classList.remove('fx-no-scroll');
  }, durationMs);
}

// Adds stagger classes to the first N cards inside a panel
export function staggerCards(panelEl, maxCards = 9) {
  if (!panelEl) return;
  const cards = panelEl.querySelectorAll('.card, .detail-section');
  // clear old delay classes
  cards.forEach((c) => {
    for (let i = 1; i <= 9; i++) c.classList.remove(`fx-d${i}`);
  });
  // assign new delay classes
  cards.forEach((c, idx) => {
    const n = Math.min(idx + 1, maxCards);
    c.classList.add(`fx-d${n}`);
  });
}

export function setActiveListButton(listRootEl, predicateFn) {
  if (!listRootEl) return;
  const btns = listRootEl.querySelectorAll('button.list-item-button');
  btns.forEach((b) => {
    const isActive = predicateFn(b);
    b.classList.toggle('is-active', isActive);
  });
}
