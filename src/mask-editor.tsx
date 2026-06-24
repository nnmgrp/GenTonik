// ============================================================
// mask-editor.tsx — Painted-mask brush editor for layer masks
// ============================================================
//
// Renders an overlay canvas over the main composite view. The user paints
// with a soft round brush; the result is stored as a Uint8Array alpha map
// in the layer's `mask` field (type: 'painted').
//
// Key design decisions:
//
//   • Two canvases stacked:
//       - `paintCanvasRef`  — full-size Uint8 alpha accumulator (NOT
//                              displayed directly; serves as backing store)
//       - `overlayCanvasRef` — same size as paint canvas, draws the live
//                               brush cursor + stroke preview; user sees this
//                               composited over the layer
//
//   • Brush stamp = radial falloff. Hardness controls falloff steepness:
//       hardness 0   → linear ramp (very soft)
//       hardness 1   → step function (hard edge)
//       formula: alpha = clamp((radius - dist) / (radius * (1 - hardness)), 0, 1)
//                but clamped to [0,1] and the inner hard disc is always 1
//                when hardness > 0. Equivalent to Photoshop's brush hardness.
//
//   • Stamp spacing = 0.25 × diameter. Stamps between mouse-move events are
//     interpolated along the segment from lastPos to currentPos so fast
//     strokes don't have gaps.
//
//   • Opacity — applied per stamp. To avoid "shading yourself darker" within
//     a single stroke, we use a per-stroke stamp-canvas that is reset on
//     mouseup. Within a stroke, each stamp adds to the stamp-canvas; on
//     mouseup the stamp-canvas is composited into the paint-canvas at the
//     stroke opacity. This matches Photoshop semantics: holding the mouse
//     down and going over the same area does NOT get darker; releasing and
//     pressing again does.
//
//   • Eraser — same as brush but writes 0 instead of `value`. Implemented
//     via `globalCompositeOperation = 'destination-out'` on the stamp canvas
//     (or simpler: directly write 0 alpha to the paint canvas). We chose
//     the stamp-canvas route so eraser respects the same opacity semantics.
//
//   • History integration — on mousedown we capture the BEFORE state; on
//     mouseup we push a single new snapshot with the AFTER state. Coalescing
//     is NOT used here (each stroke is its own undo step). The push callback
//     is provided by the parent (App.tsx) via the `onStrokeComplete` prop.
//
//   • Coordinate space — the mask is stored in LAYER-LOCAL pixel space
//     (width = layer natural width, height = layer natural height). The
//     parent passes a `viewTransform` (zoom + pan) and a `layerTransform`
//     (x, y, scale, rotation, skewX, skewY) so we can convert screen →
//     layer-local via the full inverse transform (not just axis-aligned
//     offset). This correctly handles rotated/skewed/flipped layers —
//     fixing the v1 bug where the brush "рисует не там / инвертированно"
//     on any layer that wasn't axis-aligned.
//     The inverse-transform pattern is adapted from fabric.js's
//     `sendPointToPlane` (see NOTICE.md for attribution).
//
//   • Mask initialization — if the layer has no mask yet, we create one
//     sized to the layer natural size, filled with 0 (fully transparent).
//     If the layer has a 'shape' mask, we offer to convert it to painted
//     (rasterize the shape into the alpha buffer). This is done in App.tsx
//     before opening the editor — this component assumes `initialMask` is
//     always 'painted' or undefined (in which case it creates an empty one).
// ============================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { Layer, LayerMask } from './types';
import {
  screenToLocal,
  composeLayerMatrix,
  composeViewMatrix,
  multiply,
  matrixToCss,
} from './transform-matrix';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/**
 * Tool selection for the mask editor.
 *
 * Brush tools (brush, eraser) paint continuously and use the stamp-canvas
 * accumulator for per-stroke opacity semantics.
 *
 * Selection tools (lasso, polygonal-lasso, rect-marquee, ellipse-marquee)
 * capture a region on pointer-down → move → up, then rasterize it onto
 * the paint canvas as a single atomic operation. They respect the current
 * brush opacity for the fill strength. Eraser-style selection (subtract
 * from mask) is done by holding Alt during the drag.
 */
export type MaskTool =
  | 'brush'
  | 'eraser'
  | 'lasso'
  | 'polygonal-lasso'
  | 'rect-marquee'
  | 'ellipse-marquee';

/** Whether a tool is a continuous brush-style tool (uses stamp canvas). */
export function isBrushTool(tool: MaskTool): boolean {
  return tool === 'brush' || tool === 'eraser';
}

/** Whether a tool is a selection-style tool (captures a region). */
export function isSelectionTool(tool: MaskTool): boolean {
  return tool === 'lasso' || tool === 'polygonal-lasso'
    || tool === 'rect-marquee' || tool === 'ellipse-marquee';
}

