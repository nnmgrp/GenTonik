// ============================================================
// canvas-controls/renderHandles.ts — отрисовка рамки и handles
// ============================================================
//
// Функции для отрисовки bounding box (пунктир), линий к rotater,
// и всех 9 handles на переданном 2D-контексте.
//
// ВАЖНО: функции НЕ вызывают ctx.save()/ctx.restore() на внешнем
// контексте — это ответственность вызывающего. Каждая функция
// делает свои save/restore внутри, чтобы не менять состояние ctx.
//
// КООРДИНАТЫ: все функции работают в CANVAS-ПИКСЕЛЯХ (после
// применения view matrix). Вызывающий должен применить view
// transform (pan + zoom) до вызова этих функций.
//
// Используется:
//   • transform-overlay-canvas.tsx (будущий) — в RAF render loop
//   • тестовый скрипт (для визуальной проверки handles)
// ============================================================

import type { Vec2 } from '@/types';
import {
  type Matrix,
  applyToPoint,
  composeLayerMatrix,
} from '@/transform-matrix';
import { Control, type ControlStyle } from './Control';
import { CONTROLS, CONTROL_LIST } from './controls';

// ────────────────────────────────────────────────────────────
// Типы
// ────────────────────────────────────────────────────────────

/** Стиль bounding box и handles. */
export interface HandleStyle {
  /** Цвет bounding box (пунктир). */
  boxStroke: string;
  /** Пунктир bbox: [длина_штриха, длина_паузы]. */
  boxDash: number[];
  /** Толщина bbox. */
  boxStrokeWidth: number;
  /** Заливка handle. */
  controlFill: string;
  /** Обводка handle. */
  controlStroke: string;
  /** Толщина обводки handle. */
  controlStrokeWidth: number;
  /** Размер угловых/средних handles в px. */
  controlSize: number;
  /** Размер rotater (mtr) в px. */
  rotaterSize: number;
  /** Цвет линии от bbox к rotater. */
  rotaterLineColor: string;
  /** Толщина линии к rotater. */
  rotaterLineWidth: number;
}

/** Стиль по умолчанию — синий как в Photoshop/Figma.
 *  A1.3 (2026-06-25): controlSize/rotaterSize увеличены с 8 до 12 px для
 *  лучшей видимости на hi-DPI экранах и при zoom-out. boxStrokeWidth
 *  увеличен с 1.5 до 2 для чёткости bounding box.
 *  Hit-test в controls.ts автоматически подхватывает новый size через
 *  DEFAULT_HANDLE_STYLE.controlSize — менять padding/hitTestAll не нужно. */
export const DEFAULT_HANDLE_STYLE: HandleStyle = {
  boxStroke: '#0d99ff',
  boxDash: [6, 4],
  boxStrokeWidth: 2,
  controlFill: '#ffffff',
  controlStroke: '#0d99ff',
  controlStrokeWidth: 1.5,
  controlSize: 12,
  rotaterSize: 12,
  rotaterLineColor: '#0d99ff',
  rotaterLineWidth: 1,
};

// ────────────────────────────────────────────────────────────
// getLayerCorners — 4 угла слоя в canvas-пикселях
// ────────────────────────────────────────────────────────────

/**
 * Вычисляет 4 угла bounding box слоя в canvas-пикселях.
 *
 * @param layerMatrix  forward-матрица из composeLayerMatrix()
 * @param naturalSize  размер слоя {w, h}
 * @returns [TL, TR, BR, BL] в canvas-пикселях
 */
export function getLayerCorners(
  layerMatrix: Matrix,
  naturalSize: { w: number; h: number },
): [Vec2, Vec2, Vec2, Vec2] {
  return [
    applyToPoint(layerMatrix, { x: 0, y: 0 }),                  // TL
    applyToPoint(layerMatrix, { x: naturalSize.w, y: 0 }),      // TR
    applyToPoint(layerMatrix, { x: naturalSize.w, y: naturalSize.h }), // BR
    applyToPoint(layerMatrix, { x: 0, y: naturalSize.h }),      // BL
  ];
}

// ────────────────────────────────────────────────────────────
// renderBoundingBox — пунктирная рамка
// ────────────────────────────────────────────────────────────

/**
 * Рисует bounding box слоя (пунктирный прямоугольник по 4 углам).
 *
 * @param ctx           2D-контекст
 * @param corners       [TL, TR, BR, BL] в canvas-пикселях
 * @param style         стиль (optional override)
 */
export function renderBoundingBox(
  ctx: CanvasRenderingContext2D,
  corners: [Vec2, Vec2, Vec2, Vec2],
  style?: Partial<HandleStyle>,
): void {
  const s = { ...DEFAULT_HANDLE_STYLE, ...style };

  ctx.save();
  ctx.strokeStyle = s.boxStroke;
  ctx.lineWidth = s.boxStrokeWidth;
  ctx.setLineDash(s.boxDash);

  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.lineTo(corners[2].x, corners[2].y);
  ctx.lineTo(corners[3].x, corners[3].y);
  ctx.closePath();
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.restore();
}

