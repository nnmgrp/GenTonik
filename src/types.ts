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

  // ── v2.9: Tone frequency (forward-compat) ────────────────
  // Frequency in lines-per-inch (LPI), derived from dotSize/spacing but
  // stored explicitly for halftone-style workflows where the user thinks
  // in frequency rather than spacing. Default 0 = "not set" (use spacing
  // directly). When > 0, a future renderer can use this to compute
  // spacing = dpi / frequency automatically.
  frequency: number;

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
 * - 'screentone'  — procedural pattern generated from ScreentoneParams
 * - 'image'       — raster image (lineart, scan, photo reference)
 * - 'solid'       — solid color fill (typically background; auto-created
 *                   via New Document dialog → Background: White)
 * - 'transparent' — empty layer with no fill. Useful as a container for
 *                   masks/transforms or as a placeholder for future painting
 *                   tools. Renders nothing on its own, but can host a mask
 *                   (e.g. "Mask from Sel" applied to a transparent layer
 *                   becomes a stencil cut-out revealing lower layers).
 * - 'text'        — STUB (v2.9 forward-compat). Text layer for future
 *                   typography tools (manga dialogue, sound effects).
 *                   Render: no-op for now (renders nothing). Will be
 *                   implemented when FontRegistry + text rendering land.
 * - 'vector'      — STUB (v2.9 forward-compat). Vector shape layer for
 *                   future drawing tools (speed lines, frames, panels).
 *                   Render: no-op for now. Will be implemented when
 *                   VectorRenderer lands.
 *
 * Why a separate type (vs. solid with rgba(0,0,0,0)):
 *   A solid layer with transparent fill is semantically misleading — it's
 *   still "a fill" that happens to be invisible. Worse, fillRect with
 *   rgba(0,0,0,0) is a no-op in Canvas2D and may produce surprising results
 *   under WebGL (premultiplied alpha). A dedicated 'transparent' type makes
 *   the intent explicit and lets the renderer short-circuit cleanly.
 *
 * Forward-compat note (v2.9):
 *   'text' and 'vector' are reserved for future WebToonTools / typography
 *   extensions. The stubs exist so that .ora round-trip, undo/redo, and
 *   the layer panel can handle these types gracefully (show them in the
 *   list, allow delete/reorder, but render nothing) BEFORE the actual
 *   rendering code is written. This avoids a "big bang" migration later.
 */
export type LayerType = 'screentone' | 'image' | 'solid' | 'transparent' | 'text' | 'vector';

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
      /**
       * Top-left anchor of the mask in LAYER-LOCAL pixel space.
       *
       * composite.ts applies the painted mask BEFORE the layer transform
       * (see L577-578 + comment at L25-27). That means the mask lives in
       * the layer's natural-size coordinate system (0..naturalW, 0..naturalH),
       * NOT in canvas-pixel space.
       *
       * - Mask editor always paints full-size, so offsetX=offsetY=0.
       * - Selection tools (lasso/marquee) compute the polygon in canvas-px,
       *   then invert(layerMatrix) maps it into layer-local space. The mask's
       *   tight bounding box then has offsetX/offsetY = floor(bounds.left/top).
       *
       * Without these fields, applyPaintedMask draws at (0,0) → mask lands
       * in the top-left of the layer regardless of where the user selected.
       * (A2-fix-mask-transform, 2026-06-25.)
       */
      offsetX: number;                // px, layer-local
      offsetY: number;                // px, layer-local
      invert: boolean;
      /**
       * CANVAS-SPACE MASK (PRESERVE-PERSPECTIVE feature, 2026-06-28):
       *
       * When set, this polygon (in CANVAS-pixel space) is used as a
       * post-perspective clip. The painted `data`/`offsetX`/`offsetY`
       * (layer-local) are ignored. Instead, after the layer is rendered
       * (with perspective if corners set), the destination ctx is clipped
       * to this polygon.
       *
       * This produces a "mask by canvas shape" result: the visible area
       * on the canvas matches the selection outline exactly, regardless
       * of the layer's perspective deformation. (Contrast with the default
       * layer-local mask, which produces "mask by object shape" — the
       * mask boundary follows the perspective-deformed layer.)
       *
       * Set by "Mask from Sel → by canvas shape" modal path.
       * Undefined for normal layer-local masks (mask editor, "by object shape").
       */
      canvasSpacePolygon?: Vec2[];
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
 * v2.9: Color space for a layer's content.
 *
 * This is PER-LAYER (not per-document). The document's `colorProfile` (gray8/
 * rgb8/cmyk8) is the OUTPUT space; each layer can have its own internal space
 * and the compositor converts at draw time. This forward-compat field lets
 * future WebToonTools layers declare their own space (e.g., a CMYK proof
 * layer inside an RGB document).
 *
 * - 'srgb'    — standard sRGB gamma (default). What 99% of layers use.
 * - 'linear'  — linear light (gamma 1.0). Used by some HDR workflows.
 * - 'gray8'   — 8-bit grayscale. Matched against doc.colorProfile.
 * - 'cmyk8'   — 8-bit CMYK. STUB — renderer throws "not implemented" if
 *               composited in GenToniK stage. WebToonTools will handle it.
 *
 * Default: 'srgb' for all layers (backward compat — old .ora files without
 * this field load as 'srgb').
 */
