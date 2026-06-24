// ============================================================
// TYPES & PRESETS — GenToniK Screentone Generator v2
// ============================================================
//
// This file is the CONTRACT. Everything else (engine.ts, composite.ts,
// App.tsx, preset-store.ts, ora-format.ts) depends on these types.
// Change them here first, then update the consumers.
//
// v2 changes vs v1:
//   • Layer is now multi-type: 'screentone' | 'image' | 'solid'
//   • Layer has transform, blendMode, and optional mask
//   • PresetV2 supports CRUD (id, timestamps, isBuiltIn)
//   • ScreentoneParams: +unit, +sizeMode, +tileWidth/Height, +customWidth/Height
//                       −exportWidth, −exportHeight, −fileName
//   • Mask contract supports both 'shape' and 'painted' (painting TBD)
// ============================================================


// ────────────────────────────────────────────────────────────
// SCREENTONE PARAMS
// ────────────────────────────────────────────────────────────

/**
 * 2D vector / point. Used by LayerTransform.corners, homography,
 * transform-panel, and selection tools.
 */
export interface Vec2 {
  x: number;
  y: number;
}

export type PatternType =
  | 'dots'
  | 'lines'
  | 'crosshatch'
  | 'noise'
  | 'hexgrid'
  | 'concentric'
  | 'stars'
  | 'hearts'
  | 'triangles'
  | 'checker'
  | 'gaussian_noise'
  | 'stipple';

export type DotShape = 'circle' | 'square' | 'diamond' | 'hexagon';
export type GradientType = 'none' | 'linear' | 'radial';
export type MappingSource = 'none' | 'image_brightness' | 'image_alpha';

/**
 * Units for spacing/dotSize inputs.
 * - 'px'  — raw pixels (current behavior)
 * - 'mm'  — millimeters, converted to px via DPI
 * - 'in'  — inches, converted to px via DPI
 * - 'lpi' — lines per inch (industry standard for screentone density).
 *           spacing_px = DPI / lpi
 */
export type SizeUnit = 'px' | 'mm' | 'in' | 'lpi';

/**
 * How the render canvas size is determined.
 * - 'match-document'  — fill the whole Standalone canvas / PS document
 * - 'match-selection' — fill only the active selection bounds (PS round-trip)
 * - 'tile'            — fixed-size seamless tile, registered as Photoshop Pattern
 * - 'custom'          — user-specified customWidth × customHeight
 */
export type RenderSizeMode = 'match-document' | 'match-selection' | 'tile' | 'custom';

export interface ScreentoneParams {
  // ── Pattern ──────────────────────────────────────────────
  patternType: PatternType;
  dotShape: DotShape;
  dotSize: number;
  spacingX: number;
  spacingY: number;
  density: number;
  angle: number;
  lineWidth: number;
  crossAngle: number;

  // ── Satellites ───────────────────────────────────────────
  satelliteEnabled: boolean;
  satelliteSize: number;
  satelliteDistance: number;
  satelliteCount: number;
  satelliteAngle: number;
  satelliteDotShape: DotShape;
  satelliteStretch: number;

  // ── Distortion ───────────────────────────────────────────
  aspectY: number;
  aspectX: number;
  rowOffset: number;
  mergeFactor: number;
  jitterPos: number;
  jitterSize: number;
  roundness: number;                 // 0–1, applied via corner rounding

  // ── Gradient mapping ─────────────────────────────────────
  gradType: GradientType;
  gradAngle: number;
  gradReverse: boolean;
  gradMidpoint: number;
  gradSizeStart: number;
  gradSizeEnd: number;
  gradStretchStart: number;
  gradStretchEnd: number;
  gradColorTrans: boolean;

  // ── Colors ───────────────────────────────────────────────
  colorPattern: string;
  colorBg: string;

  // ── Canvas rotation ──────────────────────────────────────
  rotCanvas: number;
  rotPattern: number;

  // ── Image mask (legacy, for image_brightness mapping) ────
  maskSource: MappingSource;
  maskInvert: boolean;
  maskThreshold: number;
  maskSmoothness: number;

  // ── Seamless tiling ──────────────────────────────────────
  seamless: boolean;

  // ── NEW: Units & sizing ──────────────────────────────────
  unit: SizeUnit;
  sizeMode: RenderSizeMode;
  tileWidth: number;                 // px, used when sizeMode === 'tile'
  tileHeight: number;                // px, used when sizeMode === 'tile'
  customWidth: number;               // px, used when sizeMode === 'custom'
  customHeight: number;              // px, used when sizeMode === 'custom'

