// ============================================================
// COMPOSITE — multi-layer rendering for GenToniK Standalone
// ============================================================
//
// This file is the bridge between the Layer model (types.ts) and
// the actual pixels on screen. It takes an ordered list of layers
// (bottom-to-top) and composites them onto a destination canvas,
// respecting for each layer:
//   • visibility (visible: false → skipped entirely)
//   • opacity    (0..1, via globalAlpha)
//   • blend mode (normal/multiply/screen/overlay/darken/lighten)
//   • transform  (translate + scale + rotate, around layer center)
//   • mask       (shape ellipse/rect, or painted alpha)
//
// Rendering pipeline per visible layer:
//
//   ┌─────────────────────────────────────────────────────────┐
//   │ 1. Allocate offscreen canvas at layer's natural size     │
//   │ 2. Render layer content (screentone / image / solid)     │
//   │ 3. Apply mask (if any) via destination-in compositing    │
//   │ 4. drawImage onto destination with transform + blend     │
//   └─────────────────────────────────────────────────────────┘
//
// Why offscreen per layer:
//   • Mask must be applied BEFORE transform/blend — otherwise
//     feathering and painted alpha get warped by the layer
//     transform, which is wrong (mask is in layer-local space).
//   • globalCompositeOperation='destination-in' affects the
//     ENTIRE destination canvas — we can't apply it to just one
//     layer. So we need a scratch buffer.
//   • Future caching: once a screentone layer's params haven't
//     changed, we can keep the offscreen canvas and skip step 2
//     on the next composite pass.
//
// Image layer loading is asynchronous in the browser, so the
// caller MUST pre-load all images and pass them in via
// `imageCache`. Composite itself is synchronous.
// ============================================================

import {
  Layer,
  LayerMask,
  Vec2,
  ColorProfile,
  blendToCompositeOp,
  getLayerNaturalSize,
  SelectionEntry,
} from './types';
import { renderScreentone } from './engine';
import {
  computeHomography,
  applyHomography,
  affineFromTriangle,
  pointInQuad,
  isQuadDegenerate,
} from './homography';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/**
 * Cached loaded images, keyed by layer.imageSrc.
 *
 * The caller (App.tsx) is responsible for loading these via
 * `new Image()` + `img.decode()` and updating the cache when
 * imageSrc changes. Composite does NOT do async loading.
 *
 * Why: composite is called on every frame during interactive
 * editing (dragging a slider, painting a mask). We can't afford
 * to await image loads inside the render loop.
 */
export interface ImageCache {
  /** Map from imageSrc (data: URL or object URL) → decoded HTMLImageElement */
  images: Map<string, HTMLImageElement>;
  /** Map from imageSrc → {w, h} natural pixel size */
  sizes: Map<string, { w: number; h: number }>;
}

/**
 * Context passed to compositeLayers.
 */
export interface CompositeContext {
  /** Document width in px (the destination canvas size) */
  docWidth: number;
  /** Document height in px */
  docHeight: number;
  /** Pre-loaded image cache for 'image' layers */
  imageCache: ImageCache;
  /**
   * Optional: DPI for unit conversion (px↔mm↔in↔lpi).
   * Passed to renderScreentone via params, but the conversion
   * itself happens BEFORE composite (in App.tsx) — composite
   * only sees already-converted px values.
   */
  dpi?: number;
  /**
   * Optional: Adaptive perspective subdivision grid size (Gemini 2.3 fix).
   * Controls the N×N triangle grid used by drawImageWithPerspective.
   *
   *   - During active perspective drag (live preview): pass 2 or 4
   *     (8–32 triangles) for instant feedback.
   *   - On pointer-up / commit / export: pass 8 or 16 (128–512 triangles)
   *     for high-quality final render.
   *
   * If undefined, defaults to 8 (medium quality, used when no live drag
   * is happening — e.g., initial load, undo/redo, layer ops).
   */
  perspectiveSubdivisions?: number;
}

// ────────────────────────────────────────────────────────────
// Offscreen canvas allocation
// ────────────────────────────────────────────────────────────

/**
 * Pool of offscreen canvases, reused across composite calls.
 *
 * Creating a <canvas> is expensive (~1ms in Chrome). For a 10-layer
 * document edited at 60fps, that's 600ms/sec just on allocation.
 * Pooling eliminates this — we reuse canvases large enough for
 * the requested size, only allocating when we need a bigger one.
 *
 * The pool is module-level (singleton). This is fine for a
 * Standalone app where only one composite runs at a time.
 */
const canvasPool: HTMLCanvasElement[] = [];

function acquireCanvas(width: number, height: number): HTMLCanvasElement {
  // A2.2.4: Find the smallest pooled canvas that fits, REMOVE IT FROM
  // THE POOL, and return it. Previously this function returned a
  // reference WITHOUT removing it from the pool, which caused a
  // catastrophic aliasing bug:
  //
  //   1. compositeSingleLayer calls acquireCanvas(W, H) → returns A
  //      (A is still in pool)
  //   2. compositeSingleLayer renders white bg + dots into A
  //   3. applyPaintedMask calls acquireCanvas(W, H) → returns A AGAIN
  //      (A is still in pool, fits the size)
  //   4. Setting A.width = W (even to the same value) CLEARS the canvas
  //      per HTML spec — dots and white bg are GONE
  //   5. putImageData writes mask data into A
  //   6. ctx.drawImage(A, 0, 0) onto A is a no-op (drawing canvas
  //      onto itself is undefined behavior, no-op in Chrome)
  //   7. destCtx.drawImage(A, 0, 0) draws only the mask onto dest
  //   8. User sees: "solid white rectangle in shape of selection"
  //      instead of the actual screentone pattern
  //
  // Fix: splice the canvas out of the pool when acquired. This
  // guarantees that nested acquireCanvas calls (e.g. inside
  // applyPaintedMask while compositeSingleLayer holds an offscreen)
  // return DIFFERENT canvases.
  let bestIdx = -1;
  let bestArea = Infinity;
  for (let i = 0; i < canvasPool.length; i++) {
    const c = canvasPool[i];
    if (c.width >= width && c.height >= height) {
      const area = c.width * c.height;
      if (area < bestArea) {
        bestIdx = i;
        bestArea = area;
      }
    }
  }
  const canvas = bestIdx >= 0
    ? canvasPool.splice(bestIdx, 1)[0]
    : document.createElement('canvas');
  // Set size even for reused canvases — drawImage with mismatched
  // sizes silently produces wrong output. NOTE: setting width/height
  // always clears the canvas per HTML spec, even if the value is
  // unchanged.
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  // Cap pool size at 8 — enough for typical layered docs without
  // unbounded memory growth.
  if (canvasPool.length < 8) {
    canvasPool.push(canvas);
  }
}

// ────────────────────────────────────────────────────────────
// Layer content rendering (to offscreen)
// ────────────────────────────────────────────────────────────

/**
 * Render a layer's content into `ctx`, sized to the layer's natural
 * dimensions. The caller is responsible for sizing the canvas.
 *
 * For 'screentone' layers: calls renderScreentone with the params.
 *   Note: ScreentoneParams has a `unit` field, but unit conversion
 *   must already be applied to spacing/dotSize by the caller
 *   (App.tsx does this when params change). Composite sees px.
 *
 * For 'image' layers: draws the cached HTMLImageElement at (0,0).
 *   If the image isn't in the cache, draws nothing (silently) —
 *   the caller should ensure images are pre-loaded.
 *
 * For 'solid' layers: fills with the solidColor. The natural size
 *   for solids is 1×1 (per getLayerNaturalSize), but composite
 *   stretches it to the document size at draw time via transform.
 */