export type LayerColorSpace = 'srgb' | 'linear' | 'gray8' | 'cmyk8';

/**
 * The unified Layer model.
 *
 * For 'screentone' layers, `params` is required.
 * For 'image' layers, `imageSrc` is required (data URL or object URL).
 * For 'solid' layers, `solidColor` is required (CSS hex string).
 * For 'transparent' layers, no payload (renders nothing).
 * For 'text' layers, `textData` is required (STUB — not yet rendered).
 * For 'vector' layers, `vectorData` is required (STUB — not yet rendered).
 *
 * `transform` is always present (never undefined) — defaults to identity.
 * `mask` is optional.
 *
 * v2.9 forward-compat fields:
 *   - `meta` — arbitrary metadata bag for plugins (e.g., WebToonTools can
 *     store "this layer is a speed-line group" without polluting the core
 *     Layer type). Treated as opaque by the core; never affects rendering.
 *   - `colorSpace` — per-layer color space (see LayerColorSpace). Default
 *     'srgb' for backward compat.
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
  textData?: TextLayerData;           // type === 'text' (STUB v2.9)
  vectorData?: VectorLayerData;       // type === 'vector' (STUB v2.9)

  // Optional mask
  mask?: LayerMask;

  /**
   * Optional override for the layer's natural size.
   *
   * For 'screentone' layers: if set, the screentone is rendered into
   * a canvas of this size instead of the document size. Used by
   * "New Layer from Selection" (A2.2) to create a localized screentone
   * object whose natural bounds match the selection bbox.
   */
  naturalWidth?: number;
  naturalHeight?: number;

  /**
   * v2.9: Per-layer color space. Default 'srgb' (backward compat).
   * See LayerColorSpace for details.
   */
  colorSpace?: LayerColorSpace;

  /**
   * v2.9: Arbitrary metadata bag for plugins / future features.
   *
   * The core treats this as opaque — never reads or writes it for rendering
   * decisions. Plugins (WebToonTools, future tools) can store whatever they
   * need here without modifying the core Layer type.
   *
   * Example: a plugin marks a layer as "speed-line group" via
   * `layer.meta.speedLineGroup = { angle: 45, density: 0.8 }`. The core
   * ignores it; the plugin's renderer reads it.
   *
   * Serialized to .ora as JSON in a gentonik:meta attribute.
   */
  meta?: Record<string, unknown>;

  // Bookkeeping
  createdAt: number;
  updatedAt: number;
}

/**
 * v2.9 STUB: Text layer data.
 *
 * Placeholder for future typography tools. The fields here are the MINIMAL
 * set that a text renderer would need; actual implementation will likely
 * expand this (kerning, ligatures, vertical text for Japanese, etc.).
 *
 * The core does NOT render text layers — `composite.ts` case 'text' is a
 * no-op. A future TextRenderer (using FontRegistry) will handle it.
 */
