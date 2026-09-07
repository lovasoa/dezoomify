// Minimal preview pan/zoom for the website canvas (todo 2.2 home, moved
// from `src/main.ts`).
//
// Transform-only and therefore tainted-safe: wheel zoom plus drag pan apply
// a CSS `translate`/`scale` to `#rendering-canvas` and never call
// `getImageData`, `toBlob`, `toDataURL`, hashing, or processing. The tainted
// display-only path stays display-only; preview never promises a clean save.
// The host document is injected so node tests drive the transform math
// without a DOM. Keep erasable-syntax-only for the browser `.js` mirrors.
export const PREVIEW_MIN_SCALE = 0.1;
export const PREVIEW_MAX_SCALE = 8;
export const PREVIEW_ZOOM_STEP = 1.25;

export interface PreviewTransform {
  scale: number;
  tx: number;
  ty: number;
}

export interface PreviewStyleLike {
  transformOrigin: string;
  transform: string;
  display: string;
  cursor: string;
}

export interface PreviewElementLike {
  style: PreviewStyleLike;
  addEventListener(type: string, listener: (event: unknown) => void, opts?: unknown): void;
  setPointerCapture?: (id: number) => void;
  isConnected?: boolean;
}

export interface PreviewDocumentLike {
  getElementById(id: string): (PreviewElementLike & { hidden?: unknown; textContent?: string | null; isConnected?: boolean }) | null;
}

export interface PreviewControls {
  getTransform(): PreviewTransform;
  resetTransform(doc?: PreviewDocumentLike | null): PreviewTransform;
  zoomBy(factor: unknown, doc?: PreviewDocumentLike | null): PreviewTransform;
  setScale(scale: unknown, doc?: PreviewDocumentLike | null): PreviewTransform;
  initControls(doc: PreviewDocumentLike): void;
}

export function clampPreviewScale(scale: unknown): number {
  const value = typeof scale === "number" ? scale : Number(scale);
  if (!Number.isFinite(value)) return 1;
  return Math.min(PREVIEW_MAX_SCALE, Math.max(PREVIEW_MIN_SCALE, value));
}

export function createPreviewControls(): PreviewControls {
  let transform: PreviewTransform = { scale: 1, tx: 0, ty: 0 };
  let wired = false;

  function getTransform(): PreviewTransform {
    return { ...transform };
  }

  function applyTransform(doc?: PreviewDocumentLike | null): void {
    if (!doc) return;
    try {
      const canvas = doc.getElementById("rendering-canvas");
      if (!canvas) return;
      canvas.style.transformOrigin = "0 0";
      canvas.style.transform = `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`;
      const label = doc.getElementById("preview-zoom-label");
      if (label) label.textContent = `${Math.round(transform.scale * 100)}%`;
    } catch {
      // Preview transform must never break the job.
    }
  }

  function resetTransform(doc?: PreviewDocumentLike | null): PreviewTransform {
    transform = { scale: 1, tx: 0, ty: 0 };
    applyTransform(doc);
    return getTransform();
  }

  function zoomBy(factor: unknown, doc?: PreviewDocumentLike | null): PreviewTransform {
    const value = typeof factor === "number" ? factor : Number(factor);
    const next = clampPreviewScale(transform.scale * (Number.isFinite(value) ? value : 1));
    transform = { ...transform, scale: next };
    applyTransform(doc);
    return getTransform();
  }

  function setScale(scale: unknown, doc?: PreviewDocumentLike | null): PreviewTransform {
    transform = { ...transform, scale: clampPreviewScale(scale) };
    applyTransform(doc);
    return getTransform();
  }

  function panBy(dx: number, dy: number, doc?: PreviewDocumentLike | null): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    transform = { ...transform, tx: transform.tx + dx, ty: transform.ty + dy };
    applyTransform(doc);
  }

  function initControls(doc: PreviewDocumentLike): void {
    if (wired) return;
    try {
      const wrapper = doc.getElementById("canvas-wrapper");
      const canvas = doc.getElementById("rendering-canvas");
      if (!wrapper || !canvas) return;
      wired = true;
      resetTransform(doc);

      doc.getElementById("preview-zoom-in")?.addEventListener("click", () => zoomBy(PREVIEW_ZOOM_STEP, doc));
      doc.getElementById("preview-zoom-out")?.addEventListener("click", () => zoomBy(1 / PREVIEW_ZOOM_STEP, doc));
      doc.getElementById("preview-zoom-reset")?.addEventListener("click", () => resetTransform(doc));
      doc.getElementById("preview-zoom-100")?.addEventListener("click", () => setScale(1, doc));

      // Wheel zoom (ctrl/pinch friendly): scale around the viewport center via
      // transform only; no pixel reads so tainted canvases stay viewable.
      wrapper.addEventListener(
        "wheel",
        (event) => {
          if (wrapper.style.display === "none") return;
          (event as { preventDefault?: () => void }).preventDefault?.();
          const delta = (event as { deltaY?: number }).deltaY ?? 0;
          const factor = delta < 0 ? PREVIEW_ZOOM_STEP : 1 / PREVIEW_ZOOM_STEP;
          zoomBy(factor, doc);
        },
        { passive: false },
      );

      // Drag pan: pointer capture on the canvas, translate only.
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      canvas.addEventListener("pointerdown", (event) => {
        dragging = true;
        lastX = (event as { clientX?: number }).clientX ?? 0;
        lastY = (event as { clientY?: number }).clientY ?? 0;
        try {
          (canvas as PreviewElementLike).setPointerCapture?.((event as { pointerId?: number }).pointerId ?? 0);
        } catch {
          // Pointer capture is best-effort.
        }
        canvas.style.cursor = "grabbing";
      });
      canvas.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const x = (event as { clientX?: number }).clientX ?? 0;
        const y = (event as { clientY?: number }).clientY ?? 0;
        panBy(x - lastX, y - lastY, doc);
        lastX = x;
        lastY = y;
      });
      const endDrag = () => {
        dragging = false;
        canvas.style.cursor = "";
      };
      canvas.addEventListener("pointerup", endDrag);
      canvas.addEventListener("pointercancel", endDrag);
    } catch {
      // Preview wiring must never break the job.
    }
  }

  return { getTransform, resetTransform, zoomBy, setScale, initControls };
}

/** Show or hide the assembled canvas plus its preview toolbar. */
export function setCanvasVisible(doc: PreviewDocumentLike | null | undefined, visible: boolean): void {
  if (!doc) return;
  try {
    const wrapper = doc.getElementById("canvas-wrapper");
    if (wrapper) wrapper.style.display = visible ? "" : "none";
    const controls = doc.getElementById("preview-controls");
    if (controls && "hidden" in controls) (controls as { hidden?: boolean }).hidden = !visible;
  } catch {
    // Canvas visibility must never break the job.
  }
}