// ────────────────────────────────────────────────────────────
// renderRotaterConnection — линия от bbox к rotater
// ────────────────────────────────────────────────────────────

/**
 * Рисует тонкую линию от верхней середины bbox к rotater handle.
 *
 * @param ctx           2D-контекст
 * @param from          точка на bbox (mt handle позиция)
 * @param to            rotater позиция
 * @param style         стиль (optional override)
 */
export function renderRotaterConnection(
  ctx: CanvasRenderingContext2D,
  from: Vec2,
  to: Vec2,
  style?: Partial<HandleStyle>,
): void {
  const s = { ...DEFAULT_HANDLE_STYLE, ...style };

  ctx.save();
  ctx.strokeStyle = s.rotaterLineColor;
  ctx.lineWidth = s.rotaterLineWidth;
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  ctx.restore();
}

// ────────────────────────────────────────────────────────────
// renderHandle — один handle
// ────────────────────────────────────────────────────────────

/**
 * Рисует один handle в заданной позиции.
 *
 * @param ctx     2D-контекст
 * @param control инстанс Control
 * @param pos     позиция в canvas-пикселях
 * @param style   стиль (optional override)
 */
export function renderHandle(
  ctx: CanvasRenderingContext2D,
  control: Control,
  pos: Vec2,
  style?: Partial<HandleStyle>,
): void {
  const s = { ...DEFAULT_HANDLE_STYLE, ...style };
  const handleStyle: Partial<ControlStyle> = {
    fill: s.controlFill,
    stroke: s.controlStroke,
    strokeWidth: s.controlStrokeWidth,
    size: control.id === 'mtr' ? s.rotaterSize : s.controlSize,
  };
  control.render(ctx, pos.x, pos.y, handleStyle);
}

// ────────────────────────────────────────────────────────────
// renderAllHandles — главный entry point
// ────────────────────────────────────────────────────────────

/**
 * Рисует bounding box + линию к rotater + все 9 handles.
 *
 * Это главная функция, которую вызывает transform-overlay-canvas.tsx
 * в каждом RAF кадре для активного слоя.
 *
 * @param ctx           2D-контекст (уже translat'нут view matrix)
 * @param layerMatrix   forward-матрица слоя из composeLayerMatrix()
 * @param naturalSize   размер слоя {w, h}
 * @param style         стиль (optional override)
 */
export function renderAllHandles(
  ctx: CanvasRenderingContext2D,
  layerMatrix: Matrix,
  naturalSize: { w: number; h: number },
  style?: Partial<HandleStyle>,
): void {
  const s = { ...DEFAULT_HANDLE_STYLE, ...style };

  // 1. Bounding box
  const corners = getLayerCorners(layerMatrix, naturalSize);
  renderBoundingBox(ctx, corners, s);

  // 2. Линия к rotater (от mt до mtr)
  const mtPos = CONTROLS.mt.positionHandler(naturalSize, layerMatrix);
  const mtrPos = CONTROLS.mtr.positionHandler(naturalSize, layerMatrix);
  renderRotaterConnection(ctx, mtPos, mtrPos, s);

  // 3. Все 9 handles
  for (const control of CONTROL_LIST) {
    const pos = control.positionHandler(naturalSize, layerMatrix);
    renderHandle(ctx, control, pos, s);
  }
}

// ────────────────────────────────────────────────────────────
// renderSelectionOutline — пунктирная рамка выделения (marching ants)
// ────────────────────────────────────────────────────────────

/**
 * Рисует "marching ants" — анимированный пунктир для активного выделения.
 *
 * Анимация: caller должен обновлять `dashOffset` каждый кадр
 * (например, dashOffset = (Date.now() / 50) % 10) и вызывать
 * эту функцию с новым значением.
 *
 * @param ctx         2D-контекст
 * @param path        Path2D выделения (rect/ellipse/lasso/polygonal)
 * @param dashOffset  текущий offset для анимации (0 = static)
 * @param fillOverlay если true — заливает выделение полупрозрачным синим
 * @param color       цвет пунктира (default '#0d99ff')
 */
export function renderSelectionOutline(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  dashOffset: number = 0,
  fillOverlay: boolean = true,
  color: string = '#0d99ff',
): void {
  ctx.save();

  // Overlay fill — полупрозрачный синий, как в Photoshop
  if (fillOverlay) {
    ctx.fillStyle = 'rgba(13, 153, 255, 0.15)';
    ctx.fill(path);
  }

  // Marching ants — синий пунктир основной линии.
  // A1.3 (2026-06-25): lineWidth увеличен с 1.5 до 2 для лучшей видимости
  // на тёмных/контрастных слоях (по запросу пользователя — "слегка утолщить").
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = -dashOffset;
  ctx.stroke(path);

  // Дополнительный белый пунктир со сдвигом для анимации "бегущих муравьёв".
  // A1.3: lineWidth увеличен с 1 до 1.5 — пропорционально синему.
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = -dashOffset + 5;
  ctx.stroke(path);

  ctx.setLineDash([]);
  ctx.restore();
}

