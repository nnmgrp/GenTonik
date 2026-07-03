// ============================================================
// gl-context.ts — WebGL2 context init + capability detection
// ============================================================
//
// Responsibilities:
//   • Acquire a WebGL2 context from a canvas
//   • Detect WebGL2 availability (silent fallback during dev,
//     toast in final GenTonik release)
//   • Cache the GL state (programs, FBOs, textures) on a single
//     GLState object so callers don't re-init every frame
//
// FALLBACK POLICY (per Q2 clarification, 2026-06-27):
//   • During development: SILENT fallback. If WebGL2 is unavailable
//     or context creation fails, `createGLState` returns null and
//     the caller (App.tsx composite useEffect) silently uses the
//     existing canvas2D `compositeLayers` path. No UI warning.
//   • In final GenTonik release: show a toast
//     "WebGL2 недоступен, используется software rendering" then
//     continue with the 2D fallback. (Not yet wired — deferred to
//     the final packaging pass.)
//
// CONTEXT ATTRIBUTES:
//   • premultipliedAlpha: true  — matches canvas2D default; blend
//     math in fragment shaders assumes premultiplied colors.
//   • alpha: true                — composite canvas is transparent
//     where no layer covers (for checkerboard show-through).
//   • preserveDrawingBuffer: false — we don't read back; the
//     composited result is on screen.
//   • antialias: false           — we render pixel-accurate patterns;
//     MSAA would blur screentone dots at edges.
//   • desynchronized: true       — low-latency hint to the compositor.
//
// All exported functions are pure w.r.t. their inputs; the module
// holds no global GL state (each canvas gets its own GLState).
// ============================================================

import * as twgl from 'twgl.js';

/**
 * Per-canvas GL state. Cached on first composite call and reused
 * across frames so we don't pay program-link / FBO-creation cost
 * every render.
 *
 * Lifetime: tied to the canvas. App.tsx holds a ref to this; if
 * the canvas element is replaced (rare — only on full app reload),
 * a new GLState is created.
 */
export interface GLState {
  /** The WebGL2 rendering context. */
  gl: WebGL2RenderingContext;
  /** twgl-managed program registry (compile-on-demand, cached by source). */
  // (twgl tracks programs internally; we just keep a ref to the module.)
  twgl: typeof import('twgl.js');
  /**
   * Pixel size of the canvas's drawing buffer at creation time.
   * Used to detect resize — if the canvas backing store changes,
   * we re-create the destination FBO.
   */
  canvasW: number;
  canvasH: number;
  /**
   * v2.15.2: Physical render size (downscaled if doc > maxTextureSize).
   *
   * When the canvas backing store exceeds GPU's MAX_TEXTURE_SIZE
   * (e.g. 16384 on most desktops, 8192 on Intel, 32768 on modern NVIDIA),
   * we render to a smaller FBO and blitFramebuffer upscales to the
   * visible canvas at the end. This avoids GL errors on oversized docs.
   *
   * Equal to canvasW × canvasH when no downscale is needed.
   * Always <= maxTextureSize.
   */
  renderW: number;
  renderH: number;
  /**
   * v2.15.2: Ratio renderW/canvasW (= renderH/canvasH). Always <= 1.0.
   *
   * All canvas-space polygons (e.g. canvasClipTex rasterization) must
   * be scaled by this factor before being rasterized to a render-sized
   * texture. The shader's u_renderSize uniform uses renderW/renderH
   * (NOT canvasW/canvasH) so gl_FragCoord → maskUV math is correct.
   *
   * LIMITATION: clip mask edges become softer for oversized docs
   * (1 render-pixel = 1/renderScale canvas-pixels). Documented as
   * known limitation; bake/export path uses Canvas2D at full res.
   */
  renderScale: number;
  /**
   * Destination FBO + color attachment. Sized to canvasW × canvasH.
   * We render all layers into this FBO, then blit to the default
   * framebuffer (the visible canvas) at the end of compositeLayersGL.
   *
   * Why an offscreen destination FBO instead of rendering directly
   * to the canvas (default framebuffer)?
   *   • Allows multi-pass: e.g., we can read the current destination
   *     pixels for "destination-in" mask operations without the
   *     WebGL canvas's swap-buffer restrictions.
   *   • Future-proofs for the "A for stability" path (Q6): render to
   *     FBO, then blit/drawImage into a 2D canvas for overlays.
   */
  destFBO: WebGLFramebuffer;
  destTexture: WebGLTexture;
  /** Depth/stencil renderbuffer for destFBO (allocated, currently unused). */
  destDepthStencil: WebGLRenderbuffer | null;
  /**
   * Cached FBO/texture pairs for per-layer offscreen rendering.
   * Keyed by `${w}x${h}` — pooled so we don't allocate per layer
   * per frame. See gl-resources.ts for the pool implementation.
   */
  layerFBOCache: Map<string, { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number; lastUsed: number }>;
  /**
   * Texture cache for image layers, keyed by imageSrc.
   * Invalidated when the imageSrc changes (rare — only on layer add
   * or image replace).
   */
  imageTextureCache: Map<string, { tex: WebGLTexture; w: number; h: number }>;
  /**
   * Capability flags captured at init time. Used by renderers to
   * select code paths (e.g., half-float FBOs for HDR-ish gradient
   * blending — currently unused but reserved).
   */
  caps: GLCaps;
  /** Has the context been lost? Set by webglcontextlost event. */
  lost: boolean;
  /** v2.7: Stored context-loss listener (for cleanup in destroyGLState). */
  _contextLostHandler?: (e: Event) => void;
  /** v2.7: Stored context-restore listener (for cleanup in destroyGLState). */
  _contextRestoredHandler?: () => void;
}

