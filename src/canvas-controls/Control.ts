// ============================================================
// canvas-controls/Control.ts — Handle (control point) class
// ============================================================
//
// Шаблон для одной манипулятора (handle) на Canvas-overlay.
//
// АРХИТЕКТУРА:
//   Каждый handle — это объект Control с координатами в "нормализованных"
//   единицах относительно bounding box слоя:
//     x = -0.5 .. 0.5  (left .. right)
//     y = -0.5 .. 0.5  (top  .. bottom)
//   offsetX/offsetY — px-сдвиг от позиции (используется для rotater,
//   который стоит на 30px выше bbox).
//
//   Позиция handle на экране вычисляется через наш composeLayerMatrix
//   из transform-matrix.ts — НИКАКИХ Fabric/Konva matrix utils.
//
// ATTRIBUTION:
//   Поля (x, y, offsetX, offsetY, cursorStyle, withConnection) —
//   заимствованы из fabric.js Control class (MIT, © Printio, Bogazzi).
//   См. NOTICE.md. Сама реализация positionHandler / hitTest — наша,
//   использует transform-matrix.ts.
//
// Используется:
//   • canvas-controls/controls.ts — 9 инстансов (tl/tr/bl/br/ml/mr/mt/mb/mtr)
//   • canvas-controls/renderHandles.ts — отрисовка
//   • transform-overlay-canvas.tsx (будущий) — hit-test на pointer events
// ============================================================

import type { Vec2 } from '@/types';
import {
  type Matrix,
  applyToPoint,
  multiply,
  rotation,
  scaling,
  translation,
} from '@/transform-matrix';

// ────────────────────────────────────────────────────────────
// Типы
// ────────────────────────────────────────────────────────────

/** Идентификатор handle — используется в hit-test и в action dispatch. */
export type ControlId =
  | 'tl' | 'tr' | 'bl' | 'br'          // 4 угла
  | 'ml' | 'mr' | 'mt' | 'mb'          // 4 середины сторон
  | 'mtr'                              // rotater
  | 'body'                             // "виртуальный" handle — тело слоя
                                       // (не рисуется; для move-drag по bbox)
  | 'ptl' | 'ptr' | 'pbr' | 'pbl';     // A3: perspective corners

/** Тип действия, которое handle запускает при drag. */
export type ControlAction =
  | 'move'
  | 'scale' | 'scale-x' | 'scale-y'
  | 'rotate'
  | 'skew-x' | 'skew-y'  // Added for skew
  | 'perspective'        // A3: corner drag
  | 'perspective-move';  // A3: body drag in perspective mode

/** Стиль отрисовки handle. */
export interface ControlStyle {
  /** Заливка квадрата/круга. */
  fill: string;
  /** Обводка. */
  stroke: string;
  /** Толщина обводки. */
  strokeWidth: number;
  /** Размер handle в px (диаметр для круга, сторона для квадрата). */
  size: number;
}

const DEFAULT_STYLE: ControlStyle = {
  fill: '#ffffff',
  stroke: '#0d99ff',
  strokeWidth: 1.5,
  size: 8,
};

// ────────────────────────────────────────────────────────────
// Класс Control
// ────────────────────────────────────────────────────────────

/**
 * Handle (манипулятор) трансформации.
 *
 * Концепция заимствована из fabric.js Control class (MIT), но без
 * зависимостей от Fabric. Поля x/y/offsetX/offsetY/cursorStyle/withConnection
 * — те же, что в Fabric. Методы positionHandler/hitTest — наши,
 * используют transform-matrix.ts.
 */
