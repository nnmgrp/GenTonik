// ============================================================
// ROUNDNESS — corner rounding for screentone dot shapes
// ============================================================
//
// Replaces the old Chaikin + morphToCircle combo that produced
// "bitten circle" artifacts when morphing squares/diamonds/hexagons.
//
// The new approach is the canvas equivalent of CSS `border-radius`:
// for each polygon vertex, step back/forward along the two adjacent
// edges by a fraction of the shorter edge, then connect the two
// step points with a single `quadraticCurveTo` whose control point
// is the original vertex. Result: smooth, symmetric, predictable
// corners that DON'T drift toward a circle unless you ask for it.
//
// Why this is better than Chaikin + morph:
//   • No vertex-count blow-up (Chaikin doubles vertices per iteration)
//   • One quadraticCurveTo per corner instead of N lineTo
//   • Doesn't drift toward a circle at low roundness values —
//     a square with roundness=0.3 still looks like a square with
//     soft corners, not a "bitten" octagon.
//   • Symmetric and idempotent: rounding twice == rounding once.
//   • CSS-like mental model: roundness=0 → sharp, roundness=1 →
//     corners touch edge midpoints.
//
// Public API:
//   • getShapeVertices(shape, size)    — moved here from engine.ts
//   • drawRoundedPolygon(ctx, verts, r) — low-level corner rounding
//   • drawRoundedShape(ctx, shape, ...) — high-level replacement
//                                         for the old drawShape()
// ============================================================

import { DotShape } from './types';

/**
 * All shape identifiers that the renderer can produce.
 *
 * `DotShape` covers the user-selectable shapes (circle/square/diamond/hexagon).
 * The extra three (star/heart/triangle) are used internally by pattern types
 * like 'stars', 'hearts', 'triangles'.
 */
export type RenderShape = DotShape | 'star' | 'heart' | 'triangle';

// ────────────────────────────────────────────────────────────
// Shape vertex tables
// ────────────────────────────────────────────────────────────

/**
 * Returns the polygon vertices for a shape, centered at origin.
 *
 * `size` is the "nominal radius" — the value the morph-to-circle
 * target uses. For most shapes the vertices land on or near a
 * circle of radius `size`; for `square` they're on a circle of
 * radius `size * 0.8 * √2 ≈ size * 1.13` (corners) and
 * `size * 0.8` (edge midpoints), which is intentional — it
 * matches how Deleter-style square screentones look.
 *
 * Returns `[]` for `'circle'` — the caller takes the arc fast-path
 * without consulting the vertex table.
 */
export function getShapeVertices(
  shape: RenderShape,
  size: number,
): [number, number][] {
  switch (shape) {
    case 'circle':
      // Caller should use ctx.arc() directly; no polygon needed.
      return [];

    case 'square': {
      // Inscribed in a box of half-side `size * 0.8`. The 0.8 factor
      // is historical — it makes square dots visually the same size
      // as circle dots at the same `size` parameter.
      const s = size * 0.8;
      return [[-s, -s], [s, -s], [s, s], [-s, s]];
    }

    case 'diamond':
      // Rhombus with vertices on the axes at distance `size`.
      return [[0, -size], [size, 0], [0, size], [-size, 0]];

    case 'hexagon': {
      // Flat-top hexagon, first vertex at angle -30°.
      const pts: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        pts.push([Math.cos(a) * size, Math.sin(a) * size]);
      }
      return pts;
    }

    case 'star': {
      // 5-pointed star, alternating outer/inner radius.
      // Outer = `size`, inner = `size * 0.4` (golden-ratio-ish).
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? size : size * 0.4;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return pts;
    }

    case 'triangle': {
      // Equilateral triangle, apex pointing up.
      return [
        [0, -size],
        [size * 0.866, size * 0.5],
        [-size * 0.866, size * 0.5],
      ];
    }

    case 'heart': {
      // Parametric heart curve, sampled at 28 points.
      // Scale chosen so the heart fits inside a circle of radius `size`.
      const pts: [number, number][] = [];
      const n = 28;
      const sc = size / 17;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        const x = sc * 16 * Math.pow(Math.sin(t), 3);
        const y = -sc * (
          13 * Math.cos(t)
          - 5 * Math.cos(2 * t)
          - 2 * Math.cos(3 * t)
          - Math.cos(4 * t)
        );
        pts.push([x, y]);
      }
      return pts;
    }

    default:
      return [];
  }
}

// ────────────────────────────────────────────────────────────
// Corner rounding — the core routine
// ────────────────────────────────────────────────────────────

/**
 * Draw a closed polygon with rounded corners.
 *
 * Algorithm (per vertex V_i, with prev P and next N):
 *   1. Compute edge vectors e1 = V − P and e2 = N − V.
 *   2. step = roundness × min(|e1|, |e2|) / 2
 *      (the /2 guarantees the arc from neighbouring corners never
 *       overlaps — at roundness=1 the two arcs on each edge meet
 *       exactly at the edge midpoint, CSS border-radius style).
 *   3. back-step  B_i = V − (e1/|e1|) × step   (on edge P→V)
 *      fwd-step   F_i = V + (e2/|e2|) × step   (on edge V→N)
 *   4. Path: moveTo(B_0); for each i: quadraticCurveTo(V_i, F_i);
 *            lineTo(B_{i+1}); closePath().
 *
 * The straight `lineTo` between F_i and B_{i+1} is correct because
 * both points lie on the same edge V_i → V_{i+1}.
 *
 * `roundness` semantics:
 *   • 0.0  — sharp corners (degenerates to a plain polygon)
 *   • 0.5  — corners eat half of each adjacent edge
 *   • 1.0  — corners eat the whole edge up to its midpoint;
 *             for a square this gives a "squircle"-ish shape
 *             (still not a true circle — see drawRoundedShape
 *             for the roundness≥0.95 → true circle fast-path).
 *
 * The caller is expected to have already set up fillStyle and any
 * transform (translate/scale/rotate). This function only builds
 * the path and calls `ctx.fill()`.
 *
 * @param ctx        Canvas 2D context
 * @param vertices   Closed polygon vertices (≥ 3 required)
 * @param roundness  0..1, fraction of the shorter adjacent edge
 *                   that each corner arc consumes
 */
