// ============================================================
// transform-matrix.ts — 2D affine matrix utilities for layer transform
// ============================================================
//
// Shared forward/inverse matrix math for the GenToniK transform pipeline.
// Used by:
//   • mask-editor.tsx — pointer→layer-local coordinate mapping
//   • transform-overlay-movable.tsx — overlay-ghost positioning + warp→skew
//   • App.tsx screenToCanvas (optional)
//
// MATHEMATICAL CONTRACT (must match composite.ts composeLayer):
//
//   forward(point_local) = T(destCenter) * R(rotation) * Skew(skewX, skewY)
//                          * S(scaleX, scaleY) * T(-w/2, -h/2) * point_local
//
//   where destCenter = (docW/2 + transform.x, docH/2 + transform.y)
//
//   This is the EXACT same order composite.ts uses:
//     ctx.translate(destCenterX, destCenterY)
//     ctx.rotate(rotation)
//     ctx.transform(1, tan(skewY), tan(skewX), 1, 0, 0)   // skew
//     ctx.scale(scaleX, scaleY)
//     ctx.translate(-renderW/2, -renderH/2)
//
// ATTRIBUTION:
//   The inverse-matrix pattern (multiply by inverse of composed viewport
//   transform to map screen→scene) is inspired by fabric.js
//   (`sendPointToPlane` in src/util/misc/planeChange.ts). fabric.js is
//   Copyright (c) Printio, Andrea Bogazzi et al., MIT License.
//   See NOTICE.md for full attribution.
//
// 2D affine matrix representation: 6-element array [a, b, c, d, e, f]
// corresponding to the 3×3 homogeneous matrix:
//   | a c e |
//   | b d f |
//   | 0 0 1 |
//
// Point transformation:  p' = M * p
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
// ============================================================

import type { LayerTransform, Vec2 } from './types';
import {
  computeHomography,
  applyHomography,
  invertHomography,
} from './homography';

/** 2D affine matrix as [a, b, c, d, e, f]. */
export type Matrix = [number, number, number, number, number, number];

/** Identity matrix [1,0,0,1,0,0]. */
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Multiply two affine matrices: M = A * B
 * (i.e., apply B first, then A — standard graphics convention)
 *
 * Result:
 *   | a1 c1 e1 |   | a2 c2 e2 |   | a1*a2+c1*b2  a1*c2+c1*d2  a1*e2+c1*f2+e1 |
 *   | b1 d1 f1 | * | b2 d2 f2 | = | b1*a2+d1*b2  b1*c2+d1*d2  b1*e2+d1*f2+f1 |
 *   | 0  0  1  |   | 0  0  1  |   | 0            0            1              |
 */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * Apply matrix M to a point: p' = M * p (homogeneous w=1).
 * Returns the transformed (x, y).
 */
export function applyToPoint(m: Matrix, p: Vec2): Vec2 {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}

/**
 * Invert an affine matrix.
 * Returns null if the matrix is degenerate (det ≈ 0).
 *
 * For  [a, b, c, d, e, f]:
 *   det = a*d - b*c
 *   inv = [d/det, -b/det, -c/det, a/det, (c*f - d*e)/det, (b*e - a*f)/det]
 */
export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return [
    m[3] * invDet,
    -m[1] * invDet,
    -m[2] * invDet,
    m[0] * invDet,
    (m[2] * m[5] - m[3] * m[4]) * invDet,
    (m[1] * m[4] - m[0] * m[5]) * invDet,
  ];
}

// ────────────────────────────────────────────────────────────
// Builder primitives — each returns a Matrix
// ────────────────────────────────────────────────────────────