export interface TextLayerData {
  /** The text content (plain string; no markup for now). */
  text: string;
  /** Font family name (resolved via FontRegistry). */
  fontFamily: string;
  /** Font size in px (in layer-local space, before transform). */
  fontSize: number;
  /** Font weight (400 = normal, 700 = bold). */
  fontWeight?: number;
  /** Font style ('normal' | 'italic'). */
  fontStyle?: 'normal' | 'italic';
  /** Text color (CSS hex string, e.g. '#000000'). */
  color: string;
  /** Text alignment within the layer's natural bounds. */
  align?: 'left' | 'center' | 'right';
  /** Line height multiplier (1.0 = normal). */
  lineHeight?: number;
}

/**
 * v2.9 STUB: Vector layer data.
 *
 * Placeholder for future vector drawing tools (speed lines, frames, panels,
 * speech bubbles). The core does NOT render vector layers — `composite.ts`
 * case 'vector' is a no-op. A future VectorRenderer will handle it.
 *
 * The shape list is intentionally minimal; future versions can add more
 * shape types (curve, path, polygon with holes, etc.) without breaking
 * the .ora round-trip (old files just have fewer shapes).
 */
export interface VectorLayerData {
  /** List of vector shapes. Each shape has a type + type-specific params. */
  shapes: VectorShape[];
  /** Default fill color for shapes that don't specify their own. */
  defaultFill?: string;
  /** Default stroke color. */
  defaultStroke?: string;
  /** Default stroke width in px (layer-local space). */
  defaultStrokeWidth?: number;
}

/**
 * v2.9 STUB: A single vector shape.
 *
 * Discriminated union on `kind`. Currently only 'line' and 'rect' are
 * defined (enough for speed lines and frames). Future: 'ellipse', 'path',
 * 'polygon', 'curve'.
 */
export type VectorShape =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; strokeWidth?: number; stroke?: string }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; strokeWidth?: number };

/**
 * A2.1b: Single entry in a multi-polygon selection.
 *
 * A selection can be built up from multiple drag operations:
 *   - 'new'       — first entry, replaces previous selection
 *   - 'add'       — union with existing
 *   - 'subtract'  — difference from existing
 *   - 'intersect' — intersection with existing
 *
 * Each entry stores BOTH canvas-px and layer-local polygons:
 *   - canvasPolygon  — for marching ants rendering (canvas-space)
 *   - layerLocalPolygon — for apply-as-mask rasterization (layer-local space)
 *
 * Both are computed at commit time from the same drag, so they're
 * guaranteed consistent. Storing both avoids recomputing inverse(layerMatrix)
 * on every frame or on apply.
 */
export interface SelectionEntry {
  /** Operation this entry performs on the accumulated selection. */
  op: SelectionOpMode;
  /** Polygon vertices in CANVAS-PIXEL space (for marching ants rendering). */
  canvasPolygon: Vec2[];
  /** Polygon vertices in LAYER-LOCAL space (for mask rasterization). */
  layerLocalPolygon: Vec2[];
  /** Selection kind that produced this entry. */
  kind: 'rect' | 'ellipse' | 'lasso' | 'polygonal';
}

/**
 * A2.1b: Multi-entry committed selection.
 *
 * `entries[0]` should always have op='new' (or op matching what user
 * intended for first entry — but typically 'new'). Subsequent entries
 * are 'add' / 'subtract' / 'intersect'.
 *
 * Empty `entries` array or null = no selection (marching ants hidden).
 */
export interface ActiveSelection {
  entries: SelectionEntry[];
}

/**
 * Selection operation mode — controls how a new selection drag interacts
 * with the existing committed `activeSelection`.
 *
 * - 'new'       — replace existing selection (default, current behavior)
 * - 'add'       — union with existing (A2.1b)
 * - 'subtract'  — difference from existing (A2.1b)
 * - 'intersect' — intersection with existing (A2.1b)
 */
export type SelectionOpMode = 'new' | 'add' | 'subtract' | 'intersect';




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
  // v2.9: Tone frequency (forward-compat, 0 = not set)
  frequency: 0,
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
 * Create an empty transparent layer.
 *
 * Renders no pixels on its own. Useful as a container for masks/transforms
 * or as a placeholder for future painting tools. The layer still has a
 * transform (so it can be moved/scaled/rotated like any other layer) and
 * can host a mask (which clips the COMPOSITE, not the layer's own pixels —
 * since the layer has no pixels, only the mask's canvas-space clip has any
 * visible effect).
 */