export class Control {
  /** Идентификатор handle (tl/tr/bl/br/ml/mr/mt/mb/mtr). */
  readonly id: ControlId;
  /** Относительная X-позиция: -0.5 (left) .. 0.5 (right). */
  readonly x: number;
  /** Относительная Y-позиция: -0.5 (top) .. 0.5 (bottom). */
  readonly y: number;
  /** Px-сдвиг по X от позиции (для rotater = 0). */
  readonly offsetX: number;
  /** Px-сдвиг по Y от позиции (для rotater = -30). */
  readonly offsetY: number;
  /** CSS-курсор при hover (nwse-resize / nesw-resize / ew-resize / ns-resize / crosshair). */
  readonly cursorStyle: string;
  /** Рисовать ли линию от bbox к handle (true для rotater). */
  readonly withConnection: boolean;
  /** Тип действия при drag. */
  readonly action: ControlAction;
  /** Форма handle. */
  readonly shape: 'square' | 'circle';

  constructor(opts: {
    id: ControlId;
    x: number;
    y: number;
    offsetX?: number;
    offsetY?: number;
    cursorStyle?: string;
    withConnection?: boolean;
    action: ControlAction;
    shape?: 'square' | 'circle';
  }) {
    this.id = opts.id;
    this.x = opts.x;
    this.y = opts.y;
    this.offsetX = opts.offsetX ?? 0;
    this.offsetY = opts.offsetY ?? 0;
    this.cursorStyle = opts.cursorStyle ?? 'default';
    this.withConnection = opts.withConnection ?? false;
    this.action = opts.action;
    this.shape = opts.shape ?? 'square';
  }

  // ─────────────────────────────────────────────────────────
  // positionHandler — позиция handle в canvas-пикселях
  // ─────────────────────────────────────────────────────────

  /**
   * Вычисляет позицию handle в canvas-пикселях для слоя с заданной
   * forward-матрицей (composeLayerMatrix).
   *
   * Алгоритм:
   *   1. Конверсия centered coords (x ∈ [-0.5, +0.5]) → natural coords:
   *        localX = (x + 0.5) * width  + offsetX
   *        localY = (y + 0.5) * height + offsetY
   *      Это соответствует natural coords, где (0, 0) = TL, (w, h) = BR.
   *   2. Применяем layerMatrix → canvas-пиксели.
   *
   * ВАЖНО (bugfix A1-positionHandler):
   *   Раньше здесь было `localX = this.x * naturalSize.w + this.offsetX`
   *   (без `+ 0.5`), что давало centered coords (-w/2..+w/2). Но
   *   composeLayerMatrix построена как `T(destCenter) * R * Skew * S * T(-w/2,-h/2)`
   *   и ожидает NATURAL coords (0..w, 0..h) на вход — внутренний T(-w/2,-h/2)
   *   сам центрирует. Передача centered coords давала точки в 2× дальше от
   *   центра, чем нужно: TL handle рендерился в (-w/2, -h/2) вместо (0, 0).
   *
   *   Подтверждено численно scripts/verify_position_handler.js:
   *   для identity-transform 800×600 слоя CURRENT давал (-400, -300) вместо
   *   (0, 0); FIXED даёт (0, 0) = точно TL corner из getLayerCorners.
   *
   * @param naturalSize  ширина/высота слоя в px (до трансформации)
   * @param layerMatrix  forward-матрица слоя из composeLayerMatrix()
   * @returns позиция в canvas-пикселях
   */
  positionHandler(
    naturalSize: { w: number; h: number },
    layerMatrix: Matrix,
  ): Vec2 {
    // Конверсия centered (x ∈ [-0.5, +0.5]) → natural (0..w):
    //   localX = (x + 0.5) * w  → для x=-0.5 даёт 0 (TL), для x=+0.5 даёт w (BR)
    const localX = (this.x + 0.5) * naturalSize.w + this.offsetX;
    const localY = (this.y + 0.5) * naturalSize.h + this.offsetY;
    return applyToPoint(layerMatrix, { x: localX, y: localY });
  }

  // ─────────────────────────────────────────────────────────
  // hitTest — проверка попадания курсора в handle
  // ─────────────────────────────────────────────────────────

