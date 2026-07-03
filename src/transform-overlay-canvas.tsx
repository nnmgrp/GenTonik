// ============================================================
// transform-overlay-canvas.tsx — Canvas-based transform overlay
// ============================================================
//
// ЗАМЕНА transform-overlay-movable.tsx (react-moveable) на Canvas-overlay,
// который рисует handles в том же render-loop, что и пиксели скринтона.
//
// КОРНЕВАЯ ПРОБЛЕМА (решаемая этим файлом):
//   DOM-оверлей (react-moveable, CSS transform: matrix3d) и Canvas-полотно
//   (ctx.translate/rotate/scale) — разные render-loop'ы, накапливают drift
//   на 1-2 кадра при zoom/pan/transform. Подтверждено видео от 2026-06-24.
//
// РЕШЕНИЕ:
//   • Handles рисуются на отдельном <canvas>, который накладывается поверх
//     основного canvas composite.ts
//   • В RAF render-loop (синхронно с requestAnimationFrame) рисуем handles
//     через renderAllHandles из canvas-controls/renderHandles.ts
//   • Pointer events (down/move/up) hit-test'ят handles через hitTestAll
//     и диспатчат action (move/scale/scale-x/scale-y/rotate) → onTransformLive
//
// АРХИТЕКТУРА:
//   • <canvas ref> — оверлей, размер = контейнеру, позиция absolute
//   • CSS transform на <canvas> НЕ НАКЛАДЫВАЕТСЯ — вместо этого view matrix
//     (zoom + pan) применяется через ctx.setTransform перед отрисовкой handles
//   • Это гарантирует, что handles рисуются в тех же canvas-пикселях, что
//     и пиксели слоя (composite.ts рисует в canvas-пикселях, view matrix
//     применяется отдельным transform на главном canvas)
//
// MVP SCOPE (этап A1-core):
//   ✅ Move (drag по центру слоя)
//   ✅ Scale uniform (4 угла, с сохранением ratio по умолчанию)
//   ✅ Scale-x (ml/mr)
//   ✅ Scale-y (mt/mb)
//   ✅ Rotate (mtr, с snap к 15° по умолчанию)
//   ❌ Skew (TODO A3)
//   ❌ Perspective / Free Transform (TODO A3)
//   ❌ Selection tools (rect/ellipse/lasso/polygonal) — TODO A2
//
// ПРОПСЫ:
//   Полностью совместимы с TransformOverlayMovableProps — можно переключать
//   через feature flag USE_CANVAS_OVERLAY в App.tsx без изменения пропсов.
//
// ИНТЕГРАЦИЯ:
//   В App.tsx:
//     import { TransformOverlayCanvas } from './transform-overlay-canvas';
//     const USE_CANVAS_OVERLAY = true; // feature flag
//     {USE_CANVAS_OVERLAY
//       ? <TransformOverlayCanvas {...props} />
//       : <TransformPanelOverlay {...props} />}
//
// ATTRIBUTION:
//   • canvas-controls/Control.ts — handle class (поля из fabric.js MIT)
//   • canvas-controls/controls.ts — 9 handles + getCursor + getSnap (из Konva MIT)
//   • canvas-controls/renderHandles.ts — отрисовка (наша, GenToniK original MIT)
//   • transform-matrix.ts — каноническая математика (наша, с inverse-pattern
//     из fabric.js sendPointToPlane MIT)
// ============================================================

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  ActiveSelection,
  Bounds,
  Layer,
  LayerMask,
  LayerTransform,
  Vec2,
  SelectionOpMode,
  SelectionEntry,
} from '@/types';
import {
  composeLayerMatrix,
  composeViewMatrix,
  invert,
  applyToPoint,
  type Matrix,
} from '@/transform-matrix';
import {
  CONTROLS,
  CONTROL_LIST,
  hitTestAll,
  getOppositeHandle,
  getCursor,
  getSnap,
  DEFAULT_SNAP_TOLERANCE_RAD,
} from '@/canvas-controls/controls';
import { Control, type ControlId } from '@/canvas-controls/Control';
import { computeSkew, isSkewHandle, type LayerCorners } from '@/canvas-controls/skew-math';
import {
  traceMaskContour,
  rasterizePolygonAtSize,
} from '@/composite';
import {
  renderAllHandles,
  renderHandle,
  renderActiveHandle,
  getLayerCorners,
  DEFAULT_HANDLE_STYLE,
  renderPerspectiveQuad,
} from '@/canvas-controls/renderHandles';
import {
  computeHomography,
  invertHomography,
  applyHomography,
  isQuadDegenerate,
  normalizeCorners,
  pointInQuad,
} from './homography';

// Re-export ToolId — must match transform-overlay-movable.tsx
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
  | 'zoom'    // v2.5: Photoshop-style Zoom tool
  | 'bucket'  // v2.10: Bucket fill tool
  | 'measure' // v2.14: Measure tool (distance + angle)
  | 'none';

// ────────────────────────────────────────────────────────────
// PROPS — полностью совместимы с TransformOverlayMovableProps
// ────────────────────────────────────────────────────────────

export interface TransformOverlayCanvasProps {
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
  /** Fired when a selection tool completes (A2.1b). */
  onSelectionCommit?: (entry: {
    canvasPolygon: Vec2[];
    layerLocalPolygon: Vec2[];
    kind: 'rect' | 'ellipse' | 'lasso' | 'polygonal';
    shiftKey: boolean;
    altKey: boolean;
  }) => void;
  /** A2.2.3: committed selection (transient, from onSelectionCommit). */
  activeSelection?: ActiveSelection | null;
  /** A2.1a: Selection operation mode (New / Add / Subtract / Intersect). */
  selectionOpMode?: SelectionOpMode;

  /** Optional: parent-controlled current tool (controlled mode). */
  tool?: ToolId;
  onToolChange?: (tool: ToolId) => void;

  /** Optional className for the toolbar container. */
  className?: string;

  /** Viewport pan offset X (CSS px). */
  panX?: number;
  /** Viewport pan offset Y (CSS px). */
  panY?: number;

  /** Optional ref to the canvas container. Currently unused but accepted for API compat. */
  containerRef?: React.RefObject<HTMLElement | null>;
}

// ────────────────────────────────────────────────────────────
// Drag state — хранится в ref, не вызывает React re-render
// ────────────────────────────────────────────────────────────

interface DragState {
  /** Какой handle тащим (null = нет активного drag). */
  activeControl: Control | null;
  /** Start transform (snapshot на pointer down — для вычисления delta). */
  startTransform: LayerTransform;
  /** Forward-матрица startTransform — кэширована, чтобы не пересчитывать каждый move. */
  startMatrix: Matrix;
  /** Cursor position в canvas-пикселях на pointer down. */
  startCanvasPoint: Vec2;
  /** Какой tool активен (для подписи коммита). */
  label: string;
  /** Shift был зажат на pointer down? (для toggle uniform scale). */
  shiftKey: boolean;
  cornerIndex?: number;  // A3: 0=TL, 1=TR, 2=BR, 3=BL, -1=body, undefined=affine
}

// ────────────────────────────────────────────────────────────
// Selection drag state (A2 — 2026-06-25)
// ────────────────────────────────────────────────────────────
//
// Хранится в ref, НЕ в React state — иначе каждый mousemove lasso даёт re-render.
// RAF loop читает ref и рисует preview напрямую.
//
// Два режима:
//   1. Marquee (rect/ellipse): start + end в canvas-px, rectangle или ellipse.
//   2. Lasso/polygonal: массив точек в canvas-px. Для lasso — добавляются на
//      каждом move; для polygonal — на каждом click. Закрытие — pointerup (lasso)
//      или double-click / Enter (polygonal).

interface MarqueeDrag {
  kind: 'marquee';
  shape: 'rect' | 'ellipse';
  start: Vec2;
  end: Vec2;
}

interface LassoDrag {
  kind: 'lasso' | 'polygonal';
  points: Vec2[];
}

type SelectionDrag = MarqueeDrag | LassoDrag;

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Минимальный scale — защита от вырождения матрицы при drag "через ноль". */
const MIN_SCALE = 0.01;

/** Helper to extract canvas-space polygon points from a committed selection drag. */
function extractSelectionPoints(
  drag: SelectionDrag | null,
): Vec2[] | null {
  if (!drag) return null;
  switch (drag.kind) {
    case 'marquee': {
      const bounds: Bounds = {
        left:   Math.min(drag.start.x, drag.end.x),
        top:    Math.min(drag.start.y, drag.end.y),
        right:  Math.max(drag.start.x, drag.end.x),
        bottom: Math.max(drag.start.y, drag.end.y),
      };
      if (bounds.right - bounds.left > 2 && bounds.bottom - bounds.top > 2) {
        return marqueeBoundsToPolygon(drag.shape, bounds);
      }
      return null;
    }
    case 'lasso':
    case 'polygonal':
      return drag.points && drag.points.length >= 3 ? drag.points : null;
    default:
      return null;
  }
}

