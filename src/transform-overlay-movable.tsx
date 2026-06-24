// ============================================================
// transform-overlay-movable.tsx
// — react-moveable-based replacement for transform-panel.tsx
// ============================================================
//
// Interactive layer transform + selection tools overlay built on
// top of `react-moveable` (https://github.com/daybrush/moveable).
//
// Two tool families are exposed on a single toolbar (same surface
// area as ./transform-panel.tsx):
//
//   1. TRANSFORM tools — operate on the active layer's `transform`.
//      Powered by react-moveable's Draggable / Scalable / Rotatable
//      / Warpable ables, attached to an invisible "ghost" <div>
//      positioned over the canvas via the canonical view × layer
//      matrix (see ./transform-matrix.ts):
//        • Move         — Draggable
//        • Scale        — Scalable (8 directional handles)
//        • Rotate       — Rotatable (top handle)
//        • Skew         — Warpable, decomposed back to skewX/skewY
//        • Perspective  — Warpable, stored directly as 4 corners
//                         (transform.corners) → homography render
//
//   2. SELECTION tools — produce a LayerMask on the active layer.
//      These do NOT use react-moveable; they use pointer events on
//      a dedicated overlay <canvas> (logic adapted from
//      ./transform-panel.tsx):
//        • Rect         — axis-aligned rect marquee  → shape mask
//        • Ellipse      — ellipse marquee            → shape mask
//        • Lasso        — freehand lasso             → painted mask
//        • Polygonal    — click-to-add-point lasso   → painted mask
//
// ------------------------------------------------------------
// ATTRIBUTION
// ------------------------------------------------------------
//
// • react-moveable  — MIT License, Copyright (c) Daybrush
//   https://github.com/daybrush/moveable
//   Used for the draggable / scalable / rotatable / warpable
//   interaction primitives. The ghost <div> + <Moveable> pattern
//   follows the official react-moveable README examples.
//
// • Selection tool logic (polygonToMask, marqueeToMask,
//   rasterizePolygon, pointer handler flow) adapted from
//   ./transform-panel.tsx (GenToniK Screentone Generator original,
//   MIT). Reimplemented here with adjustments for the new overlay
//   layout.
//
// • Matrix math (composeLayerMatrix, composeViewMatrix, multiply,
//   matrixToCss, decomposeWarpMatrix, invert, applyToPoint) is
//   imported from ./transform-matrix.ts, which is the canonical
//   module shared with composite.ts and mask-editor.tsx. The
//   inverse-matrix pattern is inspired by fabric.js
//   (sendPointToPlane) — MIT, Copyright (c) Printio, Andrea
//   Bogazzi et al.
//
// ------------------------------------------------------------
// COORDINATE SYSTEMS
// ------------------------------------------------------------
//
// All pointer math flows through the parent-supplied
// `screenToCanvas(clientX, clientY)` which converts browser
// client coords → canvas-pixel coords:
//
//   canvasX = (clientX - rect.left - panX) / zoom
//   canvasY = (clientY - rect.top  - panY) / zoom
//
// where `rect` is the canvas container's bounding rect, and
// `panX/panY` are the viewport pan offsets (in CSS px).
//
// For DOM overlay positioning (the ghost div + selection canvas),
// we need the inverse — canvas → CSS px relative to the container:
//
//   cssX = canvasX * zoom + panX
//   cssY = canvasY * zoom + panY
//
// This is the `composeViewMatrix({zoom, panX, panY})` from
// ./transform-matrix.ts. IMPORTANT: panX/panY are NOT derivable
// from `screenToCanvas` alone (we'd need the container's rect).
// They are accepted as optional RECOMMENDED props; without them,
// the overlay will misalign when the canvas is panned.
//
// ------------------------------------------------------------
// KNOWN LIMITATIONS / TODO
// ------------------------------------------------------------
//
// • Skew tool accuracy: the spec calls for decomposing Moveable's
//   onWarp matrix3d directly into skewX/skewY. Because e.matrix
//   is the FULL transform (view × layer × warp), its decomposition
//   includes view.zoom and layer.scale folded into the skewY
//   value. For a layer at zoom=1, scale=1, rotation=0 this is
//   exact; for transformed layers the skew value will be
//   approximate. Use the perspective tool or numeric input for
//   pixel-accurate skew on transformed layers.
//
// • Snappable is disabled by default — it requires a snap
//   container ref and configured guidelines, which the parent
//   does not currently provide. Can be enabled by passing
//   `snappable={true}` and a `snapContainer` if desired.
//
// • Origin indicator is hidden (`origin={false}`) — our layer
//   transform's anchor is the layer center, not a movable origin.
//
// ============================================================

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import Moveable from 'react-moveable';
import type {
  OnDrag,
  OnDragStart,
  OnDragEnd,
  OnScale,
  OnScaleStart,
  OnScaleEnd,
  OnRotate,
  OnRotateStart,
  OnRotateEnd,
  OnWarp,
  OnWarpStart,
  OnWarpEnd,
} from 'react-moveable';
import type {
  Layer,
  LayerMask,
  LayerTransform,
  Bounds,
  Vec2,
} from './types';
import { DEFAULT_TRANSFORM } from './types';
import {
  composeLayerMatrix,
  composeViewMatrix,
  multiply,
  matrixToCss,
  decomposeWarpMatrix,
  invert,
  applyToPoint,
  type Matrix,
} from './transform-matrix';
import {
  computeHomography,
  invertHomography,
  applyHomography,
} from './homography';

// Re-export ToolId for consumers that import it from this module.
export type ToolId =
  | 'move'
  | 'scale'
  | 'rotate'
  | 'skew'
  | 'perspective'
  | 'rect'
  | 'ellipse'
  | 'lasso'
  | 'polygonal'
  | 'none';

// ────────────────────────────────────────────────────────────
// PUBLIC PROPS — must be a superset of TransformPanelProps
// (see ./transform-panel.tsx lines 92-119).
// ────────────────────────────────────────────────────────────

export interface TransformOverlayMovableProps {
  /** Document size in px (same as composite.ts docWidth/docHeight). */
  docSize: { w: number; h: number };
  /** Active layer being transformed/masked (null = no layer). */
  activeLayer: Layer | null;
  /** Natural rendered size of the active layer's content (px). */
  activeLayerNaturalSize: { w: number; h: number };

  /**
   * Map a screen-space pointer event → canvas-pixel coords.
   *   canvasX = (clientX - rect.left - panX) / zoom
   *   canvasY = (clientY - rect.top  - panY) / zoom
   */
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

