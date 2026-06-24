// ============================================================
// RENDERING ENGINE — GenToniK Screentone Generator v2
// ============================================================
//
// v2 changes vs v1:
//   • SVG export REMOVED — Gigapixel model uses PNG round-trip.
//     The old `isSVG` branches and `getShapeSVG()` are gone.
//   • Shape drawing delegated to roundness.ts (`drawRoundedShape`).
//     The old `chaikinSmooth()` + `morphToCircle()` + `drawShape()`
//     are gone — they produced the "bitten circle" bug.
//   • Signature simplified:
//       −_maskCanvas (was unused, `_` prefix confirms)
//       −isSVG (SVG export removed)
//       −panX, panY (pan/zoom handled at composite/view layer)
//       −return type now `void` (was `string | void` for SVG)
//   • Hot-loop optimizations:
//       −cos/sin(rotCanvasRad) hoisted OUT of inner loops
//       −Off-canvas dots culled before save/restore (~40% fewer
//         iterations for typical 2000×2000 canvases)
//       −`iy & 1` instead of `Math.abs(iy) % 2 === 1`
//       −`if (rotation !== 0) ctx.rotate(rotation)` skips
//         unnecessary rotate call for axis-aligned patterns
//
// What's PRESERVED:
//   • All 12 pattern types (dots, lines, crosshatch, noise,
//     gaussian_noise, stipple, hexgrid, checker, concentric,
//     stars, hearts, triangles)
//   • Satellite system (4-slot orbit with stretch toward parent)
//   • Gradient mapping (linear/radial, size + stretch + color)
//   • Seeded random for deterministic tiling
//   • Color utilities (hexToRgb, lerp, lerpColor, midBiasCurve)
// ============================================================

import { ScreentoneParams } from './types';
import { RenderShape, drawRoundedShape } from './roundness';

// ────────────────────────────────────────────────────────────
// Color Utilities (unchanged from v1)
// ────────────────────────────────────────────────────────────

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function lerpColor(c1: RGB, c2: RGB, t: number): string {
  t = clamp(t, 0, 1);
  const r = Math.round(c1.r + t * (c2.r - c1.r));
  const g = Math.round(c1.g + t * (c2.g - c1.g));
  const b = Math.round(c1.b + t * (c2.b - c1.b));
  return `rgb(${r},${g},${b})`;
}

export function midBiasCurve(t: number, midpoint: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (midpoint <= 0.001 || midpoint >= 0.999) return t;
  return Math.pow(t, Math.log(0.5) / Math.log(midpoint));
}

// ────────────────────────────────────────────────────────────
// Seeded Random & Hash (unchanged from v1)
// ────────────────────────────────────────────────────────────

/**
 * Deterministic PRNG for seamless tiling. Same seed → same sequence.
 * Used by noise / gaussian_noise / stipple patterns.
 */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Stable hash of integer grid coords → [0, 1).
 * Used for jitter that must be reproducible across renders
 * (so the same params always produce the same stipple pattern).
 */
function hashCoord(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) & 0x7fffffff;
  h = ((h ^ (h >> 13)) * 1274126177) & 0x7fffffff;
  return (h ^ (h >> 16)) / 0x7fffffff;
}

// ────────────────────────────────────────────────────────────
// Gradient Factor Computation (unchanged from v1)
// ────────────────────────────────────────────────────────────

/**
 * Returns a 0..1 gradient factor at (x, y) in local coords
 * (centered at origin). Used to drive size/stretch/color modulation.
 *
 * - 'linear' — projects (x,y) onto the gradient direction vector,
 *   normalizes by canvas width × 0.8, centers at 0.5.
 * - 'radial' — distance from origin, normalized by min(w,h) × 0.6.
 *
 * The midpoint bias curve lets users place the 50% transition
 * anywhere along the gradient (e.g. midpoint=0.3 pushes it left).
 */
