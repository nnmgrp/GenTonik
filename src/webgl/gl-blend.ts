// ============================================================
// gl-blend.ts — GLSL blend functions for the 6 supported BlendModes
// ============================================================
//
// All blend functions operate on premultiplied-alpha RGBA colors.
// Convention: src = incoming layer color (premultiplied), dst = current
// destination color (premultiplied). The result is also premultiplied.
//
// For non-premultiplied blend math (the textbook Porter-Duff +
// separable blend formulas), we un-premultiply src and dst by their
// alpha, apply the blend, then re-premultiply. This is the standard
// approach used by Skia, Cairo, and the W3C compositing spec.
//
// BLEND MODES (matching composite.ts blendToCompositeOp):
//   • normal   → src over dst (Porter-Duff "source-over")
//   • multiply → src * dst (per-channel, then re-premultiply)
//   • screen   → 1 - (1-src) * (1-dst)
//   • overlay  → multiply if dst<0.5 else screen (per-channel)
//   • darken   → min(src, dst) (per-channel)
//   • lighten  → max(src, dst) (per-channel)
//
// The "normal" mode is handled by the GL blend stage (gl.BLEND with
// ONE/ONE_MINUS_SRC_ALPHA), not by the shader. The other 5 require
// reading dst, so we render those into the destination FBO with
// gl.BLEND disabled and let the shader do the math.
// ============================================================

import type { BlendMode } from '../types';

/**
 * GLSL source code declaring the blend function `vec4 blend(vec4 src, vec4 dst)`.
 *
 * Insert this string into a fragment shader that needs advanced blending.
 * The shader must already have `src` (current layer's premultiplied RGBA)
 * and `dst` (texture sample of the current destination FBO at the same pixel).
 *
 * For the 'normal' blend mode, no shader work is needed — the caller
 * uses GL's fixed-function blending.
 */
export const BLEND_GLSL = /* glsl */ `
// Un-premultiply: divide RGB by alpha, clamped to avoid div-by-zero.
vec3 unpremult(vec4 c) {
  if (c.a <= 0.0) return vec3(0.0);
  return clamp(c.rgb / c.a, 0.0, 1.0);
}

// Re-premultiply: RGB * alpha.
vec4 premult(vec3 rgb, float a) {
  return vec4(rgb * a, a);
}

// Per-channel blend modes (operate on un-premultiplied RGB).
vec3 blendMultiply(vec3 s, vec3 d) { return s * d; }
vec3 blendScreen(vec3 s, vec3 d)  { return 1.0 - (1.0 - s) * (1.0 - d); }
vec3 blendOverlay(vec3 s, vec3 d) {
  return mix(
    2.0 * s * d,
    1.0 - 2.0 * (1.0 - s) * (1.0 - d),
    step(0.5, d)   // 0 if d<0.5 (use multiply), 1 if d>=0.5 (use screen)
  );
}
vec3 blendDarken(vec3 s, vec3 d)  { return min(s, d); }
vec3 blendLighten(vec3 s, vec3 d) { return max(s, d); }

// Main entry: takes premultiplied src and dst, returns premultiplied result.
//
// mode: 0=normal, 1=multiply, 2=screen, 3=overlay, 4=darken, 5=lighten
// For mode=0, the caller should use GL fixed-function blending — but we
// still provide a correct implementation here for completeness (used when
// the shader must read dst for some other reason).
vec4 blendPremultiplied(vec4 srcPremult, vec4 dstPremult, int mode) {
  // Fast path: if src is fully transparent, return dst unchanged.
  if (srcPremult.a <= 0.0) return dstPremult;
  // If dst is fully transparent, return src for all modes (they reduce
  // to src over empty when dst.a = 0).
  if (dstPremult.a <= 0.0) return srcPremult;

  // Un-premultiply for blend math.
  vec3 s = unpremult(srcPremult);
  vec3 d = unpremult(dstPremult);

  // Apply the selected separable blend (except normal — see below).
  vec3 blendedRGB;
  if (mode == 1)      blendedRGB = blendMultiply(s, d);
  else if (mode == 2) blendedRGB = blendScreen(s, d);
  else if (mode == 3) blendedRGB = blendOverlay(s, d);
  else if (mode == 4) blendedRGB = blendDarken(s, d);
  else if (mode == 5) blendedRGB = blendLighten(s, d);
  else                blendedRGB = s; // mode == 0 (normal): RGB unchanged.

  // Compositing formula (Porter-Duff source-over with the blended src):
  //   out_a = src_a + dst_a * (1 - src_a)
  //   out_rgb = (src_a * blended_src_rgb + dst_a * (1 - src_a) * dst_rgb) / out_a
  float srcA = srcPremult.a;
  float dstA = dstPremult.a;
  float outA = srcA + dstA * (1.0 - srcA);
  if (outA <= 0.0) return vec4(0.0);
  vec3 outRGB = (srcA * blendedRGB + dstA * (1.0 - srcA) * d) / outA;
  return premult(outRGB, outA);
}
`;

/**
 * Numeric mode ID for each BlendMode, matching the GLSL switch above.
 * Used as the `u_blendMode` uniform.
 */
export function blendModeToGLSLId(mode: BlendMode): number {
  switch (mode) {
    case 'normal':   return 0;
    case 'multiply': return 1;
    case 'screen':   return 2;
    case 'overlay':  return 3;
    case 'darken':   return 4;
    case 'lighten':  return 5;
  }
}

/**
 * Does the given blend mode require reading the destination framebuffer?
 * (If false, the caller can use GL fixed-function blending for 'normal'.)
 *
 * For all non-normal modes, we need to sample dst in the shader — which
 * means we have to bind the current destination as a texture and do the
 * blend math manually. This is the so-called "back-buffer read" pattern.
 *
 * Implementation note: in WebGL2 we can't directly sample the default
 * framebuffer. That's why we always render into destFBO (not the visible
 * canvas) — so we can bind destTexture as a sampler when blending.
 */
export function blendModeNeedsDstRead(mode: BlendMode): boolean {
  return mode !== 'normal';
}