export interface GLCaps {
  /** WebGL2 is available (always true if GLState exists). */
  webgl2: boolean;
  /** Max texture size (typical: 16384 on desktop, 4096 on mobile). */
  maxTextureSize: number;
  /** Max renderbuffer size. */
  maxRenderbufferSize: number;
  /** EXT_color_buffer_float — for float FBO rendering. */
  colorBufferFloat: boolean;
  /** Max samples for MSAA. 0 = no MSAA (we set antialias=false anyway). */
  maxSamples: number;
}

/**
 * Create a GLState for a canvas. Returns null on any failure —
 * caller must fall back to 2D composite.
 *
 * The function NEVER throws. WebGL context creation can fail for
 * many reasons (no GPU driver, context lost, security policy,
 * headless test environment, etc.). All of those are recoverable
 * via the canvas2D fallback.
 *
 * @param canvas  target canvas element
 * @returns GLState, or null if WebGL2 is unavailable
 */
export function createGLState(canvas: HTMLCanvasElement): GLState | null {
  // ── Step 1: acquire WebGL2 context ────────────────────────
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      alpha: true,
      preserveDrawingBuffer: false,
      antialias: false,
      desynchronized: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    }) as WebGL2RenderingContext | null;
  } catch {
    // Some browsers throw on unknown context type. Treat as unavailable.
    return null;
  }

  if (!gl) {
    // WebGL2 not supported (Safari < 15, old Firefox ESR, headless).
    // Silent fallback during dev. Final GenTonik release will toast.
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[GenTonik WebGL] WebGL2 unavailable — using software rendering');
    }
    return null;
  }

  // ── Step 2: probe capabilities ────────────────────────────
  let maxTextureSize = 4096;
  let maxRenderbufferSize = 4096;
  let maxSamples = 0;
  let colorBufferFloat = false;
  try {
    maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
  } catch {
    //getParameter can fail if context is in a weird state. Use defaults.
  }

  // ── Step 3: allocate destination FBO + color texture ──────
  const logicalW = Math.max(1, canvas.width);
  const logicalH = Math.max(1, canvas.height);

  // v2.15.2: Downscale if the canvas exceeds MAX_TEXTURE_SIZE.
  // We render to renderW × renderH and blitFramebuffer upscales to
  // logicalW × logicalH at the end. This lets WebGL handle oversized
  // docs (e.g. 32000×32000 on a 16384-max GPU) by sacrificing some
  // preview resolution — bake/export still use Canvas2D at full res.
  let renderScale = 1.0;
  let renderW = logicalW;
  let renderH = logicalH;
  if (logicalW > maxTextureSize || logicalH > maxTextureSize) {
    renderScale = Math.min(maxTextureSize / logicalW, maxTextureSize / logicalH);
    renderW = Math.max(1, Math.floor(logicalW * renderScale));
    renderH = Math.max(1, Math.floor(logicalH * renderScale));
    if (typeof console !== 'undefined' && console.info) {
      console.info(`[GenTonik WebGL] doc ${logicalW}×${logicalH} exceeds maxTextureSize ${maxTextureSize} — downscaling to ${renderW}×${renderH} (scale=${renderScale.toFixed(4)})`);
    }
  }

  const destTexture = gl.createTexture();
  const destFBO = gl.createFramebuffer();
  if (!destTexture || !destFBO) {
    // Out of memory or driver issue — give up gracefully.
    try { gl.deleteTexture(destTexture); } catch {}
    try { gl.deleteFramebuffer(destFBO); } catch {}
    return null;
  }

  gl.bindTexture(gl.TEXTURE_2D, destTexture);
  gl.texImage2D(
    gl.TEXTURE_2D, 0,
    gl.RGBA8,            // internalformat
    renderW, renderH, 0, // physical render size (NOT logical)
    gl.RGBA,             // format
    gl.UNSIGNED_BYTE,    // type
    null,                // no initial data
  );
  // Texture filtering: NEAREST for crisp screentone pixels.
  // (LINEAR would blur dot edges — wrong for halftone work.)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, destFBO);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    destTexture,
    0,
  );
  // Check FBO completeness — bail out if the driver rejected our config.
  const fboStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (fboStatus !== gl.FRAMEBUFFER_COMPLETE) {
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[GenTonik WebGL] dest FBO incomplete — using software rendering');
    }
    try { gl.deleteTexture(destTexture); } catch {}
    try { gl.deleteFramebuffer(destFBO); } catch {}
    return null;
  }

  // ── Step 4: optional depth/stencil renderbuffer (currently unused) ──
  // Allocated lazily if a shader path needs depth testing.
  // (Perspective warping doesn't need depth — we render a single
  // textured quad per layer, depth order is controlled by draw call
  // order, which already matches layer stack order.)

  // ── Step 5: build GLState ─────────────────────────────────
  const state: GLState = {
    gl,
    twgl,
    canvasW: logicalW,
    canvasH: logicalH,
    renderW,
    renderH,
    renderScale,
    destFBO,
    destTexture,
    destDepthStencil: null,
    layerFBOCache: new Map(),
    imageTextureCache: new Map(),
    caps: {
      webgl2: true,
      maxTextureSize,
      maxRenderbufferSize,
      colorBufferFloat,
      maxSamples,
    },
    lost: false,
  };

  // ── Step 6: hook context-loss events ──────────────────────
  // v2.7: Robust context-loss handling.
  //
  // 'webglcontextlost' fires when the GPU driver reclaims the context
  // (e.g. system sleep/wake, GPU crash, too many contexts, driver update).
  // We mark state.lost = true so compositeLayersGL returns false on the next
  // call — App.tsx will skip rendering this frame (canvas stays at last
  // successful frame, which is better than a blank flash).
  //
  // 'webglcontextrestored' fires after the browser has given us a fresh GL
  // context on the same canvas. But ALL GL resources (textures, FBOs,
  // programs, buffers) are now INVALID — twgl's program cache, our destFBO,
  // layerFBOCache, imageTextureCache all hold stale handles. We can't
  // "restore" them in place; we have to tear down the entire GLState and
  // let createGLState run again on the next composite call.
  //
  // Implementation: on 'restored', evict the GLState from the WeakMap cache
  // (in composite-gl.ts) by marking it lost AND setting a flag that tells
  // compositeLayersWithFallback to recreate. We can't reach the cache from
  // here (it's in composite-gl.ts), so we expose a callback.
  //
  // The actual recreation happens lazily on the next composite call:
  // compositeLayersWithFallback sees state.lost === true, evicts, and
  // createGLState runs fresh. This is simpler than trying to rebuild
  // resources mid-event-handler.
  const handleContextLost = (e: Event) => {
    state.lost = true;
    e.preventDefault(); // allow context restoration
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[GenTonik WebGL] context lost — will restore on next composite call');
    }
  };
  const handleContextRestored = () => {
    // The browser gave us a fresh GL context on the same canvas. But ALL
    // previous GL resources (programs, FBOs, textures, buffers) are now
    // INVALID — they were allocated against the old context and cannot be
    // used with the new one.
    //
    // The safest path is to mark the state as permanently lost so
    // compositeLayersWithFallback will:
    //   1. See state.lost === true
    //   2. Call destroyGLState(state) — frees old resources (best-effort)
    //   3. Evict state from the WeakMap cache
    //   4. Call createGLState(canvas) — allocates fresh resources on the
    //      new context
    //
    // We DON'T do the recreation here because:
    //   - The WeakMap cache in composite-gl.ts owns the lifecycle.
    //   - twgl's program cache is keyed by source string; recompilation
    //     happens automatically on the next getProgram() call.
    //   - Layer FBOs and image textures are recreated on demand.
    //
    // Marking lost=true here is a signal to compositeLayersWithFallback
    // that this state is dead and must be rebuilt.
    state.lost = true;
    if (typeof console !== 'undefined' && console.info) {
      console.info('[GenTonik WebGL] context restored — old state marked for rebuild');
    }
  };
  canvas.addEventListener('webglcontextlost', handleContextLost);
  canvas.addEventListener('webglcontextrestored', handleContextRestored);

  // Store the listeners so destroyGLState can remove them (prevents leaks
  // when the canvas is unmounted).
  state._contextLostHandler = handleContextLost;
  state._contextRestoredHandler = handleContextRestored;

  return state;
}

