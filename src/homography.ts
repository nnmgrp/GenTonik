// ============================================================
// HOMOGRAPHY — 4-point perspective transform for GenToniK v2
// ============================================================
//
// Provides:
//   • computeHomography(src[4], dst[4]) → Mat3 | null
//       Solves the 8×8 linear system for the 3×3 homography
//       mapping src quad → dst quad (DLT with h33=1 normalization).
//
//   • applyHomography(H, p) → Vec2
//       Forward-transform a point through H (with dehomogenization).
//
//   • invertHomography(H) → Mat3 | null
//       3×3 matrix inverse via adjugate / determinant.
//
//   • affineFromTriangle(src[3], dst[3]) → [a,b,c,d,e,f] | null
//       Computes the 2×3 affine matrix mapping one triangle to
//       another. Used by the perspective renderer to draw each
//       sub-triangle via ctx.setTransform + clip + drawImage.
//
//   • pointInQuad(p, quad[4]) → boolean
//       Cross-product test for point-in-convex-quad.
//
// Mat3 layout (row-major, 9 elements):
//   H = [ h11 h12 h13
//         h21 h22 h23
//         h31 h32 h33 ]
//   stored as [h11, h12, h13, h21, h22, h23, h31, h32, h33]
//
// Forward map: (x, y) → (u, v)
//   u = (h11*x + h12*y + h13) / w
//   v = (h21*x + h22*y + h23) / w
//   w =  h31*x + h32*y + h33
//
// All functions are pure and allocation-free where possible.
// ============================================================

export interface Vec2 { x: number; y: number; }

/**
 * 3×3 matrix in row-major order: [h11, h12, h13, h21, h22, h23, h31, h32, h33].
 */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

// ────────────────────────────────────────────────────────────
// LINEAR SYSTEM SOLVER (Gaussian elimination with partial pivot)
// ────────────────────────────────────────────────────────────

/**
 * Solve A·x = b for x, where A is n×n and b is length n.
 * Returns null if A is singular.
 *
 * Standard Gaussian elimination with partial pivoting for numerical
 * stability.  O(n³) — fine for n ≤ 16.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  if (n === 0 || b.length !== n) return null;

  // Augment A with b: each row becomes [a0, a1, ..., a_{n-1}, b_i]
  const M: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let i = 0; i < n; i++) {
    // Partial pivot: find row with largest |M[k][i]|, swap.
    let maxRow = i;
    let maxAbs = Math.abs(M[i][i]);
    for (let k = i + 1; k < n; k++) {
      const v = Math.abs(M[k][i]);
      if (v > maxAbs) { maxAbs = v; maxRow = k; }
    }
    if (maxAbs < 1e-12) return null; // singular
    if (maxRow !== i) {
      const tmp = M[i]; M[i] = M[maxRow]; M[maxRow] = tmp;
    }

    // Eliminate below
    const pivot = M[i][i];
    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / pivot;
      if (factor === 0) continue;
      for (let j = i; j <= n; j++) {
        M[k][j] -= factor * M[i][j];
      }
    }
  }

  // Back-substitute
  const x: number[] = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }
  return x;
}

// ────────────────────────────────────────────────────────────
// HOMOGRAPHY
// ────────────────────────────────────────────────────────────

/**
 * Compute the homography H mapping src[4] → dst[4].
 *
 * Each src point (x, y) maps to the corresponding dst point (u, v):
 *   u = (h11*x + h12*y + h13) / (h31*x + h32*y + h33)
 *   v = (h21*x + h22*y + h23) / (h31*x + h32*y + h33)
 *
 * Setting h33 = 1 (valid for non-degenerate quads where the
 * dst origin doesn't map to infinity), we get 8 unknowns and
 * 8 equations (2 per correspondence × 4 correspondences).
 *
 * The linear system per correspondence (x, y) → (u, v) is:
 *   x·h11 + y·h12 + h13 - u·x·h31 - u·y·h32 = u
 *   x·h21 + y·h22 + h23 - v·x·h31 - v·y·h32 = v
 *
 * Returns null if the quad is degenerate (three points collinear,
 * or system singular).
 */
