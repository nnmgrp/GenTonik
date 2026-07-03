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
// ============================================================

import type { GLState } from './gl-context';
import { ensureGLStateSize, destroyGLState, createGLState } from './gl-context';
import { getProgram, acquireLayerFBO, bindLayerFBO, bindDestFBO, bindDefaultFramebuffer } from './gl-resources';
import { renderLayerContentGL, applyMaskGL } from './render-layer-gl';
import { affineToMat3Array, homographyToMat3Array, orthoCanvasProjection, affineScreenToClip, perspectiveMatricesForUpload } from './gl-matrix';
import { blendModeToGLSLId, blendModeNeedsDstRead } from './gl-blend';
import { composeLayerMatrix } from '../transform-matrix';
import { computeHomography, isQuadDegenerate } from '../homography';
import { applyHomography, invertHomography } from '../homography';
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
  /** Actual FBO width — used to detect size changes. */
  ppW: number;
  /** Actual FBO height — used to detect size changes. */
  ppH: number;
}

const destPingPongCache = new WeakMap<GLState, DestPingPong>();

function ensureDestPingPong(state: GLState, w: number, h: number): DestPingPong | null {
  const { gl } = state;
  let existing = destPingPongCache.get(state);

  // Validate size — recreate if mismatched.
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

// ── Scanline clipping (for backward mapping) ──
function getQuadScanline(
  quad: readonly [Vec2, Vec2, Vec2, Vec2],
  y: number,
  minX: number,
  maxX: number
): [number, number] | null {
  const intersections: number[] = [];
  for (let i = 0; i < 4; i++) {
    const p1 = quad[i];
    const p2 = quad[(i + 1) % 4];
    if ((p1.y < y && p2.y >= y) || (p2.y < y && p1.y >= y)) {
      if (Math.abs(p2.y - p1.y) < 1e-6) continue;
      const t = (y - p1.y) / (p2.y - p1.y);
      const x = p1.x + t * (p2.x - p1.x);
      intersections.push(x);
    }
  }
  if (intersections.length < 2) return null;
  intersections.sort((a, b) => a - b);
  const left = Math.max(minX, Math.floor(intersections[0]));
  const right = Math.min(maxX, Math.ceil(intersections[intersections.length - 1]));
  if (left >= right) return null;
  return [left, right];
}

// ── Backward mapping (for high-quality bake/export) ──
export function drawImageWithPerspectiveBackward(
  destCtx: CanvasRenderingContext2D,
  srcCanvas: HTMLCanvasElement,
  srcW: number,
  srcH: number,
  dstCorners: readonly [Vec2, Vec2, Vec2, Vec2],
): void {
  if (srcW <= 0 || srcH <= 0) return;
  if (isQuadDegenerate(dstCorners)) return;

  const srcQuad: [Vec2, Vec2, Vec2, Vec2] = [
    { x: 0, y: 0 }, { x: srcW, y: 0 }, { x: srcW, y: srcH }, { x: 0, y: srcH },
  ];
  const H = computeHomography(srcQuad, dstCorners);
  if (!H) {
    const xs = dstCorners.map(c => c.x), ys = dstCorners.map(c => c.y);
    destCtx.drawImage(srcCanvas, Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return;
  }

  const Hinv = invertHomography(H);
  if (!Hinv) return;

  const xs = dstCorners.map(c => c.x), ys = dstCorners.map(c => c.y);
  const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs));
  const minY = Math.floor(Math.min(...ys)), maxY = Math.ceil(Math.max(...ys));
  const outW = maxX - minX, outH = maxY - minY;
  if (outW <= 0 || outH <= 0) return;

  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) return;
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
  const srcPixels = srcData.data;
  const outImage = destCtx.createImageData(outW, outH);
  const outPixels = outImage.data;
  outPixels.fill(0);
  const srcStride = srcW * 4;

  for (let y = 0; y < outH; y++) {
    const dstY = minY + y;
    const xRange = getQuadScanline(dstCorners, dstY, minX, maxX);
    if (!xRange) continue;
    const [startX, endX] = xRange;
    const x0 = Math.max(0, startX - minX), x1 = Math.min(outW, endX - minX);
    for (let x = x0; x < x1; x++) {
      const dstX = minX + x;
      const src = applyHomography(Hinv, { x: dstX, y: dstY });
      const sx = src.x, sy = src.y;
      if (sx < 0 || sx >= srcW || sy < 0 || sy >= srcH) continue;
      const outIdx = (y * outW + x) * 4;
      if (sx >= 0 && sx < srcW - 1 && sy >= 0 && sy < srcH - 1) {
        const x0i = Math.floor(sx), y0i = Math.floor(sy);
        const fx = sx - x0i, fy = sy - y0i;
        const i00 = (y0i * srcW + x0i) * 4, i10 = i00 + 4, i01 = i00 + srcStride, i11 = i01 + 4;
        for (let c = 0; c < 4; c++) {
          const v00 = srcPixels[i00 + c], v10 = srcPixels[i10 + c], v01 = srcPixels[i01 + c], v11 = srcPixels[i11 + c];
          const v0 = v00 + fx * (v10 - v00), v1 = v01 + fx * (v11 - v01);
          outPixels[outIdx + c] = Math.round(v0 + fy * (v1 - v0));
        }
      } else {
        const xi = Math.min(Math.floor(sx), srcW - 1), yi = Math.min(Math.floor(sy), srcH - 1);
        const i0 = (yi * srcW + xi) * 4;
        outPixels[outIdx + 0] = srcPixels[i0 + 0];
        outPixels[outIdx + 1] = srcPixels[i0 + 1];
        outPixels[outIdx + 2] = srcPixels[i0 + 2];
        outPixels[outIdx + 3] = srcPixels[i0 + 3];
      }
    }
  }

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = outW; tempCanvas.height = outH;
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return;
  tempCtx.putImageData(outImage, 0, 0);
  destCtx.drawImage(tempCanvas, minX, minY);
}

