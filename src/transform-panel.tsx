// ============================================================
// TRANSFORM PANEL — GenToniK Screentone Generator v2
// ============================================================
//
// Interactive layer transform + selection tools overlay.
//
// Two tool families are exposed on a single toolbar:
//
//   1. TRANSFORM tools — operate on the active layer's `transform`:
//        • Move      — drag the layer body to translate (x, y)
//        • Scale     — 8 bounding-box handles to resize (scaleX/scaleY)
//        • Rotate    — handle above top edge to spin (rotation)
//        • Skew      — 4 edge midpoint handles to shear (skewX/skewY)
//
//   2. SELECTION tools — produce a LayerMask on the active layer:
//        • Rect      — axis-aligned rect marquee → shape mask (rect)
//        • Ellipse   — ellipse marquee           → shape mask (ellipse)
//        • Lasso     — freehand lasso            → painted mask
//        • Polygonal — click-to-add-point lasso  → painted mask
//
// The component renders an overlay <canvas> sized to the document viewport.
// It expects the parent to provide:
//   - docSize (px)
//   - viewport (a ref to the visible canvas / container, used to map
//     pointer coords → canvas px)
//   - activeLayer (the layer being edited) and onTransformChange(transform)
//   - onMaskChange(mask | undefined) for selection tools
//
// History integration:
//   - Transform tools coalesce: during one drag, only one history push
//     is fired on pointerup. Intermediate moves update the layer live
//     without polluting the undo stack.
//   - Selection tools push exactly one history entry per completed
//     selection (on pointerup / polygon close).
//
// Coordinate systems:
//   - All pointer math is done in canvas-pixel space (the same space
//     as docSize). The parent's viewport scale/offset is folded in
//     via `screenToCanvas()` which the parent provides.
//   - Layer center math matches composite.ts:
//       destCenterX = docWidth/2 + transform.x
//       destCenterY = docHeight/2 + transform.y
//
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Layer,
  LayerMask,
  LayerTransform,
  Bounds,
  Vec2,
} from './types';
import { DEFAULT_TRANSFORM } from './types';

// Re-export Vec2 for backward compatibility — consumers that import
// Vec2 from './transform-panel' still work, but the canonical location
// is now './types' (shared with composite.ts and homography.ts).
export type { Vec2 };

// ────────────────────────────────────────────────────────────
// PUBLIC TYPES
// ────────────────────────────────────────────────────────────

export type TransformToolId =
  | 'move'
  | 'scale'
  | 'rotate'
  | 'skew'
  | 'perspective';

export type SelectionToolId =
  | 'rect'
  | 'ellipse'
  | 'lasso'
  | 'polygonal';

export type ToolId = TransformToolId | SelectionToolId | 'zoom' | 'bucket' | 'none';

export interface ToolState {
  tool: ToolId;
  /** For polygonal lasso: vertices accumulated so far (canvas px). */
  polygonPoints: Vec2[];
  /** For freehand lasso: live polyline being drawn (canvas px). */
  lassoPath: Vec2[];
  /** For rect/ellipse marquee: anchor point (canvas px). */
  marqueeStart: Vec2 | null;
  /** For rect/ellipse marquee: current point (canvas px). */
  marqueeEnd: Vec2 | null;
}

export interface TransformPanelProps {
  /** Document size in px (same as composite.ts docWidth/docHeight). */
  docSize: { w: number; h: number };
  /** Active layer being transformed/masked (null = no layer). */
  activeLayer: Layer | null;
  /** Natural rendered size of the active layer's content (px). */
  activeLayerNaturalSize: { w: number; h: number };

  /** Map a screen-space pointer event → canvas-pixel coords. */
  screenToCanvas: (clientX: number, clientY: number) => Vec2;
  /** Viewport scale (canvas px per CSS px). Used for handle sizing. */
  viewportScale: number;

  /** Fired on every live transform update during a drag. */
  onTransformLive?: (transform: LayerTransform) => void;
  /** Fired once on pointerup with the final transform (→ history push). */
  onTransformCommit?: (transform: LayerTransform, label: string) => void;

  /** Fired when a selection tool completes (→ history push). */
  onMaskChange?: (mask: LayerMask | undefined, label: string) => void;

  /** Optional: parent-controlled current tool (controlled mode). */
  tool?: ToolId;
  onToolChange?: (tool: ToolId) => void;

  /** Optional className for the toolbar container. */
  className?: string;
}

// ────────────────────────────────────────────────────────────
// GEOMETRY UTILITIES
// ────────────────────────────────────────────────────────────

// Vec2 is imported from './types' (Phase 2 — shared with composite.ts).

const vadd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const vsub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const vmul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
const vlen = (a: Vec2): number => Math.hypot(a.x, a.y);
const vlerp = (a: Vec2, b: Vec2, t: number): Vec2 => vadd(a, vmul(vsub(b, a), t));

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

const clampSkew = (deg: number): number => clamp(deg, -89, 89);

// ────────────────────────────────────────────────────────────
// QUAD WINDING / SELF-INTERSECTION HELPERS
// Used by perspective-corner drag to keep the quad non-self-
// intersecting even when the user drags a corner across the
// opposite edge (TL past BR, etc.). Without this, drawImageWith-
// Perspective produces a mirrored / doubled / broken render.
// ────────────────────────────────────────────────────────────