export const TransformOverlayCanvas: React.FC<TransformOverlayCanvasProps> = ({
  docSize,
  activeLayer,
  activeLayerNaturalSize,
  screenToCanvas,
  viewportScale: zoomRaw,
  onTransformLive,
  onTransformCommit,
  onSelectionCommit,
  activeSelection,
  tool: controlledTool,
  onToolChange: _onToolChange,
  selectionOpMode: _selectionOpMode,
  className,
  panX = 0,
  panY = 0,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const dashOffsetRef = useRef<number>(0);

  // ── A2: Selection drag state (ref, НЕ React state — иначе re-render storm) ──
  // Для rect/ellipse: хранит start/end. Для lasso/polygonal: массив точек.
  // polygonal завершается double-click → close → onMaskChange.
  const selectionDragRef = useRef<SelectionDrag | null>(null);

  // Tick — принудительный re-render для polygonal vertex dots (добавление точки
  // не вызывает pointermove, нужен триггер). Для lasso не нужен — там RAF читает
  // ref каждый кадр.
  const [, setSelectionTick] = useState(0);

  // A2.1b: Sync activeSelection and selectionOpMode to refs for performance
  // and fresh closure capture inside the 60fps RAF loop.
  const activeSelectionRef = useRef<ActiveSelection | null>(null);
  useEffect(() => {
    activeSelectionRef.current = activeSelection ?? null;
  }, [activeSelection]);

  // A2.1b-fix: Cached combined selection contours to prevent re-calculating on every RAF frame.
  const cachedSelectionContourRef = useRef<{ selection: ActiveSelection | null; contours: Vec2[][] }>({
    selection: null,
    contours: [],
  });

  useEffect(() => {
    if (!activeSelection || activeSelection.entries.length === 0) {
      cachedSelectionContourRef.current = { selection: null, contours: [] };
      return;
    }
    const startTime = performance.now();
    const contours = computeCanvasSpaceContour(activeSelection.entries);
    const duration = performance.now() - startTime;
    console.log(`[marching ants] Traced contour for ${activeSelection.entries.length} entries in ${duration.toFixed(2)}ms`);
    cachedSelectionContourRef.current = { selection: activeSelection, contours };
  }, [activeSelection]);

  const selectionOpModeRef = useRef<SelectionOpMode>('new');
  useEffect(() => {
    selectionOpModeRef.current = _selectionOpMode ?? 'new';
  }, [_selectionOpMode]);


  // ── Viewport scale (zoom) with NaN/zero guard ─────────────
  const zoom = zoomRaw > 0 ? zoomRaw : 1;
  const view = useMemo(
    () => ({ zoom, panX, panY }),
    [zoom, panX, panY],
  );

  // ── Tool state ─────────────────────────────────────────────
  // Tool приходит из родителя (App.tsx) — uncontrolled mode не нужен,
  // т.к. toolbar живёт в родителе. Если tool не передан, по умолчанию 'move'.
  const tool: ToolId = controlledTool ?? 'move';

  // ── Hover state (для курсора + подсветки handle) ──────────
  const [hoverControlId, setHoverControlId] = useState<ControlId | null>(null);

  // ── Active handle (drag in progress) ──────────────────────
  const [activeControlId, setActiveControlId] = useState<ControlId | null>(null);

  // ── Computed: forward-матрица активного слоя ──────────────
  const layerMatrix = useMemo(() => {
    if (!activeLayer) return null;
    return composeLayerMatrix(
      activeLayer.transform,
      activeLayerNaturalSize,
      docSize,
    );
  }, [activeLayer, activeLayerNaturalSize, docSize]);

  // ── PRESERVE-PERSPECTIVE: corner-based handle positions ──
  // When the layer has perspective corners set, the affine `layerMatrix`
  // (above) describes only the BASE affine transform and IGNORES the
  // perspective deformation in `corners`. Handle positions computed from
  // `layerMatrix` would be in the wrong place.
  //
  // Instead of using an affine approximation (which doesn't match the
  // actual perspective quad), we position handles DIRECTLY from the corners:
  //   - tl/tr/br/bl (scale corners) = the 4 perspective corners themselves
  //   - ml/mr/mt/mb (scale edges / skew) = midpoints of the 4 edges
  //   - mtr (rotate) = above the top-edge midpoint, offset by 30px along
  //     the top edge's normal (perpendicular, pointing "up" away from center)
  //   - body = pointInQuad test on the 4 corners
  //
  // This gives EXACT visual alignment: handles sit on the perspective quad.
  // The hit-test and rendering both use this map when corners ≠ null.
  const cornerHandlePositions = useMemo<Partial<Record<ControlId, Vec2>>>(() => {
    if (!activeLayer?.transform.corners) return {};
    const c = activeLayer.transform.corners; // [TL, TR, BR, BL]
    const tl = c[0], tr = c[1], br = c[2], bl = c[3];

    // Edge midpoints
    const mt = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };  // top
    const mr = { x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2 };  // right
    const mb = { x: (br.x + bl.x) / 2, y: (br.y + bl.y) / 2 };  // bottom
    const ml = { x: (bl.x + tl.x) / 2, y: (bl.y + tl.y) / 2 };  // left

    // Centroid (layer center in canvas space)
    const cx = (tl.x + tr.x + br.x + bl.x) / 4;
    const cy = (tl.y + tr.y + br.y + bl.y) / 4;

    // MTR (rotate handle): 30px above the top-edge midpoint, along the
    // normal to the top edge pointing AWAY from the centroid.
    // Top edge vector: TL → TR
    const topDx = tr.x - tl.x;
    const topDy = tr.y - tl.y;
    const topLen = Math.hypot(topDx, topDy);
    let mtr: Vec2;
    if (topLen < 1e-6) {
      mtr = { x: mt.x, y: mt.y - 30 };
    } else {
      // Normal to top edge: (topDy, -topDx) / topLen (rotate 90° CW)
      // or (-topDy, topDx) / topLen (rotate 90° CCW).
      // We want the normal pointing AWAY from centroid.
      const nx1 = topDy / topLen;
      const ny1 = -topDx / topLen;
      // Check if (nx1, ny1) points away from centroid:
      //   vector from mt to centroid = (cx - mt.x, cy - mt.y)
      //   dot with (nx1, ny1) should be NEGATIVE (away = opposite direction)
      const toCentroidX = cx - mt.x;
      const toCentroidY = cy - mt.y;
      const dot = nx1 * toCentroidX + ny1 * toCentroidY;
      const nx = dot > 0 ? -nx1 : nx1;
      const ny = dot > 0 ? -ny1 : ny1;
      mtr = { x: mt.x + nx * 30, y: mt.y + ny * 30 };
    }

    return {
      tl, tr, br, bl,
      ml, mr, mt, mb,
      mtr,
    };
  }, [activeLayer]);

  // Helper: get handle position for a given ControlId, using corner-based
  // positions when corners ≠ null, else falling back to layerMatrix.
  const getHandlePos = useCallback((id: ControlId): Vec2 | null => {
    if (activeLayer?.transform.corners) {
      const pos = cornerHandlePositions[id];
      if (pos) return pos;
    }
    if (!layerMatrix) return null;
    const ctrl = CONTROLS[id];
    if (!ctrl || typeof ctrl.positionHandler !== 'function') return null;
    return ctrl.positionHandler(activeLayerNaturalSize, layerMatrix);
  }, [activeLayer, cornerHandlePositions, layerMatrix, activeLayerNaturalSize]);

  // A2.1b: Unified selection commit helper
  const commitSelection = useCallback((
    sel: SelectionDrag,
    shiftKey: boolean,
    altKey: boolean,
  ) => {
    const canvasPts = extractSelectionPoints(sel);
    if (!canvasPts || canvasPts.length < 3) return;

    let localPts: Vec2[];
    if (activeLayer?.transform.corners) {
      // Perspective mode: map canvas-px to layer-local using homography.
      const srcQuad: [Vec2, Vec2, Vec2, Vec2] = [
        { x: 0, y: 0 },
        { x: activeLayerNaturalSize.w, y: 0 },
        { x: activeLayerNaturalSize.w, y: activeLayerNaturalSize.h },
        { x: 0, y: activeLayerNaturalSize.h },
      ];
      const H = computeHomography(srcQuad, activeLayer.transform.corners);
      if (!H) {
        alert("Selection unavailable: layer transform is degenerate.");
        return;
      }
      const invH = invertHomography(H);
      if (!invH) {
        alert("Selection unavailable: layer transform is degenerate.");
        return;
      }
      localPts = canvasPts.map(p => applyHomography(invH, p));
    } else {
      // Affine mode: map canvas-px to layer-local using inverse layerMatrix.
      const inverted = layerMatrix ? invert(layerMatrix) : null;
      localPts = inverted ? canvasPts.map(p => applyToPoint(inverted, p)) : canvasPts;
    }

    const kind = sel.kind === 'marquee' ? sel.shape : sel.kind;

    onSelectionCommit?.({
      canvasPolygon: canvasPts,
      layerLocalPolygon: localPts,
      kind,
      shiftKey,
      altKey,
    });
  }, [layerMatrix, onSelectionCommit, activeLayer, activeLayerNaturalSize]);

  // ── Cursor для всего overlay (зависит от hover + tool) ────
  const cursor = useMemo(() => {
    if (!activeLayer || !layerMatrix) return 'default';
    // A2: selection tools — всегда crosshair (Photoshop convention)
    if (tool === 'rect' || tool === 'ellipse'
        || tool === 'lasso' || tool === 'polygonal') {
      return 'crosshair';
    }
    // A3: perspective tool cursor
    if (tool === 'perspective') {
      if (hoverControlId === 'ptl' || hoverControlId === 'ptr' || hoverControlId === 'pbr' || hoverControlId === 'pbl') {
        return 'crosshair';
      }
      if (hoverControlId === 'body') {
        return 'move';
      }
      return 'default';
    }
    if (tool === 'move' || tool === 'none') {
      // A3-fix-3: Move tool cursor is always 'move'. Previously the cursor
      // changed based on hovered handle (scale cursor at corner, rotate at
      // mtr, etc.), which was misleading — user saw a scale/rotate cursor
      // and expected scale/rotate behavior, but Move was active and they
      // got translate. This was the user-reported "3-in-1 cursor" issue.
      // Now handles are also hidden (see getHiddenControlIds), so
      // hoverControlId should be null in Move mode anyway, but we return
      // 'move' unconditionally as a defensive measure.
      return 'move';
    }
    if (tool === 'scale' || tool === 'rotate' || tool === 'skew') {
      return 'crosshair';
    }
    return 'default';
  }, [activeLayer, layerMatrix, tool, hoverControlId]);

  // ──────────────────────────────────────────────────────────
  // RAF render loop
  // ──────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cancelled = false;

    const render = () => {
      if (cancelled) return;

      // 1. Resize canvas to container (если изменился)
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.max(1, Math.floor(rect.width));
      const cssH = Math.max(1, Math.floor(rect.height));
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }

      // 2. Очистка
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 3. Если нет активного слоя — ничего не рисуем
      if (!activeLayer || !layerMatrix) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      // v2.5.1: Zoom tool shows NOTHING on the overlay — it's a pure viewport
      // operation. Cursor tool ('none') also skips transform handles but may
      // still draw selection marching-ants below (handled by the regular path).
      //
      // v2.10.1: Bucket tool — skip transform handles (like zoom), but
      // STILL draw selection marching-ants (unlike zoom). The user needs
      // to see their selection to know where the fill will go.
      // We achieve this by NOT early-returning for bucket; instead, we
      // skip only the handle-drawing section (step 5) below via a
      // tool === 'bucket' check. Selection drawing (step 7a/7) runs.
      if (tool === 'zoom' || tool === 'measure') {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      // 4. Применяем view matrix (zoom + pan) + DPR
      //    Composite.ts рисует в canvas-пикселях, а наш overlay в CSS-пикселях
      //    поверх контейнера. Поэтому: ctx = view * dpr.
      const viewM = composeViewMatrix(view);
      ctx.setTransform(
        viewM[0] * dpr, viewM[1] * dpr,
        viewM[2] * dpr, viewM[3] * dpr,
        viewM[4] * dpr, viewM[5] * dpr,
      );

      // 5. Рисуем perspective quad или обычные handles
      //
      // v2.5.1: Cursor tool ('none') shows no transform handles — neither the
      // perspective quad nor the affine handles. Selection marching-ants
      // (drawn below at step 7a/7) still render so the user can see existing
      // selections while in Cursor mode.
      //
      // v2.10.1: Bucket tool also skips handles (like 'none').
      //
      // PRESERVE-PERSPECTIVE: when corners ≠ null, we render BOTH:
      //   - the perspective quad (pink dashed, 4 corners) — visual indicator
      //     of the deformed shape (always shown when corners set)
      //   - the affine handles for the active tool (rotate/scale/skew/move)
      //     positioned via `effectiveLayerMatrix` (affine approximation of
      //     the perspective quad) so they sit on top of the quad
      //
      // Corner handles of the perspective quad are editable ONLY in the
      // Free Transform tool; in affine tools they are visual-only.
      const hasPerspective = !!activeLayer.transform.corners;
      if (tool !== 'none' && tool !== 'bucket' && tool === 'perspective') {
        renderPerspectiveQuad(
          ctx,
          activeLayer.transform,
          activeLayerNaturalSize,
          docSize,
          activeControlId ?? hoverControlId,
        );
      } else if (tool !== 'none' && tool !== 'bucket' && hasPerspective) {
        // PRESERVE-PERSPECTIVE: Show perspective quad (pink dashed) + affine
        // handles for the active tool, positioned DIRECTLY from the corners
        // (via getHandlePos) so they sit exactly on the perspective quad.
        renderPerspectiveQuad(
          ctx,
          activeLayer.transform,
          activeLayerNaturalSize,
          docSize,
          null,  // don't highlight perspective corners in affine tools
        );
        // Draw affine handles using corner-based positions.
        // We render each visible handle manually (not via renderAllHandles)
        // because renderAllHandles uses layerMatrix which ignores corners.
        const __hiddenIds = getHiddenControlIds(tool);
        const __viewM = composeViewMatrix(view);
        const __dpr = window.devicePixelRatio || 1;
        // Connection line from mt to mtr (rotate handle stem)
        const mtPos = getHandlePos('mt');
        const mtrPos = getHandlePos('mtr');
        if (mtPos && mtrPos && !__hiddenIds.includes('mtr')) {
          ctx.save();
          ctx.strokeStyle = DEFAULT_HANDLE_STYLE.rotaterLineColor;
          ctx.lineWidth = DEFAULT_HANDLE_STYLE.rotaterLineWidth;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(mtPos.x, mtPos.y);
          ctx.lineTo(mtrPos.x, mtrPos.y);
          ctx.stroke();
          ctx.restore();
        }
        // Draw all handles except hidden ones
        for (const ctrl of CONTROL_LIST) {
          if (__hiddenIds.includes(ctrl.id)) continue;
          const pos = getHandlePos(ctrl.id);
          if (!pos) continue;
          // Use renderHandle from renderHandles.ts
          renderHandle(ctx, ctrl, pos, DEFAULT_HANDLE_STYLE);
        }
      } else {
        renderAllHandles(ctx, layerMatrix, activeLayerNaturalSize);
        // A3-fix-3: erase hidden handles (visibility per tool).
        // renderAllHandles draws ALL handles; we then clear the pixels
        // around each hidden handle so the user only sees the ones that
        // are actually active for the current tool. The bounding box and
        // connection lines drawn by renderAllHandles remain visible.
        const __hiddenIds = getHiddenControlIds(tool);
        if (__hiddenIds.length > 0) {
          ctx.save();
          // Reset to identity (canvas-pixel space) for clearRect.
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          const __dpr = window.devicePixelRatio || 1;
          const __viewM = composeViewMatrix(view);
          // Padding around handle center to ensure full erasure
          // (handleSize + stroke + shadow + a few px of slack).
          const __halfSize = ((DEFAULT_HANDLE_STYLE.controlSize || 8) + 6) * __dpr;
          for (const __id of __hiddenIds) {
            const __ctrl = CONTROLS[__id];
            if (__ctrl && typeof __ctrl.positionHandler === 'function') {
              const __pos = __ctrl.positionHandler(activeLayerNaturalSize, layerMatrix);
              // Apply view matrix + DPR to convert canvas-space point
              // to canvas-pixel coordinates for clearRect.
              const __cx = (__viewM[0] * __pos.x + __viewM[2] * __pos.y + __viewM[4]) * __dpr;
              const __cy = (__viewM[1] * __pos.x + __viewM[3] * __pos.y + __viewM[5]) * __dpr;
              ctx.clearRect(__cx - __halfSize, __cy - __halfSize,
                            __halfSize * 2, __halfSize * 2);
            }
          }
          ctx.restore();
          // Re-apply the view+DPR transform that was active before erasure.
          // (ctx.save / ctx.restore would have done this, but we used
          // setTransform inside the saved state, so we need to reset
          // explicitly here for subsequent draws in this frame.)
          ctx.setTransform(
            __viewM[0] * __dpr, __viewM[1] * __dpr,
            __viewM[2] * __dpr, __viewM[3] * __dpr,
            __viewM[4] * __dpr, __viewM[5] * __dpr,
          );
        }
      }

      // 6. Подсветка активного handle (drag в процессе) или hover.
      //    'body' исключаем — у него нет визуального handle для подсветки
      //    (курсор 'move' уже показывает, что слой можно перетащить).
      const highlightId = activeControlId ?? hoverControlId;
      if (highlightId && highlightId !== 'body') {
        const ctrl = CONTROLS[highlightId];
        // PRESERVE-PERSPECTIVE: for perspective layers, use corner-based position
        const hlPos = getHandlePos(highlightId);
        if (hlPos) {
          // Manual highlight render (mirrors renderActiveHandle but with custom pos)
          const highlightStyle = {
            ...DEFAULT_HANDLE_STYLE,
            controlStroke: '#ffcc00',
            controlSize: DEFAULT_HANDLE_STYLE.controlSize + 2,
            rotaterSize: DEFAULT_HANDLE_STYLE.rotaterSize + 2,
            controlStrokeWidth: 2,
          };
          renderHandle(ctx, ctrl, hlPos, highlightStyle);
        } else {
          renderActiveHandle(ctx, ctrl, layerMatrix, activeLayerNaturalSize, {
            ...DEFAULT_HANDLE_STYLE,
            controlStroke: '#ffcc00',
            controlSize: DEFAULT_HANDLE_STYLE.controlSize + 2,
          });
        }
      }

      // 7a. A2.1b-fix-2: Combined silhouette marching ants with dashed black halo.
      //     Single contour (mathematical merge of all entries) + high-contrast yellow
      //     with dashed black halo underneath (same dash offset and pattern, lineWidth = 2.5)
      //     for visibility on any background without looking heavy.
      const selectionCache = cachedSelectionContourRef.current;
      if (selectionCache.contours.length > 0) {
        ctx.save();

        const DASH = [6, 4];
        const OFFSET = -dashOffsetRef.current;

        // 1. Subtle yellow tint fill (matches color, very transparent, evenodd rule for holes).
        ctx.beginPath();
        for (const contour of selectionCache.contours) {
          if (contour.length < 2) continue;
          ctx.moveTo(contour[0].x, contour[0].y);
          for (let i = 1; i < contour.length; i++) {
            ctx.lineTo(contour[i].x, contour[i].y);
          }
          ctx.closePath();
        }
        ctx.fillStyle = 'rgba(255, 204, 0, 0.10)';
        ctx.fill('evenodd');

        // 2. Pass 1: black dashed halo (under yellow).
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2.5;
        ctx.setLineDash(DASH);
        ctx.lineDashOffset = OFFSET;
        for (const contour of selectionCache.contours) {
          if (contour.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(contour[0].x, contour[0].y);
          for (let i = 1; i < contour.length; i++) {
            ctx.lineTo(contour[i].x, contour[i].y);
          }
          ctx.closePath();
          ctx.stroke();
        }

        // 3. Pass 2: yellow dashed ants (on top — same dash pattern, same offset).
        ctx.strokeStyle = '#ffcc00';
        ctx.lineWidth = 1.5;
        ctx.setLineDash(DASH);
        ctx.lineDashOffset = OFFSET;
        for (const contour of selectionCache.contours) {
          if (contour.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(contour[0].x, contour[0].y);
          for (let i = 1; i < contour.length; i++) {
            ctx.lineTo(contour[i].x, contour[i].y);
          }
          ctx.closePath();
          ctx.stroke();
        }

        ctx.restore();
      }

      // 7. A2: Selection preview (rect/ellipse/lasso/polygonal)
      //    Читаем из ref (НЕ React state) — RAF видит свежие точки lasso
      //    каждый кадр без re-render'ов. Marching ants анимируется через
      //    dashOffsetRef (см. ниже). Толщина линий = 2/1.5px (см. A1.3 в
      //    renderHandles.ts — тот же scale для визуальной согласованности).
      const sel = selectionDragRef.current;
      if (sel) {
        ctx.save();
        // A2.1b: Match preview color with active op mode
        const currentOp = selectionOpModeRef.current;
        let previewColor: string;
        switch (currentOp) {
          case 'new':       previewColor = '#0d99ff'; break;  // blue
          case 'add':       previewColor = '#22cc55'; break;  // green
          case 'subtract':  previewColor = '#ee3344'; break;  // red
          case 'intersect': previewColor = '#3388ff'; break;  // light blue
          default:          previewColor = '#0d99ff';
        }
        ctx.strokeStyle = previewColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -dashOffsetRef.current;

        if (sel.kind === 'marquee') {
          const x = Math.min(sel.start.x, sel.end.x);
          const y = Math.min(sel.start.y, sel.end.y);
          const w = Math.abs(sel.end.x - sel.start.x);
          const h = Math.abs(sel.end.y - sel.start.y);
          if (sel.shape === 'rect') {
            ctx.strokeRect(x, y, w, h);
          } else {
            // ellipse — используем ctx.ellipse (центр + радиусы)
            ctx.beginPath();
            ctx.ellipse(
              x + w / 2, y + h / 2,
              w / 2, h / 2,
              0, 0, Math.PI * 2,
            );
            ctx.stroke();
          }
          // Полупрозрачная заливка — как Photoshop marquee overlay
          ctx.fillStyle = 'rgba(13, 153, 255, 0.10)';
          if (sel.shape === 'rect') {
            ctx.fillRect(x, y, w, h);
          } else {
            ctx.beginPath();
            ctx.ellipse(
              x + w / 2, y + h / 2,
              w / 2, h / 2,
              0, 0, Math.PI * 2,
            );
            ctx.fill();
          }
        } else {
          // lasso / polygonal — polyline
          const pts = sel.points;
          if (pts.length >= 2) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
              ctx.lineTo(pts[i].x, pts[i].y);
            }
            // lasso (freehand) — НЕ закрываем полигон, пока pointer не отпущен.
            // polygonal — НЕ закрываем, пока не double-click. Только обводка.
            ctx.stroke();
          }
          // polygonal: рисуем vertex dots — пользователь видит, где кликал
          if (sel.kind === 'polygonal') {
            ctx.setLineDash([]);
            for (let i = 0; i < pts.length; i++) {
              const p = pts[i];
              ctx.beginPath();
              ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
              ctx.fillStyle = i === 0 ? '#ffcc00' : '#ffffff';
              ctx.fill();
              ctx.lineWidth = 1;
              ctx.strokeStyle = '#000000';
              ctx.stroke();
            }

            // Snap indicator: кружок вокруг первой точки, если 3+ точек
            // (визуальный фидбек "здесь можно замкнуть")
            if (pts.length >= 3) {
              const first = pts[0];
              const snapRadiusCssPx = 10;
              const snapRadiusCanvasPx = snapRadiusCssPx / zoom;
              ctx.beginPath();
              ctx.arc(first.x, first.y, snapRadiusCanvasPx, 0, Math.PI * 2);
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = '#ffcc00'; // жёлтый, как первая точка
              ctx.setLineDash([4, 3]);
              ctx.stroke();
              ctx.setLineDash([]); // reset
            }
          }
        }
        ctx.restore();
      }

      // 8. Update dashOffset для marching ants анимации (A2 — теперь используется!)
      dashOffsetRef.current = (Date.now() / 50) % 10;

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [activeLayer, layerMatrix, activeLayerNaturalSize, view, activeControlId, hoverControlId, zoom, activeSelection]);

  // ── A2: Reset selection state при tool/layer change ────────
  // Чтобы “незакрытый” polygonal lasso не оставался на экране при переключении
  // инструмента или выборе другого слоя.
  useEffect(() => {
    selectionDragRef.current = null;
    setSelectionTick(t => t + 1);
  }, [tool, activeLayer?.id]);

  // ── A2: Esc сбрасывает selection drag / Enter замыкает polygonal ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectionDragRef.current) {
        selectionDragRef.current = null;
        setSelectionTick(t => t + 1);
        return;
      }
      if (e.key === 'Enter' && selectionDragRef.current) {
        const sel = selectionDragRef.current;
        if (sel && sel.kind === 'polygonal' && sel.points.length >= 3) {
          commitSelection(sel, e.shiftKey, e.altKey);
          selectionDragRef.current = null;
          setSelectionTick(t => t + 1);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeLayer, commitSelection]);

  // ──────────────────────────────────────────────────────────
  // Pointer handlers
  // ──────────────────────────────────────────────────────────

  /**
   * Hit-test: попадает ли canvas-точка в тело слоя (bbox)?
   *
   * Использует алгоритм point-in-polygon (ray casting) по 4 углам bbox.
   * Корректно работает для rotated/skewed/flipped слоёв, т.к. углы
   * вычисляются через applyToPoint(layerMatrix, ...).
   *
   * Используется для move-drag по телу слоя (A1.1).
   */
  const hitTestBody = useCallback(
    (canvasPoint: Vec2): boolean => {
      if (!layerMatrix || !activeLayerNaturalSize) return false;
      const corners = getLayerCorners(layerMatrix, activeLayerNaturalSize);
      // corners = [TL, TR, BR, BL]
      return pointInPolygon(canvasPoint, corners);
    },
    [layerMatrix, activeLayerNaturalSize],
  );

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!activeLayer || !layerMatrix) return;
    // Только левая кнопка
    if (e.button !== 0) return;

    const canvasPoint = screenToCanvas(e.clientX, e.clientY);

    // ════════════════════════════════════════════════════════
    // A2: SELECTION TOOLS — перехватываем до handle hit-test.
    // Для selection мы НЕ хотим попасть на handle (Photoshop convention:
    // marquee рисуется где угодно, даже поверх рамки).
    // ════════════════════════════════════════════════════════
    if (tool === 'rect' || tool === 'ellipse') {
      e.preventDefault();
      (e.target as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
      selectionDragRef.current = {
        kind: 'marquee',
        shape: tool,
        start: canvasPoint,
        end: canvasPoint,
      };
      setSelectionTick(t => t + 1);
      return;
    }
    if (tool === 'lasso') {
      e.preventDefault();
      (e.target as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
      selectionDragRef.current = {
        kind: 'lasso',
        points: [canvasPoint],
      };
      setSelectionTick(t => t + 1);
      return;
    }
    if (tool === 'polygonal') {
      e.preventDefault();
      const existing = selectionDragRef.current;

      // Snap tolerance: 10 CSS px → canvas px. Делим на zoom, чтобы
      // визуальный радиус был ~10 CSS px при любом zoom (fix от Gemini
      // из предыдущей итерации — было *, стало /).
      const TOLERANCE_CSS_PX = 10;
      const toleranceCanvasPx = TOLERANCE_CSS_PX / (zoom || 1);

      if (existing && existing.kind === 'polygonal') {
        // Полигон уже начат — добавляем точку или замыкаем.
        if (existing.points.length >= 3) {
          const first = existing.points[0];
          const dx = canvasPoint.x - first.x;
          const dy = canvasPoint.y - first.y;
          if (Math.hypot(dx, dy) <= toleranceCanvasPx) {
            // Snap to first point → close polygon (same as onDoubleClick / Enter)
            commitSelection(existing, e.shiftKey, e.altKey);
            selectionDragRef.current = null;
            setSelectionTick(t => t + 1);
            return;
          }
        }
        // Не попали в snap (или < 3 точек) → просто добавляем vertex
        existing.points.push(canvasPoint);
        setSelectionTick(t => t + 1);
        return;
      }

      // Полигона ещё нет — создаём новый с одной точкой
      selectionDragRef.current = {
        kind: 'polygonal',
        points: [canvasPoint],
      };
      setSelectionTick(t => t + 1);
      return;
    }

    // ════════════════════════════════════════════════════════
    // TRANSFORM tools (move/scale/rotate/skew/perspective) — handle hit-test.
    // ════════════════════════════════════════════════════════

    if (tool === 'perspective') {
      e.preventDefault();
      // Try perspective corner handles first
      const corners = activeLayer.transform.corners
        ? activeLayer.transform.corners
        : getLayerCorners(layerMatrix, activeLayerNaturalSize);

      const perspectiveIds: Array<{ id: ControlId; pos: Vec2 }> = [
        { id: 'ptl', pos: corners[0] },
        { id: 'ptr', pos: corners[1] },
        { id: 'pbr', pos: corners[2] },
        { id: 'pbl', pos: corners[3] },
      ];

      const handleRadius = 8 / zoom; // 8 CSS px hit radius
      for (const h of perspectiveIds) {
        const dx = canvasPoint.x - h.pos.x;
        const dy = canvasPoint.y - h.pos.y;
        if (Math.hypot(dx, dy) <= handleRadius) {
          const hitCtrl = CONTROLS[h.id];
          (e.target as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
          dragRef.current = {
            activeControl: hitCtrl,
            startTransform: { ...activeLayer.transform },
            startMatrix: layerMatrix,
            startCanvasPoint: canvasPoint,
            label: 'Perspective Corner',
            shiftKey: e.shiftKey,
            cornerIndex: h.id === 'ptl' ? 0 : h.id === 'ptr' ? 1 : h.id === 'pbr' ? 2 : 3,
          };
          setActiveControlId(hitCtrl.id);
          return;
        }
      }

      // 2. Body hit-test via pointInQuad.
      if (pointInQuad(canvasPoint, corners)) {
        const bodyCtrl = new Control({
          id: 'body',
          x: 0, y: 0,
          cursorStyle: 'move',
          action: 'perspective-move',
        });
        (e.target as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
        dragRef.current = {
          activeControl: bodyCtrl,
          startTransform: { ...activeLayer.transform },
          startMatrix: layerMatrix,
          startCanvasPoint: canvasPoint,
          label: 'Perspective Move',
          shiftKey: e.shiftKey,
          cornerIndex: -1,
        };
        setActiveControlId('body');
        return;
      }
      return;
    }

    // 1. Hit-test всех handles
    // PRESERVE-PERSPECTIVE: when corners ≠ null, use corner-based handle
    // positions (exact match to visual quad) instead of hitTestAll (which
    // uses the affine layerMatrix and would test in the wrong place).
    let hit: Control | null;
    // PRESERVE-PERSPECTIVE: filter out handles hidden for the current tool
    // (e.g. mtr is hidden in scale/skew mode). Without this filter, a click
    // near a hidden handle would hit it, then the dispatcher would cancelDrag.
    const __downHiddenIds = getHiddenControlIds(tool);
    if (activeLayer.transform.corners) {
      // Corner-based hit-test: check each handle by its corner-computed position
      const hitRadius = (DEFAULT_HANDLE_STYLE.controlSize / 2 + 6) / zoom; // canvas px
      // Order: mtr first (visually on top), then corners, then edges
      const order: ControlId[] = ['mtr', 'tl', 'tr', 'br', 'bl', 'ml', 'mr', 'mt', 'mb'];
      hit = null;
      for (const id of order) {
        if (__downHiddenIds.includes(id)) continue;  // skip hidden handles
        const pos = getHandlePos(id);
        if (!pos) continue;
        const dx = pos.x - canvasPoint.x;
        const dy = pos.y - canvasPoint.y;
        if (Math.hypot(dx, dy) <= hitRadius) {
          hit = CONTROLS[id];
          break;
        }
      }
    } else {
      hit = hitTestAll(
        canvasPoint,
        activeLayerNaturalSize,
        layerMatrix,
        4, // padding для удобного попадания
        DEFAULT_HANDLE_STYLE.controlSize,
      );
    }
    if (!hit) {
      // Не попали в handle — в mode 'move' пробуем hit-test по телу слоя (A1.1)
      // PRESERVE-PERSPECTIVE: body hit-test uses pointInQuad on the actual
      // corners (perspective-aware), not the affine body test.
      if (tool !== 'move' && tool !== 'none') return;
      // For perspective layers, use pointInQuad on corners.
      if (activeLayer.transform.corners) {
        if (!pointInQuad(canvasPoint, activeLayer.transform.corners)) return;
      } else {
        if (!hitTestBody(canvasPoint)) return;
      }

      // Попали в тело слоя → начинаем move-drag с виртуальным body-control.
      // CONTROLS.body имеет action='move' и НЕ рисуется как handle (не в CONTROL_LIST).
      const moveCtrl = CONTROLS.body;
      e.preventDefault();
      (e.target as HTMLCanvasElement).setPointerCapture?.(e.pointerId);

      const startTransform: LayerTransform = { ...activeLayer.transform };
      // For perspective layers, startMatrix is the affine base — computeMove
      // only uses it for invert (which is null when corners set, so computeMove
      // uses the corners branch instead). For affine layers, it's the full
      // forward matrix as before.
      const startMatrix = composeLayerMatrix(startTransform, activeLayerNaturalSize, docSize);

      dragRef.current = {
        activeControl: moveCtrl,
        startTransform,
        startMatrix,
        startCanvasPoint: canvasPoint,
        label: 'Move',
        shiftKey: e.shiftKey,
      };
      setActiveControlId(moveCtrl.id);
      return;
    }

    // 2. Начинаем drag (handle)
    e.preventDefault();
    (e.target as HTMLCanvasElement).setPointerCapture?.(e.pointerId);

    const startTransform: LayerTransform = { ...activeLayer.transform };
    // For perspective layers, startMatrix is the affine base. computeRotate
    // uses it to find the layer center via applyToPoint(startM, {w/2, h/2}),
    // which gives the affine-base center — the rotation pivot. computeScale
    // and computeSkew use startM for invert(), which returns null when
    // corners set, so their corners-branch is taken instead.
    const startMatrix = composeLayerMatrix(startTransform, activeLayerNaturalSize, docSize);

    let dragControl = hit;
    // A3-fix-2: per-tool handle dispatcher.
    //
    // Previously only `tool === 'skew'` remapped edge handles to skew-x/y.
    // All other tools fell through to the handle's natural action (defined
    // in CONTROLS), causing "3-in-1 tool" leaks:
    //   - Move tool + corner hit  → Scale (BUG: tool says Move, action is Scale)
    //   - Scale tool + mtr hit    → Rotate (BUG: tool says Scale, action is Rotate)
    //   - Rotate tool + corner hit → Scale (BUG: tool says Rotate, action is Scale)
    //   - Skew tool + corner hit  → Scale (BUG: tool says Skew, action is Scale)
    //
    // Now each tool owns its full handle semantics:
    //   move   → handles remap to 'move' (translate) — body still works
    //   scale  → corners='scale' (uniform), ml/mr='scale-x', mt/mb='scale-y',
    //            mtr=ignored
    //   rotate → all corner/edge handles + mtr = 'rotate'
    //   skew   → mt/mb='skew-x', ml/mr='skew-y', corners/mtr=ignored
    //   perspective → already handled by separate early-return path above
    //
    // When a handle is "ignored" for the current tool, we release the
    // pointer capture (already acquired above) and return without
    // starting a drag — this prevents accidental transforms.
    const isCorner = hit.id === 'tl' || hit.id === 'tr' || hit.id === 'br' || hit.id === 'bl';
    const isEdgeX  = hit.id === 'ml' || hit.id === 'mr';
    const isEdgeY  = hit.id === 'mt' || hit.id === 'mb';
    const isMtr    = hit.id === 'mtr';

    // Helper: build a new Control with overridden action, copying all
    // geometric + visual props from the hit control.
    // Note: we use an explicit string-literal union for `action` rather
    // than `Control['action']` because the Control class file may not
    // export its action type, and indexed access on a class can fail
    // in strict mode if the property is computed. String literals are
    // checked by TS when passed to `new Control({action, ...})`.
    type HandleAction = 'move' | 'scale' | 'scale-x' | 'scale-y' | 'skew-x' | 'skew-y' | 'rotate';
    const remapAction = (action: HandleAction): Control => new Control({
      id: hit.id, x: hit.x, y: hit.y,
      offsetX: hit.offsetX, offsetY: hit.offsetY,
      cursorStyle: hit.cursorStyle,
      withConnection: hit.withConnection,
      action,
      shape: hit.shape,
    });

    // Helper: bail out cleanly when the hit handle is not valid for the
    // active tool. We MUST release the pointer capture that was set
    // above (line `setPointerCapture?.(e.pointerId)`) before returning,
    // otherwise the canvas keeps capturing events for a non-existent drag.
    const cancelDrag = () => {
      (e.target as HTMLCanvasElement).releasePointerCapture?.(e.pointerId);
    };

    if (tool === 'move') {
      // Move tool: any handle hit becomes a Move drag (translate layer).
      // Body drag is already handled above (hitTestBody path); this branch
      // makes corner/edge hits behave like body hits, preserving the
      // "drag-anywhere-on-layer-to-move" UX while preventing accidental
      // scale/rotate when Move is the active tool.
      //
      // v2.8 (Skew по Krita): Shift+drag on an EDGE handle (mt/mb/ml/mr)
      // in Move tool → skew instead of move. This matches Krita/Photoshop
      // where Shift on an edge handle in any transform mode triggers skew.
      if (e.shiftKey && (isEdgeX || isEdgeY)) {
        if (isEdgeY) {
          dragControl = remapAction('skew-x');
        } else {
          dragControl = remapAction('skew-y');
        }
      } else {
        dragControl = CONTROLS.body;
      }
    } else if (tool === 'scale') {
      // v2.8: Shift+drag on edge → skew (Krita-style).
      if (e.shiftKey && isEdgeY) {
        dragControl = remapAction('skew-x');
      } else if (e.shiftKey && isEdgeX) {
        dragControl = remapAction('skew-y');
      } else if (isCorner) {
        dragControl = remapAction('scale');
      } else if (isEdgeX) {
        dragControl = remapAction('scale-x');
      } else if (isEdgeY) {
        dragControl = remapAction('scale-y');
      } else {
        // mtr or anything else — not a scale target
        cancelDrag();
        return;
      }
    } else if (tool === 'rotate') {
      // v2.8: Shift+drag on edge → skew (Krita-style).
      // Corners and mtr still rotate (Shift snaps to 45° in computeRotate).
      if (e.shiftKey && isEdgeY) {
        dragControl = remapAction('skew-x');
      } else if (e.shiftKey && isEdgeX) {
        dragControl = remapAction('skew-y');
      } else if (isCorner || isEdgeX || isEdgeY || isMtr) {
        dragControl = remapAction('rotate');
      } else {
        cancelDrag();
        return;
      }
    } else if (tool === 'skew') {
      if (isEdgeY) {
        dragControl = remapAction('skew-x');
      } else if (isEdgeX) {
        dragControl = remapAction('skew-y');
      } else {
        // corners and mtr are not skewable in current implementation
        cancelDrag();
        return;
      }
    }
    // tool === 'none' falls through with the hit's default action.
    // tool === 'perspective' is handled by the early-return path above.

    // A3-fix-2: per-tool handle dispatcher applied

    let label = 'Transform';
    switch (dragControl.action) {
      case 'move': label = 'Move'; break;
      case 'scale': label = 'Scale'; break;
      case 'scale-x': label = 'Scale X'; break;
      case 'scale-y': label = 'Scale Y'; break;
      case 'skew-x': label = 'Skew X'; break;
      case 'skew-y': label = 'Skew Y'; break;
      case 'rotate': label = 'Rotate'; break;
    }

    dragRef.current = {
      activeControl: dragControl,
      startTransform,
      startMatrix,
      startCanvasPoint: canvasPoint,
      label,
      shiftKey: e.shiftKey,
    };
    setActiveControlId(dragControl.id);
  }, [activeLayer, layerMatrix, activeLayerNaturalSize, docSize, screenToCanvas, tool, hitTestBody, zoom, onSelectionCommit]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    // A2: selection drag — обновляем ref, БЕЗ React state, БЕЗ re-render.
    // RAF loop читает ref каждый кадр и рисует preview.
    const sel = selectionDragRef.current;
    if (sel) {
      const current = screenToCanvas(e.clientX, e.clientY);
      if (sel.kind === 'marquee') {
        sel.end = current;
      } else if (sel.kind === 'lasso') {
        // Добавляем точку только если сместились достаточно (>1px) — иначе
        // массив разрастается на сотни дублирующих точек при stationary drag.
        const last = sel.points[sel.points.length - 1];
        const dx = current.x - last.x;
        const dy = current.y - last.y;
        if (dx * dx + dy * dy > 1) {
          sel.points.push(current);
        }
      }
      // polygonal НЕ обновляется на move — только на click (в onPointerDown).
      return;
    }

    const drag = dragRef.current;
    if (!drag || !drag.activeControl || !activeLayer) return;

    const current = screenToCanvas(e.clientX, e.clientY);
    const newTransform = computeDragResult(
      drag,
      current,
      e.shiftKey,
      e.altKey,
      activeLayerNaturalSize,
      docSize,
    );
    if (newTransform) {
      onTransformLive?.(newTransform);
    }
  }, [activeLayer, activeLayerNaturalSize, docSize, screenToCanvas, onTransformLive]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    // A2: finalize selection drag → commit mask.
    const sel = selectionDragRef.current;
    if (sel) {
      (e.target as HTMLCanvasElement).releasePointerCapture?.(e.pointerId);

      if (sel.kind === 'marquee') {
        const bounds: Bounds = {
          left:   Math.min(sel.start.x, sel.end.x),
          top:    Math.min(sel.start.y, sel.end.y),
          right:  Math.max(sel.start.x, sel.end.x),
          bottom: Math.max(sel.start.y, sel.end.y),
        };
        // Защита от "click без drag" — не создаём 1×1 mask.
        if (bounds.right - bounds.left > 2 && bounds.bottom - bounds.top > 2) {
          commitSelection(sel, e.shiftKey, e.altKey);
        }
        selectionDragRef.current = null;
        setSelectionTick(t => t + 1);
        return;
      }

      if (sel.kind === 'lasso') {
        // Freehand lasso: close polygon (последняя точка → первая)
        if (sel.points.length >= 3) {
          commitSelection(sel, e.shiftKey, e.altKey);
        }
        selectionDragRef.current = null;
        setSelectionTick(t => t + 1);
        return;
      }

      // polygonal НЕ завершается на pointerup — только double-click / Enter.
      // PointerUp просто сбрасывает pointer capture (точка уже добавлена в down).
      // НЕ очищаем selectionDragRef.current — пусть полигон остаётся видимым,
      // пока пользователь не закроет его double-click'ом.
      return;
    }

    const drag = dragRef.current;
    if (!drag || !drag.activeControl) return;

    (e.target as HTMLCanvasElement).releasePointerCapture?.(e.pointerId);

    // Финальный коммит (если был drag — push в history через onTransformCommit)
    const current = screenToCanvas(e.clientX, e.clientY);
    const finalTransform = computeDragResult(
      drag,
      current,
      e.shiftKey,
      e.altKey,
      activeLayerNaturalSize,
      docSize,
    );
    if (finalTransform) {
      onTransformCommit?.(finalTransform, drag.label);
    }

    dragRef.current = null;
    setActiveControlId(null);
  }, [activeLayer, activeLayerNaturalSize, docSize, screenToCanvas, onTransformCommit, onSelectionCommit]);

  // ── A2: Double-click закрывает polygonal lasso ──────────────
  const onDoubleClick = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    const sel = selectionDragRef.current;
    if (!sel || sel.kind !== 'polygonal') return;
    if (sel.points.length < 3) {
      // Меньше 3 точек — не полигон, сбрасываем.
      selectionDragRef.current = null;
      setSelectionTick(t => t + 1);
      return;
    }
    commitSelection(sel, e.shiftKey, e.altKey);
    selectionDragRef.current = null;
    setSelectionTick(t => t + 1);
  }, [commitSelection]);

  // ── Hover (только когда НЕ в active drag) ─────────────────
  const onPointerHover = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    // A2: в selection tools НЕ делаем handle hit-test — курсор всегда crosshair.
    if (tool === 'rect' || tool === 'ellipse'
        || tool === 'lasso' || tool === 'polygonal') {
      // Polygonal: direct DOM cursor for snap feedback (без React state)
      const canvas = canvasRef.current;
      if (tool === 'polygonal' && canvas) {
        const sel = selectionDragRef.current;
        if (sel && sel.kind === 'polygonal' && sel.points.length >= 3) {
          const current = screenToCanvas(e.clientX, e.clientY);
          const first = sel.points[0];
          const toleranceCanvasPx = 10 / zoom;
          if (Math.hypot(current.x - first.x, current.y - first.y) <= toleranceCanvasPx) {
            canvas.style.cursor = 'pointer';
            return;
          }
        }
        canvas.style.cursor = 'crosshair';
      }
      if (hoverControlId !== null) setHoverControlId(null);
      return;
    }
    if (dragRef.current) return; // в active drag — не меняем hover
    if (!activeLayer || !layerMatrix) {
      if (hoverControlId !== null) setHoverControlId(null);
      return;
    }
    const canvasPoint = screenToCanvas(e.clientX, e.clientY);

    if (tool === 'perspective') {
      const corners = activeLayer.transform.corners
        ? activeLayer.transform.corners
        : getLayerCorners(layerMatrix, activeLayerNaturalSize);

      const handleRadius = 8 / zoom;
      const perspectiveIds: Array<{ id: ControlId; pos: Vec2 }> = [
        { id: 'ptl', pos: corners[0] },
        { id: 'ptr', pos: corners[1] },
        { id: 'pbr', pos: corners[2] },
        { id: 'pbl', pos: corners[3] },
      ];

      let newId: ControlId | null = null;
      for (const h of perspectiveIds) {
        if (Math.hypot(canvasPoint.x - h.pos.x, canvasPoint.y - h.pos.y) <= handleRadius) {
          newId = h.id;
          break;
        }
      }
      if (!newId && pointInQuad(canvasPoint, corners)) {
        newId = 'body';
      }

      if (newId !== hoverControlId) {
        setHoverControlId(newId);
      }
      return;
    }

    // PRESERVE-PERSPECTIVE: when corners ≠ null, use corner-based hit-test
    // (exact match to visual quad) instead of hitTestAll.
    let hit: Control | null;
    if (activeLayer.transform.corners) {
      const hitRadius = (DEFAULT_HANDLE_STYLE.controlSize / 2 + 6) / zoom;
      const order: ControlId[] = ['mtr', 'tl', 'tr', 'br', 'bl', 'ml', 'mr', 'mt', 'mb'];
      hit = null;
      for (const id of order) {
        const pos = getHandlePos(id);
        if (!pos) continue;
        const dx = pos.x - canvasPoint.x;
        const dy = pos.y - canvasPoint.y;
        if (Math.hypot(dx, dy) <= hitRadius) {
          hit = CONTROLS[id];
          break;
        }
      }
    } else {
      hit = hitTestAll(
        canvasPoint,
        activeLayerNaturalSize,
        layerMatrix,
        4,
        DEFAULT_HANDLE_STYLE.controlSize,
      );
    }
    // A3-fix-3: filter hover by tool — ignore hits on handles that are
    // hidden for the current tool. This keeps hover state consistent with
    // visual visibility (hidden handles can't be hovered).
    const __hoverHiddenIds = getHiddenControlIds(tool);
    const __hitId = hit && !__hoverHiddenIds.includes(hit.id) ? hit.id : null;
    // PRESERVE-PERSPECTIVE: body hover uses pointInQuad for perspective layers
    const __bodyHover = activeLayer.transform.corners
      ? pointInQuad(canvasPoint, activeLayer.transform.corners)
      : hitTestBody(canvasPoint);
    const newId = __hitId ?? (__bodyHover ? 'body' : null);
    if (newId !== hoverControlId) {
      setHoverControlId(newId);
    }
  }, [activeLayer, layerMatrix, activeLayerNaturalSize, screenToCanvas, hoverControlId, hitTestBody, tool, zoom]);

  const onPointerLeave = useCallback(() => {
    if (!dragRef.current) {
      setHoverControlId(null);
    }
  }, []);

  // ──────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none', // сам контейнер не ловит события — только canvas
      }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          // В active drag (transform ИЛИ selection) — onPointerMove; иначе — hover
          if (dragRef.current || selectionDragRef.current) onPointerMove(e);
          else onPointerHover(e);
        }}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          // v2.5.1: When Zoom tool (or 'none' / no layer) is active, the overlay
          // must NOT capture pointer events — they should pass through to the
          // CanvasView below, which owns the Zoom tool's click/drag handling.
          // Previously the overlay canvas always had pointerEvents:'auto', which
          // intercepted every click and the Zoom tool appeared dead.
          pointerEvents: (tool === 'zoom' || tool === 'none' || tool === 'bucket' || tool === 'measure') ? 'none' : 'auto',
          cursor,
          // touch-action: none — обязательно для pointer events на touch-устройствах
          touchAction: 'none',
        }}
      />
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// pointInPolygon — ray casting algorithm
// ────────────────────────────────────────────────────────────