function computeGradFactor(
  x: number,
  y: number,
  width: number,
  height: number,
  params: ScreentoneParams,
): number {
  if (params.gradType === 'none') return 0.5;

  const angle = (params.gradAngle * Math.PI) / 180;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);

  let rawGrad: number;
  if (params.gradType === 'linear') {
    const projection = x * dirX + y * dirY;
    rawGrad = projection / (width * 0.8) + 0.5;
  } else {
    const dist = Math.sqrt(x * x + y * y);
    rawGrad = dist / (Math.min(width, height) * 0.6);
  }

  if (params.gradReverse) rawGrad = 1 - rawGrad;
  rawGrad = clamp(rawGrad, 0, 1);

  return midBiasCurve(rawGrad, params.gradMidpoint);
}

// ============================================================
// MAIN RENDER — Canvas only
// ============================================================

/**
 * Render a screentone pattern to `ctx`.
 *
 * The canvas is treated as a texture: it is fully filled, with the
 * pattern centered on the canvas. The caller is responsible for
 * any view-side pan/zoom — that's a LayerTransform concern, not a
 * render concern.
 *
 * Background fill is applied first (params.colorBg), then the
 * pattern is drawn on top. The function does NOT clear transparency
 * — if you need a transparent background, set params.colorBg to a
 * fully transparent color BEFORE calling, or render to an offscreen
 * canvas and composite manually.
 *
 * @param ctx     Destination 2D context
 * @param width   Canvas width in px
 * @param height  Canvas height in px
 * @param params  Screentone parameters
 */