/** 2D cross product of vectors (o→a) and (o→b). */
function cross3(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Standard segment-intersection test (Strasbourg / computational-geometry
 * classic). Returns true iff segments a-b and c-d properly cross (not just
 * touch at an endpoint).
 */
function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross3(c, d, a);
  const d2 = cross3(c, d, b);
  const d3 = cross3(a, b, c);
  const d4 = cross3(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Given a quad [TL, TR, BR, BL], detect if it has become self-intersecting
 * (a "butterfly"/"hourglass" shape) and if so, swap the two pairs of corners
 * so the quad returns to a valid non-self-intersecting winding.
 *
 * Two failure modes are handled:
 *   • Vertical flip: TL→TR crosses BL→BR (top and bottom edges cross).
 *     Fix: swap TL↔BL and TR↔BR.
 *   • Horizontal flip: TR→BR crosses TL→BL (left and right edges cross).
 *     Fix: swap TL↔TR and BL↔BR.
 *
 * This mirrors Photoshop's behaviour when dragging a perspective corner
 * through the opposite side: the quad silently "flips through itself"
 * rather than collapsing into a degenerate butterfly.
 */
function normalizeCorners(q: [Vec2, Vec2, Vec2, Vec2]): [Vec2, Vec2, Vec2, Vec2] {
  const [tl, tr, br, bl] = q;
  if (segmentsIntersect(tl, tr, bl, br)) {
    return [bl, br, tr, tl];
  }
  if (segmentsIntersect(tr, br, tl, bl)) {
    return [tr, tl, bl, br];
  }
  return q;
}

/**
 * Forward transform a local-space point (relative to layer natural center)
 * into canvas-space, matching composite.ts pipeline:
 *   local → scale → skew → rotate → translate to dest center.
 *
 *   destCenter = docCenter + (transform.x, transform.y)
 *   scale      = (scaleX, scaleY)
 *   skew       = (tan(skewX), tan(skewY)) applied as 2x2 matrix
 *   rotate     = rotation deg
 */
export function forwardTransformPoint(
  localPoint: Vec2,
  transform: LayerTransform,
  docSize: { w: number; h: number },
): Vec2 {
  // 1. Scale
  const sx = localPoint.x * transform.scaleX;
  const sy = localPoint.y * transform.scaleY;
  // 2. Skew: x' = sx + tan(skewX) * sy;  y' = tan(skewY) * sx + sy
  const tanX = Math.tan((clampSkew(transform.skewX) * Math.PI) / 180);
  const tanY = Math.tan((clampSkew(transform.skewY) * Math.PI) / 180);
  const kx = sx + tanX * sy;
  const ky = tanY * sx + sy;
  // 3. Rotate
  const r = (transform.rotation * Math.PI) / 180;
  const cx = Math.cos(r), sn = Math.sin(r);
  const rx = kx * cx - ky * sn;
  const ry = kx * sn + ky * cx;
  // 4. Translate
  const destCenterX = docSize.w / 2 + transform.x;
  const destCenterY = docSize.h / 2 + transform.y;
  return { x: rx + destCenterX, y: ry + destCenterY };
}

/**
 * Inverse of forwardTransformPoint: canvas-space → local-space.
 * Returns null if the transform is degenerate (skew makes it singular).
 */
export function inverseTransformPoint(
  canvasPoint: Vec2,
  transform: LayerTransform,
  docSize: { w: number; h: number },
): Vec2 | null {
  const destCenterX = docSize.w / 2 + transform.x;
  const destCenterY = docSize.h / 2 + transform.y;
  // Un-translate
  let px = canvasPoint.x - destCenterX;
  let py = canvasPoint.y - destCenterY;
  // Un-rotate
  const r = (-transform.rotation * Math.PI) / 180;
  const cx = Math.cos(r), sn = Math.sin(r);
  let rx = px * cx - py * sn;
  let ry = px * sn + py * cx;
  // Un-skew: matrix [[1, tanX],[tanY, 1]] → det = 1 - tanX*tanY
  const tanX = Math.tan((clampSkew(transform.skewX) * Math.PI) / 180);
  const tanY = Math.tan((clampSkew(transform.skewY) * Math.PI) / 180);
  const det = 1 - tanX * tanY;
  if (Math.abs(det) < 1e-6) return null;
  const invDet = 1 / det;
  const ux = (rx - tanX * ry) * invDet;
  const uy = (-tanY * rx + ry) * invDet;
  rx = ux; ry = uy;
  // Un-scale
  if (transform.scaleX === 0 || transform.scaleY === 0) return null;
  rx /= transform.scaleX;
  ry /= transform.scaleY;
  return { x: rx, y: ry };
}

/**
 * Compute the 4 canvas-space corners of the active layer's bounding box
 * (after transform). Order: TL, TR, BR, BL.
 */
export function getLayerCorners(
  transform: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): [Vec2, Vec2, Vec2, Vec2] {
  const hw = naturalSize.w / 2;
  const hh = naturalSize.h / 2;
  const tl = forwardTransformPoint({ x: -hw, y: -hh }, transform, docSize);
  const tr = forwardTransformPoint({ x:  hw, y: -hh }, transform, docSize);
  const br = forwardTransformPoint({ x:  hw, y:  hh }, transform, docSize);
  const bl = forwardTransformPoint({ x: -hw, y:  hh }, transform, docSize);
  return [tl, tr, br, bl];
}

/**
 * Axis-aligned bounding box of the (possibly rotated) layer in canvas space.
 */
export function getLayerAABB(
  transform: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): Bounds {
  const [tl, tr, br, bl] = getLayerCorners(transform, naturalSize, docSize);
  const xs = [tl.x, tr.x, br.x, bl.x];
  const ys = [tl.y, tr.y, br.y, bl.y];
  return {
    left:   Math.min(...xs),
    top:    Math.min(...ys),
    right:  Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

/**
 * Test whether a canvas-space point is inside the (possibly rotated)
 * layer quad.
 */
function pointInLayerQuad(
  p: Vec2,
  corners: [Vec2, Vec2, Vec2, Vec2],
): boolean {
  // Use cross-product sign test on each edge.
  // Point is inside if it's on the same side of all 4 edges.
  const [a, b, c, d] = corners;
  const edges: [Vec2, Vec2][] = [[a, b], [b, c], [c, d], [d, a]];
  let sign = 0;
  for (const [e0, e1] of edges) {
    const ex = e1.x - e0.x;
    const ey = e1.y - e0.y;
    const cross = ex * (p.y - e0.y) - ey * (p.x - e0.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// HANDLE DEFINITIONS
// ────────────────────────────────────────────────────────────

type HandleId =
  | 'body'
  | 'scale-n'  | 'scale-s'  | 'scale-e'  | 'scale-w'
  | 'scale-nw' | 'scale-ne' | 'scale-sw' | 'scale-se'
  | 'rotate'
  | 'skew-n'   | 'skew-s'   | 'skew-e'   | 'skew-w'
  | 'perspective-tl' | 'perspective-tr' | 'perspective-br' | 'perspective-bl';

interface HandleHit {
  id: HandleId;
  /** Position in canvas px. */
  pos: Vec2;
}

/**
 * Compute the 13 visible handles for the active layer's bounding box:
 *   4 corners (scale-NW/NE/SW/SE), 4 edge midpoints (scale-N/S/E/W),
 *   1 rotate handle (above top edge),
 *   4 skew handles (at edge midpoints, offset outward).
 *
 * Note: scale-N/S/E/W and skew-N/S/E/W share the same edge midpoint
 * in concept, but for usability we draw them at slightly different
 * offsets — scale handles sit ON the edge, skew handles sit just
 * OUTSIDE the edge. We pick which one a pointer hit lands on by
 * checking the nearest handle.
 */
function computeHandles(
  transform: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): HandleHit[] {
  const [tl, tr, br, bl] = getLayerCorners(transform, naturalSize, docSize);
  const top    = vlerp(tl, tr, 0.5);
  const right  = vlerp(tr, br, 0.5);
  const bottom = vlerp(bl, br, 0.5);
  const left   = vlerp(tl, bl, 0.5);

  // Rotate handle sits 24px above the top edge midpoint, along the
  // outward normal of the top edge.
  const topEdge = vsub(tr, tl);
  const topLen = vlen(topEdge);
  const outwardNormal: Vec2 = topLen > 0
    ? { x: topEdge.y, y: -topEdge.x } // 90° CCW
    : { x: 0, y: -1 };
  const rotatePos = vadd(top, vmul(outwardNormal, 24 / (topLen || 1) * topLen));

  return [
    { id: 'body',   pos: vlerp(tl, br, 0.5) },
    { id: 'scale-nw', pos: tl },
    { id: 'scale-ne', pos: tr },
    { id: 'scale-se', pos: br },
    { id: 'scale-sw', pos: bl },
    { id: 'scale-n',  pos: top },
    { id: 'scale-e',  pos: right },
    { id: 'scale-s',  pos: bottom },
    { id: 'scale-w',  pos: left },
    { id: 'rotate',   pos: rotatePos },
    // Skew handles overlap edge midpoints; we use the same position
    // and disambiguate by tool mode (if tool === 'skew', edge hits
    // become skew; if tool === 'scale', edge hits become scale).
    { id: 'skew-n', pos: top },
    { id: 'skew-e', pos: right },
    { id: 'skew-s', pos: bottom },
    { id: 'skew-w', pos: left },
    // Perspective handles: same 4 corners as scale-NW/NE/SE/SW,
    // but active only in perspective tool. When transform.corners
    // is set, these positions come from corners directly (not from
    // the affine transform). The computePerspectiveHandles() below
    // handles that case; here we just duplicate the affine corners
    // so the overlay can render them in perspective tool too.
    { id: 'perspective-tl', pos: tl },
    { id: 'perspective-tr', pos: tr },
    { id: 'perspective-br', pos: br },
    { id: 'perspective-bl', pos: bl },
  ];
}

/**
 * Compute the 4 perspective corner handles.
 *
 * If `transform.corners` is set, use those directly (the user has
 * already entered perspective mode and deformed the quad).
 *
 * Otherwise, compute the 4 corners from the current affine transform
 * — this gives the user a sensible starting quad when they first
 * switch to the perspective tool (the layer visually doesn't change
 * until they drag a corner).
 */
function computePerspectiveHandles(
  transform: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): HandleHit[] {
  const corners: [Vec2, Vec2, Vec2, Vec2] = transform.corners
    ? transform.corners
    : getLayerCorners(transform, naturalSize, docSize);
  return [
    { id: 'perspective-tl', pos: corners[0] },
    { id: 'perspective-tr', pos: corners[1] },
    { id: 'perspective-br', pos: corners[2] },
    { id: 'perspective-bl', pos: corners[3] },
  ];
}

// ────────────────────────────────────────────────────────────
// POLYGON / RASTERIZATION HELPERS (for lasso masks)
// ────────────────────────────────────────────────────────────

/**
 * Compute the bounding box of a polyline.
 */
function polylineBounds(points: Vec2[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { left: minX, top: minY, right: maxX, bottom: maxY };
}

/**
 * Rasterize a closed polygon into a Uint8Array alpha mask.
 * - pixels entirely inside → 255
 * - pixels on the edge → 255 (inclusive)
 * - pixels outside → 0
 *
 * Uses the standard scanline polygon fill algorithm.
 * Returns { width, height, data, offsetX, offsetY } where:
 *   - the mask's (0,0) corresponds to canvas-pixel (offsetX, offsetY)
 *   - width × height = mask dimensions (>= 1×1)
 */
function rasterizePolygon(
  points: Vec2[],
): { width: number; height: number; data: Uint8Array; offsetX: number; offsetY: number } {
  const bounds = polylineBounds(points);
  if (!bounds) {
    return { width: 1, height: 1, data: new Uint8Array(1), offsetX: 0, offsetY: 0 };
  }
  const offsetX = Math.floor(bounds.left);
  const offsetY = Math.floor(bounds.top);
  const width  = Math.max(1, Math.ceil(bounds.right) - offsetX);
  const height = Math.max(1, Math.ceil(bounds.bottom) - offsetY);
  const data = new Uint8Array(width * height);

  // For each scanline y, find intersections with polygon edges,
  // sort by x, fill spans between odd/even pairs.
  for (let py = 0; py < height; py++) {
    const y = offsetY + py + 0.5; // sample at pixel center
    const xs: number[] = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const y1 = p1.y, y2 = p2.y;
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
        const t = (y - y1) / (y2 - y1);
        const x = p1.x + t * (p2.x - p1.x);
        xs.push(x);
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xStart = Math.max(0, Math.ceil(xs[i] - offsetX));
      const xEnd   = Math.min(width, Math.floor(xs[i + 1] - offsetX));
      for (let x = xStart; x < xEnd; x++) {
        data[py * width + x] = 255;
      }
    }
  }
  return { width, height, data, offsetX, offsetY };
}

/**
 * Build a LayerMask ('painted') from a closed polygon in canvas-space.
 *
 * The mask is stored relative to a tight bounding box of the polygon
 * (offsetX/offsetY = polygon's floor-left), so the mask array is as
 * small as possible.
 */
function polygonToMask(points: Vec2[], invert: boolean = false): LayerMask {
  if (points.length < 3) {
    return {
      type: 'painted',
      width: 1,
      height: 1,
      data: new Uint8Array([0]),
      // A2-fix-mask-transform (2026-06-25): offsetX/offsetY required by type.
      // This file is dead code (not imported anywhere); minimal change to
      // satisfy tsc. See transform-overlay-canvas.tsx for the canonical impl.
      offsetX: 0,
      offsetY: 0,
      invert,
    };
  }
  const r = rasterizePolygon(points);
  return {
    type: 'painted',
    width: r.width,
    height: r.height,
    data: r.data,
    offsetX: r.offsetX,
    offsetY: r.offsetY,
    invert,
  };
}

/**
 * Build a LayerMask ('shape') from a rect or ellipse marquee.
 * `bounds` is in canvas-space; the mask stores these bounds directly.
 */
function marqueeToMask(
  shape: 'rect' | 'ellipse',
  bounds: Bounds,
  feather: number = 0,
  invert: boolean = false,
): LayerMask {
  return {
    type: 'shape',
    shape,
    bounds: {
      left:   Math.min(bounds.left, bounds.right),
      top:    Math.min(bounds.top, bounds.bottom),
      right:  Math.max(bounds.left, bounds.right),
      bottom: Math.max(bounds.top, bounds.bottom),
    },
    feather,
    invert,
  };
}

/**
 * Build an ellipse as a polygon (for freehand-like consistency)
 * with N points. Used by the ellipse marquee in 'polygonal' render
 * mode, and as fallback for ellipse→painted conversion.
 */
export function ellipseToPolygon(
  cx: number, cy: number, rx: number, ry: number, n: number = 64,
): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return pts;
}

// ────────────────────────────────────────────────────────────
// TOOLBAR BUTTON
// ────────────────────────────────────────────────────────────

interface ToolbarButtonProps {
  toolId: ToolId;
  label: string;
  icon: string;
  active: boolean;
  disabled?: boolean;
  onClick: (id: ToolId) => void;
  title: string;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  label, icon, active, disabled, onClick, toolId, title,
}) => (
  <button
    type="button"
    title={title}
    disabled={disabled}
    onClick={() => onClick(toolId)}
    style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 2,
      padding: '6px 8px',
      border: active ? '1px solid #4a9' : '1px solid #444',
      borderRadius: 4,
      background: active ? '#1a3a3a' : '#222',
      color: active ? '#7ce' : '#ccc',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      fontSize: 11,
      minWidth: 56,
    }}
  >
    <span style={{ fontSize: 18, lineHeight: 1 }}>{icon}</span>
    <span>{label}</span>
  </button>
);

// ────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────

export const TransformPanel: React.FC<TransformPanelProps> = ({
  docSize,
  activeLayer,
  activeLayerNaturalSize,
  screenToCanvas,
  viewportScale,
  onTransformLive,
  onTransformCommit,
  onMaskChange,
  tool: controlledTool,
  onToolChange,
  className,
}) => {
  // Tool state (uncontrolled if `tool` prop is not provided)
  const [internalTool, setInternalTool] = useState<ToolId>('move');
  const tool = controlledTool ?? internalTool;
  const setTool = useCallback((t: ToolId) => {
    if (onToolChange) onToolChange(t);
    if (!controlledTool) setInternalTool(t);
  }, [controlledTool, onToolChange]);

  // Drag state — kept in refs to avoid re-renders during pointermove.
  const dragRef = useRef<{
    handle: HandleId;
    startCanvas: Vec2;        // pointer pos in canvas px at drag start
    startTransform: LayerTransform;
    polygonDraft?: Vec2[];    // for polygonal lasso during drag
    lassoDraft?: Vec2[];      // for freehand lasso during drag
    marqueeStart?: Vec2;
    hasMoved: boolean;
  } | null>(null);

  // Polygonal lasso persistent points (across clicks, before close)
  const [polygonPoints, setPolygonPoints] = useState<Vec2[]>([]);
  // Live marquee preview (rect/ellipse)
  const [marqueePreview, setMarqueePreview] = useState<{
    start: Vec2; end: Vec2; shape: 'rect' | 'ellipse';
  } | null>(null);
  // Live lasso preview
  const [lassoPreview, setLassoPreview] = useState<Vec2[] | null>(null);
  // Hover handle (for cursor feedback)
  const [hoverHandle, setHoverHandle] = useState<HandleId | null>(null);
  // Overlay canvas ref
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  // ── Reset transient state when tool or layer changes ──────
  useEffect(() => {
    setPolygonPoints([]);
    setMarqueePreview(null);
    setLassoPreview(null);
    dragRef.current = null;
  }, [tool, activeLayer?.id]);

  // ── Handles for active layer (memoized) ───────────────────
  const handles = useMemo<HandleHit[]>(() => {
    if (!activeLayer) return [];
    if (tool === 'perspective') {
      return computePerspectiveHandles(
        activeLayer.transform,
        activeLayerNaturalSize,
        docSize,
      );
    }
    if (tool === 'move' || tool === 'scale' || tool === 'rotate' || tool === 'skew') {
      return computeHandles(
        activeLayer.transform,
        activeLayerNaturalSize,
        docSize,
      );
    }
    return [];
  }, [activeLayer, activeLayerNaturalSize, docSize, tool]);

  // ── Handle size in screen px (constant), converted to canvas px ──
  const handleRadiusCanvas = 8 / Math.max(0.01, viewportScale);

  // ── Find nearest handle within hit radius ─────────────────
  const findHandle = useCallback((p: Vec2): HandleId | null => {
    if (!activeLayer || handles.length === 0) return null;
    const r = handleRadiusCanvas;
    // Order of preference: skip 'body' if a real handle is also hit
    let best: { id: HandleId; dist: number } | null = null;
    for (const h of handles) {
      if (h.id === 'body') continue;
      // For skew tool, ignore scale handles; for scale tool, ignore skew handles.
      if (tool === 'skew' && !h.id.startsWith('skew') && h.id !== 'rotate') continue;
      if (tool === 'scale' && h.id.startsWith('skew')) continue;
      if (tool === 'rotate' && h.id !== 'rotate') continue;
      if (tool === 'move') continue; // move tool: only body hits
      // Perspective tool: only perspective handles are active.
      if (tool === 'perspective' && !h.id.startsWith('perspective-')) continue;
      // Non-perspective tools: ignore perspective handles.
      if (tool !== 'perspective' && h.id.startsWith('perspective-')) continue;
      const d = Math.hypot(p.x - h.pos.x, p.y - h.pos.y);
      if (d <= r && (!best || d < best.dist)) {
        best = { id: h.id, dist: d };
      }
    }
    if (best) return best.id;
    // Move tool: hit body if inside the layer quad
    if (tool === 'move' && activeLayer) {
      const corners = getLayerCorners(
        activeLayer.transform, activeLayerNaturalSize, docSize,
      );
      if (pointInLayerQuad(p, corners)) return 'body';
    }
    // Perspective tool: hit body if inside the (possibly deformed) quad
    if (tool === 'perspective' && activeLayer) {
      const corners: [Vec2, Vec2, Vec2, Vec2] = activeLayer.transform.corners
        ? activeLayer.transform.corners
        : getLayerCorners(activeLayer.transform, activeLayerNaturalSize, docSize);
      if (pointInLayerQuad(p, corners)) return 'body';
    }
    return null;
  }, [activeLayer, handles, handleRadiusCanvas, tool, activeLayerNaturalSize, docSize]);

  // ── Cursor per handle ─────────────────────────────────────
  const cursorForHandle = useCallback((id: HandleId | null): string => {
    if (!id) {
      // Outside any handle: show crosshair for selection tools, default otherwise
      return (tool === 'rect' || tool === 'ellipse' || tool === 'lasso' || tool === 'polygonal')
        ? 'crosshair' : 'default';
    }
    if (id === 'body')   return 'move';
    if (id === 'rotate') return 'grab';
    // Perspective corners: use diagonal-resize cursors (matches user
    // expectation of dragging a corner).
    if (id === 'perspective-tl' || id === 'perspective-br') return 'nwse-resize';
    if (id === 'perspective-tr' || id === 'perspective-bl') return 'nesw-resize';
    // Scale cursors depend on handle world-orientation, but for simplicity:
    const map: Record<string, string> = {
      'scale-n':  'ns-resize',
      'scale-s':  'ns-resize',
      'scale-e':  'ew-resize',
      'scale-w':  'ew-resize',
      'scale-nw': 'nwse-resize',
      'scale-se': 'nwse-resize',
      'scale-ne': 'nesw-resize',
      'scale-sw': 'nesw-resize',
      'skew-n':   'all-scroll',
      'skew-s':   'all-scroll',
      'skew-e':   'all-scroll',
      'skew-w':   'all-scroll',
    };
    return map[id] ?? 'default';
  }, [tool]);

  // ── Pointer handlers ──────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!activeLayer) return;
    if (e.button !== 0) return;
    const p = screenToCanvas(e.clientX, e.clientY);

    // ── Selection tools: start a new selection ────────────
    if (tool === 'rect' || tool === 'ellipse') {
      dragRef.current = {
        handle: 'body',
        startCanvas: p,
        startTransform: { ...activeLayer.transform },
        marqueeStart: p,
        hasMoved: false,
      };
      setMarqueePreview({ start: p, end: p, shape: tool });
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'lasso') {
      dragRef.current = {
        handle: 'body',
        startCanvas: p,
        startTransform: { ...activeLayer.transform },
        lassoDraft: [p],
        hasMoved: false,
      };
      setLassoPreview([p]);
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'polygonal') {
      // Double-click or click near first point → close polygon
      if (polygonPoints.length >= 3) {
        const first = polygonPoints[0];
        if (Math.hypot(p.x - first.x, p.y - first.y) <= handleRadiusCanvas * 1.5) {
          const pts = [...polygonPoints];
          setPolygonPoints([]);
          onMaskChange?.(polygonToMask(pts), 'Polygonal Lasso');
          return;
        }
      }
      // Add a vertex
      setPolygonPoints(prev => [...prev, p]);
      return;
    }

    // ── Transform tools ───────────────────────────────────
    const hit = findHandle(p);
    if (!hit) return;
    dragRef.current = {
      handle: hit,
      startCanvas: p,
      startTransform: { ...activeLayer.transform },
      hasMoved: false,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [
    activeLayer, tool, screenToCanvas, polygonPoints, handleRadiusCanvas,
    onMaskChange, findHandle,
  ]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!activeLayer) return;
    const p = screenToCanvas(e.clientX, e.clientY);

    // Update hover handle for cursor feedback (no drag)
    if (!dragRef.current) {
      if (tool === 'move' || tool === 'scale' || tool === 'rotate' || tool === 'skew' || tool === 'perspective') {
        const h = findHandle(p);
        setHoverHandle(h);
      }
      return;
    }

    const drag = dragRef.current;
    drag.hasMoved = true;
    const start = drag.startCanvas;
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    const t0 = drag.startTransform;

    // ── Selection tools: update preview ───────────────────
    if ((tool === 'rect' || tool === 'ellipse') && drag.marqueeStart) {
      setMarqueePreview({
        start: drag.marqueeStart,
        end: p,
        shape: tool,
      });
      return;
    }
    if (tool === 'lasso' && drag.lassoDraft) {
      const last = drag.lassoDraft[drag.lassoDraft.length - 1];
      // Only add a point if moved > 2 canvas px from last (avoids huge arrays)
      if (Math.hypot(p.x - last.x, p.y - last.y) > 2) {
        drag.lassoDraft.push(p);
        setLassoPreview([...drag.lassoDraft]);
      }
      return;
    }

    // ── Transform tools: compute new transform ────────────
    let next: LayerTransform | null = null;

    if (drag.handle === 'body') {
      // Move: pure translation in canvas space (delta is in canvas px).
      // In perspective mode (corners set), translate all 4 corners
      // instead of x/y — otherwise the layer would jump back to
      // affine position.
      if (tool === 'perspective' && t0.corners) {
        next = {
          ...t0,
          corners: [
            { x: t0.corners[0].x + dx, y: t0.corners[0].y + dy },
            { x: t0.corners[1].x + dx, y: t0.corners[1].y + dy },
            { x: t0.corners[2].x + dx, y: t0.corners[2].y + dy },
            { x: t0.corners[3].x + dx, y: t0.corners[3].y + dy },
          ],
        };
      } else {
        next = { ...t0, x: t0.x + dx, y: t0.y + dy };
      }
    } else if (drag.handle === 'rotate') {
      // Rotate: angle from layer center to pointer, vs. angle at drag start
      const center = forwardTransformPoint(
        { x: 0, y: 0 }, t0, docSize,
      );
      const angNow = Math.atan2(p.y - center.y, p.x - center.x);
      const angStart = Math.atan2(start.y - center.y, start.x - center.x);
      const deltaDeg = ((angNow - angStart) * 180) / Math.PI;
      // Normalize to [-180, 180]
      let r = t0.rotation + deltaDeg;
      while (r > 180) r -= 360;
      while (r < -180) r += 360;
      next = { ...t0, rotation: r };
    } else if (drag.handle.startsWith('scale-')) {
      // Scale: project pointer delta onto the layer's local axes.
      // The layer's local x-axis in canvas space (after rotation+skew):
      //   we can invert-transform the pointer into local coords and
      //   compare to the start pointer's local coords.
      const localStart = inverseTransformPoint(start, t0, docSize);
      const localNow   = inverseTransformPoint(p,    t0, docSize);
      if (localStart && localNow) {
        const naturalHW = activeLayerNaturalSize.w / 2;
        const naturalHH = activeLayerNaturalSize.h / 2;
        let scaleX = t0.scaleX, scaleY = t0.scaleY;
        const h = drag.handle;
        // Edge handles scale only one axis; corner handles scale both.
        // We compute the ratio of |localNow - 0| to |localStart - 0|
        // along each axis, but anchored at the opposite edge.
        const aX = h.includes('w') ? +1 : h.includes('e') ? -1 : 0;
        const aY = h.includes('n') ? +1 : h.includes('s') ? -1 : 0;
        // Anchor (in local px, relative to center) is the opposite edge.
        // For corner scale-nw, anchor is the SE corner at (+hw, +hh).
        // The local coordinate grows positively toward BR.
        if (aX !== 0) {
          const anchorX = -aX * naturalHW; // opposite edge x
          const denomX = localStart.x - anchorX;
          if (Math.abs(denomX) > 1e-3) {
            scaleX = t0.scaleX * (localNow.x - anchorX) / denomX;
            // Clamp to avoid zero/negative
            scaleX = Math.sign(t0.scaleX) * Math.max(0.01, Math.abs(scaleX));
          }
        }
        if (aY !== 0) {
          const anchorY = -aY * naturalHH;
          const denomY = localStart.y - anchorY;
          if (Math.abs(denomY) > 1e-3) {
            scaleY = t0.scaleY * (localNow.y - anchorY) / denomY;
            scaleY = Math.sign(t0.scaleY) * Math.max(0.01, Math.abs(scaleY));
          }
        }
        // To keep the anchor point stationary, we also need to adjust
        // transform.x/y. The anchor in canvas space (at t0) is:
        //   anchorCanvas = forwardTransformPoint({x: -aX*hw, y: -aY*hh}, t0, docSize)
        // After scale change, the anchor in local coords is unchanged
        // but its canvas position changes unless we compensate.
        if (aX !== 0 || aY !== 0) {
          const anchorLocal = { x: -aX * naturalHW, y: -aY * naturalHH };
          const anchorCanvasBefore = forwardTransformPoint(anchorLocal, t0, docSize);
          const t1: LayerTransform = { ...t0, scaleX, scaleY };
          const anchorCanvasAfter = forwardTransformPoint(anchorLocal, t1, docSize);
          // Compensate: shift t1.x/y so anchor stays put
          next = {
            ...t1,
            x: t1.x + (anchorCanvasBefore.x - anchorCanvasAfter.x),
            y: t1.y + (anchorCanvasBefore.y - anchorCanvasAfter.y),
          };
        } else {
          next = { ...t0, scaleX, scaleY };
        }
      }
    } else if (drag.handle.startsWith('skew-')) {
      // Skew: project pointer delta onto the layer's local axes,
      // similar to scale. Skew-N means dragging the top edge sideways
      // (along local X) shears the layer in X (skewX).
      const localStart = inverseTransformPoint(start, t0, docSize);
      const localNow   = inverseTransformPoint(p,    t0, docSize);
      if (localStart && localNow) {
        const naturalHH = activeLayerNaturalSize.h / 2;
        const naturalHW = activeLayerNaturalSize.w / 2;
        const h = drag.handle;
        let skewX = t0.skewX, skewY = t0.skewY;
        if (h === 'skew-n' || h === 'skew-s') {
          // Dragging top/bottom edge sideways → skewX
          // The handle's local Y is ∓naturalHH (top = -HH, bottom = +HH).
          const handleY = h === 'skew-n' ? -naturalHH : naturalHH;
          const denom = Math.abs(handleY);
          if (denom > 1e-3) {
            const localDx = localNow.x - localStart.x;
            // tan(skewX) = localDx / |handleY|
            // skewX deg = atan(localDx / denom) — but we want DELTA from t0
            const deltaTan = localDx / denom;
            const newTan = Math.tan((clampSkew(t0.skewX) * Math.PI) / 180) + deltaTan;
            skewX = (Math.atan(newTan) * 180) / Math.PI;
            skewX = clampSkew(skewX);
          }
        } else {
          // skew-w / skew-e: dragging left/right edge vertically → skewY
          const handleX = h === 'skew-w' ? -naturalHW : naturalHW;
          const denom = Math.abs(handleX);
          if (denom > 1e-3) {
            const localDy = localNow.y - localStart.y;
            const deltaTan = localDy / denom;
            const newTan = Math.tan((clampSkew(t0.skewY) * Math.PI) / 180) + deltaTan;
            skewY = (Math.atan(newTan) * 180) / Math.PI;
            skewY = clampSkew(skewY);
          }
        }
        next = { ...t0, skewX, skewY };
      }
    } else if (drag.handle.startsWith('perspective-')) {
      // Perspective: drag the corresponding corner to p.
      // On first drag, initialize corners from the current affine
      // transform (so the layer doesn't jump visually).
      let baseCorners: [Vec2, Vec2, Vec2, Vec2];
      if (t0.corners) {
        baseCorners = [
          { ...t0.corners[0] }, { ...t0.corners[1] },
          { ...t0.corners[2] }, { ...t0.corners[3] },
        ];
      } else {
        baseCorners = getLayerCorners(t0, activeLayerNaturalSize, docSize);
      }
      const idx: number =
        drag.handle === 'perspective-tl' ? 0 :
        drag.handle === 'perspective-tr' ? 1 :
        drag.handle === 'perspective-br' ? 2 :
        drag.handle === 'perspective-bl' ? 3 : -1;
      if (idx >= 0) {
        const arr: Vec2[] = [baseCorners[0], baseCorners[1], baseCorners[2], baseCorners[3]];
        arr[idx] = { x: p.x, y: p.y };
        // A3-fix-1: if the user dragged a corner across the opposite edge
        // (TL past BR, etc.), the quad becomes self-intersecting ("butterfly"
        // shape) and the perspective renderer breaks (mirrored / doubled
        // triangles). normalizeCorners swaps adjacent corner pairs so the
        // quad returns to a valid non-self-intersecting winding — this is
        // the same behaviour Photoshop uses for perspective corner drag.
        const normalized = normalizeCorners([arr[0], arr[1], arr[2], arr[3]]);
        next = { ...t0, corners: normalized };
      }
    }

    if (next) {
      onTransformLive?.(next);
    }
  }, [
    activeLayer, tool, screenToCanvas, docSize,
    activeLayerNaturalSize, onTransformLive, findHandle,
  ]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!activeLayer) return;
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;

    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch {}

    // ── Selection tools: finalize selection ───────────────
    if ((tool === 'rect' || tool === 'ellipse') && drag.marqueeStart) {
      const start = drag.marqueeStart;
      const end = screenToCanvas(e.clientX, e.clientY);
      const b: Bounds = {
        left:   Math.min(start.x, end.x),
        top:    Math.min(start.y, end.y),
        right:  Math.max(start.x, end.x),
        bottom: Math.max(start.y, end.y),
      };
      setMarqueePreview(null);
      // Reject tiny selections (< 3px in any dim)
      if (b.right - b.left < 3 || b.bottom - b.top < 3) return;
      onMaskChange?.(marqueeToMask(tool, b), tool === 'rect' ? 'Rect Marquee' : 'Ellipse Marquee');
      return;
    }
    if (tool === 'lasso' && drag.lassoDraft) {
      const pts = [...drag.lassoDraft];
      setLassoPreview(null);
      if (pts.length >= 3) {
        onMaskChange?.(polygonToMask(pts), 'Freehand Lasso');
      }
      return;
    }

    // ── Transform tools: commit ───────────────────────────
    if (drag.hasMoved) {
      // The live updates already mutated the layer via onTransformLive.
      // We re-read the current layer.transform and push to history.
      const label =
        drag.handle === 'body'   ? 'Move' :
        drag.handle === 'rotate' ? 'Rotate' :
        drag.handle.startsWith('scale-') ? 'Scale' :
        drag.handle.startsWith('skew-')  ? 'Skew' :
        drag.handle.startsWith('perspective-') ? 'Perspective' : 'Transform';
      // Use the latest transform from the layer (it was updated via onTransformLive).
      // The parent must NOT have re-rendered us with a stale copy — but to be safe,
      // we re-read it.
      onTransformCommit?.({ ...activeLayer.transform }, label);
    }
  }, [activeLayer, tool, screenToCanvas, onMaskChange, onTransformCommit]);

  // ── Double-click handler for polygonal lasso close ───────
  const onDoubleClick = useCallback(() => {
    if (tool !== 'polygonal') return;
    if (polygonPoints.length < 3) return;
    const pts = [...polygonPoints];
    setPolygonPoints([]);
    onMaskChange?.(polygonToMask(pts), 'Polygonal Lasso');
  }, [tool, polygonPoints, onMaskChange]);

  // ── Escape: cancel current operation ─────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPolygonPoints([]);
        setMarqueePreview(null);
        setLassoPreview(null);
        dragRef.current = null;
      }
      // Tool shortcuts: V=move, S=scale, R=rotate, K=skew, F=free(perspective)
      //                 M=rect, E=ellipse, L=lasso, P=polygonal
      const map: Record<string, ToolId> = {
        v: 'move', s: 'scale', r: 'rotate', k: 'skew', f: 'perspective',
        m: 'rect', e: 'ellipse', l: 'lasso', p: 'polygonal',
      };
      const t = map[e.key.toLowerCase()];
      if (t && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setTool(t);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTool]);

  // ── Draw overlay ──────────────────────────────────────────
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The parent sets canvas.width/height to docSize; we draw in
    // canvas-pixel space directly.
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!activeLayer) return;

    // ── Draw bounding box for transform tools ─────────────
    if (tool === 'move' || tool === 'scale' || tool === 'rotate' || tool === 'skew') {
      const [tl, tr, br, bl] = getLayerCorners(
        activeLayer.transform, activeLayerNaturalSize, docSize,
      );
      ctx.save();
      ctx.strokeStyle = '#4af';
      ctx.lineWidth = 1 / viewportScale;
      ctx.setLineDash([4 / viewportScale, 4 / viewportScale]);
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw handles
      const r = handleRadiusCanvas;
      for (const h of handles) {
        if (h.id === 'body') continue;
        // Skip skew handles if tool !== 'skew'; skip scale handles if tool === 'skew'
        if (h.id.startsWith('skew') && tool !== 'skew') continue;
        if (h.id.startsWith('scale') && tool === 'skew') continue;
        if (h.id === 'rotate' && tool !== 'rotate') continue;
        // Edge scale handles hidden in move tool
        if (tool === 'move' && h.id !== 'rotate') continue;
        // Perspective handles not shown in non-perspective tools
        if (h.id.startsWith('perspective-')) continue;

        const isHover = hoverHandle === h.id;
        ctx.beginPath();
        ctx.arc(h.pos.x, h.pos.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isHover ? '#fff' : (h.id === 'rotate' ? '#7cf' : '#4af');
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1 / viewportScale;
        ctx.stroke();

        // Rotate handle: connecting line
        if (h.id === 'rotate') {
          const top = vlerp(tl, tr, 0.5);
          ctx.beginPath();
          ctx.moveTo(top.x, top.y);
          ctx.lineTo(h.pos.x, h.pos.y);
          ctx.strokeStyle = '#4af';
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // ── Draw perspective quad + corner handles ────────────
    if (tool === 'perspective' && activeLayer) {
      // Use the actual corners (from transform.corners if set,
      // else computed from affine transform).
      const corners: [Vec2, Vec2, Vec2, Vec2] = activeLayer.transform.corners
        ? activeLayer.transform.corners
        : getLayerCorners(activeLayer.transform, activeLayerNaturalSize, docSize);
      const [tl, tr, br, bl] = corners;

      ctx.save();
      // Draw quad outline
      ctx.strokeStyle = '#f4a';  // pink to distinguish from affine tools
      ctx.lineWidth = 1.5 / viewportScale;
      ctx.setLineDash([6 / viewportScale, 4 / viewportScale]);
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw diagonal lines (TL-BR and TR-BL) — helps visualize
      // the perspective deformation.
      ctx.strokeStyle = 'rgba(255, 100, 200, 0.35)';
      ctx.lineWidth = 1 / viewportScale;
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y); ctx.lineTo(br.x, br.y);
      ctx.moveTo(tr.x, tr.y); ctx.lineTo(bl.x, bl.y);
      ctx.stroke();

      // Draw corner handles as squares (different shape from
      // affine tools' circles, to reinforce that these are
      // independent perspective corners).
      const r = handleRadiusCanvas;
      const labels: Array<{ id: HandleId; pos: Vec2; label: string }> = [
        { id: 'perspective-tl', pos: tl, label: 'TL' },
        { id: 'perspective-tr', pos: tr, label: 'TR' },
        { id: 'perspective-br', pos: br, label: 'BR' },
        { id: 'perspective-bl', pos: bl, label: 'BL' },
      ];
      for (const h of labels) {
        const isHover = hoverHandle === h.id;
        ctx.beginPath();
        ctx.rect(h.pos.x - r, h.pos.y - r, r * 2, r * 2);
        ctx.fillStyle = isHover ? '#fff' : '#f4a';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1 / viewportScale;
        ctx.stroke();
      }

      // A3-fix-1: removed canvas-drawn "Affine mode — drag a corner..."
      // hint. The hint was a free-floating yellow text rendered directly
      // on the overlay canvas, with no visual anchor (no pill, no icon,
      // no border) — users reported it as an unexplained "приписка сверху"
      // that nobody notices. The same information is now surfaced as a
      // visible highlighted DOM badge in the Properties panel (see the
      // <div> block in the JSX render that renders АФФИННЫЙ РЕЖИМ when
      // tool === 'perspective' && !activeLayer.transform.corners).

      ctx.restore();
    }

    // ── Draw marquee preview ──────────────────────────────
    if (marqueePreview) {
      const { start, end, shape } = marqueePreview;
      const b: Bounds = {
        left:   Math.min(start.x, end.x),
        top:    Math.min(start.y, end.y),
        right:  Math.max(start.x, end.x),
        bottom: Math.max(start.y, end.y),
      };
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1 / viewportScale;
      ctx.setLineDash([3 / viewportScale, 3 / viewportScale]);
      if (shape === 'rect') {
        ctx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
      } else {
        ctx.beginPath();
        ctx.ellipse(
          (b.left + b.right) / 2,
          (b.top + b.bottom) / 2,
          (b.right - b.left) / 2,
          (b.bottom - b.top) / 2,
          0, 0, Math.PI * 2,
        );
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Draw lasso preview (freehand) ─────────────────────
    if (lassoPreview && lassoPreview.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 / viewportScale;
      ctx.beginPath();
      ctx.moveTo(lassoPreview[0].x, lassoPreview[0].y);
      for (let i = 1; i < lassoPreview.length; i++) {
        ctx.lineTo(lassoPreview[i].x, lassoPreview[i].y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ── Draw polygonal lasso points + connecting lines ────
    if (tool === 'polygonal' && polygonPoints.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 / viewportScale;
      ctx.beginPath();
      ctx.moveTo(polygonPoints[0].x, polygonPoints[0].y);
      for (let i = 1; i < polygonPoints.length; i++) {
        ctx.lineTo(polygonPoints[i].x, polygonPoints[i].y);
      }
      ctx.stroke();
      // Draw vertices
      const r = 4 / viewportScale;
      for (let i = 0; i < polygonPoints.length; i++) {
        const pt = polygonPoints[i];
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#7cf' : '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1 / viewportScale;
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [
    activeLayer, tool, handles, hoverHandle, viewportScale,
    marqueePreview, lassoPreview, polygonPoints,
    docSize, activeLayerNaturalSize, handleRadiusCanvas,
  ]);

  // ── Cursor for overlay ───────────────────────────────────
  const cursor = useMemo(
    () => cursorForHandle(hoverHandle),
    [cursorForHandle, hoverHandle],
  );

  // ── Numeric fields (bottom of panel) ─────────────────────
  const [numericDraft, setNumericDraft] = useState<LayerTransform>(
    activeLayer?.transform ?? DEFAULT_TRANSFORM,
  );
  useEffect(() => {
    if (activeLayer) setNumericDraft(activeLayer.transform);
  }, [activeLayer?.id, activeLayer?.transform]);

  const commitNumeric = (field: keyof LayerTransform, value: number) => {
    if (!activeLayer) return;
    const next: LayerTransform = { ...numericDraft, [field]: value };
    setNumericDraft(next);
    onTransformCommit?.(next, `Edit ${field}`);
  };

  // ── Reset transform button ───────────────────────────────
  const resetTransform = () => {
    if (!activeLayer) return;
    onTransformCommit?.({ ...DEFAULT_TRANSFORM }, 'Reset Transform');
  };

  // ── Reset corners button (revert perspective → affine) ───
  const resetCorners = () => {
    if (!activeLayer) return;
    if (!activeLayer.transform.corners) return; // already affine
    const next: LayerTransform = { ...activeLayer.transform, corners: null };
    onTransformCommit?.(next, 'Reset Perspective');
  };

  // ── Clear mask button ────────────────────────────────────
  const clearMask = () => {
    if (!activeLayer) return;
    onMaskChange?.(undefined, 'Clear Mask');
  };

  // ──────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────
  return (
    <div
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none', // overlay canvas is non-interactive by default
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        ...({ '--tw': 0 } as React.CSSProperties),
      }}
    >
      {/* A3-fix-1: keyframes for the AFFINE badge pulse animation.
          Injected once per panel mount; idempotent if React re-renders. */}
      <style>{`
        @keyframes tk-affine-hint-pulse {
          0%, 100% { box-shadow: 0 0 0 1px rgba(249, 168, 37, 0.25), 0 0 6px rgba(249, 168, 37, 0.30); }
          50%      { box-shadow: 0 0 0 1px rgba(249, 168, 37, 0.55), 0 0 12px rgba(249, 168, 37, 0.55); }
        }
      `}</style>
      {/* Toolbar — pointer-events: auto */}
      <div
        style={{
          position: 'absolute',
          top: 8, left: 8,
          display: 'flex',
          gap: 4,
          padding: 4,
          background: 'rgba(20, 22, 28, 0.92)',
          border: '1px solid #333',
          borderRadius: 6,
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
          zIndex: 10,
          flexWrap: 'wrap',
          maxWidth: 360,
        }}
      >
        {/* Transform group */}
        <ToolbarButton toolId="move"   label="Move"   icon="✥" title="Move (V)"    active={tool === 'move'}   disabled={!activeLayer} onClick={setTool} />
        <ToolbarButton toolId="scale"  label="Scale"  icon="⤢" title="Scale (S)"   active={tool === 'scale'}  disabled={!activeLayer} onClick={setTool} />
        <ToolbarButton toolId="rotate" label="Rotate" icon="⟲" title="Rotate (R)"  active={tool === 'rotate'} disabled={!activeLayer} onClick={setTool} />
        <ToolbarButton toolId="skew"   label="Skew"   icon="⤡" title="Skew (K)"    active={tool === 'skew'}   disabled={!activeLayer} onClick={setTool} />
        <ToolbarButton toolId="perspective" label="Free" icon="⬔" title="Free Transform / Perspective (F) — 4-corner deformation" active={tool === 'perspective'} disabled={!activeLayer} onClick={setTool} />

        {/* Divider */}
        <div style={{ width: 1, background: '#444', margin: '4px 2px' }} />

        {/* Selection group */}
        <ToolbarButton toolId="rect"      label="Rect"      icon="▭" title="Rect Marquee (M)"      active={tool === 'rect'}      disabled={!activeLayer} onClick={setTool} />
        <ToolbarButton toolId="ellipse"   label="Ellipse"   icon="◯" title="Ellipse Marquee (E)"   active={tool === 'ellipse'}   disabled={!activeLayer} onClick={setTool} />
        <ToolbarButton toolId="lasso"     label="Lasso"     icon="✎" title="Freehand Lasso (L)"    active={tool === 'lasso'}     disabled={!activeLayer} onClick={setTool} />
        <ToolbarButton toolId="polygonal" label="Polygonal" icon="⬠" title="Polygonal Lasso (P)"   active={tool === 'polygonal'} disabled={!activeLayer} onClick={setTool} />
      </div>

      {/* Bottom-right: numeric fields + actions */}
      <div
        style={{
          position: 'absolute',
          bottom: 8, right: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: 8,
          background: 'rgba(20, 22, 28, 0.92)',
          border: '1px solid #333',
          borderRadius: 6,
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
          zIndex: 10,
          fontSize: 11,
          color: '#ccc',
          minWidth: 220,
        }}
      >
        <div style={{ fontWeight: 600, color: '#7ce', marginBottom: 4 }}>
          Transform
        </div>
        <NumericRow label="X"     value={numericDraft.x}      onChange={v => commitNumeric('x', v)}      step={1} />
        <NumericRow label="Y"     value={numericDraft.y}      onChange={v => commitNumeric('y', v)}      step={1} />
        <NumericRow label="Scale X" value={numericDraft.scaleX} onChange={v => commitNumeric('scaleX', v)} step={0.01} />
        <NumericRow label="Scale Y" value={numericDraft.scaleY} onChange={v => commitNumeric('scaleY', v)} step={0.01} />
        <NumericRow label="Rotate"  value={numericDraft.rotation} onChange={v => commitNumeric('rotation', v)} step={1} unit="°" />
        <NumericRow label="Skew X"  value={numericDraft.skewX}  onChange={v => commitNumeric('skewX', v)}  step={0.5} unit="°" />
        <NumericRow label="Skew Y"  value={numericDraft.skewY}  onChange={v => commitNumeric('skewY', v)}  step={0.5} unit="°" />
        {activeLayer?.transform.corners && (
          <div style={{
            marginTop: 4, padding: '3px 6px',
            background: '#3a1a2a', border: '1px solid #f4a', borderRadius: 3,
            color: '#f8a', fontSize: 10, display: 'flex', justifyContent: 'space-between',
          }}>
            <span>PERSPECTIVE MODE</span>
            <span>corners set</span>
          </div>
        )}
        {/* A3-fix-1: replaced the canvas-drawn "Affine mode — drag a corner..."
            hint with this visible DOM badge. It only appears when the Free
            (perspective) tool is active but the layer is still in affine mode
            (corners === null) — exactly the state in which the old canvas hint
            was drawn. The badge is highlighted (amber background, pulsing
            border animation) so the user actually notices it, instead of the
            previous "невидимое" free-floating yellow text. */}
        {activeLayer && tool === 'perspective' && !activeLayer.transform.corners && (
          <div style={{
            marginTop: 4,
            padding: '4px 8px',
            background: 'linear-gradient(90deg, #3a2a10, #4a3017)',
            border: '1px solid #f9a825',
            borderRadius: 3,
            color: '#ffd166',
            fontSize: 10,
            lineHeight: 1.3,
            boxShadow: '0 0 0 1px rgba(249, 168, 37, 0.25), 0 0 6px rgba(249, 168, 37, 0.35)',
            animation: 'tk-affine-hint-pulse 1.6s ease-in-out infinite',
          }}>
            <div style={{ fontWeight: 700, letterSpacing: 0.4 }}>
              АФФИННЫЙ РЕЖИМ
            </div>
            <div style={{ opacity: 0.85, marginTop: 1 }}>
              потяните за угол → перспектива
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <button
            type="button"
            onClick={resetTransform}
            disabled={!activeLayer}
            style={btnStyle}
            title="Reset transform to identity"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={resetCorners}
            disabled={!activeLayer?.transform.corners}
            style={btnStyle}
            title="Revert perspective to affine transform"
          >
            Exit Persp
          </button>
          <button
            type="button"
            onClick={clearMask}
            disabled={!activeLayer?.mask}
            style={btnStyle}
            title="Remove layer mask"
          >
            Clear Mask
          </button>
        </div>
        {activeLayer?.mask && (
          <div style={{ marginTop: 2, color: '#888', fontSize: 10 }}>
            Mask: {activeLayer.mask.type}
            {activeLayer.mask.type === 'shape'
              ? ` (${activeLayer.mask.shape})`
              : ` (${activeLayer.mask.width}×${activeLayer.mask.height})`}
            {activeLayer.mask.invert ? ' [inv]' : ''}
          </div>
        )}
      </div>

      {/* Overlay canvas — captures pointer events for tools */}
      <canvas
        ref={overlayRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: activeLayer ? 'auto' : 'none',
          cursor,
          touchAction: 'none',
        }}
      />

      {/* Status hint */}
      {activeLayer && tool === 'polygonal' && polygonPoints.length > 0 && (
        <div style={hintStyle}>
          Click to add points · Click first point or double-click to close · Esc to cancel
        </div>
      )}
      {activeLayer && tool === 'lasso' && (
        <div style={hintStyle}>
          Draw freehand · Release to close selection
        </div>
      )}
      {activeLayer && (tool === 'rect' || tool === 'ellipse') && (
        <div style={hintStyle}>
          Click-drag to mark selection area
        </div>
      )}
      {activeLayer && tool === 'perspective' && (
        <div style={hintStyle}>
          Drag corner handles to deform · Drag body to move · F to toggle · Esc cancels drag
        </div>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// SMALL UI HELPERS
// ────────────────────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  flex: 1,
  padding: '4px 6px',
  fontSize: 11,
  background: '#2a2a2a',
  color: '#ccc',
  border: '1px solid #444',
  borderRadius: 3,
  cursor: 'pointer',
};

const hintStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '4px 10px',
  background: 'rgba(20, 22, 28, 0.92)',
  color: '#7ce',
  fontSize: 11,
  border: '1px solid #333',
  borderRadius: 4,
  pointerEvents: 'none',
  zIndex: 10,
  whiteSpace: 'nowrap',
};

interface NumericRowProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step: number;
  unit?: string;
}

const NumericRow: React.FC<NumericRowProps> = ({ label, value, onChange, step, unit }) => {
  const [draft, setDraft] = useState<string>(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 64, color: '#888', fontSize: 10, textAlign: 'right' }}>
        {label}
      </span>
      <input
        type="number"
        step={step}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          const n = parseFloat(draft);
          if (!isNaN(n)) onChange(n);
          else setDraft(String(value));
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        style={{
          flex: 1,
          padding: '2px 4px',
          background: '#1a1a1a',
          color: '#ddd',
          border: '1px solid #333',
          borderRadius: 2,
          fontSize: 11,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          width: 60,
        }}
      />
      {unit && <span style={{ color: '#666', fontSize: 10, width: 10 }}>{unit}</span>}
    </label>
  );
};

// ────────────────────────────────────────────────────────────
// CONVENIENCE HOOK
// ────────────────────────────────────────────────────────────

/**
 * useTransformPanel() — convenience hook that wires up the panel
 * to a parent React component managing layer state.
 *
 * Usage:
 *   const tp = useTransformPanel({ docSize, layers, activeLayerId, setLayers, pushHistory });
 *   <TransformPanel {...tp.props} />
 *
 * - onTransformLive: updates the layer in-place (no history push)
 * - onTransformCommit: updates the layer + pushes history
 * - onMaskChange: replaces the layer's mask + pushes history
 */
export function useTransformPanel(opts: {
  docSize: { w: number; h: number };
  getActiveLayer: () => Layer | null;
  onLayerTransformLive: (transform: LayerTransform) => void;
  onLayerTransformCommit: (transform: LayerTransform, label: string) => void;
  onLayerMaskChange: (mask: LayerMask | undefined, label: string) => void;
  screenToCanvas: (clientX: number, clientY: number) => Vec2;
  viewportScale: number;
  getActiveLayerNaturalSize: () => { w: number; h: number };
}): {
  props: Omit<TransformPanelProps, 'tool' | 'onToolChange'>;
} {
  const {
    docSize, getActiveLayer, onLayerTransformLive, onLayerTransformCommit,
    onLayerMaskChange, screenToCanvas, viewportScale, getActiveLayerNaturalSize,
  } = opts;

  const activeLayer = getActiveLayer();
  const props: Omit<TransformPanelProps, 'tool' | 'onToolChange'> = {
    docSize,
    activeLayer,
    activeLayerNaturalSize: getActiveLayerNaturalSize(),
    screenToCanvas,
    viewportScale,
    onTransformLive: onLayerTransformLive,
    onTransformCommit: onLayerTransformCommit,
    onMaskChange: onLayerMaskChange,
  };
  return { props };
}

// ────────────────────────────────────────────────────────────
// EXPORTS SUMMARY
// ────────────────────────────────────────────────────────────
//
// Types:
//   TransformToolId      — 'move' | 'scale' | 'rotate' | 'skew'
//   SelectionToolId      — 'rect' | 'ellipse' | 'lasso' | 'polygonal'
//   ToolId               — TransformToolId | SelectionToolId | 'none'
//   ToolState            — internal drag/polygon state (debug only)
//   TransformPanelProps  — component props
//   Vec2                 — {x, y}
//
// Geometry helpers (exported for unit testing & reuse):
//   forwardTransformPoint(localPoint, transform, docSize) → canvas point
//   inverseTransformPoint(canvasPoint, transform, docSize) → local point | null
//   getLayerCorners(transform, naturalSize, docSize) → [TL, TR, BR, BL]
//
// Components:
//   <TransformPanel {...props} /> — the main overlay
//
// Hook:
//   useTransformPanel({ ... }) — convenience wiring
//
// ============================================================
