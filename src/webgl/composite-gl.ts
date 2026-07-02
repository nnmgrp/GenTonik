// ============================================================
// composite-gl.ts — main WebGL2 composite entry, analog to
// composite.ts's compositeLayers
// ============================================================
//
// Public API:
//   • compositeLayersGL(state, canvas, layers, ctx) → boolean
//     Returns true on success, false on any failure (caller falls
//     back to canvas2D compositeLayers).
//
// PIPELINE:
//
//   1. ensureGLStateSize(state, canvasW, canvasH)
//      Resize destFBO if the canvas backing store changed.
//
//   2. Clear destFBO to transparent.
//
//   3. For each visible layer (bottom-to-top):
//      a. Acquire a layer FBO at the layer's render size
//         (naturalSize for image/screentone, docSize for solid).
//      b. Clear layer FBO to transparent.
//      c. renderLayerContentGL — fill FBO with solid/image/screentone.
//      d. applyMaskGL — second pass, multiplies alpha by mask.
//      e. Bind destFBO as render target.
//      f. Set up composite-quad program:
//         - u_localToClip (affine) OR u_homography + u_ortho (perspective)
//         - u_naturalSize
//         - u_layerTex (the layer FBO texture)
//         - u_dstTex (the destFBO texture, for blend modes)
//         - u_opacity
//         - u_blendMode
//         - u_needsBlend (1 if blend != normal)
//         - u_usePerspective (1 if corners set)
//      g. Set GL blend state:
//         - If normal mode: gl.BLEND with ONE/ONE_MINUS_SRC_ALPHA
//           (premultiplied source-over), shader skips dst read.
//         - Else: gl.BLEND disabled, shader does manual blend.
//      h. drawArrays(TRIANGLE_STRIP, 0, 4) — 4 verts = the layer quad.
//
//   4. Blit destFBO to the visible canvas (default framebuffer).
//
// ────────────────────────────────────────────────────────────
//
// BLEND FEEDBACK LOOP NOTE:
//   For non-normal blend modes, we sample destTexture while rendering
//   INTO destFBO. This is the classic "feedback loop" forbidden by GL.
//   WebGL2 allows it under specific conditions:
//     • Texture bound to a sampler is NOT the same texture object
//       attached to the current framebuffer's color attachment.
//   Solution: ping-pong destFBO. We have TWO destination FBOs (A, B).
//   On each layer:
//     - Read from "previous" FBO (the accumulated composite so far).
//     - Write to "current" FBO (adds this layer).
//     - Swap A/B.
//   After all layers, the "previous" FBO holds the final result;
//   blit it to the visible canvas.
// ============================================================

import type { GLState } from './gl-context';
import { ensureGLStateSize, destroyGLState, createGLState } from './gl-context';
import { getProgram, acquireLayerFBO, bindLayerFBO, bindDestFBO, bindDefaultFramebuffer } from './gl-resources';
import { renderLayerContentGL, applyMaskGL } from './render-layer-gl';
import { affineToMat3Array, homographyToMat3Array, orthoCanvasProjection, affineScreenToClip, perspectiveMatricesForUpload } from './gl-matrix';
import { blendModeToGLSLId, blendModeNeedsDstRead } from './gl-blend';
import { composeLayerMatrix } from '../transform-matrix';
import { computeHomography, isQuadDegenerate } from '../homography';
import type { Layer, Vec2 } from '../types';
import type { CompositeContext } from '../composite';
import { getLayerNaturalSize } from '../types';

// ────────────────────────────────────────────────────────────
// Ping-pong destination FBOs (for blend feedback loop avoidance)
// ────────────────────────────────────────────────────────────

interface DestPingPong {
  fboA: WebGLFramebuffer;
  fboB: WebGLFramebuffer;
  texA: WebGLTexture;
  texB: WebGLTexture;
  /** Which one is "current read" (holds previous frame's composite). */
  readFromA: boolean;
  /** Actual FBO width — used to detect size changes (BUG-A FIX). */
  ppW: number;
  /** Actual FBO height — used to detect size changes (BUG-A FIX). */
  ppH: number;
}

const destPingPongCache = new WeakMap<GLState, DestPingPong>();