  // ── EXTENSIONS (superset of TransformPanelProps) ──────────

  /**
   * Viewport pan offset X (CSS px). RECOMMENDED — without panX/panY,
   * the ghost div and selection canvas will misalign when the canvas
   * is panned. Defaults to 0.
   *
   * Matches App.tsx's panX state (see screenToCanvas implementation).
   */
  panX?: number;
  /** Viewport pan offset Y (CSS px). See panX. */
  panY?: number;

  /**
   * Optional ref to the canvas container. Currently unused (panX/panY
   * are required for accurate positioning), but accepted for future
   * auto-derivation of pan from screenToCanvas + container rect.
   */
  containerRef?: React.RefObject<HTMLElement | null>;
}

// ────────────────────────────────────────────────────────────
// INTERNAL HELPERS — selection rasterization
// (Adapted from ./transform-panel.tsx, GenToniK original, MIT)
// ────────────────────────────────────────────────────────────

/**
 * Compute the bounding box of a polyline (canvas-space px).
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
 * Map a canvas-space point to the layer's local coordinate space.
 * Handles both affine and perspective transform modes.
 */
function canvasToLocalPoint(
  p: Vec2,
  activeLayer: Layer,
  activeLayerNaturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): Vec2 {
  const w = activeLayerNaturalSize.w;
  const h = activeLayerNaturalSize.h;
  if (activeLayer.transform.corners) {
    const localCorners: [Vec2, Vec2, Vec2, Vec2] = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
    const H = computeHomography(localCorners, activeLayer.transform.corners);
    if (!H) return p;
    const invH = invertHomography(H);
    if (!invH) return p;
    return applyHomography(invH, p);
  } else {
    const layerM = composeLayerMatrix(activeLayer.transform, activeLayerNaturalSize, docSize);
    const invM = invert(layerM);
    if (!invM) return p;
    const localCenterRel = applyToPoint(invM, p);
    return {
      x: localCenterRel.x + w / 2,
      y: localCenterRel.y + h / 2,
    };
  }
}

/**
 * Rasterize a closed polygon in layer-local coordinates onto a canvas
 * of the full layer size. Uses GPU-accelerated Canvas2D native fill.
 */
function rasterizePolygonFull(
  points: Vec2[],
  width: number,
  height: number,
): Uint8Array {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) {
    return new Uint8Array(width * height);
  }

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
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = src[i * 4 + 3]; // alpha channel
  }
  return data;
}

/**
 * Build a LayerMask ('painted') from a closed polygon in document canvas-space.
 * Maps points into layer-local space first, then rasterizes onto a full-sized mask.
 */
function selectionToMask(
  points: Vec2[],
  activeLayer: Layer,
  activeLayerNaturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
  invert: boolean = false,
): LayerMask {
  const w = activeLayerNaturalSize.w;
  const h = activeLayerNaturalSize.h;
  if (points.length < 3) {
    return {
      type: 'painted',
      width: w,
      height: h,
      data: new Uint8Array(w * h),
      invert,
    };
  }
  
  // Inverse-transform points from document to layer-local coordinates
  const localPoints = points.map(p =>
    canvasToLocalPoint(p, activeLayer, activeLayerNaturalSize, docSize)
  );

  const data = rasterizePolygonFull(localPoints, w, h);
  return {
    type: 'painted',
    width: w,
    height: h,
    data,
    invert,
  };
}

// ────────────────────────────────────────────────────────────
// HOMOGRAPHY SOLVER — for perspective-mode ghost positioning
// ────────────────────────────────────────────────────────────

/**
 * Solve for the 4×4 homography matrix (CSS matrix3d, column-major,
// 16 elements) that maps 4 source points to 4 destination points.
 *
 * Source/dest order: [TL, TR, BR, BL].
 *
 * Used to position the ghost <div> when the layer is in perspective
 * mode (transform.corners is set). Without this, Moveable's warpable
 * would start each drag from the affine position, causing a visual
 * jump on the first handle grab.
 *
 * Returns null if the system is degenerate (e.g., 3 collinear points).
 */
function computeWarpMatrix(
  src: [Vec2, Vec2, Vec2, Vec2],
  dst: [Vec2, Vec2, Vec2, Vec2],
): number[] | null {
  // Solve for h = [h11, h12, h13, h21, h22, h23, h31, h32] (h33 = 1)
  // such that:
  //   Xi = (h11*xi + h12*yi + h13) / (h31*xi + h32*yi + 1)
  //   Yi = (h21*xi + h22*yi + h23) / (h31*xi + h32*yi + 1)
  //
  // Rearranged into linear form:
  //   h11*xi + h12*yi + h13 - h31*xi*Xi - h32*yi*Xi = Xi
  //   h21*xi + h22*yi + h23 - h31*xi*Yi - h32*yi*Yi = Yi
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }

  // Gaussian elimination with partial pivoting on the 8×8 system.
  const n = 8;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
    }
    [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];
    if (Math.abs(aug[i][i]) < 1e-12) return null; // singular
    for (let k = i + 1; k < n; k++) {
      const f = aug[k][i] / aug[i][i];
      for (let j = i; j <= n; j++) {
        aug[k][j] -= f * aug[i][j];
      }
    }
  }
  const h = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = aug[i][n];
    for (let j = i + 1; j < n; j++) s -= aug[i][j] * h[j];
    h[i] = s / aug[i][i];
  }

  // h = [h11, h12, h13, h21, h22, h23, h31, h32]
  // CSS matrix3d(a1, a2, a3, a4, b1, b2, b3, b4, c1, c2, c3, c4, d1, d2, d3, d4)
  // is column-major:
  //   | a1 b1 c1 d1 |   | h11 h12 0  h13 |
  //   | a2 b2 c2 d2 | = | h21 h22 0  h23 |
  //   | a3 b3 c3 d3 |   | 0   0   1  0   |
  //   | a4 b4 c4 d4 |   | h31 h32 0  1   |
  return [
    h[0], h[3], 0, h[6],   // col 0: a1, a2, a3, a4
    h[1], h[4], 0, h[7],   // col 1: b1, b2, b3, b4
    0,    0,    1, 0,      // col 2: c1, c2, c3, c4
    h[2], h[5], 0, 1,      // col 3: d1, d2, d3, d4
  ];
}

/**
 * Apply a CSS matrix3d (16-element column-major) to a 2D point
 * (x, y, z=0, w=1), with perspective division.
 *
 * For pure affine warps (m[3]=m[7]=0, m[15]=1) the division is a
 * no-op; for true perspective warps it is essential.
 *
 * Returns the resulting 2D point.
 */