/**
 * Проверяет, находится ли точка внутри полигона (ray casting).
 *
 * Используется для hit-test по телу слоя: 4 угла bbox в canvas-пикселях
 * образуют полигон, и мы проверяем, попадает ли курсор внутрь.
 *
 * Алгоритм корректно работает для выпуклых и невыпуклых полигонов
 * (но НЕ для self-intersecting). Bbox слоя всегда выпуклый.
 *
 * @param point    точка в canvas-пикселях
 * @param polygon  вершины полигона в canvas-пикселях (любой порядок обхода)
 * @returns true, если точка внутри полигона
 */
function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// A3-fix-3: getHiddenControlIds helper
// Returns the set of handle IDs that should be HIDDEN for the given tool.
// These handles are erased from the canvas after renderAllHandles draws
// them, and the dispatcher in onPointerDown already functionally ignores
// them (A3-fix-2). Hiding them visually prevents the "misleading" UX where
// users see a handle, try to drag it, and nothing happens.
//
// Visibility per tool:
//   move   → hide ALL handles (body drag is enough — bounding box remains)
//   scale  → hide mtr (rotate handle)
//   rotate → hide nothing (all handles + mtr rotate)
//   skew   → hide corners (tl/tr/br/bl) + mtr (only edges skew)
//   perspective → handled by separate render path (no-op here)
//   none   → hide nothing (default fallback)
function getHiddenControlIds(tool: ToolId): ControlId[] {
  switch (tool) {
    case 'move':    return ['tl', 'tr', 'br', 'bl', 'ml', 'mr', 'mt', 'mb', 'mtr'];
    case 'scale':   return ['mtr'];
    case 'rotate':  return [];
    case 'skew':    return ['tl', 'tr', 'br', 'bl', 'mtr'];
    default:        return [];
  }
}