function ensureDestPingPong(state: GLState, w: number, h: number): DestPingPong | null {
  const { gl } = state;
  let existing = destPingPongCache.get(state);

  // Validate size — recreate if mismatched.
  if (existing) {
    // Check by binding texA and querying — but we cache size externally.
    // Simpler: store size on the descriptor. We'll add a wrapper type.
  }

  // BUG FIX: track actual FBO size on the DestPingPong object itself.
  if (existing && existing.ppW === w && existing.ppH === h) {
    return existing;
  }
  if (existing) {
    // Size changed — delete old, recreate.
    gl.deleteFramebuffer(existing.fboA);
    gl.deleteFramebuffer(existing.fboB);
    gl.deleteTexture(existing.texA);
    gl.deleteTexture(existing.texB);
    destPingPongCache.delete(state);
    existing = undefined;
  }

  const makeFBO = (): { fbo: WebGLFramebuffer; tex: WebGLTexture } | null => {
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
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      return null;
    }
    return { fbo, tex };
  };

  const a = makeFBO();
  const b = makeFBO();
  if (!a || !b) {
    if (a) { gl.deleteFramebuffer(a.fbo); gl.deleteTexture(a.tex); }
    if (b) { gl.deleteFramebuffer(b.fbo); gl.deleteTexture(b.tex); }
    return null;
  }

  const pp: DestPingPong = {
    fboA: a.fbo, fboB: b.fbo,
    texA: a.tex, texB: b.tex,
    readFromA: true,
    ppW: w,
    ppH: h,
  };
  destPingPongCache.set(state, pp);
  return pp;
}

function swapPingPong(pp: DestPingPong): void {
  pp.readFromA = !pp.readFromA;
}

function getCurrentRead(pp: DestPingPong): { fbo: WebGLFramebuffer; tex: WebGLTexture } {
  return pp.readFromA
    ? { fbo: pp.fboA, tex: pp.texA }
    : { fbo: pp.fboB, tex: pp.texB };
}

function getCurrentWrite(pp: DestPingPong): { fbo: WebGLFramebuffer; tex: WebGLTexture } {
  return pp.readFromA
    ? { fbo: pp.fboB, tex: pp.texB }
    : { fbo: pp.fboA, tex: pp.texA };
}

// ────────────────────────────────────────────────────────────
// Main composite entry
// ────────────────────────────────────────────────────────────

/**
 * Composite all visible layers onto the canvas via WebGL2.
 *
 * @param state       GLState from createGLState
 * @param canvas      Target canvas (must be the same one used to create state)
 * @param layers      Layers, bottom-to-top
 * @param compositeCtx Document size + image cache
 * @returns true on success, false on any failure (caller falls back to 2D)
 */
export function compositeLayersGL(
  state: GLState,
  canvas: HTMLCanvasElement,
  layers: Layer[],
  compositeCtx: CompositeContext,
): boolean {
  if (state.lost) return false;

  const { gl } = state;
  const w = canvas.width;
  const h = canvas.height;

  // ── Step 1: ensure FBOs match canvas size ──────────────────
  if (!ensureGLStateSize(state, w, h)) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[GenTonik WebGL] ensureGLStateSize failed', { w, h, canvasW: state.canvasW, canvasH: state.canvasH, lost: state.lost });
    }
    return false;
  }
  const pp = ensureDestPingPong(state, w, h);
  if (!pp) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[GenTonik WebGL] ensureDestPingPong failed', { w, h });
    }
    return false;
  }

  try {
    // ── Step 2: clear BOTH dest FBOs to transparent ──────────
    // (Both because we may read from either depending on ping-pong state.)
    gl.bindFramebuffer(gl.FRAMEBUFFER, pp.fboA);
    gl.viewport(0, 0, w, h);
    gl.scissor(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, pp.fboB);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Reset ping-pong: first layer reads from A (empty), writes to B.
    pp.readFromA = true;

    // ── Step 3: composite each visible layer ──────────────────
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;
      if (!compositeSingleLayerGL(state, layer, compositeCtx, pp)) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[GenTonik WebGL] compositeSingleLayerGL failed at layer', i, {
            name: layer.name,
            type: layer.type,
            visible: layer.visible,
            opacity: layer.opacity,
            hasMask: !!layer.mask,
            maskType: layer.mask?.type,
            hasCanvasSpacePolygon: layer.mask?.type === 'painted' && !!(layer.mask as { canvasSpacePolygon?: unknown }).canvasSpacePolygon,
          });
        }
        return false;
      }
    }

    // ── Step 4: blit final result to visible canvas ─────────
    const finalRead = getCurrentRead(pp);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, finalRead.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); // default framebuffer = visible canvas
    gl.viewport(0, 0, w, h);
    gl.scissor(0, 0, w, h);
    gl.blitFramebuffer(
      0, 0, w, h,
      0, 0, w, h,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    return true;
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[GenTonik WebGL] compositeLayersGL failed — falling back to 2D', e);
    }
    return false;
  }
}