export function computeHomography(
  src: readonly [Vec2, Vec2, Vec2, Vec2],
  dst: readonly [Vec2, Vec2, Vec2, Vec2],
): Mat3 | null {
  // Build 8×8 system: unknowns = [h11, h12, h13, h21, h22, h23, h31, h32]
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    // Equation for u:
    //   h11·x + h12·y + h13 + 0 + 0 + 0 - h31·u·x - h32·u·y = u
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    // Equation for v:
    //   0 + 0 + 0 + h21·x + h22·y + h23 - h31·v·x - h32·v·y = v
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const sol = solveLinearSystem(A, b);
  if (!sol) return null;

  const [h11, h12, h13, h21, h22, h23, h31, h32] = sol;
  // Sanity check: h33 = 1; if the system implies h33 ≈ 0 (point at
  // infinity), the homography is degenerate.
  // We also verify by re-applying to src[0] and checking it maps
  // close to dst[0].
  const H: Mat3 = [h11, h12, h13, h21, h22, h23, h31, h32, 1];
  const check = applyHomography(H, src[0]);
  const dx = check.x - dst[0].x;
  const dy = check.y - dst[0].y;
  if (Math.hypot(dx, dy) > 1.0) {
    // Numerical instability — reject.
    return null;
  }
  return H;
}

/**
 * Apply homography H to point p. Returns the dehomogenized (x, y).
 *
 * If w (the homogeneous coordinate) is near zero (point maps to
 * infinity), returns (0, 0) — callers should avoid this case by
 * validating the quad before calling.
 */
export function applyHomography(H: Mat3, p: Vec2): Vec2 {
  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = H;
  const x = h11 * p.x + h12 * p.y + h13;
  const y = h21 * p.x + h22 * p.y + h23;
  const w = h31 * p.x + h32 * p.y + h33;
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return { x: x / w, y: y / w };
}

/**
 * Compute the inverse of a 3×3 homography matrix.
 *
 * Uses the adjugate / determinant formula:
 *   H⁻¹ = adj(H) / det(H)
 *
 * Returns null if det(H) ≈ 0 (singular matrix).
 */
export function invertHomography(H: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  // Cofactors
  const A =  (e * i - f * h);
  const B = -(d * i - f * g);
  const C =  (d * h - e * g);
  const D = -(b * i - c * h);
  const E =  (a * i - c * g);
  const F = -(a * h - b * g);
  const G =  (b * f - c * e);
  const Hh = -(a * f - c * d);
  const I =  (a * e - b * d);
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  // Adjugate = transpose of cofactor matrix → already arranged
  return [
    A * invDet, D * invDet, G * invDet,
    B * invDet, E * invDet, Hh * invDet,
    C * invDet, F * invDet, I * invDet,
  ];
}

// ────────────────────────────────────────────────────────────
// TRIANGLE AFFINE (for perspective subdivision rendering)
// ────────────────────────────────────────────────────────────

/**
 * Compute the 2×3 affine matrix [a, b, c, d, e, f] mapping src
 * triangle to dst triangle, in Canvas2D setTransform convention:
 *
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 *
 * i.e. (x, y) → (a·x + c·y + e, b·x + d·y + f)
 *
 * Returns null if the src triangle is degenerate (zero area).
 *
 * Derivation:
 *   We want M such that M·s_k = d_k for k = 1, 2, 3.
 *   Subtracting eq1 from eq2 and eq3 gives a 2×2 system for (a, c)
 *   and another for (b, d); then e = d1.x - a·s1.x - c·s1.y, etc.
 */
export function affineFromTriangle(
  src: readonly [Vec2, Vec2, Vec2],
  dst: readonly [Vec2, Vec2, Vec2],
): [number, number, number, number, number, number] | null {
  const [s1, s2, s3] = src;
  const [d1, d2, d3] = dst;

  const dx21 = s2.x - s1.x;
  const dy21 = s2.y - s1.y;
  const dx31 = s3.x - s1.x;
  const dy31 = s3.y - s1.y;
  const det = dx21 * dy31 - dx31 * dy21;
  if (Math.abs(det) < 1e-10) return null;
  const invDet = 1 / det;

  // Solve for a, c (maps src → dst.x):
  //   a·dx21 + c·dy21 = d2.x - d1.x   (= du21x)
  //   a·dx31 + c·dy31 = d3.x - d1.x   (= du31x)
  const du21x = d2.x - d1.x;
  const du31x = d3.x - d1.x;
  const a = (du21x * dy31 - du31x * dy21) * invDet;
  const c = (dx21 * du31x - dx31 * du21x) * invDet;
  const e = d1.x - a * s1.x - c * s1.y;

  // Solve for b, d (maps src → dst.y):
  const du21y = d2.y - d1.y;
  const du31y = d3.y - d1.y;
  const b = (du21y * dy31 - du31y * dy21) * invDet;
  const d = (dx21 * du31y - dx31 * du21y) * invDet;
  const f = d1.y - b * s1.x - d * s1.y;

  return [a, b, c, d, e, f];
}

// ────────────────────────────────────────────────────────────
// POINT-IN-QUAD TEST
// ────────────────────────────────────────────────────────────

