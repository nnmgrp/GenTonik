// ============================================================
// canvas-controls/controls.ts — 9 инстансов Control + утилиты
// ============================================================
//
// Определения 9 стандартных handles (tl/tr/bl/br/ml/mr/mt/mb/mtr)
// и вспомогательные функции:
//   • getCursor() — CSS-курсор в зависимости от угла вращения
//   • getSnap()   — snap к заданным углам при вращении
//   • ANGLES      — таблица углов handles для getCursor
//
// ATTRIBUTION:
//   • getCursor, getSnap, ANGLES, ANCHORS_NAMES — заимствованы из
//     Konva Transformer (MIT, © Anton Lavrenov). См. NOTICE.md.
//   • Список 9 controls (tl/tr/bl/br/ml/mr/mt/mb/mtr) — стандарт
//     из fabric.js Control (MIT, © Printio, Bogazzi).
//   • Реализация Control-инстансов — наша, через наш Control class.
// ============================================================

import { Control, type ControlId } from './Control';

// ────────────────────────────────────────────────────────────
// 9 стандартных handles
// ────────────────────────────────────────────────────────────

/**
 * Все 9 handles трансформации.
 *
 * Координаты x/y — в диапазоне [-0.5, 0.5]:
 *   -0.5 = left/top    0 = center    0.5 = right/bottom
 *
 * cursorStyle — это БАЗОВЫЙ курсор при rotation=0. Реальный курсор
 * вычисляется через getCursor(id, layerRotationRad) с учётом поворота.
 */
export const CONTROLS: Record<ControlId, Control> = {
  // 4 угла — uniform scale (с сохранением пропорций по умолчанию)
  tl: new Control({
    id: 'tl',
    x: -0.5, y: -0.5,
    cursorStyle: 'nwse-resize',
    action: 'scale',
  }),
  tr: new Control({
    id: 'tr',
    x: 0.5, y: -0.5,
    cursorStyle: 'nesw-resize',
    action: 'scale',
  }),
  bl: new Control({
    id: 'bl',
    x: -0.5, y: 0.5,
    cursorStyle: 'nesw-resize',
    action: 'scale',
  }),
  br: new Control({
    id: 'br',
    x: 0.5, y: 0.5,
    cursorStyle: 'nwse-resize',
    action: 'scale',
  }),

  // 4 середины сторон — scale по одной оси
  ml: new Control({
    id: 'ml',
    x: -0.5, y: 0,
    cursorStyle: 'ew-resize',
    action: 'scale-x',
  }),
  mr: new Control({
    id: 'mr',
    x: 0.5, y: 0,
    cursorStyle: 'ew-resize',
    action: 'scale-x',
  }),
  mt: new Control({
    id: 'mt',
    x: 0, y: -0.5,
    cursorStyle: 'ns-resize',
    action: 'scale-y',
  }),
  mb: new Control({
    id: 'mb',
    x: 0, y: 0.5,
    cursorStyle: 'ns-resize',
    action: 'scale-y',
  }),

  // Rotater — стоит на 30px выше верхней середины
  mtr: new Control({
    id: 'mtr',
    x: 0, y: -0.5,
    offsetY: -30,
    cursorStyle: 'crosshair',
    withConnection: true,
    action: 'rotate',
    shape: 'circle',
  }),

  // body — виртуальный handle для move-drag по телу слоя.
  // НЕ добавляется в CONTROL_LIST (не рисуется как handle).
  // Используется только как маркер action='move' в hit-test и drag.
  body: new Control({
    id: 'body',
    x: 0, y: 0,
    cursorStyle: 'move',
    action: 'move',
  }),

  // A3: Perspective corner handles.
  // Same normalized coordinates as affine corners, but using shape='square'
  // and action='perspective'. Renders in renderPerspectiveQuad.
  ptl: new Control({
    id: 'ptl',
    x: -0.5, y: -0.5,
    cursorStyle: 'crosshair',
    action: 'perspective',
    shape: 'square',
  }),
  ptr: new Control({
    id: 'ptr',
    x: 0.5, y: -0.5,
    cursorStyle: 'crosshair',
    action: 'perspective',
    shape: 'square',
  }),
  pbr: new Control({
    id: 'pbr',
    x: 0.5, y: 0.5,
    cursorStyle: 'crosshair',
    action: 'perspective',
    shape: 'square',
  }),
  pbl: new Control({
    id: 'pbl',
    x: -0.5, y: 0.5,
    cursorStyle: 'crosshair',
    action: 'perspective',
    shape: 'square',
  }),
};

