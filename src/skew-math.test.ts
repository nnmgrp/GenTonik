/**
 * skew-math.test.ts — Unit-тесты для skew-math.ts
 *
 * Запуск (например, через vitest):
 *   npx vitest run skew-math.test.ts
 *
 * Или через jest (заменить import на require):
 *   npx jest skew-math.test.ts
 *
 * Тесты покрывают:
 *  - Асимметричный skew для всех 4 ручек (mt/mb/ml/mr)
 *  - Симметричный skew с Alt-модификатором
 *  - Edge cases: тонкий слой, мышь над anchor, нулевое смещение
 *  - Утилиты: computeLayerCenter, isSkewHandle, конвертация углов
 */

import { describe, it, expect } from 'vitest'; // или '@jest/globals'
import {
  computeSkew,
  computeLayerCenter,
  isSkewHandle,
  degreesToRadians,
  radiansToDegrees,
  type LayerCorners,
  type Vec2,
} from './skew-math';

// Квадратный слой 100×100 с углами в (100,100)-(200,100)-(200,200)-(100,200)
const SQUARE_CORNERS: LayerCorners = {
  tl: { x: 100, y: 100 },
  tr: { x: 200, y: 100 },
  br: { x: 200, y: 200 },
  bl: { x: 100, y: 200 },
};
const SQUARE_PIVOT: Vec2 = { x: 150, y: 150 }; // центр

describe('computeSkew — асимметричный режим (дефолт)', () => {
  it('mt: мышь сдвинута вправо на 50px → skewX = atan(50/100) ≈ 26.57°', () => {
    const result = computeSkew({
      handle: 'mt',
      mouse: { x: 200, y: 100 }, // draggedMid.x = 150, dx = 50
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });

    expect(result.skewX).toBeCloseTo(Math.atan(50 / 100), 5);
    expect(result.skewY).toBe(0);
    expect(result.anchor).toEqual({ x: 150, y: 200 }); // нижняя грань
    expect(result.skewX).toBeCloseTo(degreesToRadians(26.565), 3);
  });

  it('mt: мышь над anchor (dx=0) → skewX = 0', () => {
    const result = computeSkew({
      handle: 'mt',
      mouse: { x: 150, y: 100 },
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });

    expect(result.skewX).toBe(0);
    expect(result.skewY).toBe(0);
  });

  it('mt: мышь сдвинута влево на 50px → skewX отрицательный', () => {
    const result = computeSkew({
      handle: 'mt',
      mouse: { x: 100, y: 100 },
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });

    expect(result.skewX).toBeCloseTo(-Math.atan(50 / 100), 5);
    expect(result.skewX).toBeLessThan(0);
  });

  it('mb: anchor = верхняя грань, draggedMid = нижняя', () => {
    const result = computeSkew({
      handle: 'mb',
      mouse: { x: 200, y: 200 }, // draggedMid.x = 150, dx = 50
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });

    expect(result.skewX).toBeCloseTo(Math.atan(50 / 100), 5);
    expect(result.anchor).toEqual({ x: 150, y: 100 }); // верхняя грань
  });

  it('ml: мышь сдвинута вниз на 50px → skewY = atan(50/100) ≈ 26.57°', () => {
    const result = computeSkew({
      handle: 'ml',
      mouse: { x: 100, y: 200 }, // draggedMid.y = 150, dy = 50
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });

    expect(result.skewY).toBeCloseTo(Math.atan(50 / 100), 5);
    expect(result.skewX).toBe(0);
    expect(result.anchor).toEqual({ x: 200, y: 150 }); // правая грань
  });

  it('mr: anchor = левая грань, draggedMid = правая', () => {
    const result = computeSkew({
      handle: 'mr',
      mouse: { x: 200, y: 200 },
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });

    expect(result.skewY).toBeCloseTo(Math.atan(50 / 100), 5);
    expect(result.anchor).toEqual({ x: 100, y: 150 }); // левая грань
  });
});