// ────────────────────────────────────────────────────────────
// computeDragResult — основная математика drag
// ────────────────────────────────────────────────────────────

/**
 * Вычисляет новый LayerTransform по результату drag.
 *
 * Подход — local-space: преобразуем текущий курсор в local-координаты
 * слоя через invert(startMatrix), затем вычисляем delta от начальной
 * позиции handle в local space.
 *
 * Это КОРРЕКТНО работает для rotated/skewed/flipped слоёв, в отличие от
 * подхода "вычитаем canvas offset" (который работает только для axis-aligned).
 *
 * @param drag          текущее состояние drag (start transform + matrix)
 * @param current       текущая позиция курсора в canvas-пикселях
 * @param shiftKey      зажат Shift (для toggle uniform scale, snap-to-15°)
 * @param altKey        зажат Alt (для scale-from-center)
 * @param naturalSize   размер слоя
 * @param docSize       размер документа
 * @returns новый LayerTransform, или null если не удалось вычислить
 */
function computeDragResult(
  drag: DragState,
  current: Vec2,
  shiftKey: boolean,
  altKey: boolean,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): LayerTransform | null {
  const ctrl = drag.activeControl;
  if (!ctrl) return null;

  switch (ctrl.action) {
    case 'move':
      return computeMove(drag, current, docSize);
    case 'scale':
    case 'scale-x':
    case 'scale-y':
      return computeScale(ctrl, drag, current, shiftKey, altKey, naturalSize, docSize);
    case 'skew-x':
    case 'skew-y':
      return computeSkewedTransform(ctrl, drag, current, altKey, naturalSize, docSize);
    case 'rotate':
      return computeRotate(drag, current, shiftKey, naturalSize, docSize);
    case 'perspective': {
      const t0 = drag.startTransform;
      const baseCorners: [Vec2, Vec2, Vec2, Vec2] = t0.corners
        ? [
            { ...t0.corners[0] },
            { ...t0.corners[1] },
            { ...t0.corners[2] },
            { ...t0.corners[3] },
          ]
        : getLayerCorners(drag.startMatrix, naturalSize);

      const idx = drag.cornerIndex ?? -1;
      if (idx < 0 || idx > 3) return null;

      const next = [...baseCorners] as [Vec2, Vec2, Vec2, Vec2];
      next[idx] = { x: current.x, y: current.y };

      // BUG-4 FIX: normalize self-intersecting quad (butterfly/hourglass).
      // If the user drags a corner past the opposite corner, the quad becomes
      // self-intersecting. Instead of rejecting the drag (old behavior via
      // isQuadDegenerate), we normalize by swapping the crossed corners.
      // This lets the user "flip" the layer through itself smoothly.
      const normalized = normalizeCorners(next);

      if (isQuadDegenerate(normalized)) return null;

      return { ...t0, corners: normalized };
    }
    case 'perspective-move': {
      const t0 = drag.startTransform;
      const baseCorners: [Vec2, Vec2, Vec2, Vec2] = t0.corners
        ? [
            { ...t0.corners[0] },
            { ...t0.corners[1] },
            { ...t0.corners[2] },
            { ...t0.corners[3] },
          ]
        : getLayerCorners(drag.startMatrix, naturalSize);

      const dx = current.x - drag.startCanvasPoint.x;
      const dy = current.y - drag.startCanvasPoint.y;

      return {
        ...t0,
        corners: [
          { x: baseCorners[0].x + dx, y: baseCorners[0].y + dy },
          { x: baseCorners[1].x + dx, y: baseCorners[1].y + dy },
          { x: baseCorners[2].x + dx, y: baseCorners[2].y + dy },
          { x: baseCorners[3].x + dx, y: baseCorners[3].y + dy },
        ],
      };
    }
    default:
      return null;
  }
}

