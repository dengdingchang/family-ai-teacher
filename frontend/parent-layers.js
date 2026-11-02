/* The parent space is three layers — 今天 / 成长 / 设置 — so one screen shows
   one job. Plain script (no modules) so it runs before the deferred panel code. */
(() => {
  const names = ["today", "growth", "settings"];
  const tabs = [...document.querySelectorAll("[data-layer-target]")];
  const layers = [...document.querySelectorAll("[data-layer]")];
  const grid = document.querySelector(".dashboard-grid");
  const hashLayers = {
    "#today": "today",
    "#playProgressTitle": "today",
    "#learning": "growth",
    "#memories": "growth",
    "#familySettings": "settings",
    "#modelPanel": "settings",
  };

  function apply(name, focusTab = false) {
    const layer = names.includes(name) ? name : "today";
    document.body.dataset.layer = layer;
    if (grid) grid.dataset.activeLayer = layer;
    for (const node of layers) {
      node.classList.toggle("layer-hidden", node.dataset.layer !== layer);
    }
    for (const tab of tabs) {
      const active = tab.dataset.layerTarget === layer;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focusTab) tab.focus({ preventScroll: true });
    }
  }

  function layerFromHash() {
    return hashLayers[window.location.hash] || "today";
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => {
      const layer = tab.dataset.layerTarget;
      apply(layer);
      window.history.replaceState(null, "", layer === "today" ? window.location.pathname : `#${layer}`);
    });
    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = tabs[(index + step + tabs.length) % tabs.length];
      next.click();
      next.focus();
    });
  }

  window.addEventListener("hashchange", () => apply(layerFromHash()));
  apply(layerFromHash());
})();