/**
 * Упорядоченный список всех handles (для итерации при отрисовке).
 * Порядок: сначала углы, потом середины, потом rotater.
 */
export const CONTROL_LIST: Control[] = [
  CONTROLS.tl, CONTROLS.tr, CONTROLS.bl, CONTROLS.br,
  CONTROLS.ml, CONTROLS.mr, CONTROLS.mt, CONTROLS.mb,
  CONTROLS.mtr,
];

// ────────────────────────────────────────────────────────────
// getCursor — CSS-курсор с учётом поворота слоя
// ────────────────────────────────────────────────────────────

/**
 * Базовые углы handles в градусах (относительно "north" = вверх).
 * Используется в getCursor для вычисления реального направления
 * курсора после поворота слоя.
 *
 * Например, при rotation=0 у handle 'tl' курсор 'nwse-resize'.
 * При rotation=90° тот же handle визуально становится 'tr', и
 * курсор должен стать 'nesw-resize'.
 *
 * Attribution: Konva Transformer (MIT), getCursor function.
 */
export const ANCHOR_ANGLES_DEG: Record<Exclude<ControlId, 'mtr' | 'body' | 'ptl' | 'ptr' | 'pbr' | 'pbl'>, number> = {
  tl: -45,
  tr: 45,
  bl: -135,
  br: 135,
  ml: -90,
  mr: 90,
  mt: 0,
  mb: 180,
};

/**
 * Вычисляет CSS-курсор для handle с учётом поворота слоя.
 *
 * @param controlId       идентификатор handle
 * @param layerRotationRad  текущий угол поворота слоя в радианах
 * @param rotateCursor    курсор для rotater (default 'crosshair')
 * @returns CSS-строка курсора ('ns-resize', 'nesw-resize', etc.)
 *
 * Attribution: Konva Transformer (MIT), getCursor function.
 * Изменения: убраны Konva-зависимости (Util.degToRad, Util._inRange),
 * используется чистый TypeScript.
 */
export function getCursor(
  controlId: ControlId,
  layerRotationRad: number,
  rotateCursor: string = 'crosshair',
): string {
  if (controlId === 'mtr') {
    return rotateCursor;
  }
  if (controlId === 'body') {
    return 'move';
  }
  if (controlId === 'ptl' || controlId === 'ptr' || controlId === 'pbl' || controlId === 'pbr') {
    return 'crosshair';
  }

  // Суммарный угол = угол handle + угол поворота слоя
  let angleDeg =
    (layerRotationRad * 180) / Math.PI +
    (ANCHOR_ANGLES_DEG[controlId as Exclude<ControlId, 'mtr' | 'body' | 'ptl' | 'ptr' | 'pbr' | 'pbl'>] ?? 0);
  // Нормализуем в [0, 360)
  angleDeg = ((angleDeg % 360) + 360) % 360;

  // 8 секторов по 45°, центр каждого на 0/45/90/135/180/225/270/315
  // Допуск ±22.5° от центра.
  const inRange = (a: number, lo: number, hi: number) => a >= lo && a <= hi;

  if (inRange(angleDeg, 315 + 22.5, 360) || inRange(angleDeg, 0, 22.5)) {
    return 'ns-resize';        // north (mt at rotation 0)
  } else if (inRange(angleDeg, 45 - 22.5, 45 + 22.5)) {
    return 'nesw-resize';      // north-east (tr)
  } else if (inRange(angleDeg, 90 - 22.5, 90 + 22.5)) {
    return 'ew-resize';        // east (mr)
  } else if (inRange(angleDeg, 135 - 22.5, 135 + 22.5)) {
    return 'nwse-resize';      // south-east (br)
  } else if (inRange(angleDeg, 180 - 22.5, 180 + 22.5)) {
    return 'ns-resize';        // south (mb)
  } else if (inRange(angleDeg, 225 - 22.5, 225 + 22.5)) {
    return 'nesw-resize';      // south-west (bl)
  } else if (inRange(angleDeg, 270 - 22.5, 270 + 22.5)) {
    return 'ew-resize';        // west (ml)
  } else if (inRange(angleDeg, 315 - 22.5, 315 + 22.5)) {
    return 'nwse-resize';      // north-west (tl)
  }

  // Не должно случиться — все 8 секторов покрывают [0, 360)
  return 'pointer';
}