// ────────────────────────────────────────────────────────────
// Move
// ────────────────────────────────────────────────────────────

function computeMove(
  drag: DragState,
  current: Vec2,
  // docSize зарезервирован для будущего clamping слоя в границы документа (A4).
  _docSize: { w: number; h: number },
): LayerTransform {
  const delta = {
    x: current.x - drag.startCanvasPoint.x,
    y: current.y - drag.startCanvasPoint.y,
  };
  const t = drag.startTransform;

  // PRESERVE-PERSPECTIVE: when the layer is in perspective mode (corners set),
  // the move translates the 4 corners in canvas space. The affine x/y are
  // left untouched (they only matter when corners === null). This lets the
  // user move a perspective-deformed layer around without losing the
  // deformation.
  if (t.corners) {
    return {
      ...t,
      corners: [
        { x: t.corners[0].x + delta.x, y: t.corners[0].y + delta.y },
        { x: t.corners[1].x + delta.x, y: t.corners[1].y + delta.y },
        { x: t.corners[2].x + delta.x, y: t.corners[2].y + delta.y },
        { x: t.corners[3].x + delta.x, y: t.corners[3].y + delta.y },
      ],
    };
  }

  return {
    ...t,
    x: t.x + delta.x,
    y: t.y + delta.y,
  };
}