// ────────────────────────────────────────────────────────────
// Per-layer composite
// ────────────────────────────────────────────────────────────

function compositeSingleLayerGL(
  state: GLState,
  layer: Layer,
  compositeCtx: CompositeContext,
  pp: DestPingPong,
): boolean {
  const { gl } = state;

  // ── Compute render size (matches composite.ts logic) ─────
  const naturalSize = getLayerNaturalSize(layer, {
    docWidth: compositeCtx.docWidth,
    docHeight: compositeCtx.docHeight,
    imageSizes: compositeCtx.imageCache.sizes,
  });
  let renderW = naturalSize.w;
  let renderH = naturalSize.h;
  // Solid layers are 1×1 naturally but stretched to docSize at render
  // time. Transparent layers have no intrinsic content but need a sane
  // render box so transforms/masks behave correctly — same docSize override.
  // v2.9: text/vector layers also get docSize override (no intrinsic size).
  if (layer.type === 'solid' || layer.type === 'transparent'
      || layer.type === 'text' || layer.type === 'vector') {
    renderW = compositeCtx.docWidth;
    renderH = compositeCtx.docHeight;
  }
  if (renderW <= 0 || renderH <= 0) return true; // nothing to draw

  // ── Acquire layer FBO and render content ──────────────────
  const layerFBO = acquireLayerFBO(state, renderW, renderH);
  if (!layerFBO) return false;

  bindLayerFBO(state, layerFBO);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (!renderLayerContentGL(state, layer, renderW, renderH, compositeCtx.imageCache)) {
    return false;
  }

  // ── Apply mask (in-place ping-pong inside applyMaskGL) ────
  // PRESERVE-PERSPECTIVE: skip layer-local painted mask if canvasSpacePolygon
  // is set — that mask is applied as a canvas-space clip in the composite
  // shader (u_canvasClipTex), not as a layer-local alpha multiply.
  if (layer.mask) {
    const hasCanvasSpaceMask = layer.mask.type === 'painted' && (layer.mask as { canvasSpacePolygon?: unknown }).canvasSpacePolygon;
    if (!hasCanvasSpaceMask) {
      if (!applyMaskGL(state, layerFBO, layer.mask)) {
        return false;
      }
    }
  }

  // v2.11.2: Generate mipmaps on the layer FBO texture.
  // This is critical for reducing moire/waves on screentone dot patterns
  // when the layer is scaled down or perspective-warped in the composite pass.
  // LINEAR_MIPMAP_LINEAR (set at FBO creation) uses these mip levels to
  // pre-filter high-frequency detail, preventing aliasing/moire.
  // Must be called AFTER all rendering to the FBO is complete (content + mask).
  // CRITICAL: The FBO must NOT be bound as the current framebuffer when
  // generateMipmap is called — WebGL spec requires that the texture being
  // mipmapped is not attached to the currently-bound framebuffer. We unbind
  // the FBO by binding the default framebuffer (null) first.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, layerFBO.tex);
  gl.generateMipmap(gl.TEXTURE_2D);

  // PRESERVE-PERSPECTIVE: rasterize canvas-space clip polygon → texture.
  // The polygon is in canvas-pixel space. We rasterize it to a single-channel
  // alpha texture (canvasW × canvasH) using an offscreen Canvas2D, then
  // upload as a GL texture. The composite-quad shader samples this texture
  // to clip the layer to the polygon shape (post-perspective).
  //
  // PERFORMANCE: texture is cached per-layer (keyed by layer.id). The cache
  // hits on every frame after the first, avoiding the expensive 2000×2000
  // Canvas2D rasterization. Cache invalidates automatically when the polygon
  // changes (new mask) or canvas resizes.
  let canvasClipTex: WebGLTexture | null = null;
  const canvasSpacePolygon = layer.mask?.type === 'painted'
    ? (layer.mask as { canvasSpacePolygon?: Vec2[] }).canvasSpacePolygon
    : undefined;
  const useCanvasClip = !!(canvasSpacePolygon && canvasSpacePolygon.length >= 3);
  if (useCanvasClip && canvasSpacePolygon) {
    canvasClipTex = getCanvasClipTexture(state, layer.id, canvasSpacePolygon, state.canvasW, state.canvasH);
    if (!canvasClipTex) {
      // Rasterization failed — skip canvas clip (fall back to no clip).
      // The layer will render without clipping (acceptable degradation).
    }
  }

  // ── Composite onto destination (ping-pong) ────────────────
  const readDest = getCurrentRead(pp);
  const writeDest = getCurrentWrite(pp);

  // CRITICAL FIX (2026-06-28): blit readDest → writeDest before drawing.
  //
  // The fragment shader only executes for pixels inside the layer's quad.
  // Pixels OUTSIDE the quad in writeDest would retain stale content from
  // a previous frame or from the initial clear. This causes the accumulated
  // composite (lower layers) to be lost outside the quad area.
  //
  // Symptom: with a Free Transform layer on top, layers below are invisible
  // outside the FT quad. With 2 layers under FT, the bottommost layer
  // "reappears" as stale content from a previous ping-pong cycle.
  //
  // Fix: copy the accumulated composite (readDest) into writeDest FIRST,
  // then draw the current layer on top. The shader's blendPremultiplied()
  // overwrites pixels inside the quad with the correct blended result.
  // Pixels outside the quad retain the accumulated composite from the blit.
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readDest.fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, writeDest.fbo);
  gl.blitFramebuffer(
    0, 0, state.canvasW, state.canvasH,
    0, 0, state.canvasW, state.canvasH,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );

  // Bind writeDest as render target.
  gl.bindFramebuffer(gl.FRAMEBUFFER, writeDest.fbo);
  gl.viewport(0, 0, state.canvasW, state.canvasH);
  gl.scissor(0, 0, state.canvasW, state.canvasH);

  const needsDstRead = blendModeNeedsDstRead(layer.blendMode);
  const blendId = blendModeToGLSLId(layer.blendMode);

  // ── BLEND STATE ───────────────────────────────────────────
  //
  // CRITICAL FIX (2026-06-27): always disable gl.BLEND. The shader
  // does ALL blending manually (samples u_dstTex = readDest.tex and
  // applies blendPremultiplied). The previous version enabled gl.BLEND
  // for normal mode, expecting GL fixed-function src-over — but that
  // uses the CURRENT framebuffer's content as dst, which is writeDest
  // (the empty half of the ping-pong). The accumulated composite is
  // in readDest.tex, which GL fixed-function can't see. So lower
  // layers were silently dropped. Now the shader always samples dst
  // from u_dstTex and does correct src-over for all blend modes.
  //
  // `needsDstRead` is kept for ABI compat but the shader ignores it
  // (it always reads dst). We leave the variable in place to minimize
  // the diff and to allow easy reversion if a future optimization
  // restores the GL fixed-function fast path for the first layer.
  gl.disable(gl.BLEND);
  void needsDstRead;

  // ── Set up composite-quad program ────────────────────────
  const prog = getProgram(state, 'composite-quad');
  if (!prog) return false;

  gl.useProgram(prog);

  // Bind layer FBO texture as u_layerTex.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, layerFBO.tex);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_layerTex'), 0);

  // Bind readDest texture as u_dstTex (only used if needsDstRead).
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, readDest.tex);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_dstTex'), 1);

  // Uniforms: opacity, blend mode, blend-needed flag.
  gl.uniform1f(gl.getUniformLocation(prog, 'u_opacity'), layer.opacity);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_blendMode'), blendId);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_needsBlend'), needsDstRead ? 1 : 0);

  // Uniforms: natural size.
  gl.uniform2f(gl.getUniformLocation(prog, 'u_naturalSize'), renderW, renderH);

  // Uniforms: canvas size (needed for perspective-correct interpolation
  // in COMPOSITE_VERT — it uses u_canvasSize to compute clip-space
  // homogeneous coordinates without dividing by canvasPos.z).
  gl.uniform2f(gl.getUniformLocation(prog, 'u_canvasSize'), state.canvasW, state.canvasH);

  // PRESERVE-PERSPECTIVE: canvas-space clip mask texture + enable flag.
  // Bind to texture unit 2 (0 = layerTex, 1 = dstTex, 2 = canvasClipTex).
  // NOTE: u_canvasSize is shared between COMPOSITE_VERT (perspective math)
  // and COMPOSITE_FRAG (canvas-clip UV). Both use the same value.
  if (useCanvasClip && canvasClipTex) {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, canvasClipTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_canvasClipTex'), 2);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_useCanvasClip'), 1);
  } else {
    // Disable clip: bind no texture (or a dummy), set flag to 0.
    gl.uniform1i(gl.getUniformLocation(prog, 'u_useCanvasClip'), 0);
  }

  // ── Transform uniforms: affine or perspective ────────────
  if (layer.transform.corners) {
    // Perspective path: compute homography.
    if (isQuadDegenerate(layer.transform.corners)) {
      // Skip degenerate quads (matches composite.ts behavior).
      swapPingPong(pp);
      return true;
    }
    const srcQuad = [
      { x: 0, y: 0 },
      { x: renderW, y: 0 },
      { x: renderW, y: renderH },
      { x: 0, y: renderH },
    ] as const;
    const H = computeHomography(srcQuad, layer.transform.corners);
    if (!H) {
      // Fallback: skip (matches composite.ts).
      swapPingPong(pp);
      return true;
    }
    const { homography, ortho } = perspectiveMatricesForUpload(H, state.canvasW, state.canvasH);
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_homography'), false, homography);
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_ortho'), false, ortho);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_usePerspective'), 1);
    // u_localToClip is unused in perspective path — set to identity to avoid GL warnings.
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_localToClip'), false, new Float32Array([1,0,0,0,1,0,0,0,1]));
  } else {
    // Affine path.
    const m = composeLayerMatrix(
      layer.transform,
      { w: renderW, h: renderH },
      { w: state.canvasW, h: state.canvasH },
    );
    const screenToClip = affineScreenToClip(m, state.canvasW, state.canvasH);
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_localToClip'), false, screenToClip);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_usePerspective'), 0);
    // u_homography and u_ortho unused — set to identity.
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_homography'), false, new Float32Array([1,0,0,0,1,0,0,0,1]));
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_ortho'), false, new Float32Array([1,0,0,0,1,0,0,0,1]));
  }

  // ── Draw 4-vertex triangle strip (the layer quad) ─────────
  // The vertex shader builds quad coords via gl_VertexID — no VBO needed.
  // BUT we're using gl_VertexID 0..3 with switch() expecting 4 verts.
  // So drawArrays must be TRIANGLE_STRIP with 4 verts.
  //
  // Wait — the vertex shader's switch() expects gl_VertexID 0..3, which
  // works for both TRIANGLE_STRIP and TRIANGLES + 6-vert expansion.
  // We use TRIANGLE_STRIP for efficiency.
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // PRESERVE-PERSPECTIVE: canvas-clip texture is cached — do NOT delete here.
  // The cache (getCanvasClipTexture) owns the texture and reuses it across
  // frames. It's deleted only when the polygon changes or canvas resizes.

  // ── Swap ping-pong for next layer ────────────────────────
  swapPingPong(pp);

  // Restore GL state for next pass.
  gl.disable(gl.BLEND);
  return true;
}