export function translation(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function scaling(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

/** Rotation matrix for angle in radians. */
export function rotation(rad: number): Matrix {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

/**
 * Combined skew matrix: x' = x + tan(skewX)*y;  y' = tan(skewY)*x + y
 * Matches composite.ts: ctx.transform(1, tan(skewY), tan(skewX), 1, 0, 0)
 *
 * Skew angles are clamped to ±89° to avoid NaN at 90°.
 *
 * @param skewXDeg horizontal skew in degrees (positive = top tilts right)
 * @param skewYDeg vertical skew in degrees (positive = left tilts down)
 */
export function skew(skewXDeg: number, skewYDeg: number): Matrix {
  const sx = Math.max(-89, Math.min(89, skewXDeg));
  const sy = Math.max(-89, Math.min(89, skewYDeg));
  const tx = Math.tan((sx * Math.PI) / 180);
  const ty = Math.tan((sy * Math.PI) / 180);
  // ctx.transform(1, ty, tx, 1, 0, 0) → [a=1, b=ty, c=tx, d=1, e=0, f=0]
  return [1, ty, tx, 1, 0, 0];
}

// ────────────────────────────────────────────────────────────
// LAYER TRANSFORM — the canonical composition
// ────────────────────────────────────────────────────────────

/**
 * Build the forward matrix for a LayerTransform (local-space → canvas-space),
 * matching composite.ts composeLayer pipeline exactly.
 *
 * @param t            the layer transform
 * @param naturalSize  layer's natural width/height (px)
 * @param docSize      document width/height (px)
 * @returns matrix M such that  canvasPoint = M * localPoint
 */
export function composeLayerMatrix(
  t: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): Matrix {
  // Order: rightmost applied first to point, so we build right→left:
  //   T(destCenter) * R * Skew * S * T(-w/2, -h/2)
  //
  // In multiply(A, B): B is applied first to point, then A. So we want
  //   M = multiply(T(destCenter), multiply(R, multiply(Skew, multiply(S, T(-w/2,-h/2)))))
  //
  // Read it as: translate point by (-w/2,-h/2), scale, skew, rotate, translate to destCenter.
  const destCenterX = docSize.w / 2 + t.x;
  const destCenterY = docSize.h / 2 + t.y;

  let m: Matrix = translation(-naturalSize.w / 2, -naturalSize.h / 2);
  m = multiply(scaling(t.scaleX, t.scaleY), m);
  m = multiply(skew(t.skewX, t.skewY), m);
  m = multiply(rotation((t.rotation * Math.PI) / 180), m);
  m = multiply(translation(destCenterX, destCenterY), m);
  return m;
}

/**
 * Build the inverse of composeLayerMatrix — maps canvas-space points
 * back to layer-local-space. Returns null if the transform is degenerate
 * (e.g., scaleX=0, or combined skew makes the matrix singular).
 *
 * This is the core fix for the "brush рисует не там / инвертированно" bug:
 * instead of only subtracting the canvas offset (which assumes an
 * axis-aligned layer), we multiply by the inverse of the full layer
 * matrix, correctly handling rotation, skew, flip, and scale.
 *
 * @param t            the layer transform
 * @param naturalSize  layer's natural width/height (px)
 * @param docSize      document width/height (px)
 */
export function invertLayerMatrix(
  t: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): Matrix | null {
  // When corners is set (perspective mode), there is no valid
  // 2D affine inverse — the layer is rendered via homography.
  // Callers should use canvasToLocal() instead, which correctly
  // handles perspective transforms.
  if (t.corners) {
    return null;
  }
  const m = composeLayerMatrix(t, naturalSize, docSize);
  return invert(m);
}

/**
 * Map a canvas-space point to layer-local-space using the layer transform.
 *
 * CRITICAL FIX (2026-06-28): When `t.corners` is set (perspective mode),
 * the layer is rendered via homography, and the affine matrix inverse gives
 * WRONG coordinates. This caused:
 *   - Mask on FT layer freezing (wrong coords → huge canvas allocation)
 *   - Selection on FT layer producing wrong shape
 *   - Mask editor painting in wrong position
 *
 * Fix: when corners is set, use the homography inverse instead of the
 * affine inverse.
 *
 * @returns {x, y} in layer-local pixels (0,0 = top-left of natural size),
 *          or null if the transform is degenerate.
 */
export function canvasToLocal(
  canvasPoint: Vec2,
  t: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): Vec2 | null {
  // Perspective mode: use homography inverse
  if (t.corners) {
    const srcQuad: [Vec2, Vec2, Vec2, Vec2] = [
      { x: 0, y: 0 },
      { x: naturalSize.w, y: 0 },
      { x: naturalSize.w, y: naturalSize.h },
      { x: 0, y: naturalSize.h },
    ];
    const H = computeHomography(srcQuad, t.corners);
    if (!H) return null;
    const invH = invertHomography(H);
    if (!invH) return null;
    return applyHomography(invH, canvasPoint);
  }
  // Affine mode: use matrix inverse
  const inv = invertLayerMatrix(t, naturalSize, docSize);
  if (!inv) return null;
  return applyToPoint(inv, canvasPoint);
}

/**
 * Map a layer-local point to canvas-space using the layer transform.
 * Convenience wrapper around composeLayerMatrix + applyToPoint.
 */
export function localToCanvas(
  localPoint: Vec2,
  t: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): Vec2 {
  const m = composeLayerMatrix(t, naturalSize, docSize);
  return applyToPoint(m, localPoint);
}

// ────────────────────────────────────────────────────────────
// VIEW TRANSFORM — composition of zoom + pan
// ────────────────────────────────────────────────────────────

/**
 * View (zoom + pan) matrix: canvas-pixel space → screen-space (CSS px).
 *
 *   screenPoint = T(panX, panY) * S(zoom) * canvasPoint
 *
 * Matches App.tsx screenToCanvas:
 *   canvasX = (clientX - rect.left - panX) / zoom
 * which is the inverse: canvasPoint = inv(view) * screenPoint.
 */
export function composeViewMatrix(view: {
  zoom: number;
  panX: number;
  panY: number;
}): Matrix {
  // M = T(panX, panY) * S(zoom)
  // Apply S first to point, then T:
  //   multiply(T(panX, panY), S(zoom))
  return multiply(translation(view.panX, view.panY), scaling(view.zoom, view.zoom));
}

// ────────────────────────────────────────────────────────────
// COMBINED — screen → local (the main fix)
// ────────────────────────────────────────────────────────────

/**
 * The composite screen→local transform. This is the function that fixes
 * the "brush рисует не там" bug in mask-editor.tsx.
 *
 * Pipeline:  screen (CSS px relative to canvas container)
 *          → canvas-pixel  (via inverse view)
 *          → layer-local   (via inverse layer matrix)
 *
 * @param screenPoint  point relative to the canvas container's top-left
 *                     (i.e., clientX - container.getBoundingClientRect().left)
 * @param view         viewport {zoom, panX, panY}
 * @param t            the layer's transform
 * @param naturalSize  layer's natural {w, h}
 * @param docSize      document {w, h}
 * @returns layer-local {x, y}, or null if either matrix is degenerate
 */
export function screenToLocal(
  screenPoint: Vec2,
  view: { zoom: number; panX: number; panY: number },
  t: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): Vec2 | null {
  // 1. screen → canvas-pixel:  canvasPoint = inv(view) * screenPoint
  const viewM = composeViewMatrix(view);
  const invView = invert(viewM);
  if (!invView) return null;
  const canvasP = applyToPoint(invView, screenPoint);

  // 2. canvas-pixel → layer-local:  localPoint = inv(layer) * canvasPoint
  return canvasToLocal(canvasP, t, naturalSize, docSize);
}

/**
 * Inverse of screenToLocal: layer-local → screen-space (CSS px).
 * Used for positioning DOM overlays (e.g., the ghost div for react-moveable)
 * at a known layer-local anchor.
 */
export function localToScreen(
  localPoint: Vec2,
  view: { zoom: number; panX: number; panY: number },
  t: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): Vec2 {
  // 1. local → canvas-pixel
  const canvasP = localToCanvas(localPoint, t, naturalSize, docSize);
  // 2. canvas-pixel → screen
  const viewM = composeViewMatrix(view);
  return applyToPoint(viewM, canvasP);
}

// ────────────────────────────────────────────────────────────
// MATRIX → CSS transform string
// ────────────────────────────────────────────────────────────

/**
 * Convert a 2D affine matrix [a, b, c, d, e, f] to a CSS `transform` string.
 *
 * CSS matrix(a, b, c, d, e, f) is column-major:
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 * which is exactly our Matrix layout. So this is a 1:1 mapping.
 *
 * Used to position an overlay canvas/div with the exact same transform
 * that composite.ts applies to the layer content, ensuring the overlay
 * aligns pixel-perfectly with the rendered layer (even under rotation,
 * skew, flip, etc.).
 */
export function matrixToCss(m: Matrix): string {
  return `matrix(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${m[4]}, ${m[5]})`;
}

// ────────────────────────────────────────────────────────────
// WARP → skew/scale decomposition (for react-moveable Warpable)
// ────────────────────────────────────────────────────────────

/**
 * Decompose a 2D affine matrix into {scaleX, scaleY, rotation, skewX, skewY}
 * — useful for converting react-moveable's `onWarp` matrix (which may include
 * shear) back into our LayerTransform fields.
 *
 * Uses the standard QR-style decomposition:
 *   1. Extract translation (e, f)
 *   2. Compute scaleX = sqrt(a² + b²)
 *   3. Compute rotation = atan2(b, a)
 *   4. Remove rotation → get shear component → skewY
 *   5. Compute scaleY from remaining
 *   6. skewX = 0 (the warp decomposition folds all shear into skewY
 *      when combined with rotation; we set skewX=0 because re-composing
 *      with both skews produces a different matrix than the input warp.
 *      For full round-trip fidelity, prefer storing the warp matrix as
 *      `corners` and using perspective mode.)
 *
 * For our use case, we use this only to display rough values in the
 * numeric transform panel after a warp drag — the actual layer state
 * is updated by directly setting `corners` (perspective mode), which
 * preserves the warp exactly.
 *
 * @returns a partial LayerTransform-like object. Translation is NOT
 *          returned because warp's translation is in screen-space, not
 *          layer-space; the caller must convert back via screenToLocal.
 */
export function decomposeWarpMatrix(
  m: Matrix,
): { scaleX: number; scaleY: number; rotation: number; skewY: number } | null {
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[3];

  const scaleX = Math.hypot(a, b);
  if (scaleX < 1e-12) return null;

  const rotation = Math.atan2(b, a); // radians
  // Remove rotation: R⁻¹ * M gives [[scaleX, shear], [0, scaleY]]
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  // R⁻¹ * [[a, c], [b, d]]:
  //   [[cos, -sin], [sin, cos]] * [[a, c], [b, d]]
  //   = [[cos*a - sin*b,  cos*c - sin*d],
  //      [sin*a + cos*b,  sin*c + cos*d]]
  const m00 = cos * a - sin * b; // = scaleX (sanity check)
  const m01 = cos * c - sin * d; // = shear term
  const m11 = sin * c + cos * d; // = scaleY

  void m00; // suppress unused-warning; equal to scaleX by construction
  const scaleY = m11;
  const skewY = Math.atan2(m01, scaleY); // radians

  return {
    scaleX,
    scaleY,
    rotation: (rotation * 180) / Math.PI, // degrees, matching LayerTransform
    skewY: (skewY * 180) / Math.PI,
  };
}

// ────────────────────────────────────────────────────────────
// RESERVED: applyDeltaToLayer — для будущего multi-select
// (Konva _fitNodesInto pattern, MIT, © Anton Lavrenov)
// ────────────────────────────────────────────────────────────

/**
 * RESERVED для будущего multi-select — НЕ ИСПОЛЬЗУЕТСЯ в A1.
 *
 * Применяет "delta-матрицу" к слою, возвращая новый LayerTransform.
 *
 * Концепция заимствована из Konva Transformer._fitNodesInto (MIT):
 *   delta = newTransform * oldTransform⁻¹
 *   newLayerTransform = delta * oldLayerTransform
 *
 * Когда это понадобится:
 *   • Multi-select: один delta применяется к нескольким слоям сразу
 *   • Group transform: вращение группы слоёв как единого целого
 *
 * Сейчас не подключено — single-layer transform использует более
 * прямой путь через composeLayerMatrix + handle anchor'ы.
 *
 * @param delta       матрица преобразования (например, rotate вокруг центра)
 * @param layer       исходный LayerTransform
 * @param naturalSize размер слоя
 * @param docSize     размер документа
 * @returns новый LayerTransform (исходный не мутируется)
 *
 * @example
 * // Вращение всех слоёв группы на 30° вокруг центра документа:
 * const center = { x: docSize.w / 2, y: docSize.h / 2 };
 * const delta = rotateAroundPointMatrix(center.x, center.y, degToRad(30));
 * const newLayers = selectedLayers.map(l => ({
 *   ...l,
 *   transform: applyDeltaToLayer(delta, l.transform, naturalSize, docSize)
 * }));
 */
export function applyDeltaToLayer(
  delta: Matrix,
  layer: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): LayerTransform {
  // 1. Старая forward-матрица слоя
  const oldMatrix = composeLayerMatrix(layer, naturalSize, docSize);

  // 2. Новая forward-матрица = delta * oldMatrix
  const newMatrix = multiply(delta, oldMatrix);

  // 3. Декомпозиция новой матрицы обратно в LayerTransform
  //    (translation, scale, rotation, skew)
  const decomposed = decomposeWarpMatrix(newMatrix);
  if (!decomposed) {
    // Degenerate — возвращаем исходный (без изменений)
    return { ...layer };
  }

  // 4. Вычисляем новый x/y из translation новой матрицы.
  //    composeLayerMatrix ставит destCenter = (docW/2 + x, docH/2 + y),
  //    поэтому: x = newMatrix.e - docW/2, y = newMatrix.f - docH/2
  const newX = newMatrix[4] - docSize.w / 2;
  const newY = newMatrix[5] - docSize.h / 2;

  return {
    ...layer,
    x: newX,
    y: newY,
    scaleX: decomposed.scaleX,
    scaleY: decomposed.scaleY,
    rotation: decomposed.rotation,
    // decomposeWarpMatrix возвращает skewY (skewX сворачивается в 0).
    // Для полного round-trip нужно хранить corners, но для delta-применения
    // аффинной дельты это приемлемо.
    skewX: 0,
    skewY: decomposed.skewY,
    // corners не переносим — delta-применение работает только в affine mode
    corners: null,
  };
}

/**
 * A3: Perspective-aware screen-to-local coordinate mapping.
 *
 * Maps screen-px (CSS) → layer-local px (the layer's natural coordinate space,
 * where (0,0) is top-left of the layer's natural bbox).
 *
 * Used by:
 *   - mask-editor.tsx (brush painting under perspective)
 *   - transform-overlay-canvas.tsx (selection tools under perspective)
 *
 * Under perspective (layer.transform.corners !== null):
 *   1. screen → canvas-px via invert(viewMatrix)
 *   2. canvas-px → layer-local via invertHomography(computeHomography(srcQuad, corners))
 *
 * Under affine (corners === null):
 *   Falls back to existing screenToLocal (affine path).
 *
 * @returns layer-local point, or null if transform is degenerate.
 */
export function screenToLocalPerspective(
  screenPoint: Vec2,
  view: { zoom: number; panX: number; panY: number },
  t: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): Vec2 | null {
  // 1. screen → canvas-px
  const viewM = composeViewMatrix(view);
  const invView = invert(viewM);
  if (!invView) return null;
  const canvasP = applyToPoint(invView, screenPoint);

  // 2. canvas-px → layer-local
  if (t.corners) {
    const srcQuad: [Vec2, Vec2, Vec2, Vec2] = [
      { x: 0, y: 0 },
      { x: naturalSize.w, y: 0 },
      { x: naturalSize.w, y: naturalSize.h },
      { x: 0, y: naturalSize.h },
    ];
    const H = computeHomography(srcQuad, t.corners);
    if (!H) return null;
    const invH = invertHomography(H);
    if (!invH) return null;
    return applyHomography(invH, canvasP);
  }

  // 3. Affine fallback
  return canvasToLocal(canvasP, t, naturalSize, docSize);
}

