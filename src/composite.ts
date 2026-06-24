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
  ScreentoneParams,
  Vec2,
  blendToCompositeOp,
  getLayerNaturalSize,
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
  // Find the smallest pooled canvas that fits, or create a new one.
  let best: HTMLCanvasElement | null = null;
  let bestArea = Infinity;
  for (const c of canvasPool) {
    if (c.width >= width && c.height >= height) {
      const area = c.width * c.height;
      if (area < bestArea) {
        best = c;
        bestArea = area;
      }
    }
  }
  const canvas = best ?? document.createElement('canvas');
  // Set size even for reused canvases — drawImage with mismatched
  // sizes silently produces wrong output.
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
      renderScreentone(ctx, width, height, layer.params);
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
 *   3. drawImage the temp canvas onto the layer canvas with
 *      'destination-in' (or 'destination-out' if invert=true).
 *
 * We can't use putImageData directly because it ignores
 * globalCompositeOperation. drawImage with a temp canvas is the
 * standard workaround.
 *
 * The mask may be smaller than the layer (e.g., user painted only
 * a region). The mask is anchored at (0,0) in layer-local space —
 * caller must position it via the mask's width/height relative to
 * the layer's natural size.
 */
function applyPaintedMask(
  ctx: CanvasRenderingContext2D,
  mask: Extract<LayerMask, { type: 'painted' }>,
): void {
  const { width: mw, height: mh, data, invert } = mask;
  if (mw <= 0 || mh <= 0 || data.length !== mw * mh) return;

  // Build an RGBA ImageData from the single-channel alpha array.
  const tempCanvas = acquireCanvas(mw, mh);
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
  ctx.drawImage(tempCanvas, 0, 0);
  ctx.restore();

  releaseCanvas(tempCanvas);
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
  let renderW = naturalSize.w;
  let renderH = naturalSize.h;
  if (layer.type === 'solid') {
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
  applyMask(offCtx, layer.mask, renderW, renderH);

  // ── Step 4: drawImage onto destination with transform ──
  destCtx.save();

  // Blend mode + opacity. globalAlpha multiplies with per-pixel
  // alpha, so opacity=0.5 → half-transparent layer.
  destCtx.globalCompositeOperation = blendToCompositeOp(layer.blendMode);
  destCtx.globalAlpha = layer.opacity;

  // Branch: perspective (corners set) vs affine (default).
  if (layer.transform.corners) {
    // Perspective path — bypass translate/rotate/scale/skew and
    // render via homography subdivision.
    drawImageWithPerspective(
      destCtx, offscreen, renderW, renderH,
      layer.transform.corners,
      8,  // subdivisions (8×8 = 128 triangles)
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
      : `painted:${layer.mask.width}x${layer.mask.height}:${layer.mask.invert}`
    : 'nomask';

  const contentPart =
    layer.type === 'screentone'
      ? `screentone:${JSON.stringify(layer.params)}`
      : layer.type === 'image'
        ? `image:${layer.imageSrc}`
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
  if (layer.type === 'solid') {
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

// ────────────────────────────────────────────────────────────
// Re-exports for convenience
// ────────────────────────────────────────────────────────────

export type { ScreentoneParams } from './types';
