// ============================================================
// render-layer-gl.ts — render a single layer's content into an FBO
// ============================================================
//
// This is the GL analog of composite.ts's renderLayerContent +
// applyMask. The result is a layer FBO (offscreen) containing the
// layer's content with mask applied, in premultiplied alpha form,
// ready for the composite pass.
//
// LAYER TYPE DISPATCH:
//
//   • solid       → SOLID_FILL program, single draw call.
//   • image       → IMAGE_UPLOAD program, samples an uploaded texture.
//   • screentone  → SCREENTONE program (GLSL procedural) for the 4
//                   ported pattern types (dots, lines, crosshatch, checker).
//                   For the other 8 pattern types, HYBRID path: render
//                   via CPU renderScreentone to a 2D canvas, upload as
//                   texture, draw via IMAGE_UPLOAD.
//
// MASK APPLICATION:
//
//   • shape       → MASK_SHAPE program, second draw call into the same
//                   FBO. Reads dst, multiplies alpha by the shape coverage.
//   • painted     → MASK_PAINTED program, similar second pass. Mask
//                   texture is uploaded from the Uint8Array alpha data.
//
// HYBRID SCREENTONE NOTE:
//   The CPU renderScreentone is called from engine.ts and produces a
//   canvas2D-rendered pattern. We upload it as a texture, which is the
//   "upload-as-texture" pattern documented in the worklog. This is
//   temporary — when all 12 pattern types are ported to GLSL, the
//   hybrid path can be removed.
// ============================================================

import * as twgl from 'twgl.js';
import type { GLState } from './gl-context';
import { getProgram, acquireLayerFBO, bindLayerFBO, getImageTexture, uploadCanvasAsTexture, uploadPaintedMaskAsTexture } from './gl-resources';
import { hexToRgb } from '../engine'; // for color parsing
import type { Layer, ScreentoneParams, LayerMask, DotShape, PatternType } from '../types';
import type { ImageCache } from '../composite';
import { renderScreentone } from '../engine';
import { BLEND_GLSL } from './gl-blend'; // (kept for reference; not used here)

// ────────────────────────────────────────────────────────────
// Pattern type ID mapping (must match GLSL switch in SCREENTONE_FRAG)
// ────────────────────────────────────────────────────────────

const PATTERN_TYPE_ID: Record<string, number> = {
  dots: 0,
  lines: 1,
  crosshatch: 2,
  checker: 3,
};

const DOT_SHAPE_ID: Record<DotShape, number> = {
  circle: 0,
  square: 1,
  diamond: 2,
  hexagon: 3,
};

/**
 * Returns true if the given pattern type has a GLSL implementation.
 * Otherwise the caller uses the hybrid CPU→texture path.
 */
export function isScreentonePatternPorted(p: PatternType): boolean {
  return p in PATTERN_TYPE_ID;
}

// ────────────────────────────────────────────────────────────
// Color helper: hex → premultiplied vec4
// ────────────────────────────────────────────────────────────

function hexToPremultVec4(hex: string): [number, number, number, number] {
  // Accept "#RRGGBB", "#RRGGBBAA", or "rgb(r,g,b)".
  // Default to opaque black on parse failure.
  //
  // Returns PREMULTIPLIED RGBA: (r*a, g*a, b*a, a).
  // The SCREENTONE_FRAG shader's u_colorBg and u_colorPattern are
  // documented as premultiplied. mix() of two premultiplied colors
  // gives correct premultiplied output, and the shader outputs
  // result directly (no post-multiplication step).
  //
  // FIX (2026-06-27): previously this function returned UN-premultiplied
  // (r, g, b, a) despite the name and GLSL comments saying "premultiplied".
  // Combined with the shader's vec4(result.rgb * result.a, result.a) at the
  // end, this caused DOUBLE premultiplication — edges were too dark.
  // Now we premultiply here, and the shader outputs result as-is.
  //
  // FIX 2 (2026-06-28): the earlier fix added #RRGGBBAA parsing but
  // still returned un-premultiplied values, and the solid layer's
  // hexToPremultVec4 also returned un-premultiplied. This caused
  // transparent backgrounds (#00000000) to upload as opaque black.
  if (hex.length === 9 && hex.startsWith('#')) {
    // #RRGGBBAA — 8-digit hex with alpha.
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const a = parseInt(hex.slice(7, 9), 16) / 255;
    return [r * a, g * a, b * a, a];
  }
  const rgb = hexToRgb(hex);
  // Alpha = 1.0, so premultiplied == un-premultiplied for opaque colors.
  return [
    rgb.r / 255,
    rgb.g / 255,
    rgb.b / 255,
    1.0,
  ];
}