/** Brush parameters. */
export interface BrushSettings {
  /** Diameter in layer-local pixels. Range [1, 500]. */
  size: number;
  /** Edge softness. Range [0, 1]. 0 = soft, 1 = hard. */
  hardness: number;
  /** Per-stroke opacity. Range [0, 1]. */
  opacity: number;
}

/** View transform passed in by the parent (matches App.tsx state). */
export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export interface MaskEditorProps {
  /** The layer being edited. Caller ensures type === 'painted' mask or none. */
  layer: Layer;
  /** Initial mask to load. If undefined, creates an empty one. */
  initialMask?: Extract<LayerMask, { type: 'painted' }>;
  /** Natural size of the layer content (width/height in px). */
  layerWidth: number;
  layerHeight: number;
  /** Document size in px (used to compute layer center = docCenter + transform.xy,
   *  matching composite.ts). Without this, the overlay would be misplaced
   *  for any layer whose natural size ≠ doc size (e.g., image layers). */
  docWidth: number;
  docHeight: number;
  /** View transform from the parent canvas (zoom + pan). */
  viewTransform: ViewTransform;
  /** Layer transform (full affine: x, y, scaleX, scaleY, rotation, skewX, skewY).
   *  All fields are used in v2 — the overlay canvas is positioned via the
   *  composed view×layer matrix, and screen→local conversion uses its inverse. */
  layerTransform: Layer['transform'];

  /** Called once on mount with the initialized mask (so parent can store it). */
  onMaskInit?: (mask: Extract<LayerMask, { type: 'painted' }>) => void;
  /**
   * Called when a stroke completes (mouseup). Parent should:
   *   1. Update the layer's mask field with the new data.
   *   2. Push a history entry.
   * The mask passed here is a fresh painted mask object — safe to store.
   */
  onStrokeComplete: (mask: Extract<LayerMask, { type: 'painted' }>) => void;
  /** Called when the user clicks "Clear All". */
  onClear?: () => void;
  /** Called when the user clicks "Done". */
  onClose: () => void;

  /** CSS class for the root container. */
  className?: string;
  /** Inline style for the root container. */
  style?: CSSProperties;
}

// ────────────────────────────────────────────────────────────
// Brush stamp math
// ────────────────────────────────────────────────────────────

/**
 * Build a single brush stamp as ImageData (RGBA, premultiplied not needed —
 * we use composite ops). The stamp is centered on a square canvas of
 * `2 * radius` pixels.
 *
 * Returned ImageData has alpha = brushValue × falloff; RGB = 255 (white)
 * so we can use it with destination-in / destination-out composites.
 *
 * Performance: called only when brush settings change (memoized), so a
 * 200×200 stamp rebuild is fine even at 60fps UI updates.
 */
function buildBrushStamp(size: number, hardness: number, value: number): ImageData {
  const radius = Math.max(0.5, size / 2);
  const stampSize = Math.max(2, Math.ceil(size));
  const img = new ImageData(stampSize, stampSize);
  const dst = img.data;

  const cx = (stampSize - 1) / 2;
  const cy = (stampSize - 1) / 2;
  // Falloff: for hardness = 1, the inner disc (radius * 1) is fully opaque
  // and outside is 0. For hardness = 0, the inner disc (radius * 0) is empty
  // and the falloff is linear from center to edge.
  // We use a single formula: alpha = clamp((R - d) / (R * (1 - H) + eps), 0, 1)
  //   - H=1: denom → eps, so any d<R gives alpha≈1 (hard edge)
  //   - H=0: denom = R, so alpha = (R - d) / R (linear)
  const denom = Math.max(0.5, radius * (1 - hardness));

  for (let y = 0; y < stampSize; y++) {
    for (let x = 0; x < stampSize; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let a = (radius - d) / denom;
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      const finalAlpha = Math.round(a * value);
      const i = (y * stampSize + x) * 4;
      dst[i] = 255;
      dst[i + 1] = 255;
      dst[i + 2] = 255;
      dst[i + 3] = finalAlpha;
    }
  }
  return img;
}

// ────────────────────────────────────────────────────────────
// MaskEditor component
// ────────────────────────────────────────────────────────────