// ────────────────────────────────────────────────────────────
// Main composite entry
// ────────────────────────────────────────────────────────────

const MAX_HARDWARE_TEX_LIMIT = 16384;

/**
 * Composite all visible layers onto the canvas via WebGL2.
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
      console.warn('[GenTonik WebGL] ensureGLStateSize failed', { w, h, canvasW: state.canvasW, canvasH: state.canvasH, renderW: state.renderW, renderH: state.renderH, lost: state.lost });
    }
    return false;
  }
  const pp = ensureDestPingPong(state, state.renderW, state.renderH);
  if (!pp) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[GenTonik WebGL] ensureDestPingPong failed', { renderW: state.renderW, renderH: state.renderH });
    }
    return false;
  }

  try {
    // ── Step 2: clear BOTH dest FBOs to transparent ──────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, pp.fboA);
    gl.viewport(0, 0, state.renderW, state.renderH);
    gl.scissor(0, 0, state.renderW, state.renderH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, pp.fboB);
    gl.viewport(0, 0, state.renderW, state.renderH);
    gl.scissor(0, 0, state.renderW, state.renderH);
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
      0, 0, state.renderW, state.renderH,
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

  // ── Apply mask ────
  if (layer.mask) {
    const hasCanvasSpaceMask = layer.mask.type === 'painted' && (layer.mask as { canvasSpacePolygon?: unknown }).canvasSpacePolygon;
    if (!hasCanvasSpaceMask) {
      if (!applyMaskGL(state, layerFBO, layer.mask)) {
        return false;
      }
    }
  }

  // Rasterize canvas-space clip polygon → texture.
  let canvasClipTex: WebGLTexture | null = null;
  const canvasSpacePolygon = layer.mask?.type === 'painted'
    ? (layer.mask as { canvasSpacePolygon?: Vec2[] }).canvasSpacePolygon
    : undefined;
  const useCanvasClip = !!(canvasSpacePolygon && canvasSpacePolygon.length >= 3);
  if (useCanvasClip && canvasSpacePolygon) {
    canvasClipTex = getCanvasClipTexture(state, layer.id, canvasSpacePolygon, state.canvasW, state.canvasH);
  }

  // ── Composite onto destination (ping-pong) ────────────────
  const readDest = getCurrentRead(pp);
  const writeDest = getCurrentWrite(pp);

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readDest.fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, writeDest.fbo);
  gl.blitFramebuffer(
    0, 0, state.renderW, state.renderH,
    0, 0, state.renderW, state.renderH,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );

  // Bind writeDest as render target.
  gl.bindFramebuffer(gl.FRAMEBUFFER, writeDest.fbo);
  gl.viewport(0, 0, state.renderW, state.renderH);
  gl.scissor(0, 0, state.renderW, state.renderH);

  const needsDstRead = blendModeNeedsDstRead(layer.blendMode);
  const blendId = blendModeToGLSLId(layer.blendMode);

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

  // Bind readDest texture as u_dstTex.
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, readDest.tex);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_dstTex'), 1);

  // Uniforms: opacity, blend mode, blend-needed flag.
  gl.uniform1f(gl.getUniformLocation(prog, 'u_opacity'), layer.opacity);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_blendMode'), blendId);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_needsBlend'), needsDstRead ? 1 : 0);

  // Uniforms: natural size.
  gl.uniform2f(gl.getUniformLocation(prog, 'u_naturalSize'), renderW, renderH);

  // Uniforms: canvas size (logical).
  gl.uniform2f(gl.getUniformLocation(prog, 'u_canvasSize'), state.canvasW, state.canvasH);

  // Uniforms: FBO render size (physical).
  gl.uniform2f(gl.getUniformLocation(prog, 'u_renderSize'), state.renderW, state.renderH);

  if (useCanvasClip && canvasClipTex) {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, canvasClipTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_canvasClipTex'), 2);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_useCanvasClip'), 1);
  } else {
    gl.uniform1i(gl.getUniformLocation(prog, 'u_useCanvasClip'), 0);
  }

  // ── Transform uniforms: affine or perspective ────────────
  if (layer.transform.corners) {
    if (isQuadDegenerate(layer.transform.corners)) {
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
      swapPingPong(pp);
      return true;
    }
    const { homography, ortho } = perspectiveMatricesForUpload(H, state.canvasW, state.canvasH);
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_homography'), false, homography);
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_ortho'), false, ortho);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_usePerspective'), 1);
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
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_homography'), false, new Float32Array([1,0,0,0,1,0,0,0,1]));
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_ortho'), false, new Float32Array([1,0,0,0,1,0,0,0,1]));
  }

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  swapPingPong(pp);

  // Restore GL state for next pass.
  gl.disable(gl.BLEND);
  return true;
}

// ────────────────────────────────────────────────────────────
// clipTextureCache definitions
// ────────────────────────────────────────────────────────────

interface ClipTextureCacheEntry {
  texture: WebGLTexture;
  hash: string;
  canvasW: number;
  canvasH: number;
}

const clipTextureCache = new WeakMap<GLState, Map<string, ClipTextureCacheEntry>>();

function hashClipKey(polygon: Vec2[], renderScale: number): string {
  const rounded = polygon.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('|');
  return `${renderScale.toFixed(6)}:${rounded}`;
}

function getCanvasClipTexture(
  state: GLState,
  cacheKey: string,
  polygon: Vec2[],
  canvasW: number,
  canvasH: number,
): WebGLTexture | null {
  const { gl } = state;
  if (polygon.length < 3 || canvasW <= 0 || canvasH <= 0) return null;

  const hash = hashClipKey(polygon, state.renderScale);

  let cache = clipTextureCache.get(state);
  if (!cache) {
    cache = new Map();
    clipTextureCache.set(state, cache);
  }

  const existing = cache.get(cacheKey);
  if (existing) {
    if (existing.hash === hash && existing.canvasW === canvasW && existing.canvasH === canvasH) {
      return existing.texture;
    }
    gl.deleteTexture(existing.texture);
    cache.delete(cacheKey);
  }

  // Create new texture.
  const texture = rasterizeCanvasClipToTexture(state, polygon, canvasW, canvasH);
  if (!texture) return null;

  cache.set(cacheKey, { texture, hash, canvasW, canvasH });
  return texture;
}

function rasterizeCanvasClipToTexture(
  state: GLState,
  polygon: Vec2[],
  canvasW: number,
  canvasH: number,
): WebGLTexture | null {
  const { gl } = state;
  if (polygon.length < 3 || state.renderW <= 0 || state.renderH <= 0) return null;

  try {
    const offscreen = document.createElement('canvas');
    offscreen.width = state.renderW;
    offscreen.height = state.renderH;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;

    // Scale polygon from logical canvas space to physical render space
    const s = state.renderScale;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(polygon[0].x * s, polygon[0].y * s);
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x * s, polygon[i].y * s);
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

const glStateCache = new WeakMap<HTMLCanvasElement, GLState>();

export function compositeLayersWithFallback(
  canvas: HTMLCanvasElement,
  layers: Layer[],
  compositeCtx: CompositeContext,
): void {
  // Early fallback for oversized documents
  if (canvas.width > MAX_HARDWARE_TEX_LIMIT || canvas.height > MAX_HARDWARE_TEX_LIMIT) {
    const ctx2d = canvas.getContext('2d');
    if (ctx2d) {
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      compositeLayers(ctx2d, layers, compositeCtx);
      return;
    }
    console.error('[GenTonik] Canvas too large for GPU and 2D unavailable');
    return;
  }

  // Try to get cached GL state, or create new one.
  let state: GLState | null | undefined = glStateCache.get(canvas);
  if (state && state.lost) {
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

    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[GenTonik WebGL] compositeLayersGL returned false — falling back to 2D');
    }

    if (state.lost) {
      glStateCache.delete(canvas);
      destroyGLState(state);
    }
  }

  // Fallback: canvas2D
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[GenTonik WebGL] FATAL: WebGL composite failed AND canvas2D fallback unavailable.');
    }
    return;
  }
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  compositeLayers(ctx2d, layers, compositeCtx);
}

export { createGLState, destroyGLState } from './gl-context';