// ────────────────────────────────────────────────────────────
// PRESERVE-PERSPECTIVE: rasterize canvas-space clip polygon → GL texture.
// ────────────────────────────────────────────────────────────

/**
 * Cached canvas-clip texture entry.
 *
 * Rasterizing a polygon to a canvasW × canvasH texture every frame is
 * expensive (e.g. 2000×2000 = 16MB RGBA). The clip polygon only changes
 * when the user creates a new "Mask from Sel → by canvas shape" — it does
 * NOT change during pan/zoom or while editing other layers. So we cache
 * the texture by a hash of (polygon points + canvas size).
 *
 * The cache is keyed by layer.id (one clip texture per layer). When the
 * layer's mask changes, the old texture is deleted and a new one is created.
 * When the canvas resizes, all entries are invalidated.
 */
interface ClipTextureCacheEntry {
  texture: WebGLTexture;
  /** Hash of polygon points + canvas size — detects mask changes. */
  hash: string;
  /** Canvas size when this texture was created — detects resize. */
  canvasW: number;
  canvasH: number;
}

const clipTextureCache = new WeakMap<GLState, Map<string, ClipTextureCacheEntry>>();

/**
 * Compute a hash of the polygon + canvas size for cache lookup.
 * Uses a simple string concatenation — fast enough for typical polygon
 * sizes (16-64 points from ellipse/lasso selections).
 */