function applyM3d(m: number[], x: number, y: number): Vec2 {
  const w = m[3] * x + m[7] * y + m[15];
  const safeW = Math.abs(w) < 1e-12 ? (w < 0 ? -1e-12 : 1e-12) : w;
  return {
    x: (m[0] * x + m[4] * y + m[12]) / safeW,
    y: (m[1] * x + m[5] * y + m[13]) / safeW,
  };
}

// ────────────────────────────────────────────────────────────
// SMALL UI HELPERS
// ────────────────────────────────────────────────────────────

const TOOL_GROUPS: Array<{
  id: ToolId;
  label: string;
  icon: string;
  title: string;
  isTransform: boolean;
}> = [
  { id: 'none',        label: 'Cursor',   icon: '➤', title: 'No tool (cursor only)', isTransform: false },
  { id: 'move',        label: 'Move',     icon: '✥', title: 'Move (V)',              isTransform: true },
  { id: 'scale',       label: 'Scale',    icon: '⤢', title: 'Scale (S)',             isTransform: true },
  { id: 'rotate',      label: 'Rotate',   icon: '⟲', title: 'Rotate (R)',            isTransform: true },
  { id: 'skew',        label: 'Skew',     icon: '⤡', title: 'Skew (K)',              isTransform: true },
  { id: 'perspective', label: 'Free',     icon: '⬔', title: 'Perspective / Free Transform (F)', isTransform: true },
  { id: 'rect',        label: 'Rect',     icon: '▭', title: 'Rect Marquee (M)',      isTransform: false },
  { id: 'ellipse',     label: 'Ellipse',  icon: '◯', title: 'Ellipse Marquee (E)',   isTransform: false },
  { id: 'lasso',       label: 'Lasso',    icon: '✎', title: 'Freehand Lasso (L)',    isTransform: false },
  { id: 'polygonal',   label: 'Polygon',  icon: '⬠', title: 'Polygonal Lasso (P)',   isTransform: false },
];

interface ToolbarButtonProps {
  toolId: ToolId;
  label: string;
  icon: string;
  title: string;
  active: boolean;
  disabled?: boolean;
  onClick: (id: ToolId) => void;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  toolId, label, icon, title, active, disabled, onClick,
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
      minWidth: 52,
    }}
  >
    <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
    <span>{label}</span>
  </button>
);

// ────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────