function renderLayerContent(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  width: number,
  height: number,
  compositeCtx: CompositeContext,
): void {
  switch (layer.type) {
    case 'screentone': {
      if (!layer.params) return;
      // renderScreentone fills the canvas with colorBg first,
      // then draws the pattern on top.
      const originX = (compositeCtx.docWidth / 2 + layer.transform.x) - width / 2;
      const originY = (compositeCtx.docHeight / 2 + layer.transform.y) - height / 2;
      renderScreentone(ctx, width, height, layer.params, originX, originY);
      break;
    }
    case 'image': {
      const img = layer.imageSrc
        ? compositeCtx.imageCache.images.get(layer.imageSrc)
        : undefined;
      if (!img) return;
      // Draw the image at its natural size. The layer's natural
      // size already matches the image's natural size (per
      // getLayerNaturalSize), so we draw at (0,0) without scaling.
      ctx.drawImage(img, 0, 0, width, height);
      break;
    }
    case 'solid': {
      if (!layer.solidColor) return;
      ctx.fillStyle = layer.solidColor;
      ctx.fillRect(0, 0, width, height);
      break;
    }
    case 'transparent': {
      // No content to render — the layer is intentionally empty.
      // Any mask applied to this layer is still processed downstream
      // (applyPaintedMask / canvasSpacePolygon clip in compositeSingleLayer).
      // Returning without drawing leaves the layer's offscreen buffer
      // fully transparent, which is exactly what we want.
      return;
    }
    case 'text': {
      // v2.9 STUB: Text layers are not rendered by the core.
      // A future TextRenderer (registered via PluginRegistry) will handle
      // this. For now, check if a plugin has registered a renderer for
      // 'text' layers; if so, call it. Otherwise, no-op.
      //
      // We can't import pluginRegistry here (would create a circular dep
      // types.ts → composite.ts → types.ts). The plugin check happens in
      // the caller (compositeSingleLayer) which CAN import types.ts.
      // Here we just return — the caller handles plugin delegation.
      return;
    }
    case 'vector': {
      // v2.9 STUB: Vector layers are not rendered by the core.
      // Same as 'text' — a future VectorRenderer will handle this.
      return;
    }
  }
}

// ────────────────────────────────────────────────────────────
// Mask application
// ────────────────────────────────────────────────────────────

/**
 * Apply a shape mask to the current offscreen canvas content.
 *
 * Strategy:
 *   1. Set globalCompositeOperation = 'destination-in' — keeps
 *      only the pixels under the next drawn shape.
 *   2. If feather > 0, set ctx.filter = `blur(${feather}px)` —
 *      the blur applies to the shape we draw, softening its edge.
 *   3. Draw the mask shape (ellipse or rect) at its bounds.
 *   4. If invert is true, do a second pass with 'destination-out'
 *      on a full-canvas rect — but inverted shape masks are easier
 *      to implement as: draw shape with 'destination-out' instead.
 *
 * The `bounds` are in the offscreen canvas's coordinate space,
 * which is the layer's natural size. The caller must ensure
 * bounds match the layer's coordinate system (typically this means
 * "document-space" bounds get translated by the inverse transform
 * at compose time — but for v1 we keep mask bounds in layer-local
 * space to match where the user drew them).
 *
 * NOTE: ctx.filter is NOT supported in Safari < 14. For those
 * browsers feather falls back to a hard-edge mask. Acceptable
 * for a personal tool.
 */
function applyShapeMask(
  ctx: CanvasRenderingContext2D,
  mask: Extract<LayerMask, { type: 'shape' }>,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const { shape, bounds, feather, invert } = mask;
  const cx = (bounds.left + bounds.right) / 2;
  const cy = (bounds.top + bounds.bottom) / 2;
  const rx = (bounds.right - bounds.left) / 2;
  const ry = (bounds.bottom - bounds.top) / 2;

  ctx.save();

  // Feather via canvas filter. Wrapped in try/catch because some
  // browsers throw on unknown filter syntax (older Safari).
  if (feather > 0) {
    try {
      ctx.filter = `blur(${feather}px)`;
    } catch {
      // Filter unsupported — fall back to hard edge.
    }
  }

  // For invert=true we want to KEEP pixels OUTSIDE the shape and
  // REMOVE pixels INSIDE. That's the same as 'destination-out'
  // with the shape. For invert=false, KEEP pixels INSIDE the
  // shape — that's 'destination-in' with the shape.
  ctx.globalCompositeOperation = invert ? 'destination-out' : 'destination-in';

  ctx.beginPath();
  if (shape === 'ellipse') {
    ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
  } else {
    // rect
    ctx.rect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  }
  ctx.fill();

  // If we set a filter, we need a second pass without filter to
  // catch any pixels that the blur left semi-transparent inside
  // the shape (otherwise the inside gets blurred too, which is
  // wrong — only the EDGE should be soft). Reset filter and
  // redraw the shape with hard edge to "lock in" the interior.
  if (feather > 0) {
    ctx.filter = 'none';
    ctx.fill();
  }

  ctx.restore();
  // Note: we don't reset globalCompositeOperation here because
  // the caller will restore() the full ctx state. But to be safe
  // for callers that don't save/restore, reset it.
  ctx.globalCompositeOperation = 'source-over';
  void canvasWidth; void canvasHeight; // currently unused, kept for API symmetry
}

/**
 * Apply a painted (per-pixel alpha) mask to the current offscreen
 * canvas content.
 *
 * Strategy:
 *   1. Create a temp canvas at mask dimensions.
 *   2. Build an ImageData where R=G=B=255 and A=mask.data[i].
 *      (Color doesn't matter — only alpha is used by 'destination-in'.)
 *   3. drawImage the temp canvas onto the layer canvas at
 *      (mask.offsetX, mask.offsetY) with 'destination-in'
 *      (or 'destination-out' if invert=true).
 *
 * We can't use putImageData directly because it ignores
 * globalCompositeOperation. drawImage with a temp canvas is the
 * standard workaround.
 *
 * The mask may be smaller than the layer (e.g., user painted only
 * a region). `offsetX/offsetY` anchor the mask's (0,0) in LAYER-LOCAL
 * space (the layer's natural-size coordinate system, BEFORE the layer
 * transform is applied — see compositeSingleLayer L577-578).
 *
 * Mask editor always paints full-size → offsetX=offsetY=0.
 * Selection tools compute the polygon in canvas-px, then invert the
 * layer matrix to map into layer-local space → mask is anchored at
 * the floor-left of the inverse-transformed polygon's AABB.
 *
 * Before A2-fix-mask-transform (2026-06-25), this function always
 * drew at (0,0) → lasso/marquee masks landed in the top-left of the
 * layer regardless of where the user selected.
 */
function applyPaintedMask(
  ctx: CanvasRenderingContext2D,
  mask: Extract<LayerMask, { type: 'painted' }>,
): void {
  const { width: mw, height: mh, data, invert } = mask;
  // offsetX/offsetY default to 0 for legacy masks (mask editor, .ora import).
  // Selection tools always set them explicitly.
  const ox = (mask as { offsetX?: number }).offsetX ?? 0;
  const oy = (mask as { offsetY?: number }).offsetY ?? 0;
  if (mw <= 0 || mh <= 0 || data.length !== mw * mh) return;

  // Build an RGBA ImageData from the single-channel alpha array.
  const tempCanvas = acquireCanvas(mw, mh);

  // A2.2.4: defense-in-depth — detect aliasing between tempCanvas and
  // the destination ctx's canvas. If acquireCanvas ever returns the
  // SAME canvas that ctx belongs to (e.g. due to a pool regression),
  // setting tempCanvas.width below would CLEAR the destination,
  // wiping out the just-rendered layer content. Throw with a clear
  // message instead of silently producing a "solid white rectangle".
  const destCanvas = ctx.canvas;
  if (destCanvas && tempCanvas === destCanvas) {
    releaseCanvas(tempCanvas);
    console.error('[A2.2.4] applyPaintedMask: tempCanvas aliases destination canvas — acquireCanvas pool bug!');
    return;
  }

  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) {
    releaseCanvas(tempCanvas);
    return;
  }

  const imgData = tempCtx.createImageData(mw, mh);
  const dst = imgData.data;
  for (let i = 0; i < data.length; i++) {
    const a = data[i];
    dst[i * 4]     = 255;
    dst[i * 4 + 1] = 255;
    dst[i * 4 + 2] = 255;
    dst[i * 4 + 3] = invert ? 255 - a : a;
  }
  tempCtx.putImageData(imgData, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = invert ? 'destination-out' : 'destination-in';
  ctx.drawImage(tempCanvas, ox, oy);
  ctx.restore();

  releaseCanvas(tempCanvas);
}

