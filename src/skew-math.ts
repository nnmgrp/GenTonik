/**
 * skew-math.ts — Чистая математика skew (сдвига) слоя.
 *
 * Реализует поведение по образцу Krita:
 *  - Асимметричный skew (дефолт): противоположная грань — anchor, двигается только dragged edge.
 *  - Симметричный skew (Alt-модификатор): pivot в центре, обе грани расходятся.
 *
 * Математика:
 *  Горизонтальный skew (через mt/mb): одна грань закреплена, противоположная смещается по X.
 *    skewX = atan(dx / h), где dx — смещение dragged edge по X, h — высота слоя.
 *    При symmetric: dx делится пополам, anchor = pivot, грани расходятся в разные стороны.
 *
 *  Вертикальный skew (через ml/mr): одна грань закреплена, противоположная смещается по Y.
 *    skewY = atan(dy / w), где dy — смещение dragged edge по Y, w — ширина слоя.
 *    При symmetric: dy делится пополам, anchor = pivot.
 *
 * Возвращаемые значения — радианы, готовые для передачи в transform-matrix.ts: skew(skewX, skewY).
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Четыре угла слоя в canvas-координатах (до skew). */
export interface LayerCorners {
  tl: Vec2; // top-left
  tr: Vec2; // top-right
  br: Vec2; // bottom-right
  bl: Vec2; // bottom-left
}

/** Средние маркеры, инициирующие skew. */
export type SkewHandle = 'mt' | 'mb' | 'ml' | 'mr';

/** Результат расчёта skew для передачи в transform-matrix.ts. */
export interface SkewResult {
  /** Угол сдвига по X (радианы). 0 = без сдвига. */
  skewX: number;
  /** Угол сдвига по Y (радианы). 0 = без сдвига. */
  skewY: number;
  /** Точка, остающаяся неподвижной при skew (для anchor-based рендера). */
  anchor: Vec2;
  /** Описание операции для undo-stack. */
  description: string;
}

/** Входные параметры для computeSkew. */
export interface SkewParams {
  /** Какой маркер тянется. */
  handle: SkewHandle;
  /** Текущая позиция мыши в canvas-координатах. */
  mouse: Vec2;
  /** Углы слоя до skew (исходное состояние). */
  corners: LayerCorners;
  /**
   * Симметричный режим (Alt-модификатор).
   * true: pivot в центре, обе грани расходятся.
   * false: anchor = противоположная грань, двигается только dragged edge.
   */
  symmetric: boolean;
  /**
   * Pivot point для symmetric mode. Обычно = центр слоя.
   * В asymmetric mode игнорируется (anchor вычисляется из противоположной грани).
   */
  pivot: Vec2;
  /**
   * Минимальная длина для расчёта угла (защита от деления на 0).
   * Если слой тоньше/уже этого значения, skew обнуляется.
   * По умолчанию 1px.
   */
  minDimension?: number;
}

/**
 * Главная функция: расчёт skew по позиции мыши.
 *
 * Пример использования:
 *   const result = computeSkew({
 *     handle: 'mt',
 *     mouse: { x: 150, y: 50 },
 *     corners: { tl: {x:100, y:100}, tr: {x:200, y:100}, br: {x:200, y:200}, bl: {x:100, y:200} },
 *     symmetric: false,
 *     pivot: { x: 150, y: 150 },
 *   });
 *   // result.skewX = atan((150-150) / 100) = 0 (мышь над центром)
 *   // result.skewY = 0
 *   // result.anchor = { x: 150, y: 200 } (нижняя грань)
 */
export function computeSkew(params: SkewParams): SkewResult {
  const { handle, mouse, corners, symmetric, pivot } = params;
  const minDim = params.minDimension ?? 1;

  switch (handle) {
    case 'mt':
      return computeHorizontalSkew({
        mouse,
        draggedEdge: { from: corners.tl, to: corners.tr },
        anchorEdge: { from: corners.bl, to: corners.br },
        symmetric,
        pivot,
        minDim,
        handleLabel: 'mt (top)',
      });
    case 'mb':
      return computeHorizontalSkew({
        mouse,
        draggedEdge: { from: corners.bl, to: corners.br },
        anchorEdge: { from: corners.tl, to: corners.tr },
        symmetric,
        pivot,
        minDim,
        handleLabel: 'mb (bottom)',
      });
    case 'ml':
      return computeVerticalSkew({
        mouse,
        draggedEdge: { from: corners.tl, to: corners.bl },
        anchorEdge: { from: corners.tr, to: corners.br },
        symmetric,
        pivot,
        minDim,
        handleLabel: 'ml (left)',
      });
    case 'mr':
      return computeVerticalSkew({
        mouse,
        draggedEdge: { from: corners.tr, to: corners.br },
        anchorEdge: { from: corners.tl, to: corners.bl },
        symmetric,
        pivot,
        minDim,
        handleLabel: 'mr (right)',
      });
    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = handle;
      void _exhaustive;
      throw new Error(`Unknown skew handle: ${handle}`);
    }
  }
}

