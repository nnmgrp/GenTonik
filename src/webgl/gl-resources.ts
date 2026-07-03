// ============================================================
// gl-resources.ts — program/texture/FBO cache via twgl
// ============================================================
//
// All GL resources (programs, textures, FBOs) are cached on the
// GLState object. Repeated frames with the same layer stack reuse
// the same resources — no per-frame allocation.
//
// CACHE STRATEGIES:
//
//   Programs: keyed by ProgramKey (compile-once). Cached on
//   state.programCache.
//
//   Layer FBOs: keyed by `${w}x${h}` (size pool). When a layer
//   needs an offscreen render target of size (w,h), we reuse any
//   pooled FBO that matches that exact size. Pool is capped at
//   8 entries (same as composite.ts canvasPool) — older FBOs are
//   deleted LRU when the pool is full and a new size is needed.
//
//   Image textures: keyed by imageSrc. Invalidated when the
//   imageSrc changes (rare — only on layer add or image replace).
//
//   Mask textures (painted): keyed by layer.id + mask timestamp.
//   Re-uploaded only when the painted mask data changes.
// ============================================================

import * as twgl from 'twgl.js';
import type { GLState } from './gl-context';
import { PROGRAM_SOURCES, type ProgramKey } from './gl-shaders';

// ────────────────────────────────────────────────────────────
// Program cache
// ────────────────────────────────────────────────────────────

const programCache = new WeakMap<GLState, Map<ProgramKey, WebGLProgram>>();

/**
 * Get (or compile+link) the named program for this GLState.
 *
 * Compiled programs are cached per-GLState (via WeakMap) so they
 * get GC'd when the GLState is destroyed.
 */
export function getProgram(state: GLState, key: ProgramKey): WebGLProgram | null {
  let cache = programCache.get(state);
  if (!cache) {
    cache = new Map();
    programCache.set(state, cache);
  }
  const existing = cache.get(key);
  if (existing) return existing;

  const src = PROGRAM_SOURCES[key];
  if (!src) return null;

  const program = twgl.createProgram(state.gl, [src.vert, src.frag]);
  if (!program) {
    if (typeof console !== 'undefined' && console.error) {
      console.error(`[GenTonik WebGL] failed to compile program "${key}"`);
    }
    return null;
  }
  cache.set(key, program);
  return program;
}

// ────────────────────────────────────────────────────────────
// Layer offscreen FBO pool (size-keyed)
// ────────────────────────────────────────────────────────────

const MAX_POOLED_FBOS = 8;

/**
 * Acquire a layer FBO of the given size from the pool (or create one).
 *
 * The FBO is bound to COLOR_ATTACHMENT0 with an RGBA8 texture.
 * Caller must:
 *   1. Call useLayerFBO(state, w, h) — binds the FBO and sets viewport
 *   2. Render into it (clear first!)
 *   3. The FBO stays bound until the next bind call — caller should
 *      immediately use the texture via getLayerFBOTexture(state, w, h)
 *      for the composite pass.
 *
 * Returns the FBO+texture descriptor, or null on allocation failure.
 */
export function acquireLayerFBO(
  state: GLState,
  w: number,
  h: number,
): { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } | null {
  const { gl } = state;
  if (w <= 0 || h <= 0) return null;
  if (w > state.caps.maxTextureSize || h > state.caps.maxTextureSize) return null;

  const key = `${w}x${h}`;
  const cached = state.layerFBOCache.get(key);
  if (cached) {
    cached.lastUsed = performance.now();
    return cached;
  }

  // Create a new FBO + texture.
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) {
    if (tex) gl.deleteTexture(tex);
    if (fbo) gl.deleteFramebuffer(fbo);
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA8,
    w, h, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, null,
  );
  // v2.12: REVERTED from LINEAR_MIPMAP_LINEAR back to LINEAR.
  // Mipmaps turn crisp black-and-white manga dots into gray mush.
  // Moire is fixed via fwidth()+smoothstep() in the composite shader instead.
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

  const entry = { fbo, tex, w, h, lastUsed: performance.now() };

  // Enforce pool cap — evict the LRU entry if needed.
  if (state.layerFBOCache.size >= MAX_POOLED_FBOS) {
    let lruKey: string | null = null;
    let lruTime = Infinity;
    for (const [k, v] of state.layerFBOCache) {
      if (v.lastUsed < lruTime) {
        lruTime = v.lastUsed;
        lruKey = k;
      }
    }
    if (lruKey) {
      const evicted = state.layerFBOCache.get(lruKey)!;
      gl.deleteFramebuffer(evicted.fbo);
      gl.deleteTexture(evicted.tex);
      state.layerFBOCache.delete(lruKey);
    }
  }

  state.layerFBOCache.set(key, entry);
  return entry;
}