export const TransformOverlayMovable: React.FC<TransformOverlayMovableProps> = ({
  docSize,
  activeLayer,
  activeLayerNaturalSize,
  screenToCanvas,
  viewportScale: zoomRaw,
  onTransformLive,
  onTransformCommit,
  onMaskChange,
  tool: controlledTool,
  onToolChange,
  className,
  panX,
  panY,
}) => {
  // ── Viewport scale (zoom) with NaN/zero guard ─────────────
  const zoom = zoomRaw > 0 ? zoomRaw : 1;
  const view = useMemo(
    () => ({ zoom, panX: panX ?? 0, panY: panY ?? 0 }),
    [zoom, panX, panY],
  );

  // ── Tool state (uncontrolled if `tool` prop not provided) ──
  const [internalTool, setInternalTool] = useState<ToolId>('move');
  const tool: ToolId = controlledTool ?? internalTool;
  const setTool = useCallback((t: ToolId) => {
    onToolChange?.(t);
    if (!controlledTool) setInternalTool(t);
  }, [controlledTool, onToolChange]);

  // ── Drag state — captured at the start of each Moveable drag ──
  // Stored in a ref to avoid re-renders during pointermove.
  const dragRef = useRef<{
    startTransform: LayerTransform;
    label: string;
  } | null>(null);

  // isDragging — used to suppress React's controlled transform
  // on the ghost div during a drag, so Moveable can manipulate
  // the DOM directly via its gesto system without React fighting
  // it. See "Ghost div positioning" below.
  const [isDragging, setIsDragging] = useState(false);

  // ── Selection state (rect/ellipse/lasso/polygonal) ────────
  const [polygonPoints, setPolygonPoints] = useState<Vec2[]>([]);
  const [marqueePreview, setMarqueePreview] = useState<{
    start: Vec2; end: Vec2; shape: 'rect' | 'ellipse';
  } | null>(null);
  // Gemini 2.2 fix: lasso points are stored ONLY in selectionDragRef.current.lassoDraft
  // and drawn directly to the selection canvas during pointer move — NO React state,
  // NO re-render per point. The previous setLassoPreview([...points]) on every
  // mousemove caused severe lag on long lasso strokes.
  const selectionDragRef = useRef<{
    marqueeStart?: Vec2;
    lassoDraft?: Vec2[];
  } | null>(null);
  // Tick used to force the selection-canvas useEffect to re-run when needed
  // (e.g., after lasso ends, so the line is cleared from the canvas).
  const [, setSelectionTick] = useState(0);

  // ── Selection overlay canvas ref ──────────────────────────
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── Ghost div ref — passed to <Moveable target={...}> ─────
  const ghostRef = useRef<HTMLDivElement | null>(null);

  // ── Reset transient state when tool or layer changes ──────
  useEffect(() => {
    setPolygonPoints([]);
    setMarqueePreview(null);
    selectionDragRef.current = null;
    setSelectionTick(t => t + 1);
  }, [tool, activeLayer?.id]);

  // ── Reset drag flag if layer unmounts mid-drag ────────────
  useEffect(() => {
    if (!activeLayer) {
      dragRef.current = null;
      setIsDragging(false);
    }
  }, [activeLayer]);

  // ── Keyboard shortcuts: V/S/R/K/F/M/E/L/P + Esc ──────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPolygonPoints([]);
        setMarqueePreview(null);
        selectionDragRef.current = null;
        dragRef.current = null;
        setIsDragging(false);
        setSelectionTick(t => t + 1);
        return;
      }
      // Avoid hijacking typing in inputs
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const map: Record<string, ToolId> = {
        v: 'move', s: 'scale', r: 'rotate', k: 'skew', f: 'perspective',
        m: 'rect', e: 'ellipse', l: 'lasso', p: 'polygonal',
      };
      const t = map[e.key.toLowerCase()];
      if (t) {
        e.preventDefault();
        setTool(t);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTool]);

  // ── Perspective-mode detection ────────────────────────────
  // When transform.corners is set, the affine fields (x/y/scale/
  // rotation/skew) are IGNORED at composite time. We disable the
  // affine tool buttons in this state to prevent confusion.
  const isPerspectiveMode = !!activeLayer?.transform.corners;
  const affineToolsDisabled = isPerspectiveMode;

  // ── Ghost div positioning ─────────────────────────────────
  // The ghost is an invisible <div> sized to the layer's natural
  // dimensions and positioned over the canvas via a CSS transform
  // that equals `view × layer`. This makes the ghost align pixel-
  // perfectly with the rendered layer (even under rotation/skew/
  // flip), so Moveable's handles appear at the correct positions.
  //
  // In perspective mode (corners set), we compute a matrix3d that
  // maps natural-size → current screen-space corners, so the ghost
  // follows the homography-deformed layer.
  const ghostTransform = useMemo(() => {
    if (!activeLayer) return '';
    const t = activeLayer.transform;
    if (t.corners) {
      // Perspective mode: compute screen-space corners from canvas
      // corners via the view matrix (canvas → screen CSS px).
      const screenCorners = t.corners.map(c => ({
        x: c.x * view.zoom + view.panX,
        y: c.y * view.zoom + view.panY,
      })) as [Vec2, Vec2, Vec2, Vec2];
      const w = activeLayerNaturalSize.w;
      const h = activeLayerNaturalSize.h;
      const naturalCorners: [Vec2, Vec2, Vec2, Vec2] = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ];
      const warpM = computeWarpMatrix(naturalCorners, screenCorners);
      if (warpM) {
        return `matrix3d(${warpM.join(', ')})`;
      }
      // Fallback to affine if homography is degenerate.
    }
    const layerM = composeLayerMatrix(t, activeLayerNaturalSize, docSize);
    const viewM = composeViewMatrix(view);
    return matrixToCss(multiply(viewM, layerM));
  }, [activeLayer, activeLayerNaturalSize, docSize, view]);

  // ── Active tool classification ────────────────────────────
  const isTransformToolActive =
    tool === 'move' || tool === 'scale' || tool === 'rotate' ||
    tool === 'skew' || tool === 'perspective';
  const isSelectionToolActive =
    tool === 'rect' || tool === 'ellipse' || tool === 'lasso' || tool === 'polygonal';

  // ── Moveable config — which ables are active for the current tool ──
  // NOTE: 'none' tool disables all transform ables; the ghost div is
  // also unmounted, so Moveable renders nothing. 'none' is a cursor-only
  // mode that lets the user interact with the canvas underneath.
  const draggable = (tool === 'move') && !affineToolsDisabled;
  const scalable  = (tool === 'scale') && !affineToolsDisabled;
  const rotatable = (tool === 'rotate') && !affineToolsDisabled;
  const warpable  = (tool === 'skew' || tool === 'perspective');

  // ════════════════════════════════════════════════════════════
  // MOVEABLE EVENT HANDLERS — DRAG (Move tool)
  // ════════════════════════════════════════════════════════════

  const handleDragStart = useCallback((e: OnDragStart) => {
    if (!activeLayer) return;
    dragRef.current = {
      startTransform: { ...activeLayer.transform },
      label: 'Move',
    };
    setIsDragging(true);
    // Allow Moveable to read the current transform; no override needed.
    void e;
  }, [activeLayer]);

  // ────────────────────────────────────────────────────────────
  // Anchor-based x/y correction (Gemini 2.1 fix, adapted)
  // ──────────────────────────────────────────────────────────
  // The bug: react-moveable's ghost uses transformOrigin '0 0' and
  // emits e.drag.beforeTranslate to compensate. But our composite
  // pipeline (composeLayerMatrix) rotates/scales around the layer's
  // geometric CENTER (-w/2, -h/2). Adding raw beforeTranslate to
  // transform.x/y creates a math mismatch → frame jumps/jitters.
  //
  // The fix: don't use beforeTranslate for scale/rotate. Instead,
  // compute the new (x, y) by keeping the appropriate anchor point
  // fixed in canvas space, using our own composeLayerMatrix.
  //
  // For Rotate: the layer center is the rotation pivot, so x/y DON'T
  // CHANGE — center-based rotation preserves the center position.
  //
  // For Scale: the OPPOSITE corner (relative to the dragged handle)
  // is the anchor. Compute its start position, compute its position
  // under the new scale (with x/y unchanged), and shift x/y by the
  // negative delta to keep the anchor fixed.

  // ────────────────────────────────────────────────────────────
  // projectMatrixToCanvasXY — used by handleWarp (skew tool only)
  // ──────────────────────────────────────────────────────────
  // OnWarp IS the only react-moveable event that exposes `e.matrix`
  // (a 16-element column-major matrix3d representing local→screen).
  // We use it to project the layer center through the warp matrix
  // and derive the new (x, y) so the layer doesn't drift during skew.
  //
  // (OnDrag/OnScale/OnRotate don't expose .matrix in their public
  // types, so handleDrag/Scale/Rotate use anchor-based math instead.)
  const projectMatrixToCanvasXY = useCallback(
    (m3d: number[]): { newX: number; newY: number } => {
      const w = activeLayerNaturalSize.w;
      const h = activeLayerNaturalSize.h;
      // Project local center (w/2, h/2) through matrix3d → screen space
      const screenCenter = applyM3d(m3d, w / 2, h / 2);
      // Strip view transform: screen → canvas
      const canvasCenterX = (screenCenter.x - view.panX) / view.zoom;
      const canvasCenterY = (screenCenter.y - view.panY) / view.zoom;
      // composeLayerMatrix uses destCenter = docSize/2 + transform.x
      // So inverse: transform.x = canvasCenter - docSize/2
      return {
        newX: canvasCenterX - docSize.w / 2,
        newY: canvasCenterY - docSize.h / 2,
      };
    },
    [activeLayerNaturalSize, view, docSize],
  );

  const handleDrag = useCallback((e: OnDrag) => {
    if (!activeLayer || !dragRef.current) return;
    const t0 = dragRef.current.startTransform;
    // Move tool: pure translation. beforeTranslate is fine here
    // because there's no rotation/scale around center involved.
    const dxCanvas = e.beforeTranslate[0] / zoom;
    const dyCanvas = e.beforeTranslate[1] / zoom;
    const newTransform: LayerTransform = {
      ...t0,
      x: t0.x + dxCanvas,
      y: t0.y + dyCanvas,
    };
    onTransformLive?.(newTransform);
  }, [activeLayer, zoom, onTransformLive]);

  const handleDragEnd = useCallback((e: OnDragEnd) => {
    if (!activeLayer || !dragRef.current) return;
    const label = dragRef.current.label;
    dragRef.current = null;
    setIsDragging(false);
    if (e.isDrag || e.lastEvent) {
      onTransformCommit?.({ ...activeLayer.transform }, label);
    }
    void e;
  }, [activeLayer, onTransformCommit]);

  // ════════════════════════════════════════════════════════════
  // MOVEABLE EVENT HANDLERS — SCALE (Scale tool)
  // ════════════════════════════════════════════════════════════

  const handleScaleStart = useCallback((e: OnScaleStart) => {
    if (!activeLayer) return;
    dragRef.current = {
      startTransform: { ...activeLayer.transform },
      label: 'Scale',
    };
    setIsDragging(true);
    void e;
  }, [activeLayer]);

  const handleScale = useCallback((e: OnScale) => {
    if (!activeLayer || !dragRef.current) return;
    const t0 = dragRef.current.startTransform;
    // e.scale = [scaleX, scaleY] multiplier from dragStart.
    // Guard against zero/negative scales (degenerate layer)
    const newScaleX = t0.scaleX === 0
      ? e.scale[0]
      : Math.sign(t0.scaleX) * Math.max(0.001, Math.abs(t0.scaleX * e.scale[0]));
    const newScaleY = t0.scaleY === 0
      ? e.scale[1]
      : Math.sign(t0.scaleY) * Math.max(0.001, Math.abs(t0.scaleY * e.scale[1]));

    // Gemini 2.1 fix (anchor-based): don't use e.drag.beforeTranslate.
    // Instead, keep the OPPOSITE corner fixed in canvas space.
    // e.direction is a 2-element array: [-1, 0, 1] per axis.
    // If dragging the bottom-right (direction = [1, 1]), anchor = top-left (0, 0).
    // If dragging the top-left (direction = [-1, -1]), anchor = bottom-right (w, h).
    const w = activeLayerNaturalSize.w;
    const h = activeLayerNaturalSize.h;
    const dir = e.direction;
    const anchorLocal: Vec2 = {
      x: dir && dir[0] >= 0 ? 0 : w,
      y: dir && dir[1] >= 0 ? 0 : h,
    };

    // Compute anchor's canvas-space position under t0 (start) and under
    // the new scale (with x/y temporarily = t0.x/t0.y).
    const startMatrix = composeLayerMatrix(t0, activeLayerNaturalSize, docSize);
    const startAnchor = applyToPoint(startMatrix, anchorLocal);
    const newTentative: LayerTransform = {
      ...t0,
      scaleX: newScaleX,
      scaleY: newScaleY,
    };
    const newMatrix = composeLayerMatrix(newTentative, activeLayerNaturalSize, docSize);
    const newAnchor = applyToPoint(newMatrix, anchorLocal);

    // Shift x/y so the anchor returns to its start position.
    const newX = t0.x + (startAnchor.x - newAnchor.x);
    const newY = t0.y + (startAnchor.y - newAnchor.y);

    const newTransform: LayerTransform = {
      ...t0,
      scaleX: newScaleX,
      scaleY: newScaleY,
      x: newX,
      y: newY,
    };
    onTransformLive?.(newTransform);
  }, [activeLayer, activeLayerNaturalSize, docSize, onTransformLive]);

  const handleScaleEnd = useCallback((e: OnScaleEnd) => {
    if (!activeLayer || !dragRef.current) return;
    const label = dragRef.current.label;
    dragRef.current = null;
    setIsDragging(false);
    if (e.isDrag || e.lastEvent) {
      onTransformCommit?.({ ...activeLayer.transform }, label);
    }
    void e;
  }, [activeLayer, onTransformCommit]);

  // ════════════════════════════════════════════════════════════
  // MOVEABLE EVENT HANDLERS — ROTATE (Rotate tool)
  // ════════════════════════════════════════════════════════════

  const handleRotateStart = useCallback((e: OnRotateStart) => {
    if (!activeLayer) return;
    dragRef.current = {
      startTransform: { ...activeLayer.transform },
      label: 'Rotate',
    };
    setIsDragging(true);
    void e;
  }, [activeLayer]);

  const handleRotate = useCallback((e: OnRotate) => {
    if (!activeLayer || !dragRef.current) return;
    const t0 = dragRef.current.startTransform;
    // e.beforeRotation is the absolute rotation from dragStart (deg).
    let r = t0.rotation + (e.beforeRotation || 0);
    // Normalize to [-180, 180] for cleanliness
    while (r > 180) r -= 360;
    while (r < -180) r += 360;
    // Gemini 2.1 fix: our composeLayerMatrix rotates around the layer's
    // geometric CENTER (destCenter = docSize/2 + transform.x/y). This
    // means rotation preserves the center position, so transform.x/y
    // DO NOT CHANGE during pure rotation. The old code added
    // e.drag.beforeTranslate, which is react-moveable's compensation
    // for its origin-0,0 ghost — applying it caused the layer to
    // "drift" because our pipeline doesn't need that compensation.
    const newTransform: LayerTransform = {
      ...t0,
      rotation: r,
      // x, y intentionally kept as t0.x, t0.y — center-based rotation
      // preserves the center, and our transform.x/y IS the center
      // offset from docSize/2.
    };
    onTransformLive?.(newTransform);
  }, [activeLayer, onTransformLive]);

  const handleRotateEnd = useCallback((e: OnRotateEnd) => {
    if (!activeLayer || !dragRef.current) return;
    const label = dragRef.current.label;
    dragRef.current = null;
    setIsDragging(false);
    if (e.isDrag || e.lastEvent) {
      onTransformCommit?.({ ...activeLayer.transform }, label);
    }
    void e;
  }, [activeLayer, onTransformCommit]);

  // ════════════════════════════════════════════════════════════
  // MOVEABLE EVENT HANDLERS — WARP (Skew + Perspective tools)
  // ════════════════════════════════════════════════════════════

  const handleWarpStart = useCallback((e: OnWarpStart) => {
    if (!activeLayer) return;
    dragRef.current = {
      startTransform: { ...activeLayer.transform },
      label: tool === 'perspective' ? 'Perspective' : 'Skew',
    };
    setIsDragging(true);
    void e;
  }, [activeLayer, tool]);

  const handleWarp = useCallback((e: OnWarp) => {
    if (!activeLayer || !dragRef.current) return;
    const t0 = dragRef.current.startTransform;
    const m3d = e.matrix; // 16-element column-major matrix3d

    if (tool === 'perspective') {
      // Perspective tool: extract 4 screen-space corners from the
      // matrix3d by applying it to the natural-size corners, then
      // convert to canvas-space and store in transform.corners.
      const w = activeLayerNaturalSize.w;
      const h = activeLayerNaturalSize.h;
      const screenTL = applyM3d(m3d, 0, 0);
      const screenTR = applyM3d(m3d, w, 0);
      const screenBR = applyM3d(m3d, w, h);
      const screenBL = applyM3d(m3d, 0, h);
      const toCanvas = (p: Vec2): Vec2 => ({
        x: (p.x - view.panX) / view.zoom,
        y: (p.y - view.panY) / view.zoom,
      });
      const newTransform: LayerTransform = {
        ...t0,
        corners: [
          toCanvas(screenTL),
          toCanvas(screenTR),
          toCanvas(screenBR),
          toCanvas(screenBL),
        ],
      };
      onTransformLive?.(newTransform);
    } else {
      // Skew tool: decompose the matrix3d's 2D affine part into
      // skewX/skewY (and scale/rotation, which we discard to avoid
      // double-application with the start transform).
      //
      // NOTE: This is approximate when the layer has non-trivial
      // rotation/scale, because e.matrix's 2D part includes view ×
      // layer × warp. See "KNOWN LIMITATIONS" at file top.
      const m2d: Matrix = [m3d[0], m3d[1], m3d[4], m3d[5], m3d[12], m3d[13]];
      const decomp = decomposeWarpMatrix(m2d);
      if (decomp) {
        // Decompose skewY relative to the start transform's view×layer
        // scale, so we don't fold view.zoom into the skew value.
        // The 2D part of e.matrix is view*layer*warp; we want only the
        // warp's skew contribution. Compute the "expected" 2D matrix
        // at dragStart (view × layer) and divide it out.
        const layerM = composeLayerMatrix(t0, activeLayerNaturalSize, docSize);
        const viewM = composeViewMatrix(view);
        const expectedM = multiply(viewM, layerM);
        const invExpected = invert(expectedM);
        let skewYDeg = decomp.skewY;
        let skewXDeg = 0;
        if (invExpected) {
          // warp-only matrix = invExpected * m2d
          const warpOnly = multiply(invExpected, m2d);
          const warpDecomp = decomposeWarpMatrix(warpOnly);
          if (warpDecomp) {
            skewYDeg = warpDecomp.skewY;
            // decomposeWarpMatrix folds all shear into skewY; skewX stays 0.
            skewXDeg = 0;
          }
        }
        // Clamp to ±89° to match the composite pipeline (tan(90°) = ∞)
        const clampSkew = (deg: number) => Math.max(-89, Math.min(89, deg));
        // Gemini 2.1 fix: derive x/y from matrix-projected center to
        // prevent the layer from drifting when skew is applied (the
        // center-based composeLayerMatrix doesn't match Moveable's
        // origin 0,0 ghost, so without this the layer "flies away").
        const { newX, newY } = projectMatrixToCanvasXY(e.matrix);
        const newTransform: LayerTransform = {
          ...t0,
          skewX: clampSkew(skewXDeg),
          skewY: clampSkew(skewYDeg),
          // Preserve start transform's scale and rotation — the user is
          // only skewing, not scaling/rotating.
          scaleX: t0.scaleX,
          scaleY: t0.scaleY,
          rotation: t0.rotation,
          x: newX,
          y: newY,
        };
        onTransformLive?.(newTransform);
      }
    }
  }, [activeLayer, tool, activeLayerNaturalSize, docSize, view, onTransformLive, projectMatrixToCanvasXY]);

  const handleWarpEnd = useCallback((e: OnWarpEnd) => {
    if (!activeLayer || !dragRef.current) return;
    const label = dragRef.current.label;
    dragRef.current = null;
    setIsDragging(false);
    if (e.isDrag || e.lastEvent) {
      onTransformCommit?.({ ...activeLayer.transform }, label);
    }
    void e;
  }, [activeLayer, onTransformCommit]);

  // ════════════════════════════════════════════════════════════
  // SELECTION TOOL POINTER HANDLERS (rect/ellipse/lasso/polygonal)
  // Logic adapted from ./transform-panel.tsx lines 707-1028
  // ════════════════════════════════════════════════════════════

  const onSelectionPointerDown = useCallback((e: ReactPointerEvent) => {
    if (!activeLayer) return;
    if (e.button !== 0) return;
    const p = screenToCanvas(e.clientX, e.clientY);

    if (tool === 'rect' || tool === 'ellipse') {
      selectionDragRef.current = { marqueeStart: p };
      setMarqueePreview({ start: p, end: p, shape: tool });
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'lasso') {
      selectionDragRef.current = { lassoDraft: [p] };
      // Don't setLassoPreview — draw directly to canvas during move.
      // Initialise the path with a single point; subsequent move events
      // will draw incremental segments.
      const selCanvas = selectionCanvasRef.current;
      if (selCanvas) {
        const sctx = selCanvas.getContext('2d');
        if (sctx) {
          // Clear any previous selection drawing on this canvas
          sctx.clearRect(0, 0, selCanvas.width, selCanvas.height);
          sctx.save();
          sctx.strokeStyle = '#fff';
          sctx.lineWidth = 1.5 / zoom;
          sctx.lineCap = 'round';
          sctx.lineJoin = 'round';
          sctx.beginPath();
          sctx.moveTo(p.x, p.y);
          // Stash the context state on the ref so move handler can
          // continue the same path without re-setting styles.
        }
      }
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'polygonal') {
      // Click near first point (if 3+ points) → close polygon
      const handleR = 8 / zoom;
      if (polygonPoints.length >= 3) {
        const first = polygonPoints[0];
        if (Math.hypot(p.x - first.x, p.y - first.y) <= handleR * 1.5) {
          const pts = [...polygonPoints];
          setPolygonPoints([]);
          onMaskChange?.(
            selectionToMask(pts, activeLayer, activeLayerNaturalSize, docSize),
            'Polygonal Lasso'
          );
          return;
        }
      }
      setPolygonPoints(prev => [...prev, p]);
      return;
    }
  }, [activeLayer, tool, screenToCanvas, zoom, polygonPoints, onMaskChange, activeLayerNaturalSize, docSize]);

  const onSelectionPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!activeLayer) return;
    const p = screenToCanvas(e.clientX, e.clientY);

    if (tool === 'polygonal' && polygonPoints.length > 0) {
      const selCanvas = selectionCanvasRef.current;
      if (selCanvas) {
        const ctx = selCanvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, selCanvas.width, selCanvas.height);
          ctx.save();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5 / zoom;
          ctx.beginPath();
          ctx.moveTo(polygonPoints[0].x, polygonPoints[0].y);
          for (let i = 1; i < polygonPoints.length; i++) {
            ctx.lineTo(polygonPoints[i].x, polygonPoints[i].y);
          }
          ctx.lineTo(p.x, p.y);
          ctx.stroke();

          const r = 4 / zoom;
          for (let i = 0; i < polygonPoints.length; i++) {
            const pt = polygonPoints[i];
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
            ctx.fillStyle = i === 0 ? '#7cf' : '#fff';
            ctx.fill();
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1 / zoom;
            ctx.stroke();
          }
          ctx.restore();
        }
      }
      return;
    }

    const drag = selectionDragRef.current;
    if (!drag) return;

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
      // Only add a point if moved > 2 canvas px from last (avoids
      // unbounded array growth on long drags).
      if (Math.hypot(p.x - last.x, p.y - last.y) > 2) {
        drag.lassoDraft.push(p);
        // Gemini 2.2 fix: draw the new segment DIRECTLY to the selection
        // canvas. No React state update, no re-render, no Virtual DOM
        // diff. This is O(1) per move event instead of O(N).
        const selCanvas = selectionCanvasRef.current;
        if (selCanvas) {
          const sctx = selCanvas.getContext('2d');
          if (sctx) {
            // If this is the first move after pointerDown, the context
            // may have been cleared by a state-driven useEffect re-run.
            // Re-establish styles defensively.
            sctx.strokeStyle = '#fff';
            sctx.lineWidth = 1.5 / zoom;
            sctx.lineCap = 'round';
            sctx.lineJoin = 'round';
            sctx.beginPath();
            sctx.moveTo(last.x, last.y);
            sctx.lineTo(p.x, p.y);
            sctx.stroke();
          }
        }
      }
      return;
    }
  }, [activeLayer, tool, screenToCanvas, polygonPoints, zoom]);

  const onSelectionPointerUp = useCallback((e: ReactPointerEvent) => {
    if (!activeLayer) return;
    const drag = selectionDragRef.current;
    selectionDragRef.current = null;
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }

    if (!drag) return;

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
      // Reject tiny selections (< 3 canvas px in any dim)
      if (b.right - b.left < 3 || b.bottom - b.top < 3) return;
      
      let selectionPts: Vec2[] = [];
      if (tool === 'rect') {
        selectionPts = [
          { x: b.left, y: b.top },
          { x: b.right, y: b.top },
          { x: b.right, y: b.bottom },
          { x: b.left, y: b.bottom },
        ];
      } else {
        const cx = (b.left + b.right) / 2;
        const cy = (b.top + b.bottom) / 2;
        const rx = (b.right - b.left) / 2;
        const ry = (b.bottom - b.top) / 2;
        for (let i = 0; i < 64; i++) {
          const t = (i / 64) * Math.PI * 2;
          selectionPts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
        }
      }
      
      onMaskChange?.(
        selectionToMask(selectionPts, activeLayer, activeLayerNaturalSize, docSize),
        tool === 'rect' ? 'Rect Marquee' : 'Ellipse Marquee'
      );
      return;
    }
    if (tool === 'lasso' && drag.lassoDraft) {
      const pts = [...drag.lassoDraft];
      // Clear the lasso line from the selection canvas by forcing a tick.
      // The useEffect will re-run, see no lassoDraft in the ref (we nulled
      // it above), and clear the canvas.
      setSelectionTick(t => t + 1);
      if (pts.length >= 3) {
        onMaskChange?.(
          selectionToMask(pts, activeLayer, activeLayerNaturalSize, docSize),
          'Freehand Lasso'
        );
      }
      return;
    }
  }, [activeLayer, tool, screenToCanvas, onMaskChange, activeLayerNaturalSize, docSize]);

  const onSelectionDoubleClick = useCallback(() => {
    if (tool !== 'polygonal') return;
    if (polygonPoints.length < 3) return;
    const pts = [...polygonPoints];
    setPolygonPoints([]);
    onMaskChange?.(
      selectionToMask(pts, activeLayer, activeLayerNaturalSize, docSize),
      'Polygonal Lasso'
    );
  }, [tool, polygonPoints, onMaskChange, activeLayer, activeLayerNaturalSize, docSize]);

  // ── Draw selection overlay (marquee / lasso / polygonal) ──
  // The overlay canvas is sized to docSize (canvas px) and positioned
  // via the view matrix (zoom + pan). Drawing happens in canvas px,
  // which the view transform maps to screen CSS px.
  useEffect(() => {
    const canvas = selectionCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Match canvas internal pixel size to docSize (one canvas px per
    // doc px). This lets us draw directly in canvas coords.
    if (canvas.width !== docSize.w) canvas.width = docSize.w;
    if (canvas.height !== docSize.h) canvas.height = docSize.h;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!activeLayer) return;

    // Marquee preview (rect / ellipse)
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
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([3 / zoom, 3 / zoom]);
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

    // Freehand lasso preview — read from ref, not state (Gemini 2.2 fix).
    // During an active lasso drag, points are drawn incrementally to
    // the canvas in the pointer-move handler. This block only runs when
    // the useEffect re-runs for OTHER reasons (zoom change, tool change,
    // etc.) — it re-renders the lasso line from the ref so the user
    // doesn't lose their in-progress selection.
    const lassoDraft = selectionDragRef.current?.lassoDraft;
    if (tool === 'lasso' && lassoDraft && lassoDraft.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 / zoom;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(lassoDraft[0].x, lassoDraft[0].y);
      for (let i = 1; i < lassoDraft.length; i++) {
        ctx.lineTo(lassoDraft[i].x, lassoDraft[i].y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Polygonal lasso points + connecting lines
    if (tool === 'polygonal' && polygonPoints.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 / zoom;
      ctx.beginPath();
      ctx.moveTo(polygonPoints[0].x, polygonPoints[0].y);
      for (let i = 1; i < polygonPoints.length; i++) {
        ctx.lineTo(polygonPoints[i].x, polygonPoints[i].y);
      }
      ctx.stroke();
      const r = 4 / zoom;
      for (let i = 0; i < polygonPoints.length; i++) {
        const pt = polygonPoints[i];
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#7cf' : '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1 / zoom;
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [
    activeLayer, tool, marqueePreview, polygonPoints,
    docSize, zoom,
  ]);

  // ── Reset / clear handlers (for action buttons) ───────────
  const resetTransform = useCallback(() => {
    if (!activeLayer) return;
    onTransformCommit?.({ ...DEFAULT_TRANSFORM }, 'Reset Transform');
  }, [activeLayer, onTransformCommit]);

  const resetCorners = useCallback(() => {
    if (!activeLayer) return;
    if (!activeLayer.transform.corners) return;
    onTransformCommit?.(
      { ...activeLayer.transform, corners: null },
      'Reset Perspective',
    );
  }, [activeLayer, onTransformCommit]);

  const clearMask = useCallback(() => {
    if (!activeLayer) return;
    onMaskChange?.(undefined, 'Clear Mask');
  }, [activeLayer, onMaskChange]);

  // ── Selection overlay canvas CSS transform (view matrix) ──
  const selectionCanvasTransform = useMemo(
    () => matrixToCss(composeViewMatrix(view)),
    [view],
  );

  // ── Cursor for selection overlay ──────────────────────────
  const selectionCursor: string = isSelectionToolActive ? 'crosshair' : 'default';

  // ──────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────
  return (
    <div
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none', // overlay wrapper is non-interactive; only specific children opt back in
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      {/*
        CRITICAL FIX: react-moveable's .moveable-control / .moveable-line
        elements do NOT set `pointer-events: auto` in their default CSS, so
        they inherit `none` from this wrapper. We inject an explicit override
        here so the drag/scale/rotate/warp handles can receive pointerdown.
      */}
      <style>{`
        .moveable-control-box,
        .moveable-control-box .moveable-line,
        .moveable-control-box .moveable-control,
        .moveable-control-box .moveable-area {
          pointer-events: auto !important;
        }
      `}</style>

      {/* ── Ghost div + <Moveable> ─────────────────────────── */}
      {/* Only rendered when there is an active layer and a transform
          tool is selected. The ghost div is invisible (transparent
          background, pointerEvents: 'none' on itself — Moveable's
          control box handles pointer events). */}
      {activeLayer && isTransformToolActive && (
        <>
          <div
            ref={ghostRef}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: activeLayerNaturalSize.w,
              height: activeLayerNaturalSize.h,
              // Always reflect the latest committed/live transform from
              // activeLayer state. (Previous code stripped `transform`
              // during a drag — but Moveable does NOT mutate the ghost's
              // transform; it only mutates its own control box. Stripping
              // it caused the ghost to snap to (0,0) and the handles to
              // jump far away mid-drag.)
              transform: ghostTransform,
              transformOrigin: '0 0',
              pointerEvents: 'none',
              background: 'transparent',
            }}
          />
          {/*
            Wrap Moveable in a pointer-events:auto div so its control box
            (rendered as a sibling of `target`) re-opts into hit-testing.
            Combined with the <style> override above this is belt-and-suspenders.
          */}
          <div style={{ pointerEvents: 'auto' }}>
            <Moveable
              target={ghostRef}
              // Able toggles — exactly one active per tool
              draggable={draggable}
              scalable={scalable}
              rotatable={rotatable}
              warpable={warpable}
              // Allow dragging the layer body, not just the handles —
              // matches Photoshop/Krita UX where you grab the object itself.
              dragArea={draggable}
              // Snappable is OFF — requires a snap container ref that
              // the parent doesn't currently provide.
              snappable={false}
              // No throttle — live updates on every pointermove
              throttleDrag={0}
              throttleRotate={0}
              throttleScale={0}
              // Hide the origin indicator (our anchor is layer-center,
              // not a movable transform-origin)
              origin={false}
              originDraggable={false}
              // Moveable's internal zoom — we pre-bake zoom into the
              // ghost's transform, so Moveable should treat CSS px as
              // 1:1 with screen px.
              zoom={1}
              // Keep ratio off by default (user can hold Shift for
              // uniform scale via Moveable's built-in modifier)
              keepRatio={false}
              // Event handlers
              onDragStart={handleDragStart}
              onDrag={handleDrag}
              onDragEnd={handleDragEnd}
              onScaleStart={handleScaleStart}
              onScale={handleScale}
              onScaleEnd={handleScaleEnd}
              onRotateStart={handleRotateStart}
              onRotate={handleRotate}
              onRotateEnd={handleRotateEnd}
              onWarpStart={handleWarpStart}
              onWarp={handleWarp}
              onWarpEnd={handleWarpEnd}
            />
          </div>
        </>
      )}

      {/* ── Selection overlay canvas ───────────────────────── */}
      {/* Rendered for ALL tools (so we can draw polygonal/lasso
          preview even when a transform tool is also active), but
          only captures pointer events when a selection tool is
          active. */}
      {activeLayer && (
        <canvas
          ref={selectionCanvasRef}
          onPointerDown={onSelectionPointerDown}
          onPointerMove={onSelectionPointerMove}
          onPointerUp={onSelectionPointerUp}
          onPointerCancel={onSelectionPointerUp}
          onDoubleClick={onSelectionDoubleClick}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: docSize.w,
            height: docSize.h,
            transform: selectionCanvasTransform,
            transformOrigin: '0 0',
            // Only capture pointer events for selection tools
            pointerEvents: isSelectionToolActive ? 'auto' : 'none',
            cursor: selectionCursor,
            touchAction: 'none',
            imageRendering: 'pixelated',
          }}
        />
      )}

      {/* Status hints: most hints moved to the bottom Status Bar (App.tsx).
          Only the urgent perspective-mode warning stays on the canvas. */}
      {activeLayer && isPerspectiveMode && tool !== 'perspective' && (
        <div style={hintStyle}>
          Perspective mode active — switch to Free tool to edit, or click "Exit Persp" in Properties.
        </div>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// INLINE STYLE CONSTANTS
// ────────────────────────────────────────────────────────────
// (btnStyle removed — the bottom status panel that used it is gone,
// actions now live in the right-side Properties panel.)

const hintStyle: CSSProperties = {
  position: 'absolute',
  bottom: 36, // sit above the Status Bar
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

// ────────────────────────────────────────────────────────────
// EXPORTS SUMMARY
// ────────────────────────────────────────────────────────────
//
// Types:
//   ToolId                          — 'move' | 'scale' | 'rotate' | 'skew' |
//                                     'perspective' | 'rect' | 'ellipse' |
//                                     'lasso' | 'polygonal' | 'none'
//   TransformOverlayMovableProps    — component props (superset of
//                                     TransformPanelProps from
//                                     ./transform-panel.tsx)
//
// Component:
//   <TransformOverlayMovable {...props} /> — the main overlay
//
// The component is a DROP-IN replacement for <TransformPanel>:
//   - Same required props (docSize, activeLayer, activeLayerNaturalSize,
//     screenToCanvas, viewportScale, onTransformLive, onTransformCommit,
//     onMaskChange, tool, onToolChange, className)
//   - Two additional OPTIONAL props: panX, panY (strongly recommended
//     for correct overlay alignment when the canvas is panned)
//
// ============================================================