/**
 * Test whether a point is inside a convex quad (4 vertices).
 *
 * Uses the cross-product sign test: for a convex polygon, the
 * point is inside iff it's on the same side of all 4 edges.
 *
 * For non-convex quads (which can happen with extreme perspective
 * deformation), this test may give wrong results — but for typical
 * perspective transforms the quad remains convex.
 *
 * Vertex order: [TL, TR, BR, BL] (or any consistent winding).
 */
export function pointInQuad(p: Vec2, quad: readonly [Vec2, Vec2, Vec2, Vec2]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const cross = ex * (p.y - a.y) - ey * (p.x - a.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// QUAD UTILITIES
// ────────────────────────────────────────────────────────────

/**
 * Compute the axis-aligned bounding box of a quad.
 * Returns { left, top, right, bottom, width, height }.
 */
export function quadBounds(quad: readonly [Vec2, Vec2, Vec2, Vec2]): {
  left: number; top: number; right: number; bottom: number;
  width: number; height: number;
} {
  const xs = [quad[0].x, quad[1].x, quad[2].x, quad[3].x];
  const ys = [quad[0].y, quad[1].y, quad[2].y, quad[3].y];
  const left   = Math.min(...xs);
  const top    = Math.min(...ys);
  const right  = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Compute the signed area of a quad (shoelace formula).
 * Positive = counter-clockwise, negative = clockwise.
 *
 * Used to detect degenerate (zero-area) quads and to normalize
 * winding order if needed.
 */
export function quadSignedArea(quad: readonly [Vec2, Vec2, Vec2, Vec2]): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/**
 * Check if a quad is degenerate (any 3 points collinear, or zero area).
 *
 * Used to reject invalid perspective states before computing homography.
 */
/**
 * Check if a quad is degenerate (any 3 points collinear, or zero area)
 * OR non-convex / self-intersecting (butterfly / hourglass shape).
 * A3-fix-1: convexity check via cross-product sign consistency.
 */
export function isQuadDegenerate(quad: readonly [Vec2, Vec2, Vec2, Vec2]): boolean {
  if (Math.abs(quadSignedArea(quad)) < 1) return true;
  let firstSign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) < 1) return true;
    const sign = cross > 0 ? 1 : -1;
    if (firstSign === 0) firstSign = sign;
    else if (firstSign !== sign) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// BUG-4 FIX: Self-intersecting quad normalization
// ─────────────────────────────────────────────────────────────

/**
 * Check if two line segments AB and CD intersect (proper intersection).
 */
function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cross = (o: Vec2, p: Vec2, q: Vec2) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

/**
 * Normalize a self-intersecting quad (butterfly/hourglass) by swapping
 * the crossed corners. If the quad is already convex, returns it unchanged.
 */
export function normalizeCorners(quad: readonly [Vec2, Vec2, Vec2, Vec2]): [Vec2, Vec2, Vec2, Vec2] {
  const [a, b, c, d] = quad;
  // Check diagonals a-c (TL-BR) and b-d (TR-BL). If they cross, swap TR and BL.
  if (segmentsIntersect(a, c, b, d)) {
    return [a, d, c, b];
  }
  return [a, b, c, d];
}

// ────────────────────────────────────────────────────────────
// BILINEAR INTERPOLATION (alternative to homography for rendering)
// ────────────────────────────────────────────────────────────

/**
 * Bilinear interpolation between 4 corner points.
 *
 * Given a quad [TL, TR, BR, BL] and a normalized coordinate
 * (u, v) where (0,0) = TL, (1,0) = TR, (1,1) = BR, (0,1) = BL,
 * returns the interpolated point.
 *
 * This is NOT perspective-correct (it doesn't account for depth),
 * but it's faster than homography and visually similar for mild
 * deformations. Used as a fallback if homography fails.
 */
export function bilinearSample(
  quad: readonly [Vec2, Vec2, Vec2, Vec2],
  u: number,
  v: number,
): Vec2 {
  const [tl, tr, br, bl] = quad;
  const top    = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bottom = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return {
    x: top.x + (bottom.x - top.x) * v,
    y: top.y + (bottom.y - top.y) * v,
  };
}

// ────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────
//
// Types:
//   Vec2                 — { x: number; y: number }
//   Mat3                 — readonly 9-tuple (row-major 3×3)
//
// Linear algebra:
//   solveLinearSystem    — internal (Gaussian elimination)
//   computeHomography    — 4-point DLT
//   applyHomography      — forward map
//   invertHomography     — 3×3 inverse
//   affineFromTriangle   — 3-point affine for Canvas2D setTransform
//
// Geometry:
//   pointInQuad          — convex quad containment
//   quadBounds           — AABB of a quad
//   quadSignedArea       — shoelace area (sign = winding)
//   isQuadDegenerate     — validity check
//   bilinearSample       — non-perspective-correct quad interp
//
// ============================================================
