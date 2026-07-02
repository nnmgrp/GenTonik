// ============================================================
// gl-matrix.ts — convert affine Matrix + homography Mat3 to GLSL
// ============================================================
//
// GLSL conventions:
//   • mat3 is column-major. Setting via uniformMatrix3fv(..., false, ...)
//     means the JS array is interpreted as 3 columns of 3 elements:
//       [col0.x, col0.y, col0.z, col1.x, col1.y, col1.z, col2.x, col2.y, col2.z]
//   • For a 2D affine transform in a mat3, we put:
//       | a c e |
//       | b d f |    →    in mat3 form (with homogeneous row [0 0 1])
//       | 0 0 1 |
//     column-major array = [a, b, 0,  c, d, 0,  e, f, 1]
//
//   • vec2 transformed by mat3:  v' = M * vec3(v, 1)
//     In GLSL:  vec3 result = M * vec3(position, 1.0);
//              vec2 screenPos = result.xy / result.w;  (but mat3 doesn't have .w;
//              for true perspective we use mat4 — see toPerspectiveMat4)
//
// For perspective (homography) we need a mat3 with the full 9 entries
// (no w-division happens automatically in mat3*vec3 — the shader must
// divide by result.z explicitly). So for the perspective path:
//   H = [h11 h12 h13
//        h21 h22 h23
//        h31 h32 h33]
//   column-major array = [h11, h21, h31,  h12, h22, h32,  h13, h23, h33]
//   GLSL:  vec3 hp = H * vec3(localPos, 1.0);
//          vec2 screenPos = hp.xy / hp.z;
// ============================================================

import type { Matrix } from '../transform-matrix';
import type { Mat3 } from '../homography';

/**
 * Convert an affine Matrix [a,b,c,d,e,f] to a 9-element Float32Array
 * suitable for `gl.uniformMatrix3fv(loc, false, arr)`.
 *
 * The resulting mat3 is:
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 *
 * In column-major order: [a, b, 0,  c, d, 0,  e, f, 1]
 *
 * In GLSL, transforming a point: `vec3 r = M * vec3(p, 1.0); vec2 out = r.xy;`
 * (No perspective divide needed because the third row is [0,0,1] — r.z = 1.)
 */
export function affineToMat3Array(m: Matrix): Float32Array {
  const [a, b, c, d, e, f] = m;
  return new Float32Array([
    a, b, 0,
    c, d, 0,
    e, f, 1,
  ]);
}

/**
 * Convert a homography Mat3 (row-major 9-tuple from homography.ts) to a
 * 9-element Float32Array in column-major order for GLSL mat3.
 *
 * Source layout (row-major):
 *   H = [ h11 h12 h13
 *         h21 h22 h23
 *         h31 h32 h33 ]
 *   stored as [h11, h12, h13, h21, h22, h23, h31, h32, h33]
 *
 * Column-major output:
 *   [h11, h21, h31,  h12, h22, h32,  h13, h23, h33]
 *
 * In GLSL, transforming a point with perspective divide:
 *   vec3 hp = H * vec3(p, 1.0);
 *   vec2 screen = hp.xy / hp.z;
 */
export function homographyToMat3Array(H: Mat3): Float32Array {
  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = H;
  return new Float32Array([
    h11, h21, h31,
    h12, h22, h32,
    h13, h23, h33,
  ]);
}

/**
 * Build an orthographic projection matrix mapping canvas-pixel
 * coordinates [0..w, 0..h] → clip space [-1..1].
 *
 * Used as the "view projection" uniform in the composite vertex
 * shader: layers' screen positions are in canvas-pixel space, and
 * the projection converts them to GL clip space.
 *
 * Result is a 9-element column-major mat3:
 *   | 2/w   0    -1 |
 *   |  0   2/h   -1 |
 *   |  0    0     1 |
 *
 * (Y is NOT flipped — we render with gl.viewport y-axis pointing up,
 *  and the vertex shader flips y in the composite pass to match the
 *  canvas2D top-left origin convention used throughout GenTonik.)
 */
export function orthoCanvasProjection(w: number, h: number): Float32Array {
  if (w <= 0 || h <= 0) return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const sx = 2 / w;
  const sy = 2 / h;
  return new Float32Array([
    sx,  0,   0,
    0,   sy,  0,
    -1, -1,   1,
  ]);
}

/**
 * Combined "screen → clip" matrix for the composite pass.
 *
 * Multiplies the ortho projection (canvas-pixel → clip) by the
 * layer's forward matrix (local → canvas-pixel). The result
 * transforms local coordinates directly to clip space in the
 * vertex shader.
 *
 * For perspective layers, use homographyScreenToClip instead —
 * perspective divide must happen in the shader, so we keep the
 * matrices separate.
 */
export function affineScreenToClip(
  layerMatrix: Matrix,
  canvasW: number,
  canvasH: number,
): Float32Array {
  // Both matrices are mat3. Multiply on the CPU (cheap, once per layer).
  // M_combined = M_ortho * M_layer  (i.e., apply M_layer first, then M_ortho)
  //
  // We do this by composing the 9-element arrays directly.
  // To keep things simple and avoid writing our own mat3×mat3 here,
  // we use the transform-matrix.ts multiply() on 6-element affines
  // and re-convert — but that loses the ortho's translation. So we
  // do a real 3×3 multiply below.
  //
  // Column-major convention: A * B = result, where each is 9 floats.
  //   A's column j = A[j*3 .. j*3+2]
  //   result[col j, row i] = sum_k A[k*3 + i] * B[j*3 + k]
  const layerM = affineToMat3Array(layerMatrix); // local → canvas
  const ortho = orthoCanvasProjection(canvasW, canvasH); // canvas → clip

  const out = new Float32Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += ortho[k * 3 + row] * layerM[col * 3 + k];
      }
      out[col * 3 + row] = sum;
    }
  }
  return out;
}

/**
 * For perspective layers: pass the homography as a mat3 uniform
 * (local → canvas-pixel) AND the ortho projection as a separate
 * mat3 uniform (canvas-pixel → clip). The vertex shader does:
 *   vec3 canvasPos = H * vec3(localPos, 1.0);
 *   vec3 clip = ortho * vec3(canvasPos.xy / canvasPos.z, 1.0);
 *
 * Returns both matrices as Float32Arrays for upload.
 */
export function perspectiveMatricesForUpload(
  H: Mat3,
  canvasW: number,
  canvasH: number,
): { homography: Float32Array; ortho: Float32Array } {
  return {
    homography: homographyToMat3Array(H),
    ortho: orthoCanvasProjection(canvasW, canvasH),
  };
}