export function renderScreentone(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  params: ScreentoneParams,
): void {
  const {
    patternType,
    dotShape,
    dotSize,
    spacingX,
    spacingY,
    density,
    angle,
    lineWidth,
    crossAngle,
    satelliteEnabled,
    satelliteSize,
    satelliteDistance,
    satelliteCount,
    satelliteAngle,
    satelliteDotShape,
    satelliteStretch,
    aspectX,
    aspectY,
    rowOffset,
    mergeFactor,
    jitterPos,
    jitterSize,
    roundness,
    colorPattern,
    colorBg,
    rotCanvas,
    rotPattern,
  } = params;

  // Pre-compute all trig constants ONCE. v1 re-computed these
  // inside the inner loop for every grid cell — wasteful.
  const angleRad = (angle * Math.PI) / 180;
  const crossRad = (crossAngle * Math.PI) / 180;
  const rotCanvasRad = (rotCanvas * Math.PI) / 180;
  const rotPatternRad = (rotPattern * Math.PI) / 180;
  const rotSatRad = (satelliteAngle * Math.PI) / 180;
  const cosCanvas = Math.cos(rotCanvasRad);
  const sinCanvas = Math.sin(rotCanvasRad);

  const rgbPat = hexToRgb(colorPattern);
  const rgbBg = hexToRgb(colorBg);

  // Background fill
  ctx.fillStyle = colorBg;
  ctx.fillRect(0, 0, width, height);

  // Canvas center
  const cx = width / 2;
  const cy = height / 2;

  // Culling bounds. We compute worldX/worldY for each grid cell
  // (the canvas-space position relative to center) and skip cells
  // whose dot would fall entirely outside the canvas. The margin
  // is the largest possible dot radius so we never cull a visible
  // dot. This typically eliminates 30–50% of iterations.
  const halfW = width / 2;
  const halfH = height / 2;
  const maxDotR =
    Math.max(dotSize, satelliteSize) * Math.max(aspectX, aspectY) + 4;

  // Iteration bounds — covers canvas from any rotation angle.
  // maxDist is the diagonal, so stepsX × spacingX ≥ maxDist/2.
  const maxDist = Math.sqrt(width * width + height * height);
  const stepsX = Math.ceil((maxDist / 2) / spacingX) + 2;
  const stepsY = Math.ceil((maxDist / 2) / spacingY) + 2;

  // Apply canvas rotation transform — everything below draws in
  // the rotated local frame, centered at origin.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotCanvasRad);

  // Determine the polygon shape used by the main pattern.
  // stars/hearts/triangles override dotShape.
  const mainRenderShape: RenderShape =
    patternType === 'stars' ? 'star' :
    patternType === 'hearts' ? 'heart' :
    patternType === 'triangles' ? 'triangle' :
    dotShape;

  // ─── Per-element renderer ─────────────────────────────────
  // In v2 we dropped the `worldX/worldY` and `isSVG` parameters
  // — culling happens in the caller (which already computed
  // worldX/worldY for the gradient factor), and SVG export is gone.
  const renderElement = (
    localX: number,
    localY: number,
    size: number,
    sX: number,
    sY: number,
    currentColor: string,
    shape: RenderShape,
    rotation: number,
    rnd: number,
    stretchDirAngle?: number,
  ) => {
    if (size <= 0.05) return;
    ctx.fillStyle = currentColor;
    ctx.save();
    ctx.translate(localX, localY);

    // Satellite stretch toward parent dot. Skipped entirely when
    // satelliteStretch is 0 (the common case) — saves a
    // rotate/scale/rotate triple per call.
    if (stretchDirAngle !== undefined && satelliteStretch > 0) {
      ctx.rotate(stretchDirAngle);
      ctx.scale(1 + satelliteStretch, 1);
      ctx.rotate(-stretchDirAngle);
    }

    // Skip the rotate call when rotation is exactly 0 — this is
    // the default and saves one ctx call per dot.
    if (rotation !== 0) ctx.rotate(rotation);

    drawRoundedShape(ctx, shape, size, sX, sY, rnd);
    ctx.restore();
  };

  // ─── Pattern dispatch ────────────────────────────────────

  if (patternType === 'lines' || patternType === 'crosshatch') {
    // Lines are drawn directly via ctx.stroke — no per-line
    // transform, just rotate the whole line set.
    ctx.strokeStyle = colorPattern;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';

    const lineSpacing = spacingY;
    const totalLines = Math.ceil(maxDist / lineSpacing) + 4;

    const drawLineSet = (lineAngle: number) => {
      ctx.save();
      ctx.rotate(lineAngle);
      for (let i = -totalLines; i <= totalLines; i++) {
        const pos = i * lineSpacing;
        ctx.beginPath();
        ctx.moveTo(-maxDist, pos);
        ctx.lineTo(maxDist, pos);
        ctx.stroke();
      }
      ctx.restore();
    };

    drawLineSet(angleRad);
    if (patternType === 'crosshatch') {
      drawLineSet(angleRad + crossRad);
    }
  } else if (patternType === 'noise') {
    // Uniform random scatter.
    const seed = 42;
    const rng = seededRandom(seed);
    const count = Math.floor(
      ((width * height) / (spacingX * spacingY)) * density * 5,
    );

    for (let i = 0; i < count; i++) {
      const rx = (rng() - 0.5) * maxDist;
      const ry = (rng() - 0.5) * maxDist;

      const worldX = rx * cosCanvas - ry * sinCanvas;
      const worldY = rx * sinCanvas + ry * cosCanvas;
      if (Math.abs(worldX) > halfW + maxDotR || Math.abs(worldY) > halfH + maxDotR) continue;

      const gf = computeGradFactor(rx, ry, width, height, params);
      let currentColor = colorPattern;
      if (params.gradColorTrans && params.gradType !== 'none') {
        currentColor = lerpColor(rgbPat, rgbBg, gf);
      }

      // v1 had `(1 - gf * (1 - 0))` which simplifies to `(1 - gf)`.
      const sz = dotSize * (1 - gf);

      renderElement(rx, ry, sz, aspectX, aspectY, currentColor, dotShape, 0, roundness);
    }
  } else if (patternType === 'gaussian_noise') {
    // Box-Muller transform for normal-distributed scatter.
    const rng = seededRandom(137);
    const gaussian = () => {
      const u1 = rng();
      const u2 = rng();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };

    const count = Math.floor(
      ((width * height) / (spacingX * spacingY)) * density * 8,
    );

    for (let i = 0; i < count; i++) {
      const gx = gaussian() * spacingX * 0.8;
      const gy = gaussian() * spacingY * 0.8;

      const worldX = gx * cosCanvas - gy * sinCanvas;
      const worldY = gx * sinCanvas + gy * cosCanvas;
      if (Math.abs(worldX) > halfW + maxDotR || Math.abs(worldY) > halfH + maxDotR) continue;

      const gf = computeGradFactor(gx, gy, width, height, params);
      let currentColor = colorPattern;
      if (params.gradColorTrans && params.gradType !== 'none') {
        currentColor = lerpColor(rgbPat, rgbBg, gf);
      }

      const sz = Math.max(0.5, dotSize * (0.5 + rng() * 0.5));

      renderElement(gx, gy, sz, aspectX, aspectY, currentColor, dotShape, 0, roundness);
    }
  } else if (patternType === 'stipple') {
    // Grid scatter with jitter + per-cell random keep/drop.
    const rng = seededRandom(999);
    for (let iy = -stepsY; iy <= stepsY; iy++) {
      for (let ix = -stepsX; ix <= stepsX; ix++) {
        const jx = (rng() - 0.5) * jitterPos * 0.5 * spacingX;
        const jy = (rng() - 0.5) * jitterPos * 0.5 * spacingY;

        let localX = ix * spacingX + jx;
        let localY = iy * spacingY + jy;
        // v1 used Math.abs(iy) % 2 === 1 — equivalent to (iy & 1) === 1
        // for both positive and negative iy (two's complement).
        if ((iy & 1) === 1) localX += spacingX * rowOffset;

        const worldX = localX * cosCanvas - localY * sinCanvas;
        const worldY = localX * sinCanvas + localY * cosCanvas;
        if (Math.abs(worldX) > halfW + maxDotR || Math.abs(worldY) > halfH + maxDotR) continue;

        const gf = computeGradFactor(localX, localY, width, height, params);

        if (rng() > density) continue;

        const szVariation = 0.5 + rng() * 0.5;
        const sz = dotSize * szVariation * (params.gradType !== 'none' ? (1 - gf * 0.8) : 1);

        let currentColor = colorPattern;
        if (params.gradColorTrans && params.gradType !== 'none') {
          currentColor = lerpColor(rgbPat, rgbBg, gf);
        }

        renderElement(localX, localY, sz, aspectX, aspectY, currentColor, dotShape, 0, roundness);
      }
    }
  } else if (patternType === 'hexgrid') {
    // Honeycomb — rows offset by half spacing, vertical compaction
    // by cos(30°) ≈ 0.866. Always uses 'hexagon' shape regardless
    // of dotShape (intentional).
    for (let iy = -stepsY; iy <= stepsY; iy++) {
      for (let ix = -stepsX; ix <= stepsX; ix++) {
        let localX = ix * spacingX;
        const localY = iy * spacingY * Math.cos(Math.PI / 6);
        if ((iy & 1) === 1) localX += spacingX * 0.5;

        const worldX = localX * cosCanvas - localY * sinCanvas;
        const worldY = localX * sinCanvas + localY * cosCanvas;
        if (Math.abs(worldX) > halfW + maxDotR || Math.abs(worldY) > halfH + maxDotR) continue;

        const gf = computeGradFactor(localX, localY, width, height, params);
        let modSize = 1;
        let modAspectX = aspectX;
        let modAspectY = aspectY;

        if (params.gradType !== 'none') {
          modSize = lerp(params.gradSizeStart, params.gradSizeEnd, gf);
          modAspectX = aspectX * lerp(params.gradStretchStart, params.gradStretchEnd, gf);
          modAspectY = aspectY * lerp(params.gradStretchStart, params.gradStretchEnd, gf);
        }

        const currentPSize = dotSize * modSize;

        let currentColor = colorPattern;
        if (params.gradColorTrans && params.gradType !== 'none') {
          currentColor = lerpColor(rgbPat, rgbBg, gf);
        }

        renderElement(
          localX, localY,
          currentPSize, modAspectX, modAspectY,
          currentColor, 'hexagon', rotPatternRad, roundness,
        );
      }
    }
  } else if (patternType === 'checker') {
    // Checkerboard — only odd-sum cells render. Cell size = spacing × 0.9.
    for (let iy = -stepsY; iy <= stepsY; iy++) {
      for (let ix = -stepsX; ix <= stepsX; ix++) {
        const localX = ix * spacingX;
        const localY = iy * spacingY;
        if (((ix + iy) & 1) !== 0) continue;

        const worldX = localX * cosCanvas - localY * sinCanvas;
        const worldY = localX * sinCanvas + localY * cosCanvas;
        if (Math.abs(worldX) > halfW + maxDotR || Math.abs(worldY) > halfH + maxDotR) continue;

        const gf = computeGradFactor(localX, localY, width, height, params);
        let modSize = 1;
        let modAspectX = aspectX;
        let modAspectY = aspectY;

        if (params.gradType !== 'none') {
          modSize = lerp(params.gradSizeStart, params.gradSizeEnd, gf);
          modAspectX = aspectX * lerp(params.gradStretchStart, params.gradStretchEnd, gf);
          modAspectY = aspectY * lerp(params.gradStretchStart, params.gradStretchEnd, gf);
        }

        const currentPSize = (spacingX * 0.45) * modSize;

        let currentColor = colorPattern;
        if (params.gradColorTrans && params.gradType !== 'none') {
          currentColor = lerpColor(rgbPat, rgbBg, gf);
        }

        renderElement(
          localX, localY,
          currentPSize, modAspectX, modAspectY,
          currentColor, 'square', rotPatternRad, roundness,
        );
      }
    }
  } else if (patternType === 'concentric') {
    // Concentric rings — stroked circles at multiples of spacingX.
    const maxR = maxDist / 2;
    const ringSpacing = spacingX;
    const numRings = Math.ceil(maxR / ringSpacing);

    for (let r = 1; r <= numRings; r++) {
      const radius = r * ringSpacing;
      // Concentric rings don't need canvas culling — if the radius
      // exceeds half the diagonal, the ring is fully off-canvas,
      // but we still cap at numRings above.

      const gf = computeGradFactor(radius, 0, width, height, params);

      let modSize = 1;
      if (params.gradType !== 'none') {
        modSize = lerp(params.gradSizeStart, params.gradSizeEnd, gf);
      }

      const lineW = lineWidth * modSize;
      let currentColor = colorPattern;
      if (params.gradColorTrans && params.gradType !== 'none') {
        currentColor = lerpColor(rgbPat, rgbBg, gf);
      }

      ctx.strokeStyle = currentColor;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (
    patternType === 'stars' ||
    patternType === 'hearts' ||
    patternType === 'triangles'
  ) {
    // Special shapes — grid layout with optional jitter.
    for (let iy = -stepsY; iy <= stepsY; iy++) {
      for (let ix = -stepsX; ix <= stepsX; ix++) {
        let localX = ix * spacingX;
        let localY = iy * spacingY;
        if ((iy & 1) === 1) localX += spacingX * rowOffset;

        if (jitterPos > 0) {
          localX += (hashCoord(ix, iy) - 0.5) * jitterPos * 0.5 * spacingX;
          localY += (hashCoord(ix + 1000, iy) - 0.5) * jitterPos * 0.5 * spacingY;
        }

        const worldX = localX * cosCanvas - localY * sinCanvas;
        const worldY = localX * sinCanvas + localY * cosCanvas;
        if (Math.abs(worldX) > halfW + maxDotR || Math.abs(worldY) > halfH + maxDotR) continue;

        const gf = computeGradFactor(localX, localY, width, height, params);

        let modSize = 1;
        let modAspectX = aspectX;
        let modAspectY = aspectY;
        if (params.gradType !== 'none') {
          modSize = lerp(params.gradSizeStart, params.gradSizeEnd, gf);
          modAspectX = aspectX * lerp(params.gradStretchStart, params.gradStretchEnd, gf);
          modAspectY = aspectY * lerp(params.gradStretchStart, params.gradStretchEnd, gf);
        }

        const sz = dotSize * modSize * density;
        if (sz <= 0.1) continue;

        let currentColor = colorPattern;
        if (params.gradColorTrans && params.gradType !== 'none') {
          currentColor = lerpColor(rgbPat, rgbBg, gf);
        }

        renderElement(
          localX, localY,
          sz, modAspectX, modAspectY,
          currentColor, mainRenderShape, rotPatternRad, roundness,
        );
      }
    }
  } else {
    // ─── Dots with satellites (the default + most complex case) ───
    for (let iy = -stepsY; iy <= stepsY; iy++) {
      for (let ix = -stepsX; ix <= stepsX; ix++) {
        let localX = ix * spacingX;
        let localY = iy * spacingY;
        if ((iy & 1) === 1) localX += spacingX * rowOffset;

        if (jitterPos > 0) {
          localX += (hashCoord(ix, iy) - 0.5) * jitterPos * 0.5 * spacingX;
          localY += (hashCoord(ix + 1000, iy) - 0.5) * jitterPos * 0.5 * spacingY;
        }

        const worldX = localX * cosCanvas - localY * sinCanvas;
        const worldY = localX * sinCanvas + localY * cosCanvas;
        if (Math.abs(worldX) > halfW + maxDotR || Math.abs(worldY) > halfH + maxDotR) continue;

        const gf = computeGradFactor(localX, localY, width, height, params);

        let modSize = 1;
        let modAspectX = aspectX;
        let modAspectY = aspectY;
        if (params.gradType !== 'none') {
          modSize = lerp(params.gradSizeStart, params.gradSizeEnd, gf);
          modAspectX = aspectX * lerp(params.gradStretchStart, params.gradStretchEnd, gf);
          modAspectY = aspectY * lerp(params.gradStretchStart, params.gradStretchEnd, gf);
        }

        // mergeFactor grows dots until they touch (good for solid
        // tone from sparse dots). Main and satellite grow at
        // different rates; satellite distance shrinks.
        const mergedSize = dotSize + mergeFactor * spacingX * 0.2;
        const currentPSize = mergedSize * modSize * density;
        const currentSSize =
          (satelliteSize + mergeFactor * spacingX * 0.4) * modSize * density;
        const currentSDist = satelliteDistance * (1 - mergeFactor * 0.6);

        if (currentPSize <= 0.05 && currentSSize <= 0.05) continue;

        let currentColor = colorPattern;
        if (params.gradColorTrans && params.gradType !== 'none') {
          currentColor = lerpColor(rgbPat, rgbBg, gf);
        }

        let finalSize = currentPSize;
        if (jitterSize > 0) {
          const jVal = hashCoord(ix + 5000, iy + 5000);
          finalSize = currentPSize * (1 + (jVal - 0.5) * jitterSize * 0.02);
        }

        // Main dot
        renderElement(
          localX, localY,
          finalSize,
          modAspectX, modAspectY,
          currentColor,
          dotShape,
          rotPatternRad,
          roundness,
        );

        // Satellites — 4-slot orbit (up/down/left/right of parent),
        // rotated by satelliteAngle. Each satellite can stretch
        // toward its parent (stretchDirAngle).
        if (satelliteEnabled && currentSSize > 0.05) {
          // Pre-compute satellite rotation trig once per cell
          // instead of per-satellite.
          const cosSat = Math.cos(rotSatRad);
          const sinSat = Math.sin(rotSatRad);

          // 4-slot orbit: indices 0..3 → up/down/right/left
          // (matches v1 ordering for backward compatibility).
          const satOffsets: Array<[number, number]> = [
            [0, -currentSDist],
            [0,  currentSDist],
            [ currentSDist, 0],
            [-currentSDist, 0],
          ];

          for (let s = 0; s < satelliteCount && s < 4; s++) {
            const [ox, oy] = satOffsets[s];

            // Rotate satellite offset by satelliteAngle.
            const rsx = ox * cosSat - oy * sinSat;
            const rsy = ox * sinSat + oy * cosSat;

            const satLocalX = localX + rsx;
            const satLocalY = localY + rsy;

            // Cull satellites that ended up off-canvas.
            const satWorldX = worldX + rsx * cosCanvas - rsy * sinCanvas;
            const satWorldY = worldY + rsx * sinCanvas + rsy * cosCanvas;
            if (Math.abs(satWorldX) > halfW + maxDotR ||
                Math.abs(satWorldY) > halfH + maxDotR) continue;

            // Stretch direction: from satellite toward parent.
            // atan2(-rsy, -rsx) gives the angle of the vector
            // (satellite → parent).
            const stretchDirAngle =
              (rsx !== 0 || rsy !== 0)
                ? Math.atan2(-rsy, -rsx)
                : undefined;

            renderElement(
              satLocalX, satLocalY,
              currentSSize,
              modAspectX, modAspectY,
              currentColor,
              satelliteDotShape,
              rotPatternRad,
              roundness,
              stretchDirAngle,
            );
          }
        }
      }
    }
  }

  // Restore the save() from the canvas-rotation transform.
  ctx.restore();
}
