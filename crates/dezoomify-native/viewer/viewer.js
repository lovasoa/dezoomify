import OpenSeadragon from "openseadragon";
import "./viewer.css";

// Inline metadata and ordinary image loading also work on file:// origins.
const info = JSON.parse(document.getElementById("image-info").textContent);
const viewer = OpenSeadragon({
  id: "viewer",
  drawer: "canvas",
  crossOriginPolicy: false,
  loadTilesWithAjax: false,
  tileSources: info,
  zoomInButton: "zoom-in",
  zoomOutButton: "zoom-out",
  homeButton: "home",
  fullPageButton: "fullscreen",
});
viewer.addControl(document.getElementById("viewer-controls"), {
  anchor: OpenSeadragon.ControlAnchor.BOTTOM_LEFT,
  autoFade: false,
});