// ============================================================================
// Внутренние функции
// ============================================================================

interface EdgeSkewParams {
  mouse: Vec2;
  draggedEdge: { from: Vec2; to: Vec2 };
  anchorEdge: { from: Vec2; to: Vec2 };
  symmetric: boolean;
  pivot: Vec2;
  minDim: number;
  handleLabel: string;
}

/**
 * Горизонтальный skew (mt / mb ручки).
 * Сдвигается draggedEdge по X, anchorEdge стоит.
 * skewX = atan(dx / h), где h — расстояние между гранями по Y.
 */
function computeHorizontalSkew(p: EdgeSkewParams): SkewResult {
  const draggedMid = midpoint(p.draggedEdge.from, p.draggedEdge.to);
  const anchorMid = midpoint(p.anchorEdge.from, p.anchorEdge.to);

  // Высота = расстояние между гранями по Y (с учётом поворота слоя — берём перпендикуляр)
  const h = Math.abs(draggedMid.y - anchorMid.y);
  if (h < p.minDim) {
    return {
      skewX: 0,
      skewY: 0,
      anchor: anchorMid,
      description: `skew ${p.handleLabel}: layer too thin, no skew`,
    };
  }

  if (p.symmetric) {
    // Симметричный: pivot в центре, dragged edge смещается на dx/2 от pivot,
    // anchor edge (которая на самом деле тоже двигается) — на -dx/2.
    // Но в нашей модели skew матрицы применяются к слою как целому,
    // поэтому skewX = atan((dx/2) / (h/2)) = atan(dx / h).
    // Сдвиг относительно pivot: dx = mouse.x - pivot.x.
    const dx = p.mouse.x - p.pivot.x;
    const skewX = Math.atan(dx / h);
    return {
      skewX,
      skewY: 0,
      anchor: p.pivot,
      description: `symmetric skew ${p.handleLabel}: skewX=${(skewX * 180 / Math.PI).toFixed(1)}°`,
    };
  } else {
    // Асимметричный: anchor = anchorEdge midpoint.
    // Сдвиг dragged edge относительно своего начального положения:
    // dx = mouse.x - draggedMid.x (отклонение мыши от исходной позиции грани).
    // skewX = atan(dx / h).
    const dx = p.mouse.x - draggedMid.x;
    const skewX = Math.atan(dx / h);
    return {
      skewX,
      skewY: 0,
      anchor: anchorMid,
      description: `skew ${p.handleLabel}: skewX=${(skewX * 180 / Math.PI).toFixed(1)}°`,
    };
  }
}

/**
 * Вертикальный skew (ml / mr ручки).
 * Сдвигается draggedEdge по Y, anchorEdge стоит.
 * skewY = atan(dy / w), где w — расстояние между гранями по X.
 */
function computeVerticalSkew(p: EdgeSkewParams): SkewResult {
  const draggedMid = midpoint(p.draggedEdge.from, p.draggedEdge.to);
  const anchorMid = midpoint(p.anchorEdge.from, p.anchorEdge.to);

  const w = Math.abs(draggedMid.x - anchorMid.x);
  if (w < p.minDim) {
    return {
      skewX: 0,
      skewY: 0,
      anchor: anchorMid,
      description: `skew ${p.handleLabel}: layer too narrow, no skew`,
    };
  }

  if (p.symmetric) {
    const dy = p.mouse.y - p.pivot.y;
    const skewY = Math.atan(dy / w);
    return {
      skewX: 0,
      skewY,
      anchor: p.pivot,
      description: `symmetric skew ${p.handleLabel}: skewY=${(skewY * 180 / Math.PI).toFixed(1)}°`,
    };
  } else {
    const dy = p.mouse.y - draggedMid.y;
    const skewY = Math.atan(dy / w);
    return {
      skewX: 0,
      skewY,
      anchor: anchorMid,
      description: `skew ${p.handleLabel}: skewY=${(skewY * 180 / Math.PI).toFixed(1)}°`,
    };
  }
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// ============================================================================
// Утилиты для интеграции
// ============================================================================

/**
 * Вычисляет pivot point слоя (центр).
 * Используется для symmetric mode, если художник не задал кастомный pivot.
 */
export function computeLayerCenter(corners: LayerCorners): Vec2 {
  return midpoint(
    midpoint(corners.tl, corners.tr),
    midpoint(corners.bl, corners.br),
  );
}

/**
 * Проверка: является ли данный handle skew-маркером (средняя ручка).
 * Угловые маркеры (tl/tr/br/bl) НЕ являются skew-маркерами.
 */
export function isSkewHandle(handle: string): handle is SkewHandle {
  return handle === 'mt' || handle === 'mb' || handle === 'ml' || handle === 'mr';
}

/**
 * Конвертация градусов в радианы (для UI-отображения угла skew).
 */
export function degreesToRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Конвертация радиан в градусы (для отображения в Properties panel).
 */
export function radiansToDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}