/**
 * Build a 'painted' LayerMask of FIXED dimensions from a closed polygon
 * in layer-local coordinates. Used by "New Layer from Selection" (A2.2):
 * the mask size = layer natural size (bbox of original selection), and
 * the polygon is drawn inside that canvas with alpha=255 inside, alpha=0
 * outside.
 *
 * Unlike rasterizePolygon (which computes its own tight AABB), this
 * function lets the caller specify width/height explicitly — so the
 * mask can match the layer's natural size exactly, even if the polygon
 * doesn't fill the entire bbox (alpha=0 outside polygon is fine).
 *
 * @param points   — polygon vertices in layer-local coords (already
 *                   shifted so the polygon is positioned correctly
 *                   inside the [0..width, 0..height] canvas).
 * @param width    — mask width in px (typically = layer naturalWidth).
 * @param height   — mask height in px (typically = layer naturalHeight).
 * @param offsetX  — mask origin offset in layer-local space.
 *                   Pass 0 if mask aligns with layer bounds (A2.2 case).
 * @param offsetY  — mask origin offset in layer-local space.
 * @param invert   — if true, alpha=255 outside polygon, alpha=0 inside.
 * @returns LayerMask of type 'painted'.
 */
export function polygonToMaskFixedSize(
  points: Vec2[],
  width: number,
  height: number,
  offsetX: number = 0,
  offsetY: number = 0,
  invert: boolean = false,
): LayerMask {
  // Guard against unbounded allocation
  if (width > MAX_MASK_DIM || height > MAX_MASK_DIM) {
    console.warn(`[polygonToMaskFixedSize] dimensions ${width}×${height} exceed MAX_MASK_DIM=${MAX_MASK_DIM}, clamping`);
    width = Math.min(width, MAX_MASK_DIM);
    height = Math.min(height, MAX_MASK_DIM);
  }
  if (width <= 0 || height <= 0 || points.length < 3) {
    return {
      type: 'painted',
      width: Math.max(1, width),
      height: Math.max(1, height),
      data: new Uint8Array(Math.max(1, width * height)),
      offsetX,
      offsetY,
      invert,
    };
  }

  const tempCanvas = acquireCanvas(width, height);
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) {
    releaseCanvas(tempCanvas);
    return {
      type: 'painted',
      width, height,
      data: new Uint8Array(width * height),
      offsetX, offsetY,
      invert,
    };
  }

  // Draw polygon at (offsetX, offsetY) origin in temp canvas
  tempCtx.beginPath();
  tempCtx.moveTo(points[0].x + offsetX, points[0].y + offsetY);
  for (let i = 1; i < points.length; i++) {
    tempCtx.lineTo(points[i].x + offsetX, points[i].y + offsetY);
  }
  tempCtx.closePath();
  tempCtx.fillStyle = 'white';
  tempCtx.fill();

  // Extract alpha channel
  const imageData = tempCtx.getImageData(0, 0, width, height);
  const src = imageData.data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = src[i * 4 + 3];
  }

  releaseCanvas(tempCanvas);
  return {
    type: 'painted',
    width, height,
    data,
    offsetX, offsetY,
    invert,
  };
}

/**
 * Apply any mask (shape or painted) to the current offscreen canvas.
 * No-op if mask is undefined.
 */
function applyMask(
  ctx: CanvasRenderingContext2D,
  mask: LayerMask | undefined,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (!mask) return;
  if (mask.type === 'shape') {
    applyShapeMask(ctx, mask, canvasWidth, canvasHeight);
  } else {
    applyPaintedMask(ctx, mask);
  }
}

// ────────────────────────────────────────────────────────────
// Layer compositing onto destination
// ────────────────────────────────────────────────────────────

/**
 * Composite a single layer onto the destination canvas.
 *
 * The layer is rendered to an offscreen canvas at its natural
 * size, mask is applied, then the offscreen is drawImage'd onto
 * the destination with:
 *   - blend mode (globalCompositeOperation)
 *   - opacity    (globalAlpha)
 *   - transform  (translate + rotate + scale around layer center)
 *
 * Transform math:
 *   The destination canvas has its origin at top-left. Layer
 *   transform.x/y is the offset of the layer's CENTER from the
 *   document's CENTER (not top-left). So:
 *
 *     destCenterX = docWidth/2 + transform.x
 *     destCenterY = docHeight/2 + transform.y
 *
 *   We translate to (destCenterX, destCenterY), rotate, scale,
 *   then translate by (-naturalW/2, -naturalH/2) so the layer's
 *   center aligns with (destCenterX, destCenterY).
 */

// ────────────────────────────────────────────────────────────
// PERSPECTIVE RENDERER (Phase 2 — 4-corner free transform)
// ────────────────────────────────────────────────────────────
//
// When layer.transform.corners is set, the layer is rendered via
// homography: the source rectangle (0,0,W,H) is mapped to the 4
// canvas-space corners via a 3×3 perspective matrix.
//
// Canvas2D has no native perspective support, so we subdivide the
// source rectangle into an N×N grid and render each sub-cell as
// two triangles. For each triangle we compute a 2×3 affine matrix
// via affineFromTriangle() and use ctx.setTransform + clip +
// drawImage. With enough subdivisions (default 8×8 = 128 triangles)
// the perspective distortion is visually correct.
//
// Trade-off: more subdivisions = better quality but slower.
// 8×8 is a good default; 4×4 for live drag, 16×16 for final export.

/**
 * Render a source canvas onto destCtx with a 4-corner perspective
 * transform.
 *
 * @param destCtx       — destination 2D context (canvas-pixel space)
 * @param srcCanvas     — source canvas (already rendered with content + mask)
 * @param srcW, srcH    — source dimensions
 * @param dstCorners    — [TL, TR, BR, BL] in canvas-pixel space
 * @param subdivisions  — grid resolution (default 8 → 64 cells, 128 triangles)
 *
 * The caller is responsible for setting globalAlpha and
 * globalCompositeOperation before calling this function. The
 * function saves/restores the destCtx transform.
 */
