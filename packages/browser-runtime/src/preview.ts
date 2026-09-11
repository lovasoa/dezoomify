// Minimal preview pan/zoom for the website canvas (todo 2.2 home, moved
// from `src/main.ts`).
//
// Transform-only and therefore tainted-safe: wheel zoom plus drag pan apply
// a CSS `translate`/`scale` to `#rendering-canvas` and never call
// `getImageData`, `toBlob`, `toDataURL`, hashing, or processing. The tainted
// display-only path stays display-only; preview never promises a clean save.
// The host document is injected so node tests drive the transform math
// without a DOM. Keep erasable-syntax-only for the browser `.js` mirrors.
export const PREVIEW_ZOOM_STEP = 1.25;
const PREVIEW_WHEEL_STEP_PIXELS = 100;

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
  width?: number;
  height?: number;
  clientWidth?: number;
  clientHeight?: number;
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
      canvas.style.transformOrigin = "center center";
      canvas.style.transform = `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`;
      const label = doc.getElementById("preview-zoom-label");
      if (label) label.textContent = `${Math.round(transform.scale * 100)}%`;
    } catch {
      // Preview transform must never break the job.
    }
  }

  function geometry(doc?: PreviewDocumentLike | null): {
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
  } | null {
    if (!doc) return null;
    try {
      const wrapper = doc.getElementById("canvas-wrapper");
      const canvas = doc.getElementById("rendering-canvas");
      const width = canvas?.width ?? 0;
      const height = canvas?.height ?? 0;
      const viewportWidth = wrapper?.clientWidth ?? 0;
      const viewportHeight = wrapper?.clientHeight ?? 0;
      if (!(width > 0 && height > 0 && viewportWidth > 0 && viewportHeight > 0)) return null;
      return { width, height, viewportWidth, viewportHeight };
    } catch {
      return null;
    }
  }

  function clampTranslation(doc?: PreviewDocumentLike | null): void {
    const size = geometry(doc);
    if (!size) return;
    const maxTx = Math.max(0, (size.width * transform.scale - size.viewportWidth) / 2);
    const maxTy = Math.max(0, (size.height * transform.scale - size.viewportHeight) / 2);
    transform = {
      ...transform,
      tx: Math.max(-maxTx, Math.min(maxTx, transform.tx)),
      ty: Math.max(-maxTy, Math.min(maxTy, transform.ty)),
    };
  }

  function fitScale(doc?: PreviewDocumentLike | null): number {
    const size = geometry(doc);
    if (!size) return 1;
    return Math.min(1, size.viewportWidth / size.width, size.viewportHeight / size.height);
  }

  function resetTransform(doc?: PreviewDocumentLike | null): PreviewTransform {
    transform = { scale: fitScale(doc), tx: 0, ty: 0 };
    applyTransform(doc);
    return getTransform();
  }

  function zoomBy(factor: unknown, doc?: PreviewDocumentLike | null): PreviewTransform {
    const value = typeof factor === "number" ? factor : Number(factor);
    const next = Math.max(fitScale(doc), Math.min(1, transform.scale * (Number.isFinite(value) ? value : 1)));
    transform = { ...transform, scale: next };
    clampTranslation(doc);
    applyTransform(doc);
    return getTransform();
  }

  function setScale(scale: unknown, doc?: PreviewDocumentLike | null): PreviewTransform {
    const value = typeof scale === "number" ? scale : Number(scale);
    const next = Number.isFinite(value) ? Math.max(fitScale(doc), Math.min(1, value)) : 1;
    transform = { ...transform, scale: next };
    clampTranslation(doc);
    applyTransform(doc);
    return getTransform();
  }

  function panBy(dx: number, dy: number, doc?: PreviewDocumentLike | null): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    transform = { ...transform, tx: transform.tx + dx, ty: transform.ty + dy };
    clampTranslation(doc);
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
      doc.getElementById("preview-zoom-fit")?.addEventListener("click", () => resetTransform(doc));
      doc.getElementById("preview-zoom-100")?.addEventListener("click", () => setScale(1, doc));

      // Wheel zoom (ctrl/pinch friendly): scale around the viewport center via
      // transform only; no pixel reads so tainted canvases stay viewable.
      wrapper.addEventListener(
        "wheel",
        (event) => {
          if (wrapper.style.display === "none") return;
          (event as { preventDefault?: () => void }).preventDefault?.();
          (event as { stopPropagation?: () => void }).stopPropagation?.();
          const delta = (event as { deltaY?: number }).deltaY ?? 0;
          if (!Number.isFinite(delta) || delta === 0) return;
          // Use a continuous curve so high-frequency trackpad events do not
          // apply a full button-sized zoom step each time.
          const boundedDelta = Math.max(-PREVIEW_WHEEL_STEP_PIXELS, Math.min(PREVIEW_WHEEL_STEP_PIXELS, delta));
          const factor = Math.pow(PREVIEW_ZOOM_STEP, -boundedDelta / PREVIEW_WHEEL_STEP_PIXELS);
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
