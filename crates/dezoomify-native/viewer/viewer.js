import OpenSeadragon from "openseadragon";

// Inline metadata and ordinary image loading also work on file:// origins.
const info = JSON.parse(document.getElementById("image-info").textContent);
OpenSeadragon({
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