describe('computeSkew — симметричный режим (Alt)', () => {
  it('mt symmetric: мышь сдвинута на 50px вправо от pivot → skewX = atan(50/100)', () => {
    const result = computeSkew({
      handle: 'mt',
      mouse: { x: 200, y: 100 }, // pivot.x = 150, dx = 50
      corners: SQUARE_CORNERS,
      symmetric: true,
      pivot: SQUARE_PIVOT,
    });

    expect(result.skewX).toBeCloseTo(Math.atan(50 / 100), 5);
    expect(result.anchor).toEqual(SQUARE_PIVOT); // anchor = pivot
  });

  it('mt symmetric: мышь над pivot → skewX = 0', () => {
    const result = computeSkew({
      handle: 'mt',
      mouse: { x: 150, y: 100 },
      corners: SQUARE_CORNERS,
      symmetric: true,
      pivot: SQUARE_PIVOT,
    });

    expect(result.skewX).toBe(0);
    expect(result.anchor).toEqual(SQUARE_PIVOT);
  });

  it('ml symmetric: мышь на 50px ниже pivot → skewY = atan(50/100)', () => {
    const result = computeSkew({
      handle: 'ml',
      mouse: { x: 100, y: 200 },
      corners: SQUARE_CORNERS,
      symmetric: true,
      pivot: SQUARE_PIVOT,
    });

    expect(result.skewY).toBeCloseTo(Math.atan(50 / 100), 5);
    expect(result.anchor).toEqual(SQUARE_PIVOT);
  });
});

describe('computeSkew — edge cases', () => {
  it('тонкий слой (h < minDim) → skew обнуляется', () => {
    const thinCorners: LayerCorners = {
      tl: { x: 100, y: 100 },
      tr: { x: 200, y: 100 },
      br: { x: 200, y: 100.5 }, // высота 0.5px
      bl: { x: 100, y: 100.5 },
    };

    const result = computeSkew({
      handle: 'mt',
      mouse: { x: 200, y: 100 },
      corners: thinCorners,
      symmetric: false,
      pivot: { x: 150, y: 100.25 },
      minDimension: 1,
    });

    expect(result.skewX).toBe(0);
    expect(result.skewY).toBe(0);
    expect(result.description).toContain('too thin');
  });

  it('узкий слой (w < minDim) → skew обнуляется', () => {
    const narrowCorners: LayerCorners = {
      tl: { x: 100, y: 100 },
      tr: { x: 100.5, y: 100 },
      br: { x: 100.5, y: 200 },
      bl: { x: 100, y: 200 },
    };

    const result = computeSkew({
      handle: 'ml',
      mouse: { x: 100, y: 200 },
      corners: narrowCorners,
      symmetric: false,
      pivot: { x: 100.25, y: 150 },
      minDimension: 1,
    });

    expect(result.skewX).toBe(0);
    expect(result.skewY).toBe(0);
    expect(result.description).toContain('too narrow');
  });

  it('нечёткий handle (число с плавающей точкой в координатах) — корректный расчёт', () => {
    const floatCorners: LayerCorners = {
      tl: { x: 100.7, y: 100.3 },
      tr: { x: 200.2, y: 100.3 },
      br: { x: 200.2, y: 200.8 },
      bl: { x: 100.7, y: 200.8 },
    };

    const result = computeSkew({
      handle: 'mt',
      mouse: { x: 175.4, y: 100.3 },
      corners: floatCorners,
      symmetric: false,
      pivot: { x: 150.45, y: 150.55 },
    });

    // draggedMid.x = (100.7 + 200.2) / 2 = 150.45
    // h = 200.8 - 100.3 = 100.5
    // dx = 175.4 - 150.45 = 24.95
    // skewX = atan(24.95 / 100.5)
    expect(result.skewX).toBeCloseTo(Math.atan(24.95 / 100.5), 4);
  });

  it('description содержит угол в градусах', () => {
    const result = computeSkew({
      handle: 'mt',
      mouse: { x: 200, y: 100 },
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });

    expect(result.description).toContain('skewX=');
    expect(result.description).toContain('°');
    expect(result.description).toContain('mt');
  });
});