/**
 * Bind a layer FBO as the current render target and set the viewport.
 *
 * After this call, the caller can issue draw calls that render into
 * the FBO. The FBO is NOT cleared automatically — the caller must
 * call gl.clearColor + gl.clear(gl.COLOR_BUFFER_BIT) if needed.
 */
export function bindLayerFBO(
  state: GLState,
  entry: { fbo: WebGLFramebuffer; w: number; h: number },
): void {
  const { gl } = state;
  gl.bindFramebuffer(gl.FRAMEBUFFER, entry.fbo);
  gl.viewport(0, 0, entry.w, entry.h);
  gl.scissor(0, 0, entry.w, entry.h);
}

/**
 * Bind the destination FBO (the main composite target) and set viewport.
 */
export function bindDestFBO(state: GLState): void {
  const { gl } = state;
  gl.bindFramebuffer(gl.FRAMEBUFFER, state.destFBO);
  gl.viewport(0, 0, state.canvasW, state.canvasH);
  gl.scissor(0, 0, state.canvasW, state.canvasH);
}

/**
 * Bind the default framebuffer (the visible canvas) — used for the
 * final blit from destFBO to the screen.
 */
export function bindDefaultFramebuffer(state: GLState): void {
  const { gl } = state;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, state.canvasW, state.canvasH);
  gl.scissor(0, 0, state.canvasW, state.canvasH);
}

// ────────────────────────────────────────────────────────────
// Image texture cache
// ────────────────────────────────────────────────────────────

/**
 * Get (or upload) a GL texture for an HTMLImageElement.
 *
 * Cached by the imageSrc string (passed as cacheKey). If the image
 * was already uploaded with the same key, returns the cached texture.
 *
 * Sets UNPACK_PREMULTIPLY_ALPHA_WEBGL = true so the uploaded texture
 * is in premultiplied form, matching our shader conventions.
 */
export function getImageTexture(
  state: GLState,
  cacheKey: string,
  img: HTMLImageElement,
): WebGLTexture | null {
  const { gl } = state;
  const cached = state.imageTextureCache.get(cacheKey);
  if (cached) return cached.tex;

  const tex = gl.createTexture();
  if (!tex) return null;

  // Allocate storage first (lets us set parameters before upload).
  // We need natural w/h from the image. The caller is expected to
  // have pre-decoded the image (App.tsx useImageCache handles this).
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w <= 0 || h <= 0) {
    gl.deleteTexture(tex);
    return null;
  }

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // v2.12: No mipmaps — LINEAR only (mipmaps turn dots into gray mush)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  state.imageTextureCache.set(cacheKey, { tex, w, h });
  return tex;
}

/**
 * Upload a canvas (e.g., the CPU-rendered screentone for hybrid
 * pattern types) as a GL texture. Not cached — the caller should
 * cache at a higher level (keyed by layer fingerprint).
 *
 * The texture is uploaded with UNPACK_PREMULTIPLY_ALPHA_WEBGL = true
 * because canvas2D fillStyle uses un-premultiplied colors but the
 * resulting pixels are already premultiplied when read via drawImage.
 * Set to false explicitly here to avoid double-premultiplication.
 */
export function uploadCanvasAsTexture(
  state: GLState,
  canvas: HTMLCanvasElement,
): WebGLTexture | null {
  const { gl } = state;
  const tex = gl.createTexture();
  if (!tex) return null;

  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Canvas pixels are already premultiplied (canvas2D compositing).
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // v2.12: No mipmaps — LINEAR only
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return tex;
}

/**
 * Upload a painted mask (single-channel alpha array) as a GL texture.
 * Stored as R8 (single channel). The shader reads .r but we expose
 * it via .a by swizzling in the shader — actually we use RED as the
 * alpha source: in WebGL2, texture(...).r gives the red channel.
 *
 * We upload as RGBA with R=G=B=255, A=alpha so the shader can use .a
 * directly (simpler than dealing with swizzle state).
 */
export function uploadPaintedMaskAsTexture(
  state: GLState,
  maskData: Uint8Array,    // single-channel alpha, length = w*h
  maskW: number,
  maskH: number,
): WebGLTexture | null {
  const { gl } = state;
  if (maskData.length !== maskW * maskH) return null;
  const tex = gl.createTexture();
  if (!tex) return null;

  // Build RGBA buffer: R=G=B=255, A=maskData[i]
  const rgba = new Uint8Array(maskW * maskH * 4);
  for (let i = 0; i < maskData.length; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = maskData[i];
  }

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, maskW, maskH, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return tex;
}

/**
 * Delete a GL texture (utility for cache invalidation).
 */
export function deleteTexture(state: GLState, tex: WebGLTexture): void {
  try { state.gl.deleteTexture(tex); } catch {}
}