  // ── REMOVED (vs v1) ──────────────────────────────────────
  // exportWidth: number;   — replaced by sizeMode + document/selection bounds
  // exportHeight: number;  — replaced by sizeMode + document/selection bounds
  // fileName: string;      — responsibility of the host (Standalone or PS)
}


// ────────────────────────────────────────────────────────────
// LAYER MODEL (multi-type, with transform, blend, mask)
// ────────────────────────────────────────────────────────────

/**
 * Layer types:
 * - 'screentone' — procedural pattern generated from ScreentoneParams
 * - 'image'      — raster image (lineart, scan, photo reference)
 * - 'solid'      — solid color fill (typically background)
 */
export type LayerType = 'screentone' | 'image' | 'solid';

/**
 * Blend modes. Limited to the 6 that matter for screentone work.
 * Mapped to Canvas2D globalCompositeOperation in composite.ts.
 */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten';

/**
 * Layer transform. Applied at composite time, NOT at render time.
 * - x, y         — pixel offset of the layer's center from the canvas origin
 * - scaleX, scaleY — 1.0 = native size
 * - rotation     — degrees, clockwise
 */
export interface LayerTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  /**
   * Horizontal skew (shear) in degrees. Positive = top tilts right.
   * Applied AFTER scale, BEFORE rotation in the composite pipeline.
   * Range typically [-89, 89] (90° would make the layer degenerate).
   * Default: 0.
   */
  skewX: number;
  /**
   * Vertical skew (shear) in degrees. Positive = left side tilts down.
   * Applied AFTER scale, BEFORE rotation in the composite pipeline.
   * Default: 0.
   */
  skewY: number;
  /**
   * Optional 4-corner free-transform override (Phase 2 — perspective).
   *
   * If set (non-null), the layer is rendered via homography using
   * these 4 canvas-space corners instead of the affine transform
   * (x, y, scale, rotation, skew are IGNORED while corners is set).
   *
   * Corner order: [TL, TR, BR, BL] (top-left, top-right,
   * bottom-right, bottom-left) in canvas-pixel coordinates.
   *
   * Set to null/undefined to revert to affine transform. The affine
   * fields are preserved during perspective editing, so reverting
   * restores the previous affine state.
   *
   * Default: null (affine mode).
   */
  corners?: [Vec2, Vec2, Vec2, Vec2] | null;
}

/**
 * Discriminated union for layer masks.
 *
 * 'shape'  — geometric mask (ellipse/rect), fast to implement.
 *            Used for "tone only inside this area" without painting.
 *
 * 'painted' — user-painted mask via brush tool (planned, not yet implemented).
 *             Stored as a single-channel ImageData (alpha only).
 *             The 'data' field is serialized separately when saving to .ora
 *             or localStorage.
 *
 * The discriminator 'type' lets us add more variants later without
 * breaking existing serialized layers.
 */
export type LayerMask =
  | {
      type: 'shape';
      shape: 'ellipse' | 'rect';
      bounds: Bounds;                 // canvas-space, in px
      feather: number;                // px, 0 = hard edge
      invert: boolean;
    }
  | {
      type: 'painted';
      width: number;                  // px
      height: number;                 // px
      /**
       * Single-channel alpha values, 0–255.
       * Length MUST be width × height.
       * Stored as Uint8Array for efficiency; serialized as base64 in JSON.
       */
      data: Uint8Array;
      invert: boolean;
    };

/**
 * Axis-aligned rectangle in canvas-space pixels.
 * Used for selection bounds, mask bounds, layer bounds, etc.
 */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The unified Layer model.
 *
 * For 'screentone' layers, `params` is required.
 * For 'image' layers, `imageSrc` is required (data URL or object URL).
 * For 'solid' layers, `solidColor` is required (CSS hex string).
 *
 * `transform` is always present (never undefined) — defaults to identity.
 * `mask` is optional.
 */
export interface Layer {
  id: string;
  name: string;
  type: LayerType;
  visible: boolean;
  opacity: number;                    // 0–1
  blendMode: BlendMode;
  transform: LayerTransform;

  // Type-specific payload
  params?: ScreentoneParams;          // type === 'screentone'
  imageSrc?: string;                  // type === 'image' (data: URL preferred)
  solidColor?: string;                // type === 'solid'

  // Optional mask
  mask?: LayerMask;

  // Bookkeeping
  createdAt: number;
  updatedAt: number;
}