/**
 * Resize the destination FBO if the canvas backing store changed.
 * Called at the start of each compositeLayersGL pass.
 *
 * Returns true if the FBO was reallocated (or stayed valid), false
 * if reallocation failed (caller should fall back to 2D).
 */
export function ensureGLStateSize(state: GLState, w: number, h: number): boolean {
  if (state.lost) return false;
  if (w <= 0 || h <= 0) return false;

  // v2.15.2: Compute renderScale for the new logical size.
  // The destFBO lives at renderW × renderH (physical); blitFramebuffer
  // upscales to w × h (logical) at the end of compositeLayersGL.
  const maxTex = state.caps.maxTextureSize;
  let renderScale = 1.0;
  let renderW = w;
  let renderH = h;
  if (w > maxTex || h > maxTex) {
    renderScale = Math.min(maxTex / w, maxTex / h);
    renderW = Math.max(1, Math.floor(w * renderScale));
    renderH = Math.max(1, Math.floor(h * renderScale));
  }

  // Fast path: logical size unchanged AND render size unchanged.
  if (w === state.canvasW && h === state.canvasH
      && renderW === state.renderW && renderH === state.renderH
      && renderScale === state.renderScale) {
    return true;
  }

  // Slow path: reallocate destTexture at the new renderW × renderH.
  const { gl } = state;
  try {
    gl.bindTexture(gl.TEXTURE_2D, state.destTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0,
      gl.RGBA8,
      renderW, renderH, 0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    // Update all size trackers. The ping-pong FBOs in composite-gl.ts
    // track their own size via ppW/ppH and will be recreated on the
    // next ensureDestPingPong call if renderW/renderH changed.
    state.canvasW = w;
    state.canvasH = h;
    state.renderW = renderW;
    state.renderH = renderH;
    state.renderScale = renderScale;
    return true;
  } catch {
    return false;
  }
}

/**
 * Release all GL resources held by a GLState.
 *
 * Called when the canvas is unmounted, or when the GL state has
 * been marked lost and we're rebuilding it.
 *
 * v2.7: Also removes the webglcontextlost / webglcontextrestored event
 * listeners to prevent leaks when the canvas is reused or unmounted.
 * Without this, every createGLState on the same canvas would add another
 * pair of listeners that fire forever (memory leak + duplicate handling).
 */
export function destroyGLState(state: GLState): void {
  const { gl } = state;
  // Remove context-loss/restore listeners. We need the canvas reference —
  // gl.canvas is the canvas this context was created from.
  const canvas = gl.canvas as HTMLCanvasElement | null;
  if (canvas) {
    if (state._contextLostHandler) {
      canvas.removeEventListener('webglcontextlost', state._contextLostHandler);
    }
    if (state._contextRestoredHandler) {
      canvas.removeEventListener('webglcontextrestored', state._contextRestoredHandler);
    }
  }
  try {
    for (const { fbo, tex } of state.layerFBOCache.values()) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
    }
    state.layerFBOCache.clear();
    for (const { tex } of state.imageTextureCache.values()) {
      gl.deleteTexture(tex);
    }
    state.imageTextureCache.clear();
    if (state.destDepthStencil) gl.deleteRenderbuffer(state.destDepthStencil);
    gl.deleteTexture(state.destTexture);
    gl.deleteFramebuffer(state.destFBO);
  } catch {
    // Best-effort cleanup; ignore errors.
  }
}
