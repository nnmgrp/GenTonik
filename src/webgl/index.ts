// ============================================================
// webgl/index.ts — public re-exports for the GenTonik WebGL module
// ============================================================
//
// Import from the parent directory:
//   import { compositeLayersWithFallback } from './webgl';
//
// Internal files (gl-context, gl-shaders, etc.) are NOT exported
// here — callers should only depend on the high-level API.
// ============================================================

export {
  compositeLayersWithFallback,
  compositeLayersGL,
  createGLState,
  destroyGLState,
} from './composite-gl';

export type { GLState, GLCaps } from './gl-context';

export { isScreentonePatternPorted } from './render-layer-gl';