describe('Утилиты', () => {
  it('computeLayerCenter — корректный центр квадрата', () => {
    const center = computeLayerCenter(SQUARE_CORNERS);
    expect(center).toEqual({ x: 150, y: 150 });
  });

  it('computeLayerCenter — корректный центр для произвольного quad', () => {
    const corners: LayerCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: 100, y: 0 },
      br: { x: 100, y: 50 },
      bl: { x: 0, y: 50 },
    };
    expect(computeLayerCenter(corners)).toEqual({ x: 50, y: 25 });
  });

  it('isSkewHandle — true для средних ручек', () => {
    expect(isSkewHandle('mt')).toBe(true);
    expect(isSkewHandle('mb')).toBe(true);
    expect(isSkewHandle('ml')).toBe(true);
    expect(isSkewHandle('mr')).toBe(true);
  });

  it('isSkewHandle — false для угловых ручек', () => {
    expect(isSkewHandle('tl')).toBe(false);
    expect(isSkewHandle('tr')).toBe(false);
    expect(isSkewHandle('br')).toBe(false);
    expect(isSkewHandle('bl')).toBe(false);
    expect(isSkewHandle('unknown')).toBe(false);
  });

  it('degreesToRadians / radiansToDegrees — корректная конверсия', () => {
    expect(degreesToRadians(0)).toBe(0);
    expect(degreesToRadians(90)).toBeCloseTo(Math.PI / 2, 5);
    expect(degreesToRadians(180)).toBeCloseTo(Math.PI, 5);
    expect(radiansToDegrees(0)).toBe(0);
    expect(radiansToDegrees(Math.PI / 2)).toBeCloseTo(90, 5);
    expect(radiansToDegrees(Math.PI)).toBeCloseTo(180, 5);

    // Round-trip
    expect(radiansToDegrees(degreesToRadians(45))).toBeCloseTo(45, 5);
  });
});

describe('Свойства математики', () => {
  it('Skew монотонный: больше смещение → больше угол', () => {
    const small = computeSkew({
      handle: 'mt',
      mouse: { x: 175, y: 100 }, // dx = 25
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });
    const big = computeSkew({
      handle: 'mt',
      mouse: { x: 250, y: 100 }, // dx = 100
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });

    expect(big.skewX).toBeGreaterThan(small.skewX);
    expect(big.skewX).toBeLessThan(Math.PI / 2); // всегда < 90°
  });

  it('Зеркальный mt и mb дают одинаковый |skewX| для одинакового смещения', () => {
    const mt = computeSkew({
      handle: 'mt',
      mouse: { x: 200, y: 100 }, // dx = +50
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });
    const mb = computeSkew({
      handle: 'mb',
      mouse: { x: 200, y: 200 }, // dx = +50
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });

    expect(Math.abs(mt.skewX)).toBeCloseTo(Math.abs(mb.skewX), 5);
  });

  it('mt symmetric и asymmetric дают одинаковый skewX при одинаковой dx/2 (symmetric) vs dx (asymmetric)', () => {
    // asymmetric dx=50 → skewX = atan(50/100)
    // symmetric dx=100 → skewX = atan(100/100) — должно быть больше
    const asymmetric = computeSkew({
      handle: 'mt',
      mouse: { x: 200, y: 100 }, // dx = 50 от draggedMid
      corners: SQUARE_CORNERS,
      symmetric: false,
      pivot: SQUARE_PIVOT,
    });
    const symmetric = computeSkew({
      handle: 'mt',
      mouse: { x: 250, y: 100 }, // dx = 100 от pivot
      corners: SQUARE_CORNERS,
      symmetric: true,
      pivot: SQUARE_PIVOT,
    });

    // atan(50/100) vs atan(100/100)
    expect(asymmetric.skewX).toBeCloseTo(Math.atan(0.5), 5);
    expect(symmetric.skewX).toBeCloseTo(Math.atan(1.0), 5);
    expect(symmetric.skewX).toBeGreaterThan(asymmetric.skewX);
  });
});