// ────────────────────────────────────────────────────────────
// Scale (uniform для углов, single-axis для ml/mr/mt/mb)
// ────────────────────────────────────────────────────────────

function computeScale(
  ctrl: Control,
  drag: DragState,
  current: Vec2,
  shiftKey: boolean,
  altKey: boolean,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): LayerTransform | null {
  const t = drag.startTransform;
  const startM = drag.startMatrix;

  // PRESERVE-PERSPECTIVE: when the layer is in perspective mode (corners set),
  // scale all 4 corners from an anchor point in canvas space. The anchor is:
  //   - The opposite corner of the dragged handle (for corner handles), or
  //     the midpoint of the opposite edge (for edge handles).
  //   - The layer center (in canvas space) when altKey is held.
  // Scale ratio is computed by comparing the cursor-to-anchor distance to
  // the dragged-handle-start-to-anchor distance, in canvas space — this
  // naturally handles rotated/skewed/perspective layers because everything
  // happens in canvas px.
  if (t.corners) {
    // 1. Anchor in canvas space:
    //    - corner handle → opposite corner (corners array)
    //    - edge handle   → midpoint of opposite edge
    //    - altKey        → centroid of all 4 corners (≈ layer center in canvas)
    const cornersStart = t.corners;
    // corners order: [TL, TR, BR, BL] (matches srcQuad [0,0],[w,0],[w,h],[0,h])
    const oppositeCornerIdx: Record<string, number> = {
      // tl(0) opposite br(2), tr(1) opposite bl(3), etc.
      // ctrl.id uses fabric-style: tl, tr, br, bl, ml, mr, mt, mb
      tl: 2, tr: 3, br: 0, bl: 1,
    };
    let anchorCanvas: Vec2;
    if (altKey) {
      // Centroid of 4 corners
      anchorCanvas = {
        x: (cornersStart[0].x + cornersStart[1].x + cornersStart[2].x + cornersStart[3].x) / 4,
        y: (cornersStart[0].y + cornersStart[1].y + cornersStart[2].y + cornersStart[3].y) / 4,
      };
    } else if (ctrl.id in oppositeCornerIdx) {
      anchorCanvas = { ...cornersStart[oppositeCornerIdx[ctrl.id]] };
    } else {
      // Edge handle (ml/mr/mt/mb) — anchor = midpoint of opposite edge.
      // corners: [TL, TR, BR, BL]
      //   ml (left edge midpoint)  → opposite = right edge midpoint = midpoint(TR, BR) = (corners[1]+corners[2])/2
      //   mr (right edge midpoint) → opposite = left edge midpoint  = midpoint(TL, BL) = (corners[0]+corners[3])/2
      //   mt (top edge midpoint)   → opposite = bottom edge midpoint = midpoint(BL, BR) = (corners[2]+corners[3])/2
      //   mb (bottom edge midpoint)→ opposite = top edge midpoint    = midpoint(TL, TR) = (corners[0]+corners[1])/2
      switch (ctrl.id) {
        case 'ml': anchorCanvas = { x: (cornersStart[1].x + cornersStart[2].x) / 2, y: (cornersStart[1].y + cornersStart[2].y) / 2 }; break;
        case 'mr': anchorCanvas = { x: (cornersStart[0].x + cornersStart[3].x) / 2, y: (cornersStart[0].y + cornersStart[3].y) / 2 }; break;
        case 'mt': anchorCanvas = { x: (cornersStart[2].x + cornersStart[3].x) / 2, y: (cornersStart[2].y + cornersStart[3].y) / 2 }; break;
        case 'mb': anchorCanvas = { x: (cornersStart[0].x + cornersStart[1].x) / 2, y: (cornersStart[0].y + cornersStart[1].y) / 2 }; break;
        default:   anchorCanvas = { x: (cornersStart[0].x + cornersStart[1].x + cornersStart[2].x + cornersStart[3].x) / 4, y: (cornersStart[0].y + cornersStart[1].y + cornersStart[2].y + cornersStart[3].y) / 4 };
      }
    }

    // 2. Dragged handle's START position in canvas space (one of the 4 corners,
    //    or the midpoint of one of the 4 edges).
    let draggedStartCanvas: Vec2;
    if (ctrl.id === 'tl') draggedStartCanvas = { ...cornersStart[0] };
    else if (ctrl.id === 'tr') draggedStartCanvas = { ...cornersStart[1] };
    else if (ctrl.id === 'br') draggedStartCanvas = { ...cornersStart[2] };
    else if (ctrl.id === 'bl') draggedStartCanvas = { ...cornersStart[3] };
    else {
      // Edge midpoint at drag start
      switch (ctrl.id) {
        case 'ml': draggedStartCanvas = { x: (cornersStart[0].x + cornersStart[3].x) / 2, y: (cornersStart[0].y + cornersStart[3].y) / 2 }; break;
        case 'mr': draggedStartCanvas = { x: (cornersStart[1].x + cornersStart[2].x) / 2, y: (cornersStart[1].y + cornersStart[2].y) / 2 }; break;
        case 'mt': draggedStartCanvas = { x: (cornersStart[0].x + cornersStart[1].x) / 2, y: (cornersStart[0].y + cornersStart[1].y) / 2 }; break;
        case 'mb': draggedStartCanvas = { x: (cornersStart[2].x + cornersStart[3].x) / 2, y: (cornersStart[2].y + cornersStart[3].y) / 2 }; break;
        default:   draggedStartCanvas = { ...anchorCanvas };
      }
    }

    // 3. Scale ratio: based on the dominant axis or both axes depending on handle.
    //    For corner handles: scale X and Y independently from cursor delta
    //      relative to anchor, compared to start delta. Shift = uniform (use max).
    //    For edge handles: only scale the axis perpendicular to the edge.
    const startVec = { x: draggedStartCanvas.x - anchorCanvas.x, y: draggedStartCanvas.y - anchorCanvas.y };
    const newVec   = { x: current.x - anchorCanvas.x,           y: current.y - anchorCanvas.y };

    const safeDiv = (a: number, b: number) => (Math.abs(b) < 1e-9 ? 1 : a / b);

    let ratioX = 1, ratioY = 1;
    if (ctrl.action === 'scale') {
      const rx = safeDiv(newVec.x, startVec.x);
      const ry = safeDiv(newVec.y, startVec.y);
      if (shiftKey) {
        // Free scale both axes
        ratioX = rx; ratioY = ry;
      } else {
        // Uniform: dominant axis
        const ratio = Math.abs(rx) > Math.abs(ry) ? rx : ry;
        ratioX = ratio; ratioY = ratio;
      }
    } else if (ctrl.action === 'scale-x') {
      ratioX = safeDiv(newVec.x, startVec.x);
    } else if (ctrl.action === 'scale-y') {
      ratioY = safeDiv(newVec.y, startVec.y);
    }

    // Minimum scale guard
    const MIN_RATIO = 0.01;
    if (Math.abs(ratioX) < MIN_RATIO) ratioX = MIN_RATIO * Math.sign(ratioX || 1);
    if (Math.abs(ratioY) < MIN_RATIO) ratioY = MIN_RATIO * Math.sign(ratioY || 1);

    // 4. Apply affine scale (with anchor fixed) to all 4 corners in canvas space.
    //    newCorner = anchor + (corner - anchor) * (ratioX, ratioY)
    const scaled = cornersStart.map(p => ({
      x: anchorCanvas.x + (p.x - anchorCanvas.x) * ratioX,
      y: anchorCanvas.y + (p.y - anchorCanvas.y) * ratioY,
    })) as [Vec2, Vec2, Vec2, Vec2];

    if (isQuadDegenerate(scaled)) return null;

    // Also update affine base scale (informational — used by overlay for
    // bounding box and by renderPerspectiveQuad to position the source rect).
    const newScaleX = t.scaleX * ratioX;
    const newScaleY = t.scaleY * ratioY;

    return {
      ...t,
      scaleX: newScaleX,
      scaleY: newScaleY,
      corners: scaled,
    };
  }

  // ── Affine path (no corners) — original logic below ──────────
  const invStart = invert(startM);
  if (!invStart) return null;

  // 1. Anchor = opposite handle (или центр слоя при altKey)
  let anchorId: ControlId | null;
  if (altKey) {
    anchorId = null; // scale from center
  } else {
    anchorId = getOppositeHandle(ctrl.id);
  }

  // 2. Anchor позиция в canvas-пикселях
  let anchorCanvas: Vec2;
  if (anchorId) {
    anchorCanvas = CONTROLS[anchorId].positionHandler(naturalSize, startM);
  } else {
    // Center of layer in canvas px
    anchorCanvas = applyToPoint(startM, { x: naturalSize.w / 2, y: naturalSize.h / 2 });
  }

  // 3. Dragged handle позиция в start local natural coords (0..w, 0..h).
  //    ctrl.x/y ∈ [-0.5, +0.5] — это centered coords. Конверсия в natural:
  //      localNatural = (ctrl.x + 0.5) * w   (для x=-0.5 даёт 0 = TL, для x=+0.5 даёт w = BR)
  //
  //    ВАЖНО (bugfix A1.2-draggedLocalNatural, 2026-06-25):
  //    Раньше тут было `ctrl.x * naturalSize.w` (без `+0.5`) — это давало
  //    centered coords (-w/2..+w/2) вместо natural (0..w). При этом
  //    anchorLocalNatural (L794) считался правильно (с `+w/2`), из-за чего
  //    origLocalVec получался вдвое короче, чем должен. Scale ratio
  //    оказывался в 2× больше нормы → центр слоя улетал в противоположный
  //    угол ("yanks down-right" симптом).
  //
  //    Подтверждено диагностикой [A1.2-diag] на слое 2000×2000, drag BR:
  //      БАГ:   draggedLocalNatural = (1000, 1000)  = (w/2, h/2)   ← centered
  //      FIXED: draggedLocalNatural = (2000, 2000)  = (w,   h)     ← natural
  const draggedLocalNatural = {
    x: (ctrl.x + 0.5) * naturalSize.w + ctrl.offsetX,
    y: (ctrl.y + 0.5) * naturalSize.h + ctrl.offsetY,
  };

  // 4. Текущая позиция курсора → в local space start transform
  //    Это позволяет корректно работать при rotated/skewed layer
  const cursorLocalStart = applyToPoint(invStart, current);

  // 5. Anchor в local space start
  const anchorLocalStart = applyToPoint(invStart, anchorCanvas);

  // 6. Original vector anchor → dragged в local start space.
  //    (Раньше считали в canvas space как origVec, но для rotated/skewed
  //    слоёв корректнее считать в local start — см. комментарии выше.)
  const origLocalVec = {
    x: draggedLocalNatural.x - anchorLocalStart.x,
    y: draggedLocalNatural.y - anchorLocalStart.y,
  };
  const newLocalVec = {
    x: cursorLocalStart.x - anchorLocalStart.x,
    y: cursorLocalStart.y - anchorLocalStart.y,
  };

  // 7. Scale ratio (защита от деления на 0)
  const safeDiv = (a: number, b: number) => {
    if (Math.abs(b) < 1e-9) return 1;
    return a / b;
  };

  let scaleX = t.scaleX;
  let scaleY = t.scaleY;

  switch (ctrl.action) {
    case 'scale': {
      const rx = safeDiv(newLocalVec.x, origLocalVec.x);
      const ry = safeDiv(newLocalVec.y, origLocalVec.y);
      // Uniform: по умолчанию (без shift) сохраняем ratio, shift = free
      // (Photoshop convention: shift = unlock ratio; у нас наоборот, т.к.
      //  по умолчанию corners = uniform. Но это можно поменять.)
      if (shiftKey) {
        // Free scale по обеим осям
        scaleX = t.scaleX * rx;
        scaleY = t.scaleY * ry;
      } else {
        // Uniform: берём среднее геометрическое или максимум —Photoshop
        // использует "доминирующую" ось. Используем max abs.
        const ratio = Math.abs(rx) > Math.abs(ry) ? rx : ry;
        scaleX = t.scaleX * ratio;
        scaleY = t.scaleY * ratio;
      }
      break;
    }
    case 'scale-x': {
      const rx = safeDiv(newLocalVec.x, origLocalVec.x);
      scaleX = t.scaleX * rx;
      break;
    }
    case 'scale-y': {
      const ry = safeDiv(newLocalVec.y, origLocalVec.y);
      scaleY = t.scaleY * ry;
      break;
    }
  }

  // 8. Минимальный scale
  if (Math.abs(scaleX) < MIN_SCALE) scaleX = MIN_SCALE * Math.sign(scaleX || 1);
  if (Math.abs(scaleY) < MIN_SCALE) scaleY = MIN_SCALE * Math.sign(scaleY || 1);

  // 9. Новый transform — СТАТИЧНЫЙ anchor.
  //    Layer хранит x/y как смещение центра от центра документа.
  //    При scale от anchor (не центра) — центр слоя сдвигается.
  //    Новая позиция центра: anchor + rotatedHalfSize * sign
  //
  //    Проще: вычисляем новый forward matrix с anchor-anchored scale,
  //    затем декомпозируем обратно в LayerTransform.
  //
  //    Альтернатива (проще): вычисляем позицию нового центра через
  //    anchor + (newHalfWidth, newHalfHeight) rotated.
  //
  //    Используем подход "anchor stay fixed" через матричное преобразование:
  //    newCenter = anchor + R(rotation) * ((newW/2) * signX, (newH/2) * signY)
  //    где newW = naturalSize.w * scaleX, newH = naturalSize.h * scaleY
  //    signX/signY — знак scale (для flip via negative scale)
  //
  //    Но это работает только если skew=0. Для skew≠0 нужна полная
  //    матричная декомпозиция. MVP: skew=0 — ок.

  // Примечание: новый абсолютный размер (newW = naturalSize.w * scaleX,
  // newH = naturalSize.h * scaleY) ниже не используется — вместо него
  // применяется эквивалентный подход через scaleRatio = scaleX / t.scaleX
  // и centerFromAnchor * scaleRatio (см. L740-744). Математически идентично.

  // Вектор от anchor к новому центру в local space start:
  // anchor_local = ctrl_offset_local (для corner) или midpoint (для edge)
  // В start local (до scale) центр слоя = (w/2, h/2).
  // anchor_local для угла br = (w, h) — нет, неправильно.
  //
  // Правильный подход: anchor в local — это позиция opposite handle:
  //   anchor_local = (oppositeX * w, oppositeY * h)
  // где oppositeX/oppositeY ∈ {-0.5, 0, 0.5}.
  //
  // Вектор от anchor к центру в local (start):
  //   (0 - oppositeX*w, 0 - oppositeY*h)   [т.к. центр = (w/2, h/2), anchor = (oppositeX*w + w/2, ...)]
  //
  // Это становится сложным. Используем упрощённый подход:
  // новый центр в canvas = anchor + R(rotation) * (newHalfVec)
  // где newHalfVec = (sign(newScaleX) * newW/2 - anchorLocalOffset, ...)
  //
  // Чтобы не путаться, делаем так:
  //   1. В start local space, anchor = (anchorLocalX, anchorLocalY)
  //   2. В start local space, центр layer = (w/2, h/2)
  //   3. Вектор anchor → центр в start local: (w/2 - anchorLocalX, h/2 - anchorLocalY)
  //   4. После scale: тот же вектор умножается на (scaleX/t.scaleX, scaleY/t.scaleY)
  //   5. Применяем rotation → canvas space
  //   6. newCenter = anchor + rotated scaled vector

  // anchor local position (natural coords, 0..w, 0..h)
  let anchorLocalNaturalX: number;
  let anchorLocalNaturalY: number;
  if (anchorId) {
    const anchorCtrl = CONTROLS[anchorId];
    anchorLocalNaturalX = anchorCtrl.x * naturalSize.w + anchorCtrl.offsetX + naturalSize.w / 2;
    anchorLocalNaturalY = anchorCtrl.y * naturalSize.h + anchorCtrl.offsetY + naturalSize.h / 2;
  } else {
    // Center anchor
    anchorLocalNaturalX = naturalSize.w / 2;
    anchorLocalNaturalY = naturalSize.h / 2;
  }

  // Вектор от anchor к центру в start local natural coords:
  const centerFromAnchorX = naturalSize.w / 2 - anchorLocalNaturalX;
  const centerFromAnchorY = naturalSize.h / 2 - anchorLocalNaturalY;

  // После scale этот вектор становится:
  const scaleRatioX = scaleX / t.scaleX;
  const scaleRatioY = scaleY / t.scaleY;
  const newCenterFromAnchorLocalX = centerFromAnchorX * scaleRatioX;
  const newCenterFromAnchorLocalY = centerFromAnchorY * scaleRatioY;

  // Применяем rotation (и skew, если есть) чтобы получить canvas-space вектор.
  // Используем startMatrix, но без translation и без scale:
  //   R(rotation) * Skew(skewX, skewY) — это linear часть startMatrix
  //
  // Но проще: построить "delta" матрицу от anchor:
  //   newCenterCanvas = anchorCanvas + M_linear * (newCenterFromAnchorLocal - centerFromAnchor)
  //
  // где M_linear = startMatrix без translation.
  // startMatrix = [a, b, c, d, e, f], linear part = [a, b, c, d]
  //   применяя к вектору (dx, dy): (a*dx + c*dy, b*dx + d*dy)

  // Вектор в local natural от anchor к новому центру:
  const newVecX = newCenterFromAnchorLocalX;
  const newVecY = newCenterFromAnchorLocalY;

  // Linear transform from startMatrix (применяется к векторам, не точкам):
  const a = startM[0], b = startM[1], c = startM[2], d = startM[3];
  const newCenterCanvasX = anchorCanvas.x + (a * newVecX + c * newVecY);
  const newCenterCanvasY = anchorCanvas.y + (b * newVecX + d * newVecY);

  // x/y в LayerTransform = смещение центра от центра документа
  const newX = newCenterCanvasX - docSize.w / 2;
  const newY = newCenterCanvasY - docSize.h / 2;

  // Защита: если skew ≠ 0, упрощённый подход выше неточен.
  // MVP: используем его, для skew TODO A3.

  return {
    ...t,
    x: newX,
    y: newY,
    scaleX,
    scaleY,
  };
}