function drawImageWithPerspective(
  destCtx: CanvasRenderingContext2D,
  srcCanvas: HTMLCanvasElement,
  srcW: number,
  srcH: number,
  dstCorners: readonly [Vec2, Vec2, Vec2, Vec2],
  subdivisions: number = 8,
): void {
  if (srcW <= 0 || srcH <= 0) return;
  if (isQuadDegenerate(dstCorners)) return;

  // Source quad: (0,0)-(W,0)-(W,H)-(0,H) — matches corner order [TL,TR,BR,BL].
  const srcQuad: [Vec2, Vec2, Vec2, Vec2] = [
    { x: 0,  y: 0 },
    { x: srcW, y: 0 },
    { x: srcW, y: srcH },
    { x: 0,  y: srcH },
  ];

  const H = computeHomography(srcQuad, dstCorners);
  if (!H) {
    // Fallback: render as a plain rectangle at the AABB of dstCorners.
    // This ensures the layer is still visible even if perspective fails.
    const xs = dstCorners.map(c => c.x);
    const ys = dstCorners.map(c => c.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    destCtx.drawImage(srcCanvas, minX, minY, maxX - minX, maxY - minY);
    return;
  }

  // Subdivide source into NxN grid. For each cell, compute 4 src
  // corners (regular grid) and 4 dst corners (via applyHomography).
  // Then split into 2 triangles and render each via affineFromTriangle.
  const N = Math.max(1, Math.min(32, subdivisions));

  // Precompute dst corner positions for the entire (N+1)×(N+1) grid
  // to avoid recomputing shared vertices between adjacent triangles.
  const grid: Vec2[] = new Array((N + 1) * (N + 1));
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const sx = (i / N) * srcW;
      const sy = (j / N) * srcH;
      grid[j * (N + 1) + i] = applyHomography(H, { x: sx, y: sy });
    }
  }

  // For each cell, render 2 triangles:
  //   Triangle A: TL, TR, BL  (src: (i,j), (i+1,j), (i,j+1))
  //   Triangle B: TR, BR, BL  (src: (i+1,j), (i+1,j+1), (i,j+1))
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const sTL = { x: (i / N) * srcW,     y: (j / N) * srcH };
      const sTR = { x: ((i + 1) / N) * srcW, y: (j / N) * srcH };
      const sBR = { x: ((i + 1) / N) * srcW, y: ((j + 1) / N) * srcH };
      const sBL = { x: (i / N) * srcW,     y: ((j + 1) / N) * srcH };

      const dTL = grid[j * (N + 1) + i];
      const dTR = grid[j * (N + 1) + (i + 1)];
      const dBR = grid[(j + 1) * (N + 1) + (i + 1)];
      const dBL = grid[(j + 1) * (N + 1) + i];

      // Triangle A: TL, TR, BL
      drawTriangleAffine(destCtx, srcCanvas,
        [sTL, sTR, sBL],
        [dTL, dTR, dBL]);
      // Triangle B: TR, BR, BL
      drawTriangleAffine(destCtx, srcCanvas,
        [sTR, sBR, sBL],
        [dTR, dBR, dBL]);
    }
  }
}

/**
 * Render a single source triangle to a destination triangle via
 * an affine transform computed from the 3-point correspondence.
 *
 * The destCtx transform is saved/restored. The clip path is
 * defined in source coordinates (which, after setTransform,
 * maps to the destination triangle).
 */
function drawTriangleAffine(
  destCtx: CanvasRenderingContext2D,
  srcCanvas: HTMLCanvasElement,
  srcTri: readonly [Vec2, Vec2, Vec2],
  dstTri: readonly [Vec2, Vec2, Vec2],
): void {
  const M = affineFromTriangle(srcTri, dstTri);
  if (!M) return;
  const [a, b, c, d, e, f] = M;

  destCtx.save();
  // setTransform replaces the current transform. After this,
  // drawing at source coords (x, y) lands at the corresponding
  // dst position.
  destCtx.setTransform(a, b, c, d, e, f);
  // Clip to the source triangle — after setTransform, this
  // becomes the dst triangle in screen space.
  destCtx.beginPath();
  destCtx.moveTo(srcTri[0].x, srcTri[0].y);
  destCtx.lineTo(srcTri[1].x, srcTri[1].y);
  destCtx.lineTo(srcTri[2].x, srcTri[2].y);
  destCtx.closePath();
  destCtx.clip();
  destCtx.drawImage(srcCanvas, 0, 0);
  destCtx.restore();
}

function compositeSingleLayer(
  destCtx: CanvasRenderingContext2D,
  layer: Layer,
  compositeCtx: CompositeContext,
): void {


  if (!layer.visible || layer.opacity <= 0) return;

  const naturalSize = getLayerNaturalSize(layer, {
    docWidth: compositeCtx.docWidth,
    docHeight: compositeCtx.docHeight,
    imageSizes: compositeCtx.imageCache.sizes,
  });

  // Screentone layers always fill the document — their natural
  // size IS the document size. Image layers use their intrinsic
  // size. Solid layers are 1×1 (will be stretched to fill below).
  // For solid layers specifically, we render them at doc size so
  // the transform behaves intuitively (scaling a solid by 2x = 2x
  // the area filled, not 2x of a 1px dot).
  //
  // Transparent layers get the same docSize override: they have no
  // intrinsic content, but we still need a sane render box so that
  // transform handles, masks, and the canvas-space clip work correctly.
  // v2.9: text/vector layers also get docSize override (no intrinsic size
  // until a renderer measures their content).
  let renderW = naturalSize.w;
  let renderH = naturalSize.h;
  if (layer.type === 'solid' || layer.type === 'transparent'
      || layer.type === 'text' || layer.type === 'vector') {
    renderW = compositeCtx.docWidth;
    renderH = compositeCtx.docHeight;
  }

  if (renderW <= 0 || renderH <= 0) return;

  // ── Step 1+2: Render content to offscreen ──────────────
  const offscreen = acquireCanvas(renderW, renderH);
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) {
    releaseCanvas(offscreen);
    return;
  }
  // Clear to transparent (acquireCanvas may return a previously
  // used canvas with leftover pixels).
  offCtx.clearRect(0, 0, renderW, renderH);
  renderLayerContent(offCtx, layer, renderW, renderH, compositeCtx);

  // ── Step 3: Apply mask (in layer-local space) ──────────
  // PRESERVE-PERSPECTIVE: if the mask has canvasSpacePolygon, it's a
  // canvas-space mask applied AFTER perspective (as a clip on destCtx).
  // In that case, we skip the layer-local painted mask here and apply
  // the clip in step 4 instead.
  const hasCanvasSpaceMask = layer.mask?.type === 'painted' && layer.mask.canvasSpacePolygon;
  if (!hasCanvasSpaceMask) {
    applyMask(offCtx, layer.mask, renderW, renderH);
  }

  // ── Step 4: drawImage onto destination with transform ──
  destCtx.save();

  // PRESERVE-PERSPECTIVE: apply canvas-space mask as a clip BEFORE drawing.
  // This clips the destination to the polygon in canvas-pixel space,
  // so the visible area matches the selection outline exactly regardless
  // of the layer's perspective deformation.
  if (hasCanvasSpaceMask && layer.mask?.type === 'painted' && layer.mask.canvasSpacePolygon) {
    const poly = layer.mask.canvasSpacePolygon;
    if (poly.length >= 3) {
      destCtx.beginPath();
      destCtx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) {
        destCtx.lineTo(poly[i].x, poly[i].y);
      }
      destCtx.closePath();
      destCtx.clip();
    }
  }

  // Blend mode + opacity. globalAlpha multiplies with per-pixel
  // alpha, so opacity=0.5 → half-transparent layer.
  destCtx.globalCompositeOperation = blendToCompositeOp(layer.blendMode);
  destCtx.globalAlpha = layer.opacity;

  // Branch: perspective (corners set) vs affine (default).
  if (layer.transform.corners) {
    // Perspective path — bypass translate/rotate/scale/skew and
    // render via homography subdivision.
    // Gemini 2.3 fix: use adaptive subdivisions from context.
    // App.tsx sets this to 2 or 4 during live drag for instant
    // feedback, and 8 or 16 on commit for quality.
    drawImageWithPerspective(
      destCtx, offscreen, renderW, renderH,
      layer.transform.corners,
      compositeCtx.perspectiveSubdivisions ?? 8,
    );
  } else {
    // Affine path — translate to the layer's destination center.
    const destCenterX = compositeCtx.docWidth / 2 + layer.transform.x;
    const destCenterY = compositeCtx.docHeight / 2 + layer.transform.y;
    destCtx.translate(destCenterX, destCenterY);

    // Apply rotation (degrees → radians, clockwise).
    if (layer.transform.rotation !== 0) {
      destCtx.rotate((layer.transform.rotation * Math.PI) / 180);
    }

    // Apply skew (shear) AFTER scale, BEFORE the centering translate.
    // ctx.transform(a, b, c, d, e, f) sets the matrix:
    //   | a c e |
    //   | b d f |
    //   | 0 0 1 |
    // For pure skew with no scale (scale already applied above):
    //   a=1, b=tan(skewY), c=tan(skewX), d=1, e=0, f=0
    // tan(89°) ≈ 57.3 — large but finite. Clamp to avoid NaN at exactly 90°.
    if (layer.transform.skewX !== 0 || layer.transform.skewY !== 0) {
      const skewXRad = (Math.max(-89, Math.min(89, layer.transform.skewX)) * Math.PI) / 180;
      const skewYRad = (Math.max(-89, Math.min(89, layer.transform.skewY)) * Math.PI) / 180;
      destCtx.transform(1, Math.tan(skewYRad), Math.tan(skewXRad), 1, 0, 0);
    }

    // Apply scale.
    if (layer.transform.scaleX !== 1 || layer.transform.scaleY !== 1) {
      destCtx.scale(layer.transform.scaleX, layer.transform.scaleY);
    }

    // Translate so the layer's center sits at the origin (where we
    // just translated to). After this, drawing at (0,0) with size
    // (renderW, renderH) places the layer correctly.
    destCtx.translate(-renderW / 2, -renderH / 2);

    destCtx.drawImage(offscreen, 0, 0);
  }

  destCtx.restore();
  releaseCanvas(offscreen);
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Composite all visible layers onto the destination canvas.
 *
 * Layers are drawn in array order: index 0 = bottom, last index = top.
 * The destination canvas is NOT cleared first — the caller is
 * responsible for clearing (or filling with a checkerboard, etc.)
 * if needed. This lets callers composite onto an existing image
 * (e.g., a paper texture) without us wiping it.
 *
 * Performance notes:
 *   • Offscreen canvases are pooled — no per-frame allocation.
 *   • Layer content is re-rendered every call. Future optimization:
 *     cache the offscreen until layer.params or layer.imageSrc
 *     changes (dirty flag on Layer).
 *   • Image layers require pre-loaded HTMLImageElement in imageCache.
 *
 * @param destCtx       Destination 2D context
 * @param layers        Layers, bottom-to-top
 * @param compositeCtx  Document size + image cache
 */