// ────────────────────────────────────────────────────────────
// Layer render entry — fills `targetEntry` (already-bound FBO) with
// the layer's content (NO mask applied yet).
// ────────────────────────────────────────────────────────────

/**
 * Render the layer's CONTENT (no mask) into the bound layer FBO.
 *
 * Pre-conditions:
 *   • The layer FBO is already bound and sized to (renderW, renderH).
 *   • The FBO has been cleared to transparent.
 *
 * Post-conditions:
 *   • The FBO contains the layer's content (solid fill, image, or screentone).
 *   • GL state is restored (program unbound, blend disabled).
 *
 * Returns true on success, false on GL error (caller should fall back).
 */
export function renderLayerContentGL(
  state: GLState,
  layer: Layer,
  renderW: number,
  renderH: number,
  imageCache: ImageCache,
): boolean {
  const { gl } = state;

  switch (layer.type) {
    case 'solid': {
      if (!layer.solidColor) return true; // nothing to draw
      const prog = getProgram(state, 'solid-fill');
      if (!prog) return false;

      gl.useProgram(prog);
      gl.disable(gl.BLEND);

      // Color uniform (premultiplied RGBA).
      const color = hexToPremultVec4(layer.solidColor);
      const uColor = gl.getUniformLocation(prog, 'u_color');
      gl.uniform4f(uColor, color[0], color[1], color[2], color[3]);

      // Draw fullscreen triangle (3 verts).
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    }

    case 'image': {
      if (!layer.imageSrc) return true;
      const img = imageCache.images.get(layer.imageSrc);
      if (!img) return true; // image not loaded yet — silent skip

      const tex = getImageTexture(state, layer.imageSrc, img);
      if (!tex) return false;

      const prog = getProgram(state, 'image-upload');
      if (!prog) return false;

      gl.useProgram(prog);
      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_imageTex'), 0);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    }

    case 'screentone': {
      if (!layer.params) return true;
      const params = layer.params;

      // Decide: GLSL procedural, or hybrid CPU→texture?
      //
      // The GLSL screentone shader currently implements ONLY the base
      // pattern (dot/line/crosshatch/checker geometry) plus solid color
      // fill. It does NOT yet implement:
      //   - gradient mapping (gradType !== 'none')
      //   - satellites (satelliteEnabled === true)
      //   - density modulation
      //   - aspect/rowOffset/mergeFactor/jitter/roundness distortion
      //   - rotCanvas/rotPattern (canvas or pattern rotation)
      //   - seamless tiling
      // When a layer uses ANY of these features, we MUST use the hybrid
      // CPU->texture path (which calls renderScreentone from engine.ts
      // and handles every param correctly). Otherwise the layer would
      // render as a plain pattern and lose the gradient/satellite/etc.
      //
      // This is the cause of the regression reported on 2026-06-27:
      // "Perestali rabotat' gradienty v screentonah i planety" — before
      // the WebGL migration, all screentone layers went through the CPU
      // renderScreentone; after, layers with ported patternType went
      // through GLSL and silently dropped the unported features.
      if (isScreentonePatternPorted(params.patternType) && !screentoneLayerNeedsHybrid(params)) {
        return renderScreentoneGLSL(state, params, renderW, renderH);
      } else {
        return renderScreentoneHybrid(state, params, renderW, renderH);
      }
    }

    case 'transparent': {
      // No content to render — FBO is already cleared to transparent by
      // the caller (compositeSingleLayerGL). Return true so the composite
      // pass continues; the layer's mask (if any) is applied downstream
      // via applyMaskGL / u_canvasClipTex.
      return true;
    }

    case 'text': {
      // v2.9 STUB: Text layers are not rendered by the core GL pipeline.
      // A future TextRenderer (registered via PluginRegistry) will handle
      // this. For now, return true (no-op) so the layer's mask still works.
      return true;
    }

    case 'vector': {
      // v2.9 STUB: Vector layers are not rendered by the core GL pipeline.
      // Same as 'text' — a future VectorRenderer will handle this.
      return true;
    }
  }

  return true;
}

// ────────────────────────────────────────────────────────────
// Feature gate: detect params that the GLSL shader doesn't handle yet.
// If any such feature is in use, the caller falls back to the hybrid
// CPU->texture path so visual output matches canvas2D exactly.
//
// When a feature is ported to GLSL, remove it from this function.
// Once this function returns false for ALL inputs (every feature is
// ported), the hybrid path can be deleted entirely.
// ────────────────────────────────────────────────────────────

function screentoneLayerNeedsHybrid(p: ScreentoneParams): boolean {
  // Gradient mapping — not yet in GLSL.
  if (p.gradType && p.gradType !== 'none') return true;

  // Gradient color transition — not yet in GLSL.
  // When gradColorTrans is true, the gradient interpolates between
  // colorPattern and colorBg (not just dot size). The GLSL shader
  // has no support for this, so we must fall back to hybrid.
  if (p.gradColorTrans) return true;

  // Satellites — not yet in GLSL.
  if (p.satelliteEnabled) return true;

  // Density modulation — not yet in GLSL.
  // (Base pattern renders at full strength; density<1 would thin it out.)
  if (typeof p.density === 'number' && p.density > 0 && p.density < 1) return true;

  // Aspect distortion — not yet in GLSL.
  if (typeof p.aspectX === 'number' && p.aspectX !== 1) return true;
  if (typeof p.aspectY === 'number' && p.aspectY !== 1) return true;

  // Row offset (brick pattern) — not yet in GLSL.
  if (typeof p.rowOffset === 'number' && p.rowOffset !== 0 && p.rowOffset !== 1) {
    // rowOffset of 1 == 0 (full period) — only fractional offsets matter.
    const frac = Math.abs(p.rowOffset - Math.round(p.rowOffset));
    if (frac > 1e-4) return true;
  }

  // Merge factor — not yet in GLSL.
  if (typeof p.mergeFactor === 'number' && p.mergeFactor > 0) return true;

  // Jitter — not yet in GLSL.
  if (typeof p.jitterPos === 'number' && p.jitterPos > 0) return true;
  if (typeof p.jitterSize === 'number' && p.jitterSize > 0) return true;

  // Roundness — not yet in GLSL.
  if (typeof p.roundness === 'number' && p.roundness > 0) return true;

  // Canvas / pattern rotation — not yet in GLSL.
  // (u_angle in the shader rotates the pattern grid, but rotCanvas
  //  rotates the whole layer and rotPattern is a separate concept.)
  if (typeof p.rotCanvas === 'number' && p.rotCanvas !== 0) return true;
  if (typeof p.rotPattern === 'number' && p.rotPattern !== 0) return true;

  // Seamless tiling — not yet in GLSL.
  if (p.seamless) return true;

  return false;
}

// ────────────────────────────────────────────────────────────
// GLSL procedural screentone render
// ────────────────────────────────────────────────────────────

function renderScreentoneGLSL(
  state: GLState,
  params: ScreentoneParams,
  renderW: number,
  renderH: number,
): boolean {
  const { gl } = state;
  const prog = getProgram(state, 'screentone');
  if (!prog) return false;

  gl.useProgram(prog);
  gl.disable(gl.BLEND);

  // Set uniforms. (UniformLocation lookups could be cached, but twgl
  // already does this internally if we use twgl.setUniforms. To keep
  // the code simple, we use raw GL here; the cost is negligible.)
  const uniforms: Record<string, number | number[] | boolean> = {
    u_resolution: [renderW, renderH],
    u_patternType: PATTERN_TYPE_ID[params.patternType],
    u_dotShape: DOT_SHAPE_ID[params.dotShape],
    u_dotSize: params.dotSize,
    u_spacingX: params.spacingX,
    u_spacingY: params.spacingY,
    u_angle: params.angle,
    u_lineWidth: params.lineWidth,
    u_crossAngle: params.crossAngle,
  };

  // Colors (premultiplied; alpha=1 by default).
  const colorPattern = hexToPremultVec4(params.colorPattern);
  const colorBg = hexToPremultVec4(params.colorBg);
  (uniforms.u_colorPattern as number[]) = colorPattern;
  (uniforms.u_colorBg as number[]) = colorBg;

  // Upload uniforms.
  for (const [name, value] of Object.entries(uniforms)) {
    const loc = gl.getUniformLocation(prog, name);
    if (!loc) continue;
    if (typeof value === 'number') {
      gl.uniform1f(loc, value);
    } else if (Array.isArray(value)) {
      if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
      else if (value.length === 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
    }
  }

  // Special: integer uniforms (pattern type, dot shape) need uniform1i.
  const uPatType = gl.getUniformLocation(prog, 'u_patternType');
  if (uPatType) gl.uniform1i(uPatType, PATTERN_TYPE_ID[params.patternType]);
  const uDotShape = gl.getUniformLocation(prog, 'u_dotShape');
  if (uDotShape) gl.uniform1i(uDotShape, DOT_SHAPE_ID[params.dotShape]);

  // Draw fullscreen triangle.
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return true;
}

// ────────────────────────────────────────────────────────────
// Hybrid screentone: CPU renderScreentone → canvas → texture → FBO
// ────────────────────────────────────────────────────────────

// Reusable canvas for CPU rendering. Module-level for the same
// pooling reason as composite.ts canvasPool.
const hybridCanvasPool: HTMLCanvasElement[] = [];

function acquireHybridCanvas(w: number, h: number): HTMLCanvasElement {
  let best: HTMLCanvasElement | null = null;
  let bestArea = Infinity;
  for (const c of hybridCanvasPool) {
    if (c.width >= w && c.height >= h) {
      const area = c.width * c.height;
      if (area < bestArea) { best = c; bestArea = area; }
    }
  }
  const c = best ?? document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function releaseHybridCanvas(c: HTMLCanvasElement): void {
  if (hybridCanvasPool.length < 8) hybridCanvasPool.push(c);
}

function renderScreentoneHybrid(
  state: GLState,
  params: ScreentoneParams,
  renderW: number,
  renderH: number,
): boolean {
  const { gl } = state;
  const canvas = acquireHybridCanvas(renderW, renderH);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    releaseHybridCanvas(canvas);
    return false;
  }
  ctx.clearRect(0, 0, renderW, renderH);
  try {
    renderScreentone(ctx, renderW, renderH, params);
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[GenTonik WebGL] renderScreentone failed in hybrid path', e);
    }
    releaseHybridCanvas(canvas);
    return false;
  }

  // Upload as texture and draw via image-upload program.
  const tex = uploadCanvasAsTexture(state, canvas);
  releaseHybridCanvas(canvas);
  if (!tex) return false;

  const prog = getProgram(state, 'image-upload');
  if (!prog) {
    state.gl.deleteTexture(tex);
    return false;
  }

  gl.useProgram(prog);
  gl.disable(gl.BLEND);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_imageTex'), 0);

  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // Free the temp texture (we don't cache it — caller may upload it
  // again next frame if params change).
  // Future optimization: cache by layer fingerprint.
  gl.deleteTexture(tex);
  return true;
}

// ────────────────────────────────────────────────────────────
// Mask application (second pass into the same layer FBO)
// ────────────────────────────────────────────────────────────

/**
 * Apply a mask to the layer FBO (which must already contain the
 * layer's content). The mask is rendered IN-PLACE: a second draw
 * call reads the current FBO content and writes back the masked
 * version.
 *
 * Implementation: bind the layer FBO's texture as a sampler, run
 * the mask fragment shader, write back to the SAME FBO. WebGL2
 * forbids sampling from a texture that's attached to the current
 * framebuffer's color attachment, so we use a TEMP FBO ping-pong:
 *
 *   1. Allocate a temp FBO of the same size (from the pool).
 *   2. Bind temp FBO as render target.
 *   3. Bind layer FBO texture as sampler.
 *   4. Run mask shader, writing masked result into temp FBO.
 *   5. Copy temp FBO back into layer FBO via gl.blitFramebuffer.
 *
 * For shape masks (no painted texture), we can skip the ping-pong
 * and just write to the same FBO using gl_FragCoord to compute the
 * shape coverage — but we still need to READ the current layer
 * content to multiply alpha. So ping-pong is required for both
 * shape and painted masks.
 */
export function applyMaskGL(
  state: GLState,
  layerFBOEntry: { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number },
  mask: LayerMask | undefined,
): boolean {
  if (!mask) return true;

  const { gl } = state;
  const w = layerFBOEntry.w;
  const h = layerFBOEntry.h;

  // Acquire a temp FBO of the same size (from the pool — same size = same key,
  // so this might return the SAME FBO. We need a DIFFERENT FBO for ping-pong.)
  // Solution: use a dedicated temp FBO (not from the pool) for masks.
  const tempEntry = allocateTempFBO(state, w, h);
  if (!tempEntry) return false;

  try {
    if (mask.type === 'shape') {
      // ── Shape mask pass ──────────────────────────────────
      const prog = getProgram(state, 'mask-shape');
      if (!prog) return false;

      // Bind temp FBO as render target, layer FBO texture as sampler.
      gl.bindFramebuffer(gl.FRAMEBUFFER, tempEntry.fbo);
      gl.viewport(0, 0, w, h);
      gl.scissor(0, 0, w, h);
      gl.disable(gl.BLEND);

      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layerFBOEntry.tex);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_layerTex'), 0);
      gl.uniform2f(gl.getUniformLocation(prog, 'u_resolution'), w, h);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_shape'), mask.shape === 'ellipse' ? 0 : 1);
      gl.uniform4f(
        gl.getUniformLocation(prog, 'u_bounds'),
        mask.bounds.left, mask.bounds.top, mask.bounds.right, mask.bounds.bottom,
      );
      gl.uniform1f(gl.getUniformLocation(prog, 'u_feather'), mask.feather);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_invert'), mask.invert ? 1 : 0);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      // ── Painted mask pass ────────────────────────────────
      const prog = getProgram(state, 'mask-painted');
      if (!prog) return false;

      // Upload mask as texture.
      const maskTex = uploadPaintedMaskAsTexture(state, mask.data, mask.width, mask.height);
      if (!maskTex) return false;

      gl.bindFramebuffer(gl.FRAMEBUFFER, tempEntry.fbo);
      gl.viewport(0, 0, w, h);
      gl.scissor(0, 0, w, h);
      gl.disable(gl.BLEND);

      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layerFBOEntry.tex);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_layerTex'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_maskTex'), 1);
      gl.uniform2f(gl.getUniformLocation(prog, 'u_maskOffset'), mask.offsetX, mask.offsetY);
      gl.uniform2f(gl.getUniformLocation(prog, 'u_maskSize'), mask.width, mask.height);
      // BUG-2 FIX: pass the layer FBO size so the shader can correctly map
      // layer-space UV → mask UV for sub-region masks (selections). Without
      // this, the shader assumes mask covers the full layer and stretches
      // sub-region masks across the entire layer, producing wrong results.
      gl.uniform2f(gl.getUniformLocation(prog, 'u_layerSize'), w, h);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_invert'), mask.invert ? 1 : 0);

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Free mask texture (could cache by layer.id+mask version; for now, simple).
      gl.deleteTexture(maskTex);
    }

    // ── Blit temp FBO back to layer FBO ──────────────────
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, tempEntry.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layerFBOEntry.fbo);
    gl.blitFramebuffer(
      0, 0, w, h,
      0, 0, w, h,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    // Restore default framebuffer binding (caller will rebind as needed).
    gl.bindFramebuffer(gl.FRAMEBUFFER, layerFBOEntry.fbo);
    return true;
  } finally {
    // Free temp FBO + texture.
    gl.deleteFramebuffer(tempEntry.fbo);
    gl.deleteTexture(tempEntry.tex);
  }
}

/**
 * Allocate a one-shot temp FBO for the mask ping-pong.
 * Not pooled (cheap to create, used briefly).
 */
function allocateTempFBO(
  state: GLState,
  w: number,
  h: number,
): { fbo: WebGLFramebuffer; tex: WebGLTexture } | null {
  const { gl } = state;
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) {
    if (tex) gl.deleteTexture(tex);
    if (fbo) gl.deleteFramebuffer(fbo);
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    return null;
  }
  return { fbo, tex };
}

// ────────────────────────────────────────────────────────────
// Sanity re-export (used by composite-gl.ts)
// ────────────────────────────────────────────────────────────

void BLEND_GLSL; // imported for reference; not used directly here