// ────────────────────────────────────────────────────────────
// renderActiveHandle — подсветка handle при hover/drag
// ────────────────────────────────────────────────────────────

/**
 * Рисует handle с подсветкой (при hover или active drag).
 *
 * @param ctx      2D-контекст
 * @param control  handle для подсветки
 * @param layerMatrix  forward-матрица слоя
 * @param naturalSize  размер слоя
 * @param style    стиль (optional override)
 */
export function renderActiveHandle(
  ctx: CanvasRenderingContext2D,
  control: Control,
  layerMatrix: Matrix,
  naturalSize: { w: number; h: number },
  style?: Partial<HandleStyle>,
): void {
  const s = { ...DEFAULT_HANDLE_STYLE, ...style };
  const pos = control.positionHandler(naturalSize, layerMatrix);

  // Подсветка: увеличенный размер + жёлтый контур
  const highlightStyle: Partial<HandleStyle> = {
    ...s,
    controlStroke: '#ffcc00',
    controlSize: s.controlSize + 2,
    rotaterSize: s.rotaterSize + 2,
    controlStrokeWidth: 2,
  };

  renderHandle(ctx, control, pos, highlightStyle);
}

// ────────────────────────────────────────────────────────────
// Convenience: render с готовым LayerTransform
// ────────────────────────────────────────────────────────────

import type { LayerTransform } from '@/types';

/**
 * Удобная обёртка: принимает LayerTransform напрямую, сама строит
 * матрицу через composeLayerMatrix.
 *
 * @param ctx       2D-контекст
 * @param transform LayerTransform слоя
 * @param naturalSize  размер слоя
 * @param docSize   размер документа
 * @param style     стиль (optional override)
 */
export function renderHandlesForLayer(
  ctx: CanvasRenderingContext2D,
  transform: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
  style?: Partial<HandleStyle>,
): void {
  const layerMatrix = composeLayerMatrix(transform, naturalSize, docSize);
  renderAllHandles(ctx, layerMatrix, naturalSize, style);
}

/**
 * A3: Render perspective quad + diagonals + 4 square handles.
 *
 * Called from transform-overlay-canvas.tsx RAF loop when tool === 'perspective'.
 * Renders INSTEAD of renderAllHandles (affine 9-handle set).
 *
 * Visual design:
 *   - Pink (#f4a) dashed quad outline (matches existing perspective look).
 *   - Semi-transparent pink diagonals (visual cue for "deformable quad").
 *   - 4 square handles at corners (pink fill, black outline; white on hover).
 *   - If !activeLayer.transform.corners (affine layer in perspective tool mode):
 *     show "Affine mode — drag a corner to enter perspective" hint.
 */
export function renderPerspectiveQuad(
  ctx: CanvasRenderingContext2D,
  transform: LayerTransform,
  naturalSize: { w: number; h: number },
  docSize: { w: number; h: number },
  hoverHandle: string | null,
): void {
  // Determine corners: use transform.corners if set, else compute from affine.
  const corners: [Vec2, Vec2, Vec2, Vec2] = transform.corners
    ? transform.corners
    : getLayerCorners(composeLayerMatrix(transform, naturalSize, docSize), naturalSize);

  const [tl, tr, br, bl] = corners;
  const r = 6;  // handle half-size (matching controlSize=12 in affine handles)

  ctx.save();

  // 1. Pink dashed quad outline.
  ctx.strokeStyle = '#f4a';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. Semi-transparent diagonals (visual cue).
  ctx.strokeStyle = 'rgba(255, 100, 200, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y); ctx.lineTo(br.x, br.y);
  ctx.moveTo(tr.x, tr.y); ctx.lineTo(bl.x, bl.y);
  ctx.stroke();

  // 3. 4 square handles.
  const handles: Array<{ id: string; pos: Vec2 }> = [
    { id: 'ptl', pos: tl },
    { id: 'ptr', pos: tr },
    { id: 'pbr', pos: br },
    { id: 'pbl', pos: bl },
  ];
  ctx.lineWidth = 1;
  for (const h of handles) {
    ctx.beginPath();
    ctx.rect(h.pos.x - r, h.pos.y - r, r * 2, r * 2);
    ctx.fillStyle = hoverHandle === h.id ? '#fff' : '#f4a';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }

  // A3-fix-1: removed canvas-drawn "Affine mode — drag a corner..." hint.
  // The hint was a free-floating yellow text with no visual anchor — users
  // reported it as an unexplained "приписка сверху". The same info is now
  // surfaced as a visible highlighted DOM badge in the Properties panel in
  // App.tsx (see "АФФИННЫЙ РЕЖИМ" badge block).

  ctx.restore();
}