export function compositeLayers(
  destCtx: CanvasRenderingContext2D,
  layers: Layer[],
  compositeCtx: CompositeContext,
): void {
  // Save/restore around the whole loop so we don't leak any
  // composite-operation or alpha state to the caller.
  destCtx.save();
  for (const layer of layers) {
    compositeSingleLayer(destCtx, layer, compositeCtx);
  }
  destCtx.restore();
}

/**
 * Composite a SINGLE layer onto the destination, ignoring all
 * other layers. Used by the UI for "isolate layer" preview and
 * for exporting one layer to PNG (Photoshop round-trip).
 *
 * Same as compositeLayers but with one layer. Extracted as a
 * public function so callers don't need to construct a single-
 * element array.
 */
export function compositeSingleLayerPublic(
  destCtx: CanvasRenderingContext2D,
  layer: Layer,
  compositeCtx: CompositeContext,
): void {
  destCtx.save();
  compositeSingleLayer(destCtx, layer, compositeCtx);
  destCtx.restore();
}

// ────────────────────────────────────────────────────────────
// v2.9.1: Color profile conversion (RGB ↔ Gray)
// ────────────────────────────────────────────────────────────
//
// Converts all layers in a document from one color profile to another.
// This is a DESTRUCTIVE operation — pixel data is rewritten. The caller
// should pushHistory before calling.
//
// Conversions:
//   RGB → Gray:  Y = 0.299R + 0.587G + 0.114B (ITU-R BT.601 luminance)
//                Hex colors → grayscale hex (R=G=B=Y)
//                Image layers → per-pixel luminance via canvas
//   Gray → RGB:  Replicate Y to R=G=B=Y
//                Hex colors stay the same (already grayscale-equivalent)
//                Image layers → per-pixel replicate via canvas
//
// Solid and screentone layers only carry color STRINGS (hex), so conversion
// is cheap (parse hex → compute → format hex). Image layers carry pixel
// data as data URLs, so we decode → convert pixels → re-encode.
//
// CMYK is NOT supported (stub) — the function throws if either profile is
// 'cmyk8'. WebToonTools will handle CMYK conversion.

/** Parse a #rrggbb hex string into {r, g, b} (0-255). Returns null on failure. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/** Format {r, g, b} (0-255) as #rrggbb. */
function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** Convert a hex color to grayscale using ITU-R BT.601 luminance. */
function hexToGrayscale(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex; // can't parse — leave as-is
  const y = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  return rgbToHex(y, y, y);
}

/**
 * Convert an image layer's pixel data from RGB to grayscale or vice versa.
 * Returns a NEW data URL with converted pixels. The original imageSrc is
 * not modified.
 *
 * Implementation: decode data URL → canvas → getImageData → per-pixel
 * convert → putImageData → canvas.toDataURL.
 */
function convertImageDataUrl(
  imageSrc: string,
  toGray: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('no 2d context')); return; }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      if (toGray) {
        // RGB → Gray: Y = 0.299R + 0.587G + 0.114B
        for (let i = 0; i < data.length; i += 4) {
          const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          data[i] = y;
          data[i + 1] = y;
          data[i + 2] = y;
          // alpha unchanged
        }
      } else {
        // Gray → RGB: already R=G=B in a grayscale image, so this is a no-op
        // for true grayscale. But if the image had color (user imported a
        // color PNG into a gray doc then converts back to RGB), we leave
        // the pixels as-is — they keep whatever values they had.
        // (Replicating Y to RGB would only matter if the source was truly
        // single-channel, which Canvas2D doesn't expose — it's always RGBA.)
      }
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('failed to load image for conversion'));
    img.src = imageSrc;
  });
}

/**
 * Convert all layers in a document from `fromProfile` to `toProfile`.
 *
 * Returns a NEW layers array — does not mutate the input. The caller is
 * responsible for setLayers + pushHistory.
 *
 * For image layers, the conversion is ASYNC (pixel processing). This
 * function returns a Promise.
 *
 * @throws if either profile is 'cmyk8' (not supported in core).
 */