// ────────────────────────────────────────────────────────────
// PRESETS (v2 — with CRUD)
// ────────────────────────────────────────────────────────────

/**
 * Preset v2.
 *
 * Differences vs v1 Preset:
 *   + id           — stable identifier for CRUD
 *   + isBuiltIn    — built-ins cannot be deleted (but can be duplicated)
 *   + createdAt/updatedAt — for sorting and display
 *   + Optional description / tags for search
 *
 * Built-in presets are seeded at first launch.
 * User presets live in localStorage and can be exported/imported as JSON.
 */
export interface PresetV2 {
  id: string;
  name: string;
  icon: string;
  category: string;
  description?: string;
  tags?: string[];
  params: ScreentoneParams;
  isBuiltIn: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Shape of an exported presets file (.json).
 * Used by preset-store.ts for import/export.
 */
export interface PresetFile {
  format: 'gentonik-presets';
  version: 2;
  exportedAt: number;
  presets: PresetV2[];
}


// ────────────────────────────────────────────────────────────
// DEFAULTS
// ────────────────────────────────────────────────────────────

export const DEFAULT_PARAMS: ScreentoneParams = {
  // Pattern
  patternType: 'dots',
  dotShape: 'circle',
  dotSize: 6,
  spacingX: 16,
  spacingY: 16,
  density: 0.5,
  angle: 0,
  lineWidth: 1.5,
  crossAngle: 45,
  // Satellites
  satelliteEnabled: false,
  satelliteSize: 6,
  satelliteDistance: 25,
  satelliteCount: 4,
  satelliteAngle: 0,
  satelliteDotShape: 'circle',
  satelliteStretch: 0,
  // Distortion
  aspectY: 1,
  aspectX: 1,
  rowOffset: 0,
  mergeFactor: 0,
  jitterPos: 0,
  jitterSize: 0,
  roundness: 0,
  // Gradient
  gradType: 'none',
  gradAngle: 90,
  gradReverse: false,
  gradMidpoint: 0.5,
  gradSizeStart: 1,
  gradSizeEnd: 1,
  gradStretchStart: 1,
  gradStretchEnd: 1,
  gradColorTrans: false,
  // Colors
  colorPattern: '#000000',
  colorBg: '#ffffff',
  // Canvas rotation
  rotCanvas: 0,
  rotPattern: 0,
  // Image mask (legacy)
  maskSource: 'none',
  maskInvert: false,
  maskThreshold: 0.5,
  maskSmoothness: 1,
  // Seamless
  seamless: false,
  // Units & sizing (NEW)
  unit: 'px',
  sizeMode: 'match-document',
  tileWidth: 256,
  tileHeight: 256,
  customWidth: 2000,
  customHeight: 2000,
};

export const DEFAULT_TRANSFORM: LayerTransform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  skewX: 0,
  skewY: 0,
  corners: null,
};

export const BLEND_MODES: { value: BlendMode; label: string; compositeOp: GlobalCompositeOperation }[] = [
  { value: 'normal',  label: 'Normal',   compositeOp: 'source-over' },
  { value: 'multiply', label: 'Multiply', compositeOp: 'multiply' },
  { value: 'screen',  label: 'Screen',   compositeOp: 'screen' },
  { value: 'overlay', label: 'Overlay',  compositeOp: 'overlay' },
  { value: 'darken',  label: 'Darken',   compositeOp: 'darken' },
  { value: 'lighten', label: 'Lighten',  compositeOp: 'lighten' },
];

/**
 * Map BlendMode → Canvas2D composite operation.
 * Used by composite.ts.
 */
export function blendToCompositeOp(mode: BlendMode): GlobalCompositeOperation {
  const found = BLEND_MODES.find(b => b.value === mode);
  return found ? found.compositeOp : 'source-over';
}


// ────────────────────────────────────────────────────────────
// BUILT-IN PRESETS (migrated from v1, all categories preserved)
// ────────────────────────────────────────────────────────────

const PRESET_BASE_OVERRIDES: Partial<ScreentoneParams> = {
  unit: 'px',
  sizeMode: 'match-document',
  tileWidth: 256,
  tileHeight: 256,
  customWidth: 2000,
  customHeight: 2000,
};

function makePreset(
  id: string,
  name: string,
  icon: string,
  category: string,
  overrides: Partial<ScreentoneParams>,
  description?: string,
): PresetV2 {
  const now = Date.now();
  return {
    id,
    name,
    icon,
    category,
    description,
    params: { ...DEFAULT_PARAMS, ...PRESET_BASE_OVERRIDES, ...overrides },
    isBuiltIn: true,
    createdAt: now,
    updatedAt: now,
  };
}