export function drawRoundedPolygon(
  ctx: CanvasRenderingContext2D,
  vertices: [number, number][],
  roundness: number,
): void {
  const n = vertices.length;
  if (n < 3) return;

  // Clamp roundness to [0, 1]; ≤0 means sharp polygon.
  const r = Math.max(0, Math.min(1, roundness));
  if (r <= 0) {
    // Fast path: plain polygon, no bezier overhead.
    ctx.beginPath();
    ctx.moveTo(vertices[0][0], vertices[0][1]);
    for (let i = 1; i < n; i++) {
      ctx.lineTo(vertices[i][0], vertices[i][1]);
    }
    ctx.closePath();
    ctx.fill();
    return;
  }

  // Pre-compute back-step and forward-step for each vertex.
  // Allocating two arrays of length n is cheaper than recomputing
  // edge lengths twice per vertex inside the loop.
  const backs: [number, number][] = new Array(n);
  const fwds: [number, number][] = new Array(n);

  for (let i = 0; i < n; i++) {
    const prev = vertices[(i - 1 + n) % n];
    const curr = vertices[i];
    const next = vertices[(i + 1) % n];

    const e1x = curr[0] - prev[0];
    const e1y = curr[1] - prev[1];
    const e1len = Math.hypot(e1x, e1y) || 1e-6;

    const e2x = next[0] - curr[0];
    const e2y = next[1] - curr[1];
    const e2len = Math.hypot(e2x, e2y) || 1e-6;

    // step is limited by the SHORTER of the two adjacent edges,
    // so a corner never eats more than half of any edge — even
    // when its other edge is very long.
    const step = r * Math.min(e1len, e2len) * 0.5;

    const u1x = e1x / e1len;
    const u1y = e1y / e1len;
    const u2x = e2x / e2len;
    const u2y = e2y / e2len;

    backs[i] = [curr[0] - u1x * step, curr[1] - u1y * step];
    fwds[i]  = [curr[0] + u2x * step, curr[1] + u2y * step];
  }

  // Build path: start at back-step of vertex 0, then for each vertex
  // draw a quadraticCurveTo through it to its forward-step, then
  // lineTo to the next vertex's back-step (same edge, straight line).
  ctx.beginPath();
  ctx.moveTo(backs[0][0], backs[0][1]);
  for (let i = 0; i < n; i++) {
    const nextI = (i + 1) % n;
    // Corner arc: control point = original vertex, end = forward-step.
    ctx.quadraticCurveTo(
      vertices[i][0], vertices[i][1],
      fwds[i][0], fwds[i][1],
    );
    // Straight bridge to the next corner's back-step.
    // For the last vertex (i === n-1), nextI === 0 and closePath()
    // below will handle the bridge back to the start — so skip it.
    if (nextI !== 0) {
      ctx.lineTo(backs[nextI][0], backs[nextI][1]);
    }
  }
  ctx.closePath();
  ctx.fill();
}

// ────────────────────────────────────────────────────────────
// High-level shape drawing (replacement for old drawShape)
// ────────────────────────────────────────────────────────────

/**
 * Draw a single screentone dot at the origin (caller handles translate).
 *
 * Replaces the old `drawShape()` from engine.ts v1.
 *
 * Decision tree:
 *   1. size ≤ 0                              → no-op
 *   2. shape === 'circle'                    → ctx.arc (true circle)
 *   3. roundness ≥ 0.95 (any polygon shape)  → ctx.arc with radius=size
 *                                                (this is what the old
 *                                                 morphToCircle was
 *                                                 approximating at r=1)
 *   4. roundness ≤ 0                         → plain polygon
 *   5. 0 < roundness < 0.95                  → drawRoundedPolygon
 *
 * Stretch is applied via ctx.scale — same as v1.
 *
 * @param ctx        Canvas 2D context
 * @param shape      Shape identifier (circle/square/diamond/hexagon/star/...)
 * @param size       Nominal radius (matches v1 semantics)
 * @param stretchX   Horizontal scale (aspectX, satellite stretch, etc.)
 * @param stretchY   Vertical scale (aspectY, satellite stretch, etc.)
 * @param roundness  0..1, see drawRoundedPolygon for semantics
 */
export function drawRoundedShape(
  ctx: CanvasRenderingContext2D,
  shape: RenderShape,
  size: number,
  stretchX: number,
  stretchY: number,
  roundness: number,
): void {
  if (size <= 0) return;

  // Normalize roundness once.
  const r = Math.max(0, Math.min(1, roundness));

  ctx.save();
  ctx.scale(stretchX, stretchY);

  // True-circle fast-paths. Both `circle` shape (regardless of roundness)
  // and any polygon shape with roundness ≥ 0.95 end up here. The arc
  // radius is `size` — this matches the v1 morphToCircle target.
  if (shape === 'circle' || r >= 0.95) {
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const vertices = getShapeVertices(shape, size);
  if (vertices.length < 3) {
    // Unknown / degenerate shape — fall back to a circle of radius `size`.
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  drawRoundedPolygon(ctx, vertices, r);
  ctx.restore();
}