function hashClipKey(polygon: Vec2[], canvasW: number, canvasH: number): string {
  // Round to 0.1 px to avoid float jitter creating new cache entries.
  // The rounding error is negligible for clip mask purposes.
  const rounded = polygon.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('|');
  return `${canvasW}x${canvasH}:${rounded}`;
}

/**
 * Get or create a canvas-clip texture for the given polygon + canvas size.
 * Uses a per-GLState cache (keyed by layer.id passed via `cacheKey`).
 *
 * @param state        GL state (cache is per-state)
 * @param cacheKey     Unique key per layer (typically layer.id)
 * @param polygon      Canvas-space clip polygon
 * @param canvasW      Canvas width in px
 * @param canvasH      Canvas height in px
 * @returns GL texture, or null on failure. Caller must NOT delete the
 *          returned texture — it's owned by the cache.
 */
function getCanvasClipTexture(
  state: GLState,
  cacheKey: string,
  polygon: Vec2[],
  canvasW: number,
  canvasH: number,
): WebGLTexture | null {
  const { gl } = state;
  if (polygon.length < 3 || canvasW <= 0 || canvasH <= 0) return null;

  const hash = hashClipKey(polygon, canvasW, canvasH);

  let cache = clipTextureCache.get(state);
  if (!cache) {
    cache = new Map();
    clipTextureCache.set(state, cache);
  }

  const existing = cache.get(cacheKey);
  if (existing) {
    // Cache hit — check if polygon or canvas size changed.
    if (existing.hash === hash && existing.canvasW === canvasW && existing.canvasH === canvasH) {
      return existing.texture;
    }
    // Polygon or canvas changed — delete old texture, create new.
    gl.deleteTexture(existing.texture);
    cache.delete(cacheKey);
  }

  // Create new texture.
  const texture = rasterizeCanvasClipToTexture(state, polygon, canvasW, canvasH);
  if (!texture) return null;

  cache.set(cacheKey, { texture, hash, canvasW, canvasH });
  return texture;
}