export const BUILT_IN_PRESETS: PresetV2[] = [
  // ── Classic Dots ─────────────────────────────────────────
  makePreset('classic-10', 'Deleter 10% Dot', '⚪', 'Classic Dots',
    { patternType: 'dots', dotShape: 'circle', dotSize: 3, spacingX: 25, spacingY: 25, density: 0.1 },
    'Light screentone for highlights and subtle shading.'),

  makePreset('classic-30', 'Deleter 30% Dot', '⚫', 'Classic Dots',
    { patternType: 'dots', dotShape: 'circle', dotSize: 5.5, spacingX: 22, spacingY: 22, density: 0.3 },
    'Standard mid-tone for manga shading.'),

  makePreset('classic-60', 'Deleter 60% Dot', '🔘', 'Classic Dots',
    { patternType: 'dots', dotShape: 'circle', dotSize: 8, spacingX: 20, spacingY: 20, density: 0.6 },
    'Heavy shading tone for shadows.'),

  makePreset('square-dots', 'Square Dots', '⬜', 'Classic Dots',
    { patternType: 'dots', dotShape: 'square', dotSize: 6, spacingX: 22, spacingY: 22, density: 0.4, angle: 45 },
    'Square-dot screentone with 45° rotation.'),

  makePreset('diamond-dots', 'Diamond Dots', '🔷', 'Classic Dots',
    { patternType: 'dots', dotShape: 'diamond', dotSize: 7, spacingX: 22, spacingY: 22, density: 0.4 },
    'Diamond-shaped dot pattern.'),

  // ── Lines & Hatching ─────────────────────────────────────
  makePreset('lines-45', 'Parallel Lines 45°', '▤', 'Lines & Hatching',
    { patternType: 'lines', dotSize: 3, spacingX: 12, spacingY: 12, density: 0.5, angle: 45, lineWidth: 1.5 },
    'Diagonal hatching lines.'),

  makePreset('crosshatch', 'Crosshatch', '╳', 'Lines & Hatching',
    { patternType: 'crosshatch', dotSize: 3, spacingX: 15, spacingY: 15, density: 0.5, angle: 45, lineWidth: 1, crossAngle: 90 },
    'Two-layer crosshatch for dense shading.'),

  makePreset('fine-lines', 'Fine Lines 0°', '≡', 'Lines & Hatching',
    { patternType: 'lines', dotSize: 2, spacingX: 8, spacingY: 8, density: 0.3, angle: 0, lineWidth: 0.8 },
    'Horizontal fine lines for subtle texture.'),

  // ── Texture ──────────────────────────────────────────────
  makePreset('gauze', 'Gauze / Sand', '🏖', 'Texture',
    { patternType: 'noise', dotSize: 2, spacingX: 6, spacingY: 6, density: 0.3, jitterPos: 30, jitterSize: 50 },
    'Random noise pattern, good for sand and grain textures.'),

  makePreset('heavy-noise', 'Heavy Noise', '🌫', 'Texture',
    { patternType: 'gaussian_noise', dotSize: 2, spacingX: 4, spacingY: 4, density: 0.5, jitterPos: 50, jitterSize: 60 },
    'Dense Gaussian noise for organic textures.'),

  makePreset('stipple', 'Stipple / Pointillism', '·', 'Texture',
    { patternType: 'stipple', dotSize: 2, spacingX: 8, spacingY: 8, density: 0.4, jitterPos: 40, jitterSize: 40 },
    'Stippled dots with random size variation.'),

  // ── Geometric ────────────────────────────────────────────
  makePreset('hex-grid', 'Hex Grid', '⬡', 'Geometric',
    { patternType: 'hexgrid', dotSize: 8, spacingX: 20, spacingY: 20, density: 0.5 },
    'Honeycomb hexagonal grid pattern.'),

  makePreset('checker', 'Checkerboard', '🏁', 'Geometric',
    { patternType: 'checker', dotSize: 10, spacingX: 20, spacingY: 20, density: 0.5 },
    'Classic checkerboard pattern.'),

  makePreset('triangles', 'Triangles ▲', '🔺', 'Geometric',
    { patternType: 'triangles', dotSize: 10, spacingX: 30, spacingY: 30, density: 0.4 },
    'Repeating triangle shapes.'),

  // ── Effects ──────────────────────────────────────────────
  makePreset('concentric', 'Concentric Circles', '◎', 'Effects',
    { patternType: 'concentric', dotSize: 5, spacingX: 20, spacingY: 20, density: 0.5, lineWidth: 1.5,
      gradType: 'radial', gradSizeStart: 1, gradSizeEnd: 0.1 },
    'Concentric rings with radial size gradient.'),

  // ── Fun & Shojo ──────────────────────────────────────────
  makePreset('stars', 'Stars ★', '⭐', 'Fun & Shojo',
    { patternType: 'stars', dotSize: 8, spacingX: 40, spacingY: 40, density: 0.4, jitterPos: 20, jitterSize: 20 },
    'Sparkle stars for shojo manga effects.'),

  makePreset('hearts', 'Hearts ♥', '💜', 'Fun & Shojo',
    { patternType: 'hearts', dotSize: 8, spacingX: 35, spacingY: 35, density: 0.3, jitterPos: 15, jitterSize: 15 },
    'Heart shapes for romantic effects.'),

  // ── Gradient Effects ─────────────────────────────────────
  makePreset('radial-grad', 'Radial Gradient Dots', '🔵', 'Gradient Effects',
    { patternType: 'dots', dotSize: 6, spacingX: 18, spacingY: 18, density: 0.5,
      gradType: 'radial', gradSizeStart: 1.5, gradSizeEnd: 0 },
    'Dots fading from large (center) to zero (edge).'),

  makePreset('linear-fade', 'Linear Gradient Fade', '📐', 'Gradient Effects',
    { patternType: 'dots', dotSize: 5, spacingX: 16, spacingY: 16, density: 0.5,
      gradType: 'linear', gradAngle: 90, gradSizeStart: 1.5, gradSizeEnd: 0, gradColorTrans: true },
    'Linear fade with color transition to background.'),

  // ── Original (advanced) ──────────────────────────────────
  makePreset('planets', 'Planets & Satellites', '🪐', 'Original',
    { patternType: 'dots', dotSize: 15, spacingX: 80, spacingY: 69, density: 0.5,
      satelliteEnabled: true, satelliteSize: 6, satelliteDistance: 25, satelliteCount: 4, rowOffset: 0.5,
      gradType: 'radial', gradSizeStart: 1, gradSizeEnd: 0 },
    'Demo of satellites — main dots with orbiting smaller dots.'),
];