export function MaskEditor({
  layer,
  initialMask,
  layerWidth,
  layerHeight,
  docWidth,
  docHeight,
  viewTransform,
  layerTransform,
  onMaskInit,
  onStrokeComplete,
  onClose,
  className,
  style,
}: MaskEditorProps): JSX.Element {
  // ── Tool state ─────────────────────────────────────────
  const [tool, setTool] = useState<MaskTool>('brush');
  const [brush, setBrush] = useState<BrushSettings>({
    size: 40,
    hardness: 0.5,
    opacity: 1,
  });
  const [invert, setInvert] = useState<boolean>(
    initialMask?.invert ?? false,
  );

  // ── Canvas refs ────────────────────────────────────────
  // paintCanvas  — backing store, full layer size, alpha only (R=G=B=255, A=value)
  // overlayCanvas — same size, displayed over the layer, shows live stroke
  // stampCanvas  — per-stroke accumulator, reset on mouseup
  const paintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stampCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── Stroke state ───────────────────────────────────────
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const isDrawingRef = useRef<boolean>(false);

  // ── Selection state (used by lasso / polygonal / marquee tools) ──
  // For freehand lasso and marquee: pointsRef accumulates drag points,
  // committed on pointerup. For polygonal lasso: pointsRef accumulates
  // click points; double-click or Enter commits; Escape cancels.
  const pointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const isSelectingRef = useRef<boolean>(false);
  // Live selection preview is drawn onto the overlay canvas via syncOverlay
  // — we don't need a separate canvas for it.
  // For polygonal lasso, we track whether we're in the middle of a polygon
  // (i.e., the user has clicked at least one point but hasn't committed).
  const [polygonActive, setPolygonActive] = useState<boolean>(false);
  // Hover position for polygonal lasso rubber-band preview.
  const hoverPosRef = useRef<{ x: number; y: number } | null>(null);

  // ── Initialize paint canvas with current mask ──────────
  useEffect(() => {
    const paintCanvas = paintCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const stampCanvas = stampCanvasRef.current;
    if (!paintCanvas || !overlayCanvas || !stampCanvas) return;

    const w = Math.max(1, layerWidth);
    const h = Math.max(1, layerHeight);
    paintCanvas.width = w;
    paintCanvas.height = h;
    overlayCanvas.width = w;
    overlayCanvas.height = h;
    stampCanvas.width = w;
    stampCanvas.height = h;

    const pCtx = paintCanvas.getContext('2d');
    if (!pCtx) return;
    pCtx.clearRect(0, 0, w, h);

    // Load existing mask data if provided.
    if (initialMask && initialMask.data.length === w * h) {
      const imgData = pCtx.createImageData(w, h);
      const dst = imgData.data;
      const src = initialMask.data;
      for (let i = 0; i < src.length; i++) {
        const a = src[i];
        dst[i * 4] = 255;
        dst[i * 4 + 1] = 255;
        dst[i * 4 + 2] = 255;
        dst[i * 4 + 3] = a;
      }
      pCtx.putImageData(imgData, 0, 0);
    }

    // Notify parent of the initialized mask so they have a reference.
    if (onMaskInit) {
      onMaskInit(extractMaskFromCanvas(paintCanvas, w, h, invert));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerWidth, layerHeight]);

  // ── Brush stamp memoized on (size, hardness, opacity, tool) ──
  const stampImage = useMemo(() => {
    // For eraser, we use destination-out so the stamp color doesn't matter;
    // build a white stamp regardless and let the composite op handle erasing.
    const value = Math.round(brush.opacity * 255);
    return buildBrushStamp(brush.size, brush.hardness, value);
  }, [brush.size, brush.hardness, brush.opacity]);

  // ── Convert screen → layer-local coords ────────────────
  //
  // v2 fix: previously this only subtracted the overlay-canvas offset and
  // divided by the CSS scale, which assumed the overlay was axis-aligned
  // over the layer. That broke for any layer with rotation/skew/flip —
  // the brush would paint in the wrong place ("инвертированно").
  //
  // The fix follows fabric.js's `sendPointToPlane` pattern (see NOTICE.md):
  // we compose the full forward matrix M = view × layer, take its inverse,
  // and multiply the screen point by it. The overlay canvas is now also
  // positioned via the same forward matrix as a CSS `transform`, so the
  // canvas DOM element aligns pixel-perfectly with the rendered layer.
  //
  // We use the overlay canvas's PARENT element as our reference frame
  // (the root div of the mask editor, which covers the full viewport).
  // Browser client coords → container-relative coords via getBoundingClientRect.
  const screenToLayer = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const overlay = overlayCanvasRef.current;
      if (!overlay) return null;
      const parent = overlay.parentElement;
      if (!parent) return null;
      const rect = parent.getBoundingClientRect();
      // Browser client coords → container-relative screen coords.
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      // Full inverse: screen → canvas-pixel → layer-local.
      return screenToLocal(
        { x: screenX, y: screenY },
        viewTransform,
        layerTransform,
        { w: layerWidth, h: layerHeight },
        { w: docWidth, h: docHeight },
      );
    },
    [viewTransform, layerTransform, layerWidth, layerHeight, docWidth, docHeight],
  );

  // ── Stamp a single point onto the stamp canvas ─────────
  const stampAt = useCallback(
    (x: number, y: number) => {
      const stampCanvas = stampCanvasRef.current;
      if (!stampCanvas) return;
      const sCtx = stampCanvas.getContext('2d');
      if (!sCtx) return;

      const stampSize = stampImage.width;
      const half = stampSize / 2;

      sCtx.save();
      if (tool === 'eraser') {
        sCtx.globalCompositeOperation = 'destination-out';
      } else {
        sCtx.globalCompositeOperation = 'source-over';
      }
      // drawImage accepts ImageData via a temp canvas. Create one lazily
      // and cache it on the ref.
      let tempCanvas = stampAtTempCanvasRef.current;
      if (!tempCanvas) {
        tempCanvas = document.createElement('canvas');
        stampAtTempCanvasRef.current = tempCanvas;
      }
      if (tempCanvas.width !== stampSize || tempCanvas.height !== stampSize) {
        tempCanvas.width = stampSize;
        tempCanvas.height = stampSize;
      }
      const tCtx = tempCanvas.getContext('2d');
      if (!tCtx) return;
      tCtx.clearRect(0, 0, stampSize, stampSize);
      tCtx.putImageData(stampImage, 0, 0);
      sCtx.drawImage(tempCanvas, x - half, y - half);
      sCtx.restore();
    },
    [stampImage, tool],
  );
  const stampAtTempCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── Stroke segment: interpolate stamps from A to B ─────
  const strokeSegment = useCallback(
    (fromX: number, fromY: number, toX: number, toY: number) => {
      const dx = toX - fromX;
      const dy = toY - fromY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const spacing = Math.max(1, brush.size * 0.25);
      const steps = Math.max(1, Math.ceil(dist / spacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        stampAt(fromX + dx * t, fromY + dy * t);
      }
    },
    [brush.size, stampAt],
  );

  // ── Pointer handlers ───────────────────────────────────
  // Dispatch to brush or selection logic based on current tool.
  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const pos = screenToLayer(e.clientX, e.clientY);
    if (!pos) return;

    if (isSelectionTool(tool)) {
      handleSelectionDown(e, pos);
    } else {
      handleBrushDown(e, pos);
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const pos = screenToLayer(e.clientX, e.clientY);
    if (!pos) return;

    if (isSelectionTool(tool)) {
      handleSelectionMove(pos);
    } else {
      handleBrushMove(pos);
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (isSelectionTool(tool)) {
      handleSelectionUp(e);
    } else {
      handleBrushUp(e);
    }
  };

  // ── Brush pointer logic (extracted from old handlers) ──
  const handleBrushDown = (e: ReactPointerEvent<HTMLCanvasElement>, pos: { x: number; y: number }) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    lastPosRef.current = pos;

    // Reset the stamp canvas for a fresh stroke.
    const stampCanvas = stampCanvasRef.current;
    if (stampCanvas) {
      const sCtx = stampCanvas.getContext('2d');
      sCtx?.clearRect(0, 0, stampCanvas.width, stampCanvas.height);
    }

    stampAt(pos.x, pos.y);
    syncOverlay();
  };

  const handleBrushMove = (pos: { x: number; y: number }) => {
    if (!isDrawingRef.current) return;
    const last = lastPosRef.current;
    if (last) {
      strokeSegment(last.x, last.y, pos.x, pos.y);
    } else {
      stampAt(pos.x, pos.y);
    }
    lastPosRef.current = pos;
    syncOverlay();
  };

  const handleBrushUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    isDrawingRef.current = false;
    lastPosRef.current = null;

    // Composite the stamp canvas onto the paint canvas with stroke opacity.
    const paintCanvas = paintCanvasRef.current;
    const stampCanvas = stampCanvasRef.current;
    if (!paintCanvas || !stampCanvas) return;
    const pCtx = paintCanvas.getContext('2d');
    if (!pCtx) return;

    pCtx.save();
    pCtx.globalAlpha = brush.opacity;
    if (tool === 'eraser') {
      pCtx.globalCompositeOperation = 'destination-out';
    } else {
      pCtx.globalCompositeOperation = 'source-over';
    }
    pCtx.drawImage(stampCanvas, 0, 0);
    pCtx.restore();

    // Clear stamp canvas for next stroke.
    const sCtx = stampCanvas.getContext('2d');
    sCtx?.clearRect(0, 0, stampCanvas.width, stampCanvas.height);

    // Notify parent of the new mask state.
    const newMask = extractMaskFromCanvas(
      paintCanvas,
      paintCanvas.width,
      paintCanvas.height,
      invert,
    );
    onStrokeComplete(newMask);
    syncOverlay();
  };

  // ── Selection pointer logic ────────────────────────────
  // Freehand lasso + rect/ellipse marquee: single drag operation.
  //   - pointerdown: start accumulating points (lasso) or record start (marquee)
  //   - pointermove: append point (lasso) or update end (marquee)
  //   - pointerup: rasterize the region onto the paint canvas at brush.opacity
  //
  // Polygonal lasso: multi-click operation.
  //   - pointerdown (first): start polygon, set polygonActive=true
  //   - pointerdown (subsequent): add vertex
  //   - pointermove: update hover pos for rubber-band preview
  //   - double-click OR Enter: commit polygon
  //   - Escape: cancel polygon
  //
  // Alt key (e.altKey) inverts the operation: subtract from mask instead
  // of adding. Useful for carving holes in an existing selection.
  const handleSelectionDown = (
    e: ReactPointerEvent<HTMLCanvasElement>,
    pos: { x: number; y: number },
  ) => {
    if (tool === 'polygonal-lasso') {
      if (!polygonActive) {
        // First click — start a new polygon.
        e.currentTarget.setPointerCapture(e.pointerId);
        pointsRef.current = [pos];
        isSelectingRef.current = true;
        setPolygonActive(true);
      } else {
        // Subsequent click — add vertex. If click is close to the first
        // point, close the polygon (Photoshop behavior).
        const first = pointsRef.current[0];
        if (first && Math.hypot(pos.x - first.x, pos.y - first.y) < 8) {
          commitPolygon(e);
        } else {
          pointsRef.current.push(pos);
        }
      }
      syncOverlay();
      return;
    }

    // Freehand lasso / rect marquee / ellipse marquee
    e.currentTarget.setPointerCapture(e.pointerId);
    isSelectingRef.current = true;
    pointsRef.current = [pos];
    lastPosRef.current = pos;
    syncOverlay();
  };

  const handleSelectionMove = (pos: { x: number; y: number }) => {
    if (tool === 'polygonal-lasso') {
      // Update hover position for rubber-band preview.
      hoverPosRef.current = pos;
      syncOverlay();
      return;
    }
    if (!isSelectingRef.current) return;
    pointsRef.current.push(pos);
    lastPosRef.current = pos;
    syncOverlay();
  };

  const handleSelectionUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (tool === 'polygonal-lasso') {
      // Polygonal lasso doesn't commit on pointerup — only on double-click
      // or click-near-first-point. Just release the capture if we somehow
      // had it (we only capture on first click).
      return;
    }
    if (!isSelectingRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    isSelectingRef.current = false;

    const pts = pointsRef.current;
    if (pts.length < 2) {
      pointsRef.current = [];
      syncOverlay();
      return;
    }

    // Rasterize the selection region onto the paint canvas.
    rasterizeSelection(pts, tool, e.altKey);

    pointsRef.current = [];
    lastPosRef.current = null;
    syncOverlay();

    // Push history.
    const paintCanvas = paintCanvasRef.current;
    if (paintCanvas) {
      const newMask = extractMaskFromCanvas(
        paintCanvas,
        paintCanvas.width,
        paintCanvas.height,
        invert,
      );
      onStrokeComplete(newMask);
    }
  };

  // Double-click handler for polygonal lasso commit.
  const handleDoubleClick = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (tool === 'polygonal-lasso' && polygonActive) {
      commitPolygon(e);
    }
  };

  // Commit the current polygonal-lasso polygon to the paint canvas.
  const commitPolygon = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const pts = pointsRef.current;
    if (pts.length < 3) {
      // Not enough points — cancel.
      cancelPolygon();
      return;
    }
    rasterizeSelection(pts, 'polygonal-lasso', e.altKey);
    cancelPolygon();
    syncOverlay();
    const paintCanvas = paintCanvasRef.current;
    if (paintCanvas) {
      const newMask = extractMaskFromCanvas(
        paintCanvas,
        paintCanvas.width,
        paintCanvas.height,
        invert,
      );
      onStrokeComplete(newMask);
    }
  };

  const cancelPolygon = () => {
    pointsRef.current = [];
    isSelectingRef.current = false;
    hoverPosRef.current = null;
    setPolygonActive(false);
  };

  // Keyboard handlers for polygonal lasso (Enter=commit, Escape=cancel).
  // Mounted once on the overlay canvas via tabIndex + onKeyDown.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (tool !== 'polygonal-lasso') return;
    if (e.key === 'Enter' && polygonActive) {
      e.preventDefault();
      // Synthesize an alt-state from e.altKey for consistency.
      rasterizeSelection(pointsRef.current, 'polygonal-lasso', e.altKey);
      cancelPolygon();
      syncOverlay();
      const paintCanvas = paintCanvasRef.current;
      if (paintCanvas) {
        const newMask = extractMaskFromCanvas(
          paintCanvas,
          paintCanvas.width,
          paintCanvas.height,
          invert,
        );
        onStrokeComplete(newMask);
      }
    } else if (e.key === 'Escape' && polygonActive) {
      e.preventDefault();
      cancelPolygon();
      syncOverlay();
    }
  };

  // ── Rasterize a selection region onto the paint canvas ──
  // For lasso / polygonal-lasso: fill the polygon path.
  // For rect-marquee: fill the bounding rect from points[0] to last point.
  // For ellipse-marquee: fill the ellipse inscribed in that bounding rect.
  //
  // If `subtract` is true (Alt held), use destination-out to carve a hole.
  // Otherwise, source-over with brush.opacity.
  const rasterizeSelection = (
    pts: Array<{ x: number; y: number }>,
    selectionTool: MaskTool,
    subtract: boolean,
  ) => {
    const paintCanvas = paintCanvasRef.current;
    if (!paintCanvas) return;
    const pCtx = paintCanvas.getContext('2d');
    if (!pCtx || pts.length < 2) return;

    pCtx.save();
    pCtx.globalAlpha = brush.opacity;
    pCtx.globalCompositeOperation = subtract ? 'destination-out' : 'source-over';
    pCtx.fillStyle = '#ffffff';

    if (selectionTool === 'lasso' || selectionTool === 'polygonal-lasso') {
      // Build a closed path through all points.
      pCtx.beginPath();
      pCtx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        pCtx.lineTo(pts[i].x, pts[i].y);
      }
      pCtx.closePath();
      pCtx.fill();
    } else if (selectionTool === 'rect-marquee') {
      const a = pts[0];
      const b = pts[pts.length - 1];
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      pCtx.fillRect(x, y, w, h);
    } else if (selectionTool === 'ellipse-marquee') {
      const a = pts[0];
      const b = pts[pts.length - 1];
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const rx = Math.abs(b.x - a.x) / 2;
      const ry = Math.abs(b.y - a.y) / 2;
      pCtx.beginPath();
      pCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      pCtx.fill();
    }
    pCtx.restore();
  };

  // ── Sync overlay canvas (paint + live stamp + live selection) ──
  const syncOverlay = useCallback(() => {
    const paintCanvas = paintCanvasRef.current;
    const stampCanvas = stampCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    if (!paintCanvas || !stampCanvas || !overlay) return;
    const oCtx = overlay.getContext('2d');
    if (!oCtx) return;
    oCtx.clearRect(0, 0, overlay.width, overlay.height);
    // Paint layer (mask) — show as white with alpha.
    oCtx.drawImage(paintCanvas, 0, 0);
    // Live brush stroke on top.
    oCtx.save();
    oCtx.globalCompositeOperation = 'source-atop';
    oCtx.drawImage(stampCanvas, 0, 0);
    oCtx.restore();

    // Live selection preview (lasso outline / marquee rectangle).
    const pts = pointsRef.current;
    if (pts.length > 0 && (isSelectingRef.current || polygonActive)) {
      oCtx.save();
      oCtx.strokeStyle = '#5ac8fa';
      oCtx.lineWidth = 1;
      oCtx.setLineDash([4, 4]);
      oCtx.lineJoin = 'round';

      if (tool === 'lasso' || tool === 'polygonal-lasso') {
        oCtx.beginPath();
        oCtx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          oCtx.lineTo(pts[i].x, pts[i].y);
        }
        // Rubber-band line to current hover position (polygonal only).
        if (tool === 'polygonal-lasso' && hoverPosRef.current) {
          oCtx.lineTo(hoverPosRef.current.x, hoverPosRef.current.y);
        } else if (tool === 'lasso' && lastPosRef.current) {
          // Already in pts for lasso (freehand appends on move).
        }
        if (tool === 'lasso') {
          oCtx.closePath();
        }
        oCtx.stroke();
      } else if (tool === 'rect-marquee') {
        const a = pts[0];
        const b = lastPosRef.current ?? pts[pts.length - 1];
        oCtx.strokeRect(
          Math.min(a.x, b.x),
          Math.min(a.y, b.y),
          Math.abs(b.x - a.x),
          Math.abs(b.y - a.y),
        );
      } else if (tool === 'ellipse-marquee') {
        const a = pts[0];
        const b = lastPosRef.current ?? pts[pts.length - 1];
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const rx = Math.abs(b.x - a.x) / 2;
        const ry = Math.abs(b.y - a.y) / 2;
        oCtx.beginPath();
        oCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        oCtx.stroke();
      }
      oCtx.restore();
    }
  }, [polygonActive, tool]);

  // ── Clear all ──────────────────────────────────────────
  const handleClear = () => {
    const paintCanvas = paintCanvasRef.current;
    if (!paintCanvas) return;
    const pCtx = paintCanvas.getContext('2d');
    if (!pCtx) return;
    pCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
    syncOverlay();
    const newMask = extractMaskFromCanvas(
      paintCanvas,
      paintCanvas.width,
      paintCanvas.height,
      invert,
    );
    onStrokeComplete(newMask);
  };

  // ── Invert toggle ──────────────────────────────────────
  const handleInvertToggle = () => {
    setInvert(prev => {
      const next = !prev;
      // Push a history entry for the invert change.
      const paintCanvas = paintCanvasRef.current;
      if (paintCanvas) {
        const newMask = extractMaskFromCanvas(
          paintCanvas,
          paintCanvas.width,
          paintCanvas.height,
          next,
        );
        onStrokeComplete(newMask);
      }
      return next;
    });
  };

  // ── Container layout: overlay positioned via full CSS matrix transform ──
  //
  // The overlay canvas is sized to the layer's NATURAL pixel dimensions
  // (layerWidth × layerHeight) and positioned at (0, 0) of the container,
  // then transformed via a CSS matrix that equals:
  //
  //   M_screen = view × layer
  //
  // where `layer` is composeLayerMatrix(layerTransform, naturalSize, docSize)
  // and `view` is composeViewMatrix(viewTransform). This makes the canvas
  // DOM element align pixel-perfectly with the rendered layer — including
  // rotation, skew, and flip — so the brush cursor and stroke preview are
  // always under the actual visible pixels of the layer.
  //
  // In v1 this was a plain axis-aligned rect, which broke for any layer
  // with rotation/skew (brush painted in the wrong place).
  const overlayCssTransform = useMemo(() => {
    const layerM = composeLayerMatrix(
      layerTransform,
      { w: layerWidth, h: layerHeight },
      { w: docWidth, h: docHeight },
    );
    const viewM = composeViewMatrix(viewTransform);
    const screenM = multiply(viewM, layerM);
    return matrixToCss(screenM);
  }, [layerTransform, viewTransform, layerWidth, layerHeight, docWidth, docHeight]);

  return (
    <div
      className={className}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        ...style,
      }}
    >
      {/* Overlay canvas — positioned over the layer via the composed
          view × layer CSS matrix transform (see overlayCssTransform above).
          Pointer events enabled only here (the rest of the container
          passes through).

          The canvas is sized to the layer's NATURAL pixel dimensions
          (layerWidth × layerHeight) and placed at (0,0); the CSS
          transform handles all positioning, rotation, scaling, skew.
          transform-origin is '0 0' so the matrix maps (0,0) → layer's
          top-left in screen-space, matching the math in
          transform-matrix.ts. */}
      <canvas
        ref={overlayCanvasRef}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: `${layerWidth}px`,
          height: `${layerHeight}px`,
          transform: overlayCssTransform,
          transformOrigin: '0 0',
          pointerEvents: 'auto',
          cursor: tool === 'polygonal-lasso' ? 'pointer' : 'crosshair',
          imageRendering: 'pixelated',
          // Slight tint to make the mask visible against the artwork.
          // Real mask rendering happens in composite.ts; this is just for
          // the editor's live preview.
          mixBlendMode: 'screen',
          outline: 'none',
        }}
      />
      {/* Hidden backing canvases — kept in DOM but never displayed. */}
      <canvas ref={paintCanvasRef} style={{ display: 'none' }} />
      <canvas ref={stampCanvasRef} style={{ display: 'none' }} />

      {/* Toolbar */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 8,
          padding: '8px 12px',
          background: 'rgba(40, 40, 45, 0.95)',
          borderRadius: 8,
          color: '#eee',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 13,
          pointerEvents: 'auto',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          zIndex: 10,
        }}
      >
        <button
          onClick={() => setTool('brush')}
          style={toolButtonStyle(tool === 'brush')}
          title="Brush (B)"
        >
          🖌 Brush
        </button>
        <button
          onClick={() => setTool('eraser')}
          style={toolButtonStyle(tool === 'eraser')}
          title="Eraser (E)"
        >
          ⌫ Eraser
        </button>
        <Divider />
        <button
          onClick={() => setTool('lasso')}
          style={toolButtonStyle(tool === 'lasso')}
          title="Freehand Lasso (L) — drag to draw a freeform selection"
        >
          ✎ Lasso
        </button>
        <button
          onClick={() => setTool('polygonal-lasso')}
          style={toolButtonStyle(tool === 'polygonal-lasso')}
          title="Polygonal Lasso (P) — click to add points, double-click or Enter to close"
        >
          ◇ Poly
        </button>
        <button
          onClick={() => setTool('rect-marquee')}
          style={toolButtonStyle(tool === 'rect-marquee')}
          title="Rectangular Marquee (R) — drag to select a rectangle"
        >
          ▭ Rect
        </button>
        <button
          onClick={() => setTool('ellipse-marquee')}
          style={toolButtonStyle(tool === 'ellipse-marquee')}
          title="Elliptical Marquee (O) — drag to select an ellipse"
        >
          ◯ Ellipse
        </button>
        <Divider />
        <label style={labelStyle}>
          Size
          <input
            type="range"
            min={1}
            max={500}
            value={brush.size}
            onChange={e => setBrush(b => ({ ...b, size: Number(e.target.value) }))}
            style={{ width: 100 }}
          />
          <span style={{ width: 32, textAlign: 'right' }}>{brush.size}</span>
        </label>
        <Divider />
        <label style={labelStyle}>
          Hard
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(brush.hardness * 100)}
            onChange={e =>
              setBrush(b => ({ ...b, hardness: Number(e.target.value) / 100 }))
            }
            style={{ width: 80 }}
          />
          <span style={{ width: 32, textAlign: 'right' }}>
            {Math.round(brush.hardness * 100)}
          </span>
        </label>
        <Divider />
        <label style={labelStyle}>
          Opacity
          <input
            type="range"
            min={1}
            max={100}
            value={Math.round(brush.opacity * 100)}
            onChange={e =>
              setBrush(b => ({ ...b, opacity: Number(e.target.value) / 100 }))
            }
            style={{ width: 80 }}
          />
          <span style={{ width: 32, textAlign: 'right' }}>
            {Math.round(brush.opacity * 100)}
          </span>
        </label>
        <Divider />
        <button
          onClick={handleInvertToggle}
          style={toolButtonStyle(invert)}
          title="Invert mask"
        >
          ⇋ Invert
        </button>
        <button
          onClick={handleClear}
          style={toolButtonStyle(false)}
          title="Clear entire mask"
        >
          ✕ Clear
        </button>
        <Divider />
        <button
          onClick={onClose}
          style={{
            ...toolButtonStyle(false),
            background: '#3a7bd5',
            color: '#fff',
            border: 'none',
          }}
          title="Finish editing mask"
        >
          ✓ Done
        </button>
      </div>

      {/* Status line */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '4px 10px',
          background: 'rgba(40, 40, 45, 0.85)',
          borderRadius: 6,
          color: '#ccc',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 11,
          pointerEvents: 'none',
          zIndex: 10,
        }}
      >
        Mask editor — layer "{layer.name}" · {layerWidth}×{layerHeight}px ·{' '}
        {tool === 'brush' ? `Brush ${brush.size}px` :
         tool === 'eraser' ? `Eraser ${brush.size}px` :
         tool === 'lasso' ? 'Freehand Lasso (Alt = subtract)' :
         tool === 'polygonal-lasso' ?
           (polygonActive ? `Polygon (${pointsRef.current.length} pts, dbl-click to close)` : 'Polygonal Lasso — click to start') :
         tool === 'rect-marquee' ? 'Rect Marquee (Alt = subtract)' :
         tool === 'ellipse-marquee' ? 'Ellipse Marquee (Alt = subtract)' :
         tool}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Extract a painted-mask object from the current paint canvas state. */
function extractMaskFromCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  invert: boolean,
): Extract<LayerMask, { type: 'painted' }> {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return {
      type: 'painted',
      width,
      height,
      data: new Uint8Array(width * height),
      invert,
    };
  }
  const imgData = ctx.getImageData(0, 0, width, height);
  const src = imgData.data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    // Use alpha channel only (we always wrote RGB=255).
    data[i] = src[i * 4 + 3];
  }
  return { type: 'painted', width, height, data, invert };
}

// ────────────────────────────────────────────────────────────
// Inline style helpers (kept here to avoid a separate CSS file)
// ────────────────────────────────────────────────────────────

function toolButtonStyle(active: boolean): CSSProperties {
  return {
    padding: '4px 10px',
    border: '1px solid #555',
    borderRadius: 4,
    background: active ? '#555' : '#2a2a2e',
    color: active ? '#fff' : '#ccc',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'inherit',
  };
}

const labelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
};

function Divider(): JSX.Element {
  return (
    <div
      style={{
        width: 1,
        background: '#555',
        alignSelf: 'stretch',
        margin: '4px 0',
      }}
    />
  );
}

// ────────────────────────────────────────────────────────────
// Default export for lazy loading
// ────────────────────────────────────────────────────────────

export default MaskEditor;