/**
 * Rasterize a canvas-space polygon to a single-channel alpha texture
 * (canvasW × canvasH) and upload it as a GL texture.
 *
 * The polygon is in canvas-pixel space (0..canvasW, 0..canvasH), top-left origin
 * (Canvas2D convention). The resulting texture has alpha=255 inside the polygon
 * and alpha=0 outside.
 *
 * The composite-quad shader samples this texture with Y flipped (WebGL Y is
 * bottom-up) to clip the layer to the polygon shape.
 *
 * @returns GL texture, or null on failure.
 */
function rasterizeCanvasClipToTexture(
  state: GLState,
  polygon: Vec2[],
  canvasW: number,
  canvasH: number,
): WebGLTexture | null {
  const { gl } = state;
  if (polygon.length < 3 || canvasW <= 0 || canvasH <= 0) return null;

  try {
    // Use an offscreen Canvas2D to rasterize the polygon.
    // (We can't use the main canvas — it has a WebGL context.)
    const offscreen = document.createElement('canvas');
    offscreen.width = canvasW;
    offscreen.height = canvasH;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;

    // Fill polygon with white (alpha=255 inside, 0 outside).
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(polygon[0].x, polygon[0].y);
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x, polygon[i].y);
    }
    ctx.closePath();
    ctx.fill();

    // Upload as GL texture.
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      gl.RGBA, gl.UNSIGNED_BYTE, offscreen
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  } catch (err) {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Convenience: try WebGL first, fall back to canvas2D on failure.
// ────────────────────────────────────────────────────────────

import { compositeLayers } from '../composite';

/**
 * Try WebGL2 composite; on any failure, silently fall back to 2D
 * compositeLayers. The GLState is preserved across calls (cached
 * on the canvas via WeakMap) so a transient failure doesn't
 * permanently disable WebGL.
 *
 * This is the function App.tsx should call in its composite useEffect.
 *
 * During dev: silent fallback (no UI warning).
 * Final GenTonik release: toast notification (TBD).
 */
const glStateCache = new WeakMap<HTMLCanvasElement, GLState>();

export function compositeLayersWithFallback(
  canvas: HTMLCanvasElement,
  layers: Layer[],
  compositeCtx: CompositeContext,
): void {
  // PRESERVE-PERSPECTIVE: canvas-space masks (canvasSpacePolygon) are now
  // handled natively in the WebGL composite shader (u_canvasClipTex +
  // u_useCanvasClip). No Canvas2D fallback needed for canvas-space masks.
  // The previous fallback was broken anyway — canvas.getContext('2d') returns
  // null when the canvas already has a WebGL context (HTML5 Canvas can only
  // have one context type).

  // Try to get cached GL state, or create new one.
  let state: GLState | null | undefined = glStateCache.get(canvas);
  // v2.7: If the cached state was marked lost (context loss + restore),
  // tear it down and create a fresh one. The old GL resources (FBOs,
  // textures, programs) are invalid after context restore — using them
  // would produce GL errors or silent no-ops. destroyGLState frees the
  // stale handles (best-effort) and removes event listeners.
  if (state && state.lost) {
    if (typeof console !== 'undefined' && console.info) {
      console.info('[GenTonik WebGL] rebuilding GLState after context loss/restore');
    }
    destroyGLState(state);
    glStateCache.delete(canvas);
    state = null;
  }
  if (!state) {
    state = createGLState(canvas);
    if (state) glStateCache.set(canvas, state);
  }

  // If we have a working GL state and it's not lost, try WebGL.
  if (state && !state.lost) {
    const ok = compositeLayersGL(state, canvas, layers, compositeCtx);
    if (ok) return;

    // WebGL failed — log the reason for debugging the "transparent layers" bug.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[GenTonik WebGL] compositeLayersGL returned false — falling back to 2D (which may also fail since canvas already has WebGL context)');
    }

    // WebGL failed — if state is permanently lost, evict from cache.
    if (state.lost) {
      glStateCache.delete(canvas);
      destroyGLState(state);
    }
  }

  // ── Fallback: canvas2D ──────────────────────────────────
  // NOTE: This fallback only works if the canvas does NOT already have a
  // WebGL context. In GenToniK the canvas always has WebGL (created on first
  // composite call), so this fallback path is effectively dead code. It's
  // kept for safety (e.g. if WebGL2 is unavailable on first run).
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) {
    // BUG-transparent-diagnostic: log loudly so the user can see WHY
    // canvas stays transparent. Common causes:
    //   1. WebGL composite failed silently (shader compile error, FBO incomplete)
    //   2. Canvas already has WebGL context → getContext('2d') returns null
    //   3. All layers invisible or zero opacity
    if (typeof console !== 'undefined' && console.error) {
      const visibleLayerCount = layers.filter(l => l.visible && l.opacity > 0).length;
      console.error('[GenTonik WebGL] FATAL: WebGL composite failed AND canvas2D fallback unavailable. Canvas will be transparent.', {
        visibleLayerCount,
        totalLayerCount: layers.length,
        layersSummary: layers.map(l => ({ name: l.name, type: l.type, visible: l.visible, opacity: l.opacity, hasMask: !!l.mask })),
        docSize: { w: canvas.width, h: canvas.height },
      });
    }
    return;
  }
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  compositeLayers(ctx2d, layers, compositeCtx);
}

// Re-export createGLState so consumers can manage lifecycle explicitly.
// (Already imported above; re-exported here for the public API.)
export { createGLState, destroyGLState } from './gl-context';