export const PATTERN_CATEGORIES = Array.from(new Set(BUILT_IN_PRESETS.map(p => p.category)));


// ────────────────────────────────────────────────────────────
// LAYER FACTORIES
// ────────────────────────────────────────────────────────────

let layerCounter = 0;

function makeLayerId(): string {
  layerCounter++;
  return `layer-${Date.now()}-${layerCounter}`;
}

export function createScreentoneLayer(
  name: string,
  params: ScreentoneParams = DEFAULT_PARAMS,
): Layer {
  const now = Date.now();
  return {
    id: makeLayerId(),
    name,
    type: 'screentone',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...DEFAULT_TRANSFORM },
    params: { ...params },
    createdAt: now,
    updatedAt: now,
  };
}

export function createImageLayer(name: string, imageSrc: string): Layer {
  const now = Date.now();
  return {
    id: makeLayerId(),
    name,
    type: 'image',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...DEFAULT_TRANSFORM },
    imageSrc,
    createdAt: now,
    updatedAt: now,
  };
}

export function createSolidLayer(name: string, color: string): Layer {
  const now = Date.now();
  return {
    id: makeLayerId(),
    name,
    type: 'solid',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...DEFAULT_TRANSFORM },
    solidColor: color,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Returns the natural width/height of a layer's content (before transform).
 * For 'screentone' this is the document size (caller provides it).
 * For 'image' this is the image's intrinsic size (caller provides it).
 * For 'solid' this is 1×1 (it's a fill).
 *
 * Used by composite.ts to compute the layer's effective bounds after transform.
 */
export function getLayerNaturalSize(
  layer: Layer,
  context: { docWidth: number; docHeight: number; imageSizes: Map<string, { w: number; h: number }> },
): { w: number; h: number } {
  switch (layer.type) {
    case 'screentone':
      return { w: context.docWidth, h: context.docHeight };
    case 'image': {
      const size = context.imageSizes.get(layer.imageSrc ?? '');
      return size ?? { w: 0, h: 0 };
    }
    case 'solid':
      return { w: 1, h: 1 };
  }
}