export async function convertLayersColorProfile(
  layers: readonly Layer[],
  fromProfile: ColorProfile,
  toProfile: ColorProfile,
): Promise<Layer[]> {
  if (fromProfile === toProfile) return layers.slice();
  if (fromProfile === 'cmyk8' || toProfile === 'cmyk8') {
    throw new Error('CMYK conversion is not supported in GenToniK core — use WebToonTools.');
  }

  const toGray = toProfile === 'gray8';
  const fromGray = fromProfile === 'gray8';

  const result: Layer[] = [];
  for (const layer of layers) {
    const newLayer: Layer = { ...layer, updatedAt: Date.now() };

    // Solid layer: convert solidColor hex
    if (layer.type === 'solid' && layer.solidColor) {
      newLayer.solidColor = toGray ? hexToGrayscale(layer.solidColor) : layer.solidColor;
    }

    // Screentone layer: convert colorPattern + colorBg hex
    if (layer.type === 'screentone' && layer.params) {
      const newParams = { ...layer.params };
      if (toGray) {
        newParams.colorPattern = hexToGrayscale(newParams.colorPattern);
        newParams.colorBg = hexToGrayscale(newParams.colorBg);
      }
      // Gray → RGB: colors stay as-is (they were already grayscale hex).
      // If the user had a color hex in a gray doc (unusual), we leave it —
      // the screentone generator handles color regardless of profile.
      newLayer.params = newParams;
    }

    // Image layer: convert pixel data (async)
    if (layer.type === 'image' && layer.imageSrc) {
      try {
        // Only convert if there's an actual change needed:
        // - RGB → Gray: always convert (luminance)
        // - Gray → RGB: no-op (pixels already correct in RGBA canvas)
        if (toGray) {
          newLayer.imageSrc = await convertImageDataUrl(layer.imageSrc, true);
        }
        // fromGray → RGB: leave imageSrc as-is
      } catch (err) {
        // If conversion fails, keep the original image — better than
        // losing the layer entirely.
        console.warn('[GenToniK] Failed to convert image layer, keeping original:', err);
      }
    }

    // text/vector/solid/transparent: no color payload to convert
    // (textData.color is a hex string — convert it too for consistency)
    if (layer.type === 'text' && layer.textData) {
      newLayer.textData = {
        ...layer.textData,
        color: toGray ? hexToGrayscale(layer.textData.color) : layer.textData.color,
      };
    }
    if (layer.type === 'vector' && layer.vectorData) {
      const vd = { ...layer.vectorData };
      if (vd.defaultFill) vd.defaultFill = toGray ? hexToGrayscale(vd.defaultFill) : vd.defaultFill;
      if (vd.defaultStroke) vd.defaultStroke = toGray ? hexToGrayscale(vd.defaultStroke) : vd.defaultStroke;
      vd.shapes = vd.shapes.map(s => {
        if (s.kind === 'line') {
          return { ...s, stroke: s.stroke ? (toGray ? hexToGrayscale(s.stroke) : s.stroke) : s.stroke };
        } else {
          return {
            ...s,
            fill: s.fill ? (toGray ? hexToGrayscale(s.fill) : s.fill) : s.fill,
            stroke: s.stroke ? (toGray ? hexToGrayscale(s.stroke) : s.stroke) : s.stroke,
          };
        }
      });
      newLayer.vectorData = vd;
    }

    result.push(newLayer);
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// Helpers for cache invalidation (used by App.tsx)
// ────────────────────────────────────────────────────────────

/**
 * Compute a quick "dirty fingerprint" for a layer's renderable state.
 *
 * Two layers with the same fingerprint can share a cached offscreen
 * (skipping the expensive renderLayerContent call). App.tsx can
 * store the last fingerprint per layer.id and skip re-rendering
 * when it hasn't changed.
 *
 * The fingerprint covers EVERYTHING that affects the offscreen:
 *   • type + payload (params / imageSrc / solidColor)
 *   • mask
 *   • natural size (which depends on docWidth/docHeight for
 *     screentone layers, or image natural size for image layers)
 *
 * It does NOT cover transform/opacity/blendMode/visible — those
 * are applied at draw time, not at content-render time.
 */
export function layerContentFingerprint(
  layer: Layer,
  compositeCtx: CompositeContext,
): string {
  const naturalSize = getLayerNaturalSize(layer, {
    docWidth: compositeCtx.docWidth,
    docHeight: compositeCtx.docHeight,
    imageSizes: compositeCtx.imageCache.sizes,
  });

  const maskPart = layer.mask
    ? layer.mask.type === 'shape'
      ? `shape:${layer.mask.shape}:${layer.mask.bounds.left},${layer.mask.bounds.top},${layer.mask.bounds.right},${layer.mask.bounds.bottom}:${layer.mask.feather}:${layer.mask.invert}`
      : `painted:${layer.mask.width}x${layer.mask.height}:${(layer.mask as { offsetX?: number }).offsetX ?? 0},${(layer.mask as { offsetY?: number }).offsetY ?? 0}:${layer.mask.invert}`
    : 'nomask';

  const contentPart =
    layer.type === 'screentone'
      ? `screentone:${JSON.stringify(layer.params)}`
      : layer.type === 'image'
        ? `image:${layer.imageSrc}`
        : layer.type === 'transparent'
          ? `transparent`           // no payload — fingerprint is constant per layer.id
          : layer.type === 'text'
            ? `text:${JSON.stringify(layer.textData)}`  // v2.9: text content
            : layer.type === 'vector'
              ? `vector:${JSON.stringify(layer.vectorData)}`  // v2.9: vector shapes
              : `solid:${layer.solidColor}`;

  return `${layer.id}|${contentPart}|${naturalSize.w}x${naturalSize.h}|${maskPart}`;
}

/**
 * Compute the visible bounding box of a layer after transform.
 *
 * Used by App.tsx to draw selection handles / transformation
 * overlay around the layer's actual on-canvas position.
 *
 * Returns null for invisible layers or layers with zero size.
 */
export function getLayerCanvasBounds(
  layer: Layer,
  compositeCtx: CompositeContext,
): { x: number; y: number; w: number; h: number } | null {
  if (!layer.visible) return null;

  const naturalSize = getLayerNaturalSize(layer, {
    docWidth: compositeCtx.docWidth,
    docHeight: compositeCtx.docHeight,
    imageSizes: compositeCtx.imageCache.sizes,
  });

  let renderW = naturalSize.w;
  let renderH = naturalSize.h;
  // v2.9: text/vector layers also get docSize override (they have no
  // intrinsic size until a renderer measures their content).
  if (layer.type === 'solid' || layer.type === 'transparent'
      || layer.type === 'text' || layer.type === 'vector') {
    renderW = compositeCtx.docWidth;
    renderH = compositeCtx.docHeight;
  }
  if (renderW <= 0 || renderH <= 0) return null;

  // ── Perspective mode: use corners directly ──────────────
  if (layer.transform.corners) {
    const c = layer.transform.corners;
    const xs = [c[0].x, c[1].x, c[2].x, c[3].x];
    const ys = [c[0].y, c[1].y, c[2].y, c[3].y];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // The layer's 4 corners in layer-local space (before transform).
  const corners: Array<[number, number]> = [
    [0, 0],
    [renderW, 0],
    [renderW, renderH],
    [0, renderH],
  ];

  // Apply transform: translate to (-w/2, -h/2), scale, skew, rotate,
  // then translate to destination center.
  const cos = Math.cos((layer.transform.rotation * Math.PI) / 180);
  const sin = Math.sin((layer.transform.rotation * Math.PI) / 180);
  // Precompute skew coefficients (clamped to avoid NaN at ±90°).
  const skewXClamped = Math.max(-89, Math.min(89, layer.transform.skewX));
  const skewYClamped = Math.max(-89, Math.min(89, layer.transform.skewY));
  const tanSkewX = Math.tan((skewXClamped * Math.PI) / 180);
  const tanSkewY = Math.tan((skewYClamped * Math.PI) / 180);
  const destCenterX = compositeCtx.docWidth / 2 + layer.transform.x;
  const destCenterY = compositeCtx.docHeight / 2 + layer.transform.y;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [lx, ly] of corners) {
    // Center-relative
    const cx = lx - renderW / 2;
    const cy = ly - renderH / 2;
    // Scale
    const sx = cx * layer.transform.scaleX;
    const sy = cy * layer.transform.scaleY;
    // Skew (shear): after scale, before rotate.
    //   x' = sx + tanSkewX * sy
    //   y' = tanSkewY * sx + sy
    const skewX = sx + tanSkewX * sy;
    const skewY = tanSkewY * sx + sy;
    // Rotate
    const rx = skewX * cos - skewY * sin;
    const ry = skewX * sin + skewY * cos;
    // Translate to destination
    const dx = rx + destCenterX;
    const dy = ry + destCenterY;
    if (dx < minX) minX = dx;
    if (dy < minY) minY = dy;
    if (dx > maxX) maxX = dx;
    if (dy > maxY) maxY = dy;
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Test whether a canvas-space point is inside a layer's transformed
 * bounds (used for click-to-select in the UI).
 *
 * Inverse-transforms the point into layer-local space and checks
 * if it's inside [0, renderW] × [0, renderH].
 */
export function isPointInLayer(
  layer: Layer,
  pointX: number,
  pointY: number,
  compositeCtx: CompositeContext,
): boolean {
  if (!layer.visible) return false;

  const naturalSize = getLayerNaturalSize(layer, {
    docWidth: compositeCtx.docWidth,
    docHeight: compositeCtx.docHeight,
    imageSizes: compositeCtx.imageCache.sizes,
  });

  let renderW = naturalSize.w;
  let renderH = naturalSize.h;
  if (layer.type === 'solid') {
    renderW = compositeCtx.docWidth;
    renderH = compositeCtx.docHeight;
  }
  if (renderW <= 0 || renderH <= 0) return false;

  // ── Perspective mode: point-in-quad test ────────────────
  if (layer.transform.corners) {
    return pointInQuad({ x: pointX, y: pointY }, layer.transform.corners);
  }

  // Inverse the forward transform:
  //   forward: local → center-rel → scale → skew → rotate → translate to dest
  //   inverse: translate from dest → un-rotate → un-skew → un-scale → un-center-rel
  const destCenterX = compositeCtx.docWidth / 2 + layer.transform.x;
  const destCenterY = compositeCtx.docHeight / 2 + layer.transform.y;

  // Translate from dest to dest center
  let px = pointX - destCenterX;
  let py = pointY - destCenterY;

  // Un-rotate
  const cos = Math.cos((-layer.transform.rotation * Math.PI) / 180);
  const sin = Math.sin((-layer.transform.rotation * Math.PI) / 180);
  let rx = px * cos - py * sin;
  let ry = px * sin + py * cos;

  // Un-skew: invert the 2×2 matrix [[1, tanX],[tanY, 1]].
  //   det = 1 - tanX*tanY
  //   inverse = (1/det) * [[1, -tanX], [-tanY, 1]]
  // If det ≈ 0 (skewX + skewY ≈ 90° combined), the transform is
  // degenerate — treat as no inverse (point not in layer).
  const skewXClamped = Math.max(-89, Math.min(89, layer.transform.skewX));
  const skewYClamped = Math.max(-89, Math.min(89, layer.transform.skewY));
  const tanSkewX = Math.tan((skewXClamped * Math.PI) / 180);
  const tanSkewY = Math.tan((skewYClamped * Math.PI) / 180);
  const det = 1 - tanSkewX * tanSkewY;
  if (Math.abs(det) < 1e-6) return false;
  const invDet = 1 / det;
  const unskewX = (rx - tanSkewX * ry) * invDet;
  const unskewY = (-tanSkewY * rx + ry) * invDet;
  rx = unskewX;
  ry = unskewY;

  // Un-scale (avoid divide-by-zero)
  if (layer.transform.scaleX === 0 || layer.transform.scaleY === 0) return false;
  rx /= layer.transform.scaleX;
  ry /= layer.transform.scaleY;

  // Un-center-rel: now in local coords
  const lx = rx + renderW / 2;
  const ly = ry + renderH / 2;

  return lx >= 0 && lx <= renderW && ly >= 0 && ly <= renderH;
}

/**
 * A2.1b: Rasterize a polygon into a Uint8Array alpha mask at a FIXED size
 * and offset. Used by apply-as-mask to combine multiple selection entries
 * with boolean ops — all entries must rasterize to the SAME dimensions
 * for pixel-wise combine to work.
 *
 * Points must already be in the target coordinate space (e.g. layer-local).
 * (offsetX, offsetY) is the top-left of the output mask in that space.
 *
 * Returns Uint8Array of length width*height, values 0 or 255
 * (anti-aliasing not supported — keep simple for boolean combine).
 */
export const MAX_MASK_DIM = 8192;

export function rasterizePolygonAtSize(
  points: Vec2[],
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
): Uint8Array {
  // Guard against unbounded allocation (e.g. when layerLocalPolygon
  // has huge coordinates from incorrect inverse on FT layers).
  if (width > MAX_MASK_DIM || height > MAX_MASK_DIM) {
    console.warn(`[rasterizePolygonAtSize] dimensions ${width}×${height} exceed MAX_MASK_DIM=${MAX_MASK_DIM}, clamping`);
    width = Math.min(width, MAX_MASK_DIM);
    height = Math.min(height, MAX_MASK_DIM);
  }
  const data = new Uint8Array(width * height);
  if (points.length < 3 || width <= 0 || height <= 0) return data;

  // Use a temp canvas to rasterize, then extract alpha channel.
  const tempCanvas = acquireCanvas(width, height);
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) {
    releaseCanvas(tempCanvas);
    return data;
  }

  tempCtx.clearRect(0, 0, width, height);
  tempCtx.translate(-offsetX, -offsetY);
  tempCtx.beginPath();
  tempCtx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    tempCtx.lineTo(points[i].x, points[i].y);
  }
  tempCtx.closePath();
  tempCtx.fillStyle = 'white';
  tempCtx.fill();

  const imageData = tempCtx.getImageData(0, 0, width, height);
  const src = imageData.data;
  for (let i = 0; i < data.length; i++) {
    data[i] = src[i * 4 + 3]; // alpha channel
  }
  releaseCanvas(tempCanvas);
  return data;
}

// ────────────────────────────────────────────────────────────
// Contour tracing (marching squares)
// ────────────────────────────────────────────────────────────

/**
 * A2.1b-fix: Marching squares contour tracer.
 *
 * Given a binary mask (Uint8Array, values 0 or 255), returns an array of
 * polygon contours. Each contour is a closed polygon (Vec2[]). The first
 * contour is the outer boundary of the largest connected component;
 * subsequent contours may be additional outer boundaries (multiple
 * disjoint components) or holes (inside an outer boundary).
 *
 * Polygons are in mask-local coordinates (0,0 = top-left of mask).
 * Caller adds (offsetX, offsetY) to convert to target space.
 */
export function traceMaskContour(
  mask: Uint8Array,
  width: number,
  height: number,
  offsetX: number = 0,
  offsetY: number = 0,
): Vec2[][] {
  if (width < 2 || height < 2 || mask.length < width * height) return [];

  const THRESHOLD = 128;

  // Build binary grid (1 = inside, 0 = outside). Add 1px transparent
  // border so boundary cells at the edge of the mask still trace correctly.
  const W = width + 2;
  const H = height + 2;
  const grid = new Uint8Array(W * H);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      grid[(y + 1) * W + (x + 1)] = mask[y * width + x] > THRESHOLD ? 1 : 0;
    }
  }

  // Canonical marching squares lookup table:
  const cases: number[][][] = [
    [],               // 0: 0000
    [[3, 0]],         // 1: 0001
    [[0, 1]],         // 2: 0010
    [[3, 1]],         // 3: 0011
    [[1, 2]],         // 4: 0100
    [[3, 0], [1, 2]], // 5: 0101
    [[0, 2]],         // 6: 0110
    [[3, 2]],         // 7: 0111
    [[2, 3]],         // 8: 1000
    [[0, 2]],         // 9: 1001
    [[0, 1], [2, 3]], // 10: 1010
    [[1, 2]],         // 11: 1011
    [[3, 1]],         // 12: 1100
    [[0, 1]],         // 13: 1101
    [[3, 0]],         // 14: 1110
    []                // 15: 1111
  ];

  interface Segment { a: Vec2; b: Vec2; }
  const segments: Segment[] = [];

  const edgePoint = (cellX: number, cellY: number, edge: number): Vec2 => {
    const mx = cellX - 1;
    const my = cellY - 1;
    switch (edge) {
      case 0: return { x: mx + 0.5, y: my };       // top
      case 1: return { x: mx + 1,   y: my + 0.5 }; // right
      case 2: return { x: mx + 0.5, y: my + 1 };   // bottom
      case 3: return { x: mx,       y: my + 0.5 }; // left
      default: return { x: mx, y: my };
    }
  };

  for (let cy = 0; cy < H - 1; cy++) {
    for (let cx = 0; cx < W - 1; cx++) {
      const tl = grid[cy * W + cx];
      const tr = grid[cy * W + (cx + 1)];
      const br = grid[(cy + 1) * W + (cx + 1)];
      const bl = grid[(cy + 1) * W + cx];
      const idx = (tl << 0) | (tr << 1) | (br << 2) | (bl << 3);

      const segs = cases[idx];
      if (!segs || segs.length === 0) continue;
      for (const [ea, eb] of segs) {
        segments.push({
          a: edgePoint(cx, cy, ea),
          b: edgePoint(cx, cy, eb),
        });
      }
    }
  }

  const used = new Uint8Array(segments.length);
  const contours: Vec2[][] = [];
  const EPS = 0.01;

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    const contour: Vec2[] = [segments[i].a, segments[i].b];
    used[i] = 1;
    let current = segments[i].b;

    // Walk forward
    while (true) {
      let found = -1;
      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const s = segments[j];
        if (Math.abs(s.a.x - current.x) < EPS && Math.abs(s.a.y - current.y) < EPS) {
          found = j; break;
        }
        if (Math.abs(s.b.x - current.x) < EPS && Math.abs(s.b.y - current.y) < EPS) {
          segments[j] = { a: s.b, b: s.a };
          found = j; break;
        }
      }
      if (found === -1) break;
      used[found] = 1;
      current = segments[found].b;
      if (Math.abs(current.x - contour[0].x) < EPS && Math.abs(current.y - contour[0].y) < EPS) {
        break;
      }
      contour.push(current);
    }

    for (const p of contour) {
      p.x += offsetX;
      p.y += offsetY;
    }

    const simplified = simplifyContour(contour, 0.5);
    if (simplified.length >= 3) contours.push(simplified);
  }

  return contours;
}