export function createTransparentLayer(name: string): Layer {
  const now = Date.now();
  return {
    id: makeLayerId(),
    name,
    type: 'transparent',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...DEFAULT_TRANSFORM },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * v2.9 STUB: Create a text layer.
 *
 * The layer is created with the given text data, but the core does NOT
 * render it (composite.ts case 'text' is a no-op). A future TextRenderer
 * (registered via PluginRegistry) will handle the actual rendering.
 *
 * The layer is still useful for:
 *   - Showing in the layer panel (with a text icon)
 *   - Undo/redo (text content changes are tracked)
 *   - .ora round-trip (textData is serialized)
 *   - Transform (move/scale/rotate the text bounding box)
 */
export function createTextLayer(name: string, textData: TextLayerData): Layer {
  const now = Date.now();
  return {
    id: makeLayerId(),
    name,
    type: 'text',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...DEFAULT_TRANSFORM },
    textData,
    colorSpace: 'srgb',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * v2.9 STUB: Create a vector layer.
 *
 * The layer is created with the given vector data (shapes list), but the
 * core does NOT render it (composite.ts case 'vector' is a no-op). A
 * future VectorRenderer (registered via PluginRegistry) will handle the
 * actual rendering.
 */
export function createVectorLayer(name: string, vectorData: VectorLayerData): Layer {
  const now = Date.now();
  return {
    id: makeLayerId(),
    name,
    type: 'vector',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...DEFAULT_TRANSFORM },
    vectorData,
    colorSpace: 'srgb',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Returns the natural width/height of a layer's content (before transform).
 * For 'screentone' this is the document size (caller provides it).
 * For 'image' this is the image's intrinsic size (caller provides it).
 * For 'solid' this is 1×1 (it's a fill) — composite.ts overrides this to
 *   docSize at render time so transforms behave intuitively.
 * For 'transparent' this is 1×1 (no content) — same docSize override
 *   applies in composite.ts so the layer can still be transformed.
 *
 * Used by composite.ts to compute the layer's effective bounds after transform.
 */
export function getLayerNaturalSize(
  layer: Layer,
  context: { docWidth: number; docHeight: number; imageSizes: Map<string, { w: number; h: number }> },
): { w: number; h: number } {
  switch (layer.type) {
    case 'screentone':
      // A2.2: if layer has naturalWidth/naturalHeight override (e.g.,
      // created via "New Layer from Selection"), use those instead of
      // docSize. This makes the screentone render into a bbox-sized
      // canvas rather than the full document.
      if (layer.naturalWidth && layer.naturalHeight) {
        return { w: layer.naturalWidth, h: layer.naturalHeight };
      }
      return { w: context.docWidth, h: context.docHeight };
    case 'image': {
      // v2.9.1: if the layer has naturalWidth/naturalHeight override
      // (e.g., after Bake Transform), use those instead of the image's
      // intrinsic size. This ensures the baked image renders at the
      // correct size with identity transform.
      if (layer.naturalWidth && layer.naturalHeight) {
        return { w: layer.naturalWidth, h: layer.naturalHeight };
      }
      const size = context.imageSizes.get(layer.imageSrc ?? '');
      return size ?? { w: 0, h: 0 };
    }
    case 'solid':
      return { w: 1, h: 1 };
    case 'transparent':
      // No intrinsic content — return 1×1. composite.ts and the GL
      // pipeline override this to docSize at draw time so the layer's
      // transform handles behave intuitively (matches solid layer behavior).
      return { w: 1, h: 1 };
    case 'text':
      // v2.9 STUB: Text layers have no intrinsic size until a TextRenderer
      // measures the text. Return 1×1; composite.ts overrides to docSize.
      // Future: when TextRenderer lands, it will compute the text bbox and
      // we can return that here.
      return { w: 1, h: 1 };
    case 'vector':
      // v2.9 STUB: Vector layers have no intrinsic size until a
      // VectorRenderer computes the shapes' bbox. Return 1×1; composite.ts
      // overrides to docSize.
      return { w: 1, h: 1 };
  }
}

// ────────────────────────────────────────────────────────────
// 1.6-1.8: Multi-document support (tabs + color profile)
// ────────────────────────────────────────────────────────────

/**
 * Color profile of a document.
 *
 * - `gray8`: 8-bit grayscale. Primary mode for screentone/manga. Screentones
 *   render as black dots on transparent. Export → 1-bit/8-bit gray TIFF/PNG.
 * - `rgb8`: 8-bit RGB color. For webtoon/color work. Screentones use
 *   `params.color`. Export → RGB PNG.
 * - `cmyk8`: 8-bit CMYK. STUB — reserved for WebToonTools. Renderer throws
 *   "not implemented in GenTonik stage" if selected (UI disables it).
 *
 * Internally, the canvas is always RGBA8 (HTML5 Canvas limitation).
 * `colorProfile` affects screentone generation, export format, and display hint.
 */
export type ColorProfile = 'gray8' | 'rgb8' | 'cmyk8';

/**
 * Background type for new documents.
 * - `white`: opaque white background layer
 * - `transparent`: no background layer (checkerboard shows through)
 */
export type DocBackground = 'white' | 'transparent';

/**
 * Snapshot of a single document's state.
 *
 * Used by the multi-document tab system (1.6). The App keeps an array of
 * these + an `activeDocId`. When switching tabs, the current document's
 * state is saved into its snapshot, and the target document's snapshot is
 * restored into the App's live state.
 *
 * This is a "snapshot" approach (vs. a full refactor to per-document React
 * context) — it's minimally invasive to the existing 4300-line App.tsx and
 * matches how Photoshop internally manages documents.
 */
export interface DocumentState {
  /** Unique ID (used as React key for tabs). */
  id: string;
  /** Display name (shown in tab, editable via double-click). */
  name: string;
  /** All layers (bottom-to-top). */
  layers: Layer[];
  /** Document size in px. */
  docSize: { w: number; h: number };
  /** Resolution in DPI. */
  dpi: number;
  /** Color profile (affects screentone generation + export). */
  colorProfile: ColorProfile;
  /** Active selection (or null if none). */
  activeSelection: ActiveSelection | null;
  /** Viewport state. */
  viewport: { panX: number; panY: number; zoom: number };
  /** Selected layer ID (or null). */
  selectedLayerId: string | null;
  /** History manager (undo/redo stack). Serialized as snapshot array. */
  historySnapshot: unknown;
  /** True if there are unsaved changes (shows ● in tab). */
  dirty: boolean;
  /** File path if saved/loaded from disk (for Save vs Save As). */
  filePath?: string;
  /** Timestamp of creation (for "Untitled-N" numbering). */
  createdAt: number;
}

/**
 * Options for creating a new document (passed from the New Document dialog).
 */
export interface NewDocumentOptions {
  name: string;
  width: number;
  height: number;
  dpi: number;
  colorProfile: ColorProfile;
  background: DocBackground;
}

/**
 * Preset for the New Document dialog.
 */
export interface DocPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  dpi: number;
  colorProfile: ColorProfile;
  description: string;
}

/**
 * Built-in document presets (Photoshop-style).
 */
export const DOC_PRESETS: DocPreset[] = [
  {
    id: 'b5-manga',
    label: 'B5 Manga',
    width: 2079,
    height: 2953,
    dpi: 300,
    colorProfile: 'gray8',
    description: '176×250 mm — стандартная manga page',
  },
  {
    id: 'a4-print',
    label: 'A4 Print',
    width: 2480,
    height: 3508,
    dpi: 300,
    colorProfile: 'gray8',
    description: '210×297 mm @ 300 DPI',
  },
  {
    id: 'webtoon-strip',
    label: 'Webtoon Strip',
    width: 800,
    height: 12000,
    dpi: 72,
    colorProfile: 'rgb8',
    description: '800×12000 px — вертикальная полоса',
  },
  {
    id: 'square-1000',
    label: 'Square 1000',
    width: 1000,
    height: 1000,
    dpi: 72,
    colorProfile: 'rgb8',
    description: '1000×1000 px @ 72 DPI',
  },
  {
    id: 'custom',
    label: 'Custom',
    width: 2000,
    height: 2000,
    dpi: 300,
    colorProfile: 'gray8',
    description: 'Пользовательские размеры',
  },
];

// ────────────────────────────────────────────────────────────
// v2.9: Forward-compat plugin / font registries (STUBS)
// ────────────────────────────────────────────────────────────
//
// These interfaces are RESERVED for future WebToonTools / typography
// extensions. The core GenToniK does NOT implement them — they exist so
// that plugins can be developed against a stable API without modifying the
// core, and so that the core can gracefully handle plugin-provided layer
// types (text, vector, CMYK) before the renderers are written.
//
// Lifecycle:
//   1. Plugin registers itself via PluginRegistry.register(plugin) at app
//      startup (or when dynamically loaded).
//   2. Core queries PluginRegistry.getRenderer(layer.type) when compositing.
//      If a renderer is registered, it's called; otherwise the layer is
//      a no-op (current behavior for 'text' / 'vector').
//   3. FontRegistry is queried by the (future) text renderer to resolve
//      font family names to font files / metrics.

/**
 * v2.9 STUB: A plugin that extends GenToniK's capabilities.
 *
 * Plugins can register:
 *   - Custom layer renderers (for 'text', 'vector', or new layer types)
 *   - Custom tools (added to the toolbox)
 *   - Custom export formats
 *   - Custom import formats
 *
 * The core calls `canHandle(layer)` to check if the plugin wants to render
 * a layer, then `render(ctx, layer, ...)` to actually render it.
 */
export interface GenToniKPlugin {
  /** Unique plugin ID (e.g., 'webtoon-tools', 'manga-text'). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Version (semver-ish, e.g., '1.0.0'). */
  version: string;
  /** Layer types this plugin can render (e.g., ['text', 'vector']). */
  layerTypes: LayerType[];
  /**
   * Check if this plugin can render the given layer. Called before render().
   * Return false to let other plugins handle it.
   */
  canHandle?: (layer: Layer) => boolean;
  /**
   * Render the layer to a canvas context. Called by the compositor when
   * canHandle returned true (or layer.type is in layerTypes).
   *
   * @param ctx     Canvas2D context to render into (layer-local space)
   * @param layer   The layer to render
   * @param width   Render width in px
   * @param height  Render height in px
   */
  render?: (
    ctx: CanvasRenderingContext2D,
    layer: Layer,
    width: number,
    height: number,
  ) => void;
}

/**
 * v2.9 STUB: Registry for plugins.
 *
 * Singleton — accessed via `pluginRegistry` export. The core queries it
 * during composite to find renderers for layer types it doesn't know
 * (currently 'text' and 'vector').
 *
 * Usage (future, when WebToonTools is loaded):
 *   import { pluginRegistry } from './types';
 *   const webtoonPlugin: GenToniKPlugin = { id: 'webtoon', ... };
 *   pluginRegistry.register(webtoonPlugin);
 */
export interface PluginRegistry {
  /** Register a plugin. Later registrations for the same id replace earlier. */
  register(plugin: GenToniKPlugin): void;
  /** Unregister a plugin by id. */
  unregister(id: string): void;
  /** List all registered plugins. */
  list(): readonly GenToniKPlugin[];
  /**
   * Find a plugin that can render the given layer. Returns null if none.
   * The first plugin whose layerTypes includes layer.type AND canHandle
   * returns true (or canHandle is undefined) wins.
   */
  getRenderer(layer: Layer): GenToniKPlugin | null;
}

/**
 * v2.9 STUB: A font entry in the FontRegistry.
 *
 * Fonts are identified by family name. A family can have multiple faces
 * (regular, bold, italic, bold-italic). The registry resolves a
 * (family, weight, style) tuple to a font file URL + metrics.
 */
export interface FontEntry {
  /** Font family name (e.g., 'Noto Sans', 'Comic Sans MS'). */
  family: string;
  /** Font weight (400 = normal, 700 = bold). */
  weight: number;
  /** Font style. */
  style: 'normal' | 'italic';
  /** URL to the font file (woff2/ttf/otf). Can be a data: URL. */
  url: string;
  /** Font format hint ('woff2' | 'truetype' | 'opentype'). */
  format?: string;
}

/**
 * v2.9 STUB: Registry for fonts.
 *
 * Singleton — accessed via `fontRegistry` export. The (future) text
 * renderer queries it to resolve font family names to FontEntry objects,
 * then loads them via FontFace API.
 *
 * Built-in fonts can be registered at app startup. User-installed fonts
 * (uploaded via UI) are added dynamically.
 */
export interface FontRegistry {
  /** Register a font. Replaces existing entry with same (family, weight, style). */
  register(entry: FontEntry): void;
  /** Unregister a font by (family, weight, style). */
  unregister(family: string, weight: number, style: 'normal' | 'italic'): void;
  /** List all registered fonts. */
  list(): readonly FontEntry[];
  /**
   * Resolve a (family, weight, style) tuple to a FontEntry. Returns null
   * if not found. Weight matching is fuzzy (700 → 700, or nearest available).
   */
  resolve(family: string, weight: number, style: 'normal' | 'italic'): FontEntry | null;
  /** List all unique font family names. */
  families(): readonly string[];
}

/**
 * v2.9 STUB: Concrete PluginRegistry implementation (minimal).
 *
 * This is a simple in-memory registry. It's exported as a singleton so
 * plugins can register themselves at startup. The core queries it via
 * `pluginRegistry.getRenderer(layer)` during composite.
 */
class InMemoryPluginRegistry implements PluginRegistry {
  private plugins = new Map<string, GenToniKPlugin>();

  register(plugin: GenToniKPlugin): void {
    this.plugins.set(plugin.id, plugin);
  }
  unregister(id: string): void {
    this.plugins.delete(id);
  }
  list(): readonly GenToniKPlugin[] {
    return Array.from(this.plugins.values());
  }
  getRenderer(layer: Layer): GenToniKPlugin | null {
    for (const plugin of this.plugins.values()) {
      if (plugin.layerTypes.includes(layer.type)) {
        if (!plugin.canHandle || plugin.canHandle(layer)) {
          return plugin;
        }
      }
    }
    return null;
  }
}

/**
 * v2.9 STUB: Concrete FontRegistry implementation (minimal).
 */
class InMemoryFontRegistry implements FontRegistry {
  private fonts: FontEntry[] = [];

  register(entry: FontEntry): void {
    // Remove existing entry with same (family, weight, style)
    this.fonts = this.fonts.filter(
      f => !(f.family === entry.family && f.weight === entry.weight && f.style === entry.style)
    );
    this.fonts.push(entry);
  }
  unregister(family: string, weight: number, style: 'normal' | 'italic'): void {
    this.fonts = this.fonts.filter(
      f => !(f.family === family && f.weight === weight && f.style === style)
    );
  }
  list(): readonly FontEntry[] {
    return this.fonts.slice();
  }
  resolve(family: string, weight: number, style: 'normal' | 'italic'): FontEntry | null {
    // Exact match first
    const exact = this.fonts.find(
      f => f.family === family && f.weight === weight && f.style === style
    );
    if (exact) return exact;
    // Fuzzy weight match (nearest weight, same style)
    const sameStyle = this.fonts.filter(f => f.family === family && f.style === style);
    if (sameStyle.length > 0) {
      let best = sameStyle[0];
      let bestDiff = Math.abs(best.weight - weight);
      for (const f of sameStyle) {
        const diff = Math.abs(f.weight - weight);
        if (diff < bestDiff) { best = f; bestDiff = diff; }
      }
      return best;
    }
    // Any family match
    return this.fonts.find(f => f.family === family) ?? null;
  }
  families(): readonly string[] {
    return Array.from(new Set(this.fonts.map(f => f.family)));
  }
}

/** v2.9: Singleton PluginRegistry. Plugins register here at startup. */
export const pluginRegistry: PluginRegistry = new InMemoryPluginRegistry();

/** v2.9: Singleton FontRegistry. Fonts register here at startup or on upload. */
export const fontRegistry: FontRegistry = new InMemoryFontRegistry();