// ────────────────────────────────────────────────────────────
// Skew (horizontal mt/mb, vertical ml/mr)
// ────────────────────────────────────────────────────────────

function computeSkewedTransform(
  ctrl: Control,
  drag: DragState,
  current: Vec2,
  altKey: boolean,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
): LayerTransform | null {
  const t = drag.startTransform;
  const startM = drag.startMatrix;

  // PRESERVE-PERSPECTIVE: when the layer is in perspective mode (corners set),
  // apply skew as a shear transform to all 4 corners in canvas space.
  // Skew anchor = the opposite edge (or layer center if altKey).
  //
  // Math: skew is a shear. For mt (top edge), the top edge moves horizontally
  // by `dx * (1/h)` where dx = horizontal cursor delta, h = layer height in
  // canvas. The bottom edge stays. So:
  //   newCornerY = cornerY  (unchanged for top-edge skew)
  //   newCornerX = cornerX + dx * (cornerY - anchorY) / (topY - anchorY)
  // where anchorY = bottom edge Y (the fixed edge), and topY = top edge Y.
  //
  // For perspective layers, we apply the same shear to all 4 corners, using
  // the centroid of the appropriate edge as the "top" reference.
  if (t.corners) {
    const cornersStart = t.corners;
    // corners order: [TL, TR, BR, BL]
    // Edge centroids in canvas space:
    const topMid    = { x: (cornersStart[0].x + cornersStart[1].x) / 2, y: (cornersStart[0].y + cornersStart[1].y) / 2 };
    const bottomMid = { x: (cornersStart[2].x + cornersStart[3].x) / 2, y: (cornersStart[2].y + cornersStart[3].y) / 2 };
    const leftMid   = { x: (cornersStart[0].x + cornersStart[3].x) / 2, y: (cornersStart[0].y + cornersStart[3].y) / 2 };
    const rightMid  = { x: (cornersStart[1].x + cornersStart[2].x) / 2, y: (cornersStart[1].y + cornersStart[2].y) / 2 };
    const center    = { x: (cornersStart[0].x + cornersStart[1].x + cornersStart[2].x + cornersStart[3].x) / 4, y: (cornersStart[0].y + cornersStart[1].y + cornersStart[2].y + cornersStart[3].y) / 4 };

    // Cursor delta from drag start in canvas px
    const dx = current.x - drag.startCanvasPoint.x;
    const dy = current.y - drag.startCanvasPoint.y;

    // For mt/mb: shear X by horizontal delta. The "fixed" edge is the opposite edge.
    // For ml/mr: shear Y by vertical delta.
    //
    // The shear ratio is:
    //   mt: shear = dx / (topMid.y - bottomMid.y)   [top moves by dx, bottom fixed]
    //   mb: shear = dx / (bottomMid.y - topMid.y)   [bottom moves by dx, top fixed]
    //   ml: shear = dy / (leftMid.x - rightMid.x)   [left moves by dy, right fixed]
    //   mr: shear = dy / (rightMid.x - leftMid.x)   [right moves by dy, left fixed]
    //
    // Then apply shear to each corner:
    //   X-shear (mt/mb): newX = cornerX + shear * (cornerY - anchorY)
    //   Y-shear (ml/mr): newY = cornerY + shear * (cornerX - anchorX)
    //
    // Where anchor = the fixed edge (or center if altKey, in which case both
    // edges move symmetrically by dx/2 each).

    let sheared: [Vec2, Vec2, Vec2, Vec2];
    if (ctrl.id === 'mt' || ctrl.id === 'mb') {
      // X-shear
      const topY = topMid.y;
      const botY = bottomMid.y;
      const heightY = topY - botY;
      if (Math.abs(heightY) < 1e-6) return null;
      // shear coefficient (per 1 px of Y)
      const shearCoeff = dx / heightY;  // mt: top moves +dx, bottom fixed
      // anchor Y (fixed edge). For mt: bottom is fixed. For mb: top is fixed.
      // For altKey: anchor = center, both move by dx/2 → effective shear same,
      //   but anchor is center Y.
      let anchorY: number;
      if (altKey) {
        anchorY = center.y;
        // With altKey, the user's dx represents the TOTAL shear (top moves +dx/2,
        // bottom moves -dx/2 relative to anchor). So effective top-move = dx/2.
        // Recompute shearCoeff accordingly:
        //   shearCoeff_alt = (dx/2) / ((topY - center.y))  = (dx/2) / (heightY/2) = dx/heightY
        // Same as non-alt! The difference is just the anchor position.
      } else if (ctrl.id === 'mt') {
        anchorY = botY;
      } else {
        anchorY = topY;
      }
      sheared = cornersStart.map(p => ({
        x: p.x + shearCoeff * (p.y - anchorY) * (altKey ? 1 : 1),
        y: p.y,
      })) as [Vec2, Vec2, Vec2, Vec2];
    } else {
      // ml or mr — Y-shear
      const leftX = leftMid.x;
      const rightX = rightMid.x;
      const widthX = leftX - rightX;
      if (Math.abs(widthX) < 1e-6) return null;
      const shearCoeff = dy / widthX;
      let anchorX: number;
      if (altKey) {
        anchorX = center.x;
      } else if (ctrl.id === 'ml') {
        anchorX = rightX;
      } else {
        anchorX = leftX;
      }
      sheared = cornersStart.map(p => ({
        x: p.x,
        y: p.y + shearCoeff * (p.x - anchorX) * (altKey ? 1 : 1),
      })) as [Vec2, Vec2, Vec2, Vec2];
    }

    if (isQuadDegenerate(sheared)) return null;

    // Update skewX/skewY on the affine base (informational; corners encode
    // the actual visual shear).
    // Compute the affine-equivalent skew angle for display purposes.
    // For mt/mb: skewXDeg = atan(dx / layerHeightCanvas) in degrees
    // For ml/mr: skewYDeg = atan(dy / layerWidthCanvas) in degrees
    // (This is approximate — perspective makes it non-affine, but it gives
    //  the user a rough sense of the shear amount in the Transform panel.)
    let newSkewX = t.skewX;
    let newSkewY = t.skewY;
    if (ctrl.id === 'mt') {
      const layerH = Math.abs(topMid.y - bottomMid.y);
      if (layerH > 1e-6) newSkewX = t.skewX - Math.atan(dx / layerH) * RAD_TO_DEG;
    } else if (ctrl.id === 'mb') {
      const layerH = Math.abs(topMid.y - bottomMid.y);
      if (layerH > 1e-6) newSkewX = t.skewX + Math.atan(dx / layerH) * RAD_TO_DEG;
    } else if (ctrl.id === 'ml') {
      const layerW = Math.abs(leftMid.x - rightMid.x);
      if (layerW > 1e-6) newSkewY = t.skewY - Math.atan(dy / layerW) * RAD_TO_DEG;
    } else if (ctrl.id === 'mr') {
      const layerW = Math.abs(leftMid.x - rightMid.x);
      if (layerW > 1e-6) newSkewY = t.skewY + Math.atan(dy / layerW) * RAD_TO_DEG;
    }
    newSkewX = Math.max(-89, Math.min(89, newSkewX));
    newSkewY = Math.max(-89, Math.min(89, newSkewY));

    return {
      ...t,
      skewX: newSkewX,
      skewY: newSkewY,
      corners: sheared,
    };
  }

  // ── Affine path (no corners) — original logic below ──────────
  const invStart = invert(startM);
  if (!invStart) return null;

  const handle = ctrl.id as 'mt' | 'mb' | 'ml' | 'mr';

  // 1. Mouse в local space начального transform (СО skew — нет скачка при захвате).
  //    КРИТИЧНО: используем drag.startMatrix (содержит текущий skew), а НЕ матрицу
  //    без skew. Прямая (startMatrix, рисует ручку) и обратная (invStart, переводит
  //    мышь в local) матрицы должны быть согласованы — иначе в начале drag mouseLocal
  //    ≠ истинной позиции ручки, dx ≠ 0, и skew прыгает.
  const cursorLocalStart = applyToPoint(invStart, current);

  // 2. Углы и pivot в natural space для computeSkew
  const localCorners: LayerCorners = {
    tl: { x: 0, y: 0 },
    tr: { x: naturalSize.w, y: 0 },
    br: { x: naturalSize.w, y: naturalSize.h },
    bl: { x: 0, y: naturalSize.h },
  };
  const localPivot = { x: naturalSize.w / 2, y: naturalSize.h / 2 };

  // 3. Дельта skew относительно начала drag.
  //    computeSkew возвращает atan(dx/h) — точное изменение угла для текущего
  //    смещения мыши. В начале drag dx=0 (mouseLocal = позиция ручки), skewX=0.
  //    Никакого "накопления ошибки из-за нелинейности tan" нет: dx пересчитывается
  //    каждый кадр от актуальной cursorLocalStart, не от предыдущего кадра.
  const result = computeSkew({
    handle,
    mouse: cursorLocalStart,
    corners: localCorners,
    symmetric: altKey,
    pivot: localPivot,
  });

  // 4. Применяем дельту к начальным углам (инкрементально, не абсолютно).
  //    Знак минус для mt/ml: в transform-matrix.ts skew(skewX) сдвигает верхнюю
  //    грань ВЛЕВО при skewX>0, поэтому чтобы mt следовала за мышью ВПРАВО,
  //    нужно вычитать deltaX.
  const deltaX = (result.skewX * 180) / Math.PI;
  const deltaY = (result.skewY * 180) / Math.PI;

  let newSkewX = t.skewX;
  let newSkewY = t.skewY;

  if (handle === 'mt') {
    newSkewX = t.skewX - deltaX;
  } else if (handle === 'mb') {
    newSkewX = t.skewX + deltaX;
  } else if (handle === 'ml') {
    newSkewY = t.skewY - deltaY;
  } else if (handle === 'mr') {
    newSkewY = t.skewY + deltaY;
  }

  newSkewX = Math.max(-89, Math.min(89, newSkewX));
  newSkewY = Math.max(-89, Math.min(89, newSkewY));

  // 5. Anchor (неподвижная грань / центр при Alt)
  let localAnchor: Vec2;
  if (altKey) {
    localAnchor = localPivot;
  } else {
    switch (handle) {
      case 'mt': localAnchor = { x: naturalSize.w / 2, y: naturalSize.h }; break;
      case 'mb': localAnchor = { x: naturalSize.w / 2, y: 0 }; break;
      case 'ml': localAnchor = { x: naturalSize.w, y: naturalSize.h / 2 }; break;
      case 'mr': localAnchor = { x: 0, y: naturalSize.h / 2 }; break;
    }
  }

  // 6. Позиция anchor на холсте до drag (через startM СО skew)
  const anchorCanvas = applyToPoint(startM, localAnchor);

  // 7. Компенсация x/y, чтобы anchor остался на месте.
  //    Стандартная anchor-preservation: tempMatrix строится с newSkewX и x=0,y=0,
  //    tempAnchorPos = где anchor оказался бы без translation, correctedX/Y =
  //    разница с исходной позицией anchor.
  const tempTransform: LayerTransform = {
    ...t,
    skewX: newSkewX,
    skewY: newSkewY,
    x: 0,
    y: 0,
  };

  const tempMatrix = composeLayerMatrix(tempTransform, naturalSize, docSize);
  const tempAnchorPos = applyToPoint(tempMatrix, localAnchor);

  const correctedX = anchorCanvas.x - tempAnchorPos.x;
  const correctedY = anchorCanvas.y - tempAnchorPos.y;

  return {
    ...t,
    skewX: newSkewX,
    skewY: newSkewY,
    x: correctedX,
    y: correctedY,
  };
}