  /**
   * Проверяет, попадает ли точка (в canvas-пикселях) в этот handle.
   *
   * Использует bounding circle: distance < (size / 2 + padding).
   * Это проще и быстрее, чем polygon hit-test из Fabric.js, и для
   * handles размером 8px визуально неотличимо.
   *
   * @param point         точка курсора в canvas-пикселях
   * @param naturalSize   ширина/высота слоя
   * @param layerMatrix   forward-матрица слоя
   * @param padding       доп. радиус для удобного попадания (default 4)
   * @param sizeOverride  размер handle (если отличается от default)
   */
  hitTest(
    point: Vec2,
    naturalSize: { w: number; h: number },
    layerMatrix: Matrix,
    padding: number = 4,
    sizeOverride?: number,
  ): boolean {
    const handlePos = this.positionHandler(naturalSize, layerMatrix);
    const radius = (sizeOverride ?? DEFAULT_STYLE.size) / 2 + padding;
    const dx = handlePos.x - point.x;
    const dy = handlePos.y - point.y;
    return (dx * dx + dy * dy) <= radius * radius;
  }

  // ─────────────────────────────────────────────────────────
  // render — отрисовка handle на ctx
  // ─────────────────────────────────────────────────────────

  /**
   * Рисует handle на ctx в заданной позиции (canvas-пиксели).
   *
   * Контекст НЕ должен быть translat'нут — функция сама сдвигается
   * к (x, y) и рисует квадрат или круг.
   *
   * @param ctx   2D-контекст overlay-canvas
   * @param x     canvas-пиксель X
   * @param y     canvas-пиксель Y
   * @param style стиль (optional override)
   */
  render(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    style?: Partial<ControlStyle>,
  ): void {
    const s = { ...DEFAULT_STYLE, ...style };
    const half = s.size / 2;

    ctx.save();
    ctx.fillStyle = s.fill;
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = s.strokeWidth;

    if (this.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(x, y, half, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x - half, y - half, s.size, s.size);
      ctx.strokeRect(x - half, y - half, s.size, s.size);
    }
    ctx.restore();
  }
}

// ────────────────────────────────────────────────────────────
// Вспомогательная функция — матрица для вращения вокруг центра
// (для будущего rotate-around-center в Canvas-overlay)
// ────────────────────────────────────────────────────────────

/**
 * Строит матрицу "вращение вокруг заданной точки" (а не вокруг origin).
 *
 *   M = T(cx, cy) * R(angle) * T(-cx, -cy)
 *
 * Зачем: при drag rotater мы хотим вращать layer вокруг его центра,
 * а не вокруг (0,0). Аналог rotateAroundCenter из Konva (MIT).
 *
 * @param cx    X центра вращения (canvas-пиксели)
 * @param cy    Y центра вращения
 * @param rad   угол в радианах
 */
export function rotateAroundPointMatrix(
  cx: number,
  cy: number,
  rad: number,
): Matrix {
  return multiply(
    multiply(translation(cx, cy), rotation(rad)),
    translation(-cx, -cy),
  );
}

/**
 * Строит матрицу "масштабирование относительно заданной точки".
 *
 *   M = T(cx, cy) * S(sx, sy) * T(-cx, -cy)
 *
 * Зачем: при drag corner handle мы хотим масштабировать layer
 * так, чтобы противоположный угол оставался на месте. Этот
 * противоположный угол и есть (cx, cy).
 *
 * @param cx  X anchor-точки (canvas-пиксели)
 * @param cy  Y anchor-точки
 * @param sx  масштаб по X
 * @param sy  масштаб по Y
 */
export function scaleAroundPointMatrix(
  cx: number,
  cy: number,
  sx: number,
  sy: number,
): Matrix {
  return multiply(
    multiply(translation(cx, cy), scaling(sx, sy)),
    translation(-cx, -cy),
  );
}

// ────────────────────────────────────────────────────────────
// Экспорт стиля по умолчанию (для renderHandles.ts)
// ────────────────────────────────────────────────────────────

export const DEFAULT_CONTROL_STYLE: ControlStyle = DEFAULT_STYLE;