function simplifyContour(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let maxI = -1;
    const a = points[s];
    const b = points[e];
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(points[i], a, b);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI !== -1) {
      keep[maxI] = true;
      stack.push([s, maxI]);
      stack.push([maxI, e]);
    }
  }

  const result: Vec2[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

function perpDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    const ddx = p.x - a.x;
    const ddy = p.y - a.y;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  const ddx = p.x - projX;
  const ddy = p.y - projY;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

// ────────────────────────────────────────────────────────────
// BUG-3 FIX: Sutherland-Hodgman polygon clipping
// ────────────────────────────────────────────────────────────

/**
 * Clip a convex/concave subject polygon against a CONVEX clip polygon (rectangle).
 *
 * Sutherland-Hodgman algorithm: for each edge of the clip rectangle, walk the
 * subject polygon and keep only the parts inside that edge. Intersections are
 * computed exactly.
 *
 * Used by handleApplySelectionAsMask to clip the selection polygon (in
 * layer-local space) to the layer's natural bounds [0, w] × [0, h]. This
 * prevents the inverse-perspective from mapping out-of-quad canvas points to
 * extreme layer-local coordinates, which previously produced huge mask
 * bounding boxes (e.g. 7798×6002) and triggered the MAX_MASK_DIM guard.
 *
 * @param subject  The polygon to clip (array of {x, y}).
 * @param bounds   The clip rectangle as {left, top, right, bottom} (inclusive).
 * @returns New array of points = the clipped polygon. May be empty if the
 *          subject is entirely outside bounds.
 */
export function clipPolygonToRect(
  subject: Vec2[],
  bounds: { left: number; top: number; right: number; bottom: number },
): Vec2[] {
  if (subject.length < 3) return [];

  // Sutherland-Hodgman against each of the 4 clip edges.
  // Each edge is defined by a point on the edge and the inward normal.
  // We clip in order: left, right, bottom, top.
  // (Note: y increases downward — "top" edge has smaller y, "bottom" has larger.)

  type Edge = { point: Vec2; normal: Vec2; inside: (p: Vec2) => boolean };
  const edges: Edge[] = [
    // Left edge: x = bounds.left, inward normal = (+1, 0)
    { point: { x: bounds.left, y: 0 }, normal: { x: 1, y: 0 },
      inside: (p) => p.x >= bounds.left - 1e-9 },
    // Right edge: x = bounds.right, inward normal = (-1, 0)
    { point: { x: bounds.right, y: 0 }, normal: { x: -1, y: 0 },
      inside: (p) => p.x <= bounds.right + 1e-9 },
    // Bottom edge: y = bounds.bottom, inward normal = (0, -1)
    { point: { x: 0, y: bounds.bottom }, normal: { x: 0, y: -1 },
      inside: (p) => p.y <= bounds.bottom + 1e-9 },
    // Top edge: y = bounds.top, inward normal = (0, +1)
    { point: { x: 0, y: bounds.top }, normal: { x: 0, y: 1 },
      inside: (p) => p.y >= bounds.top - 1e-9 },
  ];

  let output = subject.slice();

  for (const edge of edges) {
    if (output.length === 0) break;
    const input = output;
    output = [];
    const S = input[input.length - 1]; // start with last point

    let prevInside = edge.inside(S);
    let prev = S;

    for (let i = 0; i < input.length; i++) {
      const curr = input[i];
      const currInside = edge.inside(curr);

      if (currInside) {
        if (!prevInside) {
          // Entering: compute intersection
          const inter = lineSegIntersect(prev, curr, edge);
          if (inter) output.push(inter);
        }
        output.push(curr);
      } else if (prevInside) {
        // Leaving: compute intersection
        const inter = lineSegIntersect(prev, curr, edge);
        if (inter) output.push(inter);
      }
      // else: both outside, skip

      prev = curr;
      prevInside = currInside;
    }
  }

  return output;
}

/**
 * Compute intersection of line segment (p1→p2) with an infinite clip edge.
 * The edge is defined by a point and inward normal. Returns the intersection
 * point, or null if the segment is parallel to the edge (no unique intersection).
 */
function lineSegIntersect(
  p1: Vec2,
  p2: Vec2,
  edge: { point: Vec2; normal: Vec2 },
): Vec2 | null {
  // Line segment: P = p1 + t*(p2-p1), t ∈ [0, 1]
  // Edge plane: dot(P - edgePoint, edgeNormal) = 0
  // Solve for t:
  //   dot(p1 + t*(p2-p1) - edgePoint, normal) = 0
  //   dot(p1 - edgePoint, normal) + t * dot(p2-p1, normal) = 0
  //   t = -dot(p1 - edgePoint, normal) / dot(p2-p1, normal)
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const denom = dx * edge.normal.x + dy * edge.normal.y;
  if (Math.abs(denom) < 1e-12) return null; // parallel

  const ex = p1.x - edge.point.x;
  const ey = p1.y - edge.point.y;
  const numer = ex * edge.normal.x + ey * edge.normal.y;
  const t = -numer / denom;

  return {
    x: p1.x + t * dx,
    y: p1.y + t * dy,
  };
}

/**
 * A2.1b-fix: Compute combined selection mask from multi-entry ActiveSelection.
 */
export function computeCombinedSelectionMask(
  entries: SelectionEntry[],
): { mask: Uint8Array; width: number; height: number; offsetX: number; offsetY: number } | null {
  if (entries.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const entry of entries) {
    for (const p of entry.layerLocalPolygon) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  
  minX = Math.floor(minX) - 1;
  minY = Math.floor(minY) - 1;
  maxX = Math.ceil(maxX) + 1;
  maxY = Math.ceil(maxY) + 1;

  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return null;

  // Guard against unbounded allocation on FT layers with wrong inverse.
  if (width > MAX_MASK_DIM || height > MAX_MASK_DIM) {
    console.warn(`[computeCombinedSelectionMask] dimensions ${width}×${height} exceed MAX_MASK_DIM=${MAX_MASK_DIM}, clamping`);
    const clampW = Math.min(width, MAX_MASK_DIM);
    const clampH = Math.min(height, MAX_MASK_DIM);
    const mask = new Uint8Array(clampW * clampH);
    return { mask, width: clampW, height: clampH, offsetX: minX, offsetY: minY };
  }

  const mask = new Uint8Array(width * height);

  for (const entry of entries) {
    const entryMask = rasterizePolygonAtSize(
      entry.layerLocalPolygon,
      width, height,
      minX, minY,
    );
    for (let i = 0; i < mask.length; i++) {
      const src = entryMask[i] > 128;
      const dst = mask[i] > 128;
      let result: boolean;
      switch (entry.op) {
        case 'new':       result = src; break;
        case 'add':       result = dst || src; break;
        case 'subtract':  result = dst && !src; break;
        case 'intersect': result = dst && src; break;
        default:          result = dst;
      }
      mask[i] = result ? 255 : 0;
    }
  }

  return { mask, width, height, offsetX: minX, offsetY: minY };
}

// ────────────────────────────────────────────────────────────
// Re-exports for convenience
// ────────────────────────────────────────────────────────────

export type { ScreentoneParams, SelectionEntry } from './types';