// ────────────────────────────────────────────────────────────
// Rotate
// ────────────────────────────────────────────────────────────

function computeRotate(
  drag: DragState,
  current: Vec2,
  shiftKey: boolean,
  naturalSize: { w: number; h: number },
  // docSize зарезервирован для будущего snap к углам документа (A4).
  _docSize: { w: number; h: number },
): LayerTransform | null {
  const t = drag.startTransform;
  const startM = drag.startMatrix;

  // Центр слоя в canvas-пикселях (точка вращения)
  const centerCanvas = applyToPoint(startM, {
    x: naturalSize.w / 2,
    y: naturalSize.h / 2,
  });

  // PRESERVE-PERSPECTIVE: when the layer is in perspective mode (corners set),
  // rotation rotates all 4 corners around the layer center in canvas space.
  // The center is computed via the affine startMatrix (which is the affine
  // base of the perspective transform — same as renderPerspectiveQuad uses
  // to position the layer before applying the corner deformation).
  //
  // Why use startM (affine) for the center, not the centroid of corners?
  // Because corners store the FULL deformation (affine + perspective). The
  // affine part of the transform (x/y/scale/rotation/skew) determines where
  // the layer's natural center sits in canvas space, and the perspective
  // homography maps that center to the canvas. Using startM keeps the
  // rotation pivot consistent with how the layer is rendered.
  if (t.corners) {
    // Start angle: from center to initial cursor position
    const startAngle = Math.atan2(
      drag.startCanvasPoint.y - centerCanvas.y,
      drag.startCanvasPoint.x - centerCanvas.x,
    );
    const currentAngle = Math.atan2(
      current.y - centerCanvas.y,
      current.x - centerCanvas.x,
    );
    let deltaRad = currentAngle - startAngle;

    // Snap (optional, matches affine path). Snap step 15° (or 45° with Shift).
    const snapStep = shiftKey ? 45 : 15;
    const snaps: number[] = [];
    for (let deg = 0; deg < 360; deg += snapStep) {
      snaps.push((deg * Math.PI) / 180);
    }
    // Try to snap the absolute rotation (current angle around center) to
    // nearby snap angles. Compute absolute angle of "current" relative to
    // horizontal, then snap.
    const absAngle = Math.atan2(current.y - centerCanvas.y, current.x - centerCanvas.x);
    const snappedAbs = getSnap(snaps, ((absAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), DEFAULT_SNAP_TOLERANCE_RAD);
    // getSnap returns the snapped angle if within tolerance, else the input unchanged
    deltaRad = snappedAbs - startAngle;

    const cos = Math.cos(deltaRad);
    const sin = Math.sin(deltaRad);
    const cx = centerCanvas.x;
    const cy = centerCanvas.y;

    const rotated = t.corners.map(p => {
      // Translate to origin (center), rotate, translate back
      const dx = p.x - cx;
      const dy = p.y - cy;
      return {
        x: cx + dx * cos - dy * sin,
        y: cy + dx * sin + dy * cos,
      };
    }) as [Vec2, Vec2, Vec2, Vec2];

    if (isQuadDegenerate(rotated)) return null;

    // We also store the rotation in t.rotation so the affine base stays
    // consistent (used by overlay to render the bounding box, and by the
    // affine path if the user later clears perspective via "Reset Persp.").
    // The corners already encode the full visual rotation, so t.rotation
    // is informational here — it's the rotation of the affine BASE.
    let newRotationDeg = t.rotation + deltaRad * RAD_TO_DEG;
    // Normalize to (-180, 180]
    newRotationDeg = ((newRotationDeg + 180) % 360 + 360) % 360 - 180;

    return {
      ...t,
      rotation: newRotationDeg,
      corners: rotated,
    };
  }

  // Affine path (no corners) — original logic below
  // Угол от центра к начальному курсору
  const startAngle = Math.atan2(
    drag.startCanvasPoint.y - centerCanvas.y,
    drag.startCanvasPoint.x - centerCanvas.x,
  );
  // Угол от центра к текущему курсору
  const currentAngle = Math.atan2(
    current.y - centerCanvas.y,
    current.x - centerCanvas.x,
  );

  // Delta в радианах
  const deltaRad = currentAngle - startAngle;

  // Новый rotation (deg)
  let newRotationRad = (t.rotation * DEG_TO_RAD) + deltaRad;

  // Snap к 15° (или 45° при shiftKey — Photoshop convention)
  const snapStep = shiftKey ? 45 : 15;
  const snaps: number[] = [];
  for (let deg = 0; deg < 360; deg += snapStep) {
    snaps.push((deg * Math.PI) / 180);
  }
  // Нормализуем в [0, 2π)
  newRotationRad = ((newRotationRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  newRotationRad = getSnap(snaps, newRotationRad, DEFAULT_SNAP_TOLERANCE_RAD);

  let newRotationDeg = newRotationRad * RAD_TO_DEG;
  // Нормализуем в (-180, 180] для удобства отображения
  if (newRotationDeg > 180) newRotationDeg -= 360;

  return {
    ...t,
    rotation: newRotationDeg,
  };
}

// ════════════════════════════════════════════════════════════
// A2: SELECTION HELPERS — rasterization & mask construction
// ════════════════════════════════════════════════════════════
//
// Перенесены из transform-overlay-movable.tsx (L220-337), оригинал
// GenToniK MIT. Не зависят от react-moveable — чистая математика +
// Canvas2D native rasterization (GPU-ускоренное, ~500× быстрее JS
// scanline, по тестам Gemini 2.2 fix).
//
// Используются:
//   • polygonToMask              — lasso/polygonal select → painted mask
//   • marqueeBoundsToPolygon     — rect/ellipse bounds → polygon vertices
//   • transformPointsToLayerLocal — canvas-px → layer-local via invert(layerMatrix)
//
// LayerMask type (types.ts L224-262):
//   • 'shape'   — { type:'shape', shape, bounds, feather, invert }
//   • 'painted' — { type:'painted', width, height, data, offsetX, offsetY, invert }
//
// ВАЖНО (A2-fix-mask-transform, 2026-06-25): mask хранится в LAYER-LOCAL
// space, НЕ в canvas-pixel space. composite.ts L577-578 применяет mask
// ДО transform (см. комментарий L25-27), значит координаты mask
// интерпретируются в natural-size системе слоя.
//
// Поэтому перед построением mask мы ОБЯЗАТЕЛЬНО применяем invert(layerMatrix)
// к canvas-px точкам выделения. Без этого:
//   • marquee на scaleX=0.37 попадает в layer-local координаты как на scale 1.0
//     → маска применяется не там, где пользователь выделил.
//   • lasso "улетает в левый верхний угол": без invert transform + без offsetX/offsetY
//     в типе painted, applyPaintedMask рисует маску в (0,0) layer-local.
//
// Для rotated/skewed слоёв inverse-transformed rect это rotated rect в layer-local.
// 'shape' mask хранит только AABB, поэтому мы ВСЕГДА растеризуем выделение в
// 'painted' mask — это единообразно покрывает scale/rotate/skew/perspective.

// Helper mask functions removed as selection is now separated from layer masks

/**
 * Convert a rect or ellipse marquee (in canvas-px) into polygon vertices.
 *
 * - Rect: 4 corners (TL, TR, BR, BL).
 * - Ellipse: 32 vertices sampled uniformly around the center.
 *
 * The polygon is in CANVAS-PIXEL space. The caller MUST transform it
 * to layer-local via `transformPointsToLayerLocal` before passing
 * to `polygonToMask` — otherwise the mask will be in the wrong space.
 */
function marqueeBoundsToPolygon(shape: 'rect' | 'ellipse', bounds: Bounds): Vec2[] {
  const left = Math.min(bounds.left, bounds.right);
  const right = Math.max(bounds.left, bounds.right);
  const top = Math.min(bounds.top, bounds.bottom);
  const bottom = Math.max(bounds.top, bounds.bottom);
  if (shape === 'rect') {
    return [
      { x: left,  y: top    },
      { x: right, y: top    },
      { x: right, y: bottom },
      { x: left,  y: bottom },
    ];
  }
  // Ellipse: 32 vertices (smooth enough for rasterization at typical canvas sizes).
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const rx = (right - left) / 2;
  const ry = (bottom - top) / 2;
  const N = 32;
  const pts: Vec2[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = (i / N) * 2 * Math.PI;
    pts[i] = { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  }
  return pts;
}

// transformPointsToLayerLocal removed as selection is now separated from layer masks

// ────────────────────────────────────────────────────────────
// A2.1b-fix: Helper to compute combined silhouette contours in canvas space.
// ────────────────────────────────────────────────────────────
function computeCanvasSpaceContour(entries: SelectionEntry[]): Vec2[][] {
  if (entries.length === 0) return [];

  // Union bbox of canvasPolygons.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const entry of entries) {
    for (const p of entry.canvasPolygon) {
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

  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 || h <= 0) return [];

  // Guard against unbounded allocation (defense-in-depth)
  const MAX_DIM = 8192;
  if (w > MAX_DIM || h > MAX_DIM) {
    console.warn(`[computeCanvasSpaceContour] dimensions ${w}×${h} exceed MAX_DIM, skipping`);
    return [];
  }

  const mask = new Uint8Array(w * h);
  for (const entry of entries) {
    const entryMask = rasterizePolygonAtSize(
      entry.canvasPolygon,
      w, h,
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

  // Trace contour. Points are in (minX, minY) offset space.
  return traceMaskContour(mask, w, h, minX, minY);
}