// ────────────────────────────────────────────────────────────
// getSnap — snap угла вращения к заданным значениям
// ────────────────────────────────────────────────────────────

/**
 * Snap угла вращения к ближайшему из списка snaps, если в пределах допуска.
 *
 * @param snaps         список углов в РАДИАНАХ (например, [0, π/4, π/2, ...])
 * @param newRotationRad  текущий угол в радианах
 * @param toleranceRad  допуск в радианах (например, 5° = 0.087)
 * @returns snapped угол в радианах (равен newRotationRad, если не попал ни в один snap)
 *
 * Attribution: Konva Transformer (MIT), getSnap function.
 * Изменения: убран Konva.getAngle (он делает то же самое для радиан),
 * используется чистый TypeScript.
 */
export function getSnap(
  snaps: number[],
  newRotationRad: number,
  toleranceRad: number,
): number {
  let snapped = newRotationRad;
  for (const snapAngle of snaps) {
    const absDiff = Math.abs(snapAngle - newRotationRad) % (Math.PI * 2);
    const diff = Math.min(absDiff, Math.PI * 2 - absDiff);
    if (diff < toleranceRad) {
      snapped = snapAngle;
    }
  }
  return snapped;
}

/**
 * Готовый список snap-углов каждые 15° (типичный Photoshop behavior).
 * В радианах, для использования с getSnap().
 */
export const DEFAULT_ROTATION_SNAPS_RAD: number[] = (() => {
  const snaps: number[] = [];
  for (let deg = 0; deg < 360; deg += 15) {
    snaps.push((deg * Math.PI) / 180);
  }
  return snaps;
})();

/**
 * Допуск snap по умолчанию: 5° в радианах.
 */
export const DEFAULT_SNAP_TOLERANCE_RAD = (5 * Math.PI) / 180;

// ────────────────────────────────────────────────────────────
// hitTestAll — проверить все handles сразу
// ────────────────────────────────────────────────────────────

import type { Vec2 } from '@/types';
import type { Matrix } from '@/transform-matrix';

/**
 * Проверяет все handles и возвращает первый, в который попал курсор.
 * Порядок проверки: rotater → углы → середины (rotater "на верху",
 * чтобы перекрытие с mt было маловероятно).
 *
 * @param point         курсор в canvas-пикселях
 * @param naturalSize   размер слоя
 * @param layerMatrix   forward-матрица слоя
 * @param padding       доп. радиус (default 4)
 * @param handleSize    размер handle (default 8)
 * @returns Control, в который попали, или null
 */
export function hitTestAll(
  point: Vec2,
  naturalSize: { w: number; h: number },
  layerMatrix: Matrix,
  padding: number = 4,
  handleSize: number = 8,
): Control | null {
  // Сначала rotater — он визуально "на верху"
  if (CONTROLS.mtr.hitTest(point, naturalSize, layerMatrix, padding, handleSize)) {
    return CONTROLS.mtr;
  }
  // Углы
  for (const id of ['tl', 'tr', 'bl', 'br'] as ControlId[]) {
    if (CONTROLS[id].hitTest(point, naturalSize, layerMatrix, padding, handleSize)) {
      return CONTROLS[id];
    }
  }
  // Середины
  for (const id of ['ml', 'mr', 'mt', 'mb'] as ControlId[]) {
    if (CONTROLS[id].hitTest(point, naturalSize, layerMatrix, padding, handleSize)) {
      return CONTROLS[id];
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// getOppositeHandle — для anchor-based scale
// ────────────────────────────────────────────────────────────

/**
 * Возвращает "противоположный" handle для заданного углового/среднего.
 *
 * При drag, например, 'br' мы хотим зафиксировать 'tl' (противоположный
 * угол) — это даёт intuitive scale "от противоположного угла".
 *
 *   tl ↔ br
 *   tr ↔ bl
 *   ml ↔ mr
 *   mt ↔ mb
 *
 * Для rotater (mtr) возвращает null (нет противоположного).
 */
export function getOppositeHandle(id: ControlId): ControlId | null {
  switch (id) {
    case 'tl': return 'br';
    case 'tr': return 'bl';
    case 'bl': return 'tr';
    case 'br': return 'tl';
    case 'ml': return 'mr';
    case 'mr': return 'ml';
    case 'mt': return 'mb';
    case 'mb': return 'mt';
    case 'mtr': return null;
    case 'body': return null;
    case 'ptl': return null;
    case 'ptr': return null;
    case 'pbl': return null;
    case 'pbr': return null;
  }
}
