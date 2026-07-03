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
  twgl: typeof import('twgl.js');
  /**
   * Pixel size of the canvas's drawing buffer at creation time.
   * Used to detect resize — if the canvas backing store changes,
   * we re-create the destination FBO.
   */
  canvasW: number;
  canvasH: number;
  /** Physical render size (downscaled if doc > maxTextureSize). */
  renderW: number;
  renderH: number;
  /** Ratio render / logical. All canvas-space polygons must be scaled by this before rasterization. */
  renderScale: number;
  /**
   * Destination FBO + color attachment. Sized to canvasW × canvasH.
   * We render all layers into this FBO, then blit to the default
   * framebuffer (the visible canvas) at the end of compositeLayersGL.
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

  let renderW = logicalW;
  let renderH = logicalH;
  let renderScale = 1.0;

  if (logicalW > maxTextureSize || logicalH > maxTextureSize) {
    renderScale = Math.min(maxTextureSize / logicalW, maxTextureSize / logicalH);
    renderW = Math.floor(logicalW * renderScale);
    renderH = Math.floor(logicalH * renderScale);
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
    renderW, renderH, 0, // physical render size
    gl.RGBA,             // format
    gl.UNSIGNED_BYTE,    // type
    null,                // no initial data
  );
  // Texture filtering: NEAREST for crisp screentone pixels.
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
  const handleContextLost = (e: Event) => {
    state.lost = true;
    e.preventDefault(); // allow context restoration
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[GenTonik WebGL] context lost — will restore on next composite call');
    }
  };
  const handleContextRestored = () => {
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
  if (w === state.canvasW && h === state.canvasH) return true;
  if (w <= 0 || h <= 0) return false;

  const maxTex = state.caps.maxTextureSize;
  let renderScale = 1.0;
  let renderW = w;
  let renderH = h;

  if (w > maxTex || h > maxTex) {
    renderScale = Math.min(maxTex / w, maxTex / h);
    renderW = Math.floor(w * renderScale);
    renderH = Math.floor(h * renderScale);
  }

  // Fast path: render size unchanged, only logical size updated
  if (renderW === state.renderW && renderH === state.renderH && renderScale === state.renderScale) {
    state.canvasW = w;
    state.canvasH = h;
    return true;
  }

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
 */
export function destroyGLState(state: GLState): void {
  const { gl } = state;
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
