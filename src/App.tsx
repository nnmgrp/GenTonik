// ============================================================
// App.tsx — GenToniK Standalone (v2 multi-layer UI)
// ============================================================
//
// This is the main UI for the GenToniK Standalone app.
//
// Architecture:
//   • Bottom-left:  Layer panel (add/delete/reorder/visibility/select)
//   • Bottom-left:  Preset browser (CRUD, search, apply)
//   • Center:       Canvas with pan/zoom (uses composite.ts)
//   • Right:        Param editor (Simple / Advanced split)
//                   + Transform panel (x/y/scale/rotation)
//
// State model:
//   • layers[]            — Layer[] from types.ts, bottom-to-top
//   • selectedLayerId     — currently edited layer
//   • docSize {w,h}       — canvas size in px
//   • dpi                 — for unit conversion (px/mm/in/lpi)
//   • viewTransform       — { zoom, panX, panY } for canvas view
//   • paramMode           — 'simple' | 'advanced'
//   • presetFilter        — { category, query } for preset browser
//
// Re-render strategy:
//   • useEffect on [layers, docSize, imageCache, dpi] → compositeLayers
//   • imageCache is rebuilt when layer.imageSrc changes
//   • Use requestAnimationFrame to debounce back-to-back state updates
//
// Styling:
//   • CSS variables from index.css (--c-* family)
//   • Inline styles for theme-aware colors
//   • Tailwind utility classes for layout where possible
// ============================================================

import {
  useState, useRef, useEffect, useCallback, useMemo,
  type CSSProperties, type ChangeEvent,
} from 'react';
import {
  type Layer, type ScreentoneParams, type PresetV2,
  type BlendMode, type LayerTransform, type LayerType,
  type LayerMask,
  type DotShape, type PatternType, type SizeUnit, type RenderSizeMode,
  DEFAULT_PARAMS, DEFAULT_TRANSFORM, BLEND_MODES,
  createScreentoneLayer, createImageLayer, createSolidLayer, createTransparentLayer,
  ActiveSelection, getLayerNaturalSize, type SelectionOpMode, type SelectionEntry,
  type Vec2,
  type ColorProfile, type DocBackground, type NewDocumentOptions,
  type DocumentState,
  DOC_PRESETS,
} from './types';
import {
  type CompositeContext, type ImageCache,
  compositeLayers, getLayerCanvasBounds,
  rasterizePolygonAtSize,
  computeCombinedSelectionMask,
  clipPolygonToRect,
  convertLayersColorProfile,
  compositeSingleLayerPublic,
} from './composite';
import { renderScreentone } from './engine';
import { compositeLayersWithFallback } from './webgl';
import { computeHomography, applyHomography } from './homography';
import { toPx, fromPx } from './units';
import * as presetStore from './preset-store';
import {
  saveOraFile, openOraFile, isOraFile, ORA_FILE_ACCEPT,
  type OraImportResult,
} from './ora-format';

// ── NEW (v2.1): History (undo/redo) ───────────────────────────
import {
  HistoryManager, makeSnapshot,
} from './history';

// ── NEW (A1-core): Canvas-based overlay — replacement for react-moveable ──
import {
  TransformOverlayCanvas,
  type ToolId,
} from './transform-overlay-canvas';

// ── NEW (v2.1): Mask Editor (brush + 4 selection tools) ───────
import {
  MaskEditor,
} from './mask-editor';

// ── NEW (v2.0): Debug Tools (structured logging + overlay) ────
import { debug, DebugPanel } from './debug-tools';

// ── NEW (v2.0): PS Bridge (PNG import/export) ─────────────────
import {
  pngBridge,
  exportCompositeToFile,
  type BridgeImportResult,
} from './ps-bridge';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const DEFAULT_DOC_SIZE = { w: 2000, h: 2000 };
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const CHECKERBOARD_SIZE = 16;

const PATTERN_TYPES: { value: PatternType; label: string }[] = [
  { value: 'dots', label: 'Dots' },
  { value: 'lines', label: 'Lines' },
  { value: 'crosshatch', label: 'Crosshatch' },
  { value: 'noise', label: 'Noise' },
  { value: 'gaussian_noise', label: 'Gaussian Noise' },
  { value: 'stipple', label: 'Stipple' },
  { value: 'hexgrid', label: 'Hex Grid' },
  { value: 'checker', label: 'Checker' },
  { value: 'concentric', label: 'Concentric' },
  { value: 'stars', label: 'Stars' },
  { value: 'hearts', label: 'Hearts' },
  { value: 'triangles', label: 'Triangles' },
];

const DOT_SHAPES: { value: DotShape; label: string; icon: string }[] = [
  { value: 'circle', label: 'Circle', icon: '●' },
  { value: 'square', label: 'Square', icon: '■' },
  { value: 'diamond', label: 'Diamond', icon: '◆' },
  { value: 'hexagon', label: 'Hexagon', icon: '⬢' },
];

const SIZE_MODES: { value: RenderSizeMode; label: string; hint: string }[] = [
  { value: 'match-document',  label: 'Match Document',  hint: 'Fill the whole canvas' },
  { value: 'match-selection', label: 'Match Selection', hint: 'Fill only selection bounds (PS round-trip)' },
  { value: 'tile',            label: 'Tile',            hint: 'Seamless tile, register as PS pattern' },
  { value: 'custom',          label: 'Custom',          hint: 'User-specified size' },
];

const SIZE_UNITS: { value: SizeUnit; label: string }[] = [
  { value: 'px',  label: 'px' },
  { value: 'mm',  label: 'mm' },
  { value: 'in',  label: 'in' },
  { value: 'lpi', label: 'lpi' },
];

// ────────────────────────────────────────────────────────────
// Theme helper
// ────────────────────────────────────────────────────────────

function themeColor(name: string): string {
  return `var(--c-${name})`;
}

const styles = {
  app: {
    background: themeColor('app-bg'),
    color: themeColor('text'),
    fontFamily: 'system-ui, -apple-system, sans-serif',
  } as CSSProperties,
  sidebar: {
    background: themeColor('sidebar-bg'),
    borderRight: `1px solid ${themeColor('border')}`,
  } as CSSProperties,
  topbar: {
    background: themeColor('topbar-bg'),
    borderBottom: `1px solid ${themeColor('border')}`,
  } as CSSProperties,
  panel: {
    background: themeColor('panel-bg'),
    border: `1px solid ${themeColor('panel-border')}`,
  } as CSSProperties,
  input: {
    background: themeColor('input-bg'),
    border: `1px solid ${themeColor('input-border')}`,
    color: themeColor('text'),
  } as CSSProperties,
  button: {
    background: themeColor('btn-secondary'),
    color: themeColor('text'),
    border: `1px solid ${themeColor('input-border')}`,
  } as CSSProperties,
  textMuted: { color: themeColor('text-muted') } as CSSProperties,
  textDim: { color: themeColor('text-dim') } as CSSProperties,
  // ── NEW (v3): Photoshop-style layout regions ──
  menubar: {
    background: themeColor('topbar-bg'),
    borderBottom: `1px solid ${themeColor('border')}`,
  } as CSSProperties,
  toolbox: {
    background: themeColor('toolbox-bg'),
    borderRight: `1px solid ${themeColor('border')}`,
  } as CSSProperties,
  statusbar: {
    background: themeColor('statusbar-bg'),
    borderTop: `1px solid ${themeColor('border')}`,
  } as CSSProperties,
};

// ────────────────────────────────────────────────────────────
// useImageCache — keeps HTMLImageElement cache in sync with layers
// ────────────────────────────────────────────────────────────

function useImageCache(layers: Layer[]): ImageCache {
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const sizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  const [, forceTick] = useState(0);

  // Collect all unique imageSrc values from layers
  const srcs = useMemo(() => {
    const set = new Set<string>();
    for (const layer of layers) {
      if (layer.type === 'image' && layer.imageSrc) {
        set.add(layer.imageSrc);
      }
    }
    return Array.from(set);
  }, [layers]);

  useEffect(() => {
    let cancelled = false;
    const toLoad = srcs.filter(s => !imagesRef.current.has(s));
    if (toLoad.length === 0) {
      // Still need to prune removed srcs
      const srcSet = new Set(srcs);
      for (const key of Array.from(imagesRef.current.keys())) {
        if (!srcSet.has(key)) {
          imagesRef.current.delete(key);
          sizesRef.current.delete(key);
        }
      }
      return;
    }

    let pending = toLoad.length;
    for (const src of toLoad) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        imagesRef.current.set(src, img);
        sizesRef.current.set(src, { w: img.naturalWidth, h: img.naturalHeight });
        pending--;
        if (pending === 0) forceTick(t => t + 1);
      };
      img.onerror = () => {
        if (cancelled) return;
        // Skip broken images silently — composite will draw nothing
        pending--;
        if (pending === 0) forceTick(t => t + 1);
      };
      img.src = src;
    }

    return () => { cancelled = true; };
  }, [srcs]);

  // Prune removed srcs (also runs when srcs change but loading is done)
  useEffect(() => {
    const srcSet = new Set(srcs);
    for (const key of Array.from(imagesRef.current.keys())) {
      if (!srcSet.has(key)) {
        imagesRef.current.delete(key);
        sizesRef.current.delete(key);
      }
    }
  }, [srcs]);

  return { images: imagesRef.current, sizes: sizesRef.current };
}

// ────────────────────────────────────────────────────────────
// Reusable UI primitives
// ────────────────────────────────────────────────────────────

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
}

function NumberField({ label, value, onChange, min, max, step = 1, suffix, disabled }: NumberFieldProps) {
  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) onChange(v);
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, opacity: disabled ? 0.5 : 1 }}>
      <span style={{ flex: '0 0 80px', fontSize: 12, ...styles.textMuted }}>{label}</span>
      <input
        type="number"
        value={value}
        onChange={handle}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        style={{ ...styles.input, flex: 1, padding: '4px 6px', fontSize: 13, minWidth: 0 }}
      />
      {suffix && <span style={{ fontSize: 11, ...styles.textDim, minWidth: 24 }}>{suffix}</span>}
    </label>
  );
}

interface SliderFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}

function SliderField({ label, value, onChange, min, max, step = 0.01, suffix }: SliderFieldProps) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
        <span style={styles.textMuted}>{label}</span>
        <span style={{ ...styles.textDim, fontVariantNumeric: 'tabular-nums' }}>
          {value.toFixed(step >= 1 ? 0 : 2)}{suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: themeColor('input-focus') }}
      />
    </div>
  );
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: string }[];
}

function SelectField<T extends string>({ label, value, onChange, options }: SelectFieldProps<T>) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span style={{ flex: '0 0 80px', fontSize: 12, ...styles.textMuted }}>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        style={{ ...styles.input, flex: 1, padding: '4px 6px', fontSize: 13, minWidth: 0 }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.icon ? `${o.icon} ${o.label}` : o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
}

function ColorField({ label, value, onChange }: ColorFieldProps) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span style={{ flex: '0 0 80px', fontSize: 12, ...styles.textMuted }}>{label}</span>
      <input
        type="color"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: 32, height: 24, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
      />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ ...styles.input, flex: 1, padding: '4px 6px', fontSize: 13, minWidth: 0 }}
      />
    </label>
  );
}

interface ToggleFieldProps {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

function ToggleField({ label, value, onChange }: ToggleFieldProps) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={value}
        onChange={e => onChange(e.target.checked)}
        style={{ accentColor: themeColor('input-focus') }}
      />
      <span style={{ fontSize: 12, ...styles.textMuted }}>{label}</span>
    </label>
  );
}

// ────────────────────────────────────────────────────────────
// Section header (collapsible accordion title)
// ────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  expanded,
  onToggle,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: '100%',
        padding: '6px 8px',
        background: 'transparent',
        border: 'none',
        color: themeColor('text'),
        textAlign: 'left',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
        ▶
      </span>
      {title}
    </button>
  );
}

// ────────────────────────────────────────────────────────────
// ParamEditor — Simple mode
// ────────────────────────────────────────────────────────────

interface ParamEditorSimpleProps {
  params: ScreentoneParams;
  onChange: (patch: Partial<ScreentoneParams>) => void;
  dpi: number;
}

function ParamEditorSimple({ params, onChange, dpi }: ParamEditorSimpleProps) {
  // Convert current spacing/dotSize to the user-selected unit for display
  const unitLabel = SIZE_UNITS.find(u => u.value === params.unit)?.label ?? 'px';
  const convertFromPx = (px: number) => fromPx(px, params.unit, dpi);
  const convertToPx = (v: number) => toPx(v, params.unit, dpi);

  // Gemini 2.4.2: chain-lock for Spacing X/Y. When locked,
  // changing Spacing updates both axes synchronously. When unlocked,
  // the user gets separate X and Y fields.
  // A1.3 (2026-06-25): default changed from `true` to `false` — в старой
  // версии GenToniK Шаг X / Шаг Y были видны оба одновременно (см. скриншот
  // от пользователя). Chain-lock оставлен для convenience, но по дефолту
  // оба поля раскрыты, чтобы не прятать X/Y функционал за иконкой.
  const [spacingLocked, setSpacingLocked] = useState(false);

  return (
    <div style={{ padding: '8px 4px' }}>
      <SelectField
        label="Pattern"
        value={params.patternType}
        onChange={v => onChange({ patternType: v })}
        options={PATTERN_TYPES}
      />

      {/* Shape selection — only for patterns that use dotShape */}
      {!['lines', 'crosshatch', 'concentric'].includes(params.patternType) && (
        <SelectField
          label="Shape"
          value={params.dotShape}
          onChange={v => onChange({ dotShape: v })}
          options={DOT_SHAPES}
        />
      )}

      <NumberField
        label="Size"
        value={convertFromPx(params.dotSize)}
        onChange={v => onChange({ dotSize: convertToPx(v) })}
        min={0.1}
        step={0.1}
        suffix={unitLabel}
      />

      {/* Gemini 2.4.2: Unified Spacing field with chain lock.
          - Lock CLOSED (default): one field, edits both spacingX and spacingY.
          - Lock OPEN: two fields (Spacing X, Spacing Y) for independent control.
          The chain icon button toggles the lock state. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
        <div style={{ flex: 1 }}>
          <NumberField
            label={spacingLocked ? 'Spacing' : 'Spacing X'}
            value={convertFromPx(params.spacingX)}
            onChange={v => {
              const px = convertToPx(v);
              if (spacingLocked) {
                onChange({ spacingX: px, spacingY: px });
              } else {
                onChange({ spacingX: px });
              }
            }}
            min={0.1}
            step={0.1}
            suffix={unitLabel}
          />
        </div>
        <button
          type="button"
          onClick={() => setSpacingLocked(s => !s)}
          title={spacingLocked ? 'Unlock X/Y (independent spacing)' : 'Lock X/Y (synchronous spacing)'}
          style={{
            ...styles.button,
            width: 30,
            height: 30,
            padding: 0,
            marginBottom: 4,
            background: spacingLocked ? themeColor('input-focus') : themeColor('btn-secondary'),
            color: spacingLocked ? '#fff' : themeColor('text-muted'),
            border: `1px solid ${spacingLocked ? themeColor('input-focus') : themeColor('input-border')}`,
            fontSize: 14,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {spacingLocked ? '🔗' : '⛓'}
        </button>
      </div>

      {!spacingLocked && (
        <NumberField
          label="Spacing Y"
          value={convertFromPx(params.spacingY)}
          onChange={v => onChange({ spacingY: convertToPx(v) })}
          min={0.1}
          step={0.1}
          suffix={unitLabel}
        />
      )}

      <SliderField
        label="Density"
        value={params.density}
        onChange={v => onChange({ density: v })}
        min={0.01}
        max={1}
        step={0.01}
      />

      <ColorField
        label="Color"
        value={params.colorPattern}
        onChange={v => onChange({ colorPattern: v })}
      />

      {/* Gemini 2.4.4: Background field REMOVED from screentone params.
          Background color belongs to the document or to a separate
          Solid layer below the screentone — not to the screentone
          itself. Removing it here keeps the param editor focused on
          what the screentone actually controls (pattern + color). */}

      {/* Quick angle control — useful for lines/dots */}
      <NumberField
        label="Angle"
        value={params.angle}
        onChange={v => onChange({ angle: v })}
        min={-180}
        max={180}
        step={1}
        suffix="°"
      />

      {/* For lines — show line width */}
      {(params.patternType === 'lines' || params.patternType === 'crosshatch' || params.patternType === 'concentric') && (
        <NumberField
          label="Line Width"
          value={convertFromPx(params.lineWidth)}
          onChange={v => onChange({ lineWidth: convertToPx(v) })}
          min={0.1}
          step={0.1}
          suffix={unitLabel}
        />
      )}

      {/* For crosshatch — show cross angle */}
      {params.patternType === 'crosshatch' && (
        <NumberField
          label="Cross Angle"
          value={params.crossAngle}
          onChange={v => onChange({ crossAngle: v })}
          min={0}
          max={180}
          step={1}
          suffix="°"
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// ParamEditor — Advanced mode (collapsible sections)
// ────────────────────────────────────────────────────────────

interface ParamEditorAdvancedProps {
  params: ScreentoneParams;
  onChange: (patch: Partial<ScreentoneParams>) => void;
  dpi: number;
}

function ParamEditorAdvanced({ params, onChange, dpi }: ParamEditorAdvancedProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['satellites']));

  const toggleSection = (id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isExpanded = (id: string) => expandedSections.has(id);
  const convertFromPx = (px: number) => fromPx(px, params.unit, dpi);
  const convertToPx = (v: number) => toPx(v, params.unit, dpi);
  const unitLabel = SIZE_UNITS.find(u => u.value === params.unit)?.label ?? 'px';

  return (
    <div style={{ padding: '4px 0' }}>
      {/* First show the Simple fields too, in case user wants to tweak them in advanced mode */}
      <ParamEditorSimple params={params} onChange={onChange} dpi={dpi} />

      {/* ── Satellites ── */}
      <div style={{ marginTop: 4, borderTop: `1px solid ${themeColor('sub-border')}` }}>
        <SectionHeader title="Satellites" expanded={isExpanded('satellites')} onToggle={() => toggleSection('satellites')} />
        {isExpanded('satellites') && (
          <div style={{ padding: '4px 8px 8px', background: themeColor('sub-bg') }}>
            <ToggleField
              label="Enable satellites"
              value={params.satelliteEnabled}
              onChange={v => onChange({ satelliteEnabled: v })}
            />
            <NumberField
              label="Size"
              value={convertFromPx(params.satelliteSize)}
              onChange={v => onChange({ satelliteSize: convertToPx(v) })}
              min={0.1}
              step={0.1}
              suffix={unitLabel}
              disabled={!params.satelliteEnabled}
            />
            <NumberField
              label="Distance"
              value={convertFromPx(params.satelliteDistance)}
              onChange={v => onChange({ satelliteDistance: convertToPx(v) })}
              min={0}
              step={0.1}
              suffix={unitLabel}
              disabled={!params.satelliteEnabled}
            />
            <NumberField
              label="Count"
              value={params.satelliteCount}
              onChange={v => onChange({ satelliteCount: Math.max(0, Math.min(4, Math.round(v))) })}
              min={0}
              max={4}
              step={1}
              disabled={!params.satelliteEnabled}
            />
            <NumberField
              label="Angle"
              value={params.satelliteAngle}
              onChange={v => onChange({ satelliteAngle: v })}
              min={-180}
              max={180}
              step={1}
              suffix="°"
              disabled={!params.satelliteEnabled}
            />
            <SelectField
              label="Shape"
              value={params.satelliteDotShape}
              onChange={v => onChange({ satelliteDotShape: v })}
              options={DOT_SHAPES}
            />
            <SliderField
              label="Stretch to parent"
              value={params.satelliteStretch}
              onChange={v => onChange({ satelliteStretch: v })}
              min={0}
              max={2}
              step={0.05}
            />
          </div>
        )}
      </div>

      {/* ── Distortion ── */}
      <div style={{ marginTop: 4, borderTop: `1px solid ${themeColor('sub-border')}` }}>
        <SectionHeader title="Distortion" expanded={isExpanded('distortion')} onToggle={() => toggleSection('distortion')} />
        {isExpanded('distortion') && (
          <div style={{ padding: '4px 8px 8px', background: themeColor('sub-bg') }}>
            <NumberField
              label="Aspect X"
              value={params.aspectX}
              onChange={v => onChange({ aspectX: v })}
              min={0.1}
              step={0.1}
            />
            <NumberField
              label="Aspect Y"
              value={params.aspectY}
              onChange={v => onChange({ aspectY: v })}
              min={0.1}
              step={0.1}
            />
            <SliderField
              label="Row Offset"
              value={params.rowOffset}
              onChange={v => onChange({ rowOffset: v })}
              min={0}
              max={1}
              step={0.05}
            />
            <SliderField
              label="Merge Factor"
              value={params.mergeFactor}
              onChange={v => onChange({ mergeFactor: v })}
              min={0}
              max={1}
              step={0.05}
            />
            <SliderField
              label="Jitter Pos"
              value={params.jitterPos}
              onChange={v => onChange({ jitterPos: v })}
              min={0}
              max={100}
              step={1}
            />
            <SliderField
              label="Jitter Size"
              value={params.jitterSize}
              onChange={v => onChange({ jitterSize: v })}
              min={0}
              max={100}
              step={1}
            />
            <SliderField
              label="Roundness"
              value={params.roundness}
              onChange={v => onChange({ roundness: v })}
              min={0}
              max={1}
              step={0.01}
            />
          </div>
        )}
      </div>

      {/* ── Gradient ── */}
      <div style={{ marginTop: 4, borderTop: `1px solid ${themeColor('sub-border')}` }}>
        <SectionHeader title="Gradient Mapping" expanded={isExpanded('gradient')} onToggle={() => toggleSection('gradient')} />
        {isExpanded('gradient') && (
          <div style={{ padding: '4px 8px 8px', background: themeColor('sub-bg') }}>
            <SelectField
              label="Type"
              value={params.gradType}
              onChange={v => onChange({ gradType: v })}
              options={[
                { value: 'none', label: 'None' },
                { value: 'linear', label: 'Linear' },
                { value: 'radial', label: 'Radial' },
              ]}
            />
            <NumberField
              label="Angle"
              value={params.gradAngle}
              onChange={v => onChange({ gradAngle: v })}
              min={0}
              max={360}
              step={1}
              suffix="°"
              disabled={params.gradType === 'none'}
            />
            <ToggleField
              label="Reverse"
              value={params.gradReverse}
              onChange={v => onChange({ gradReverse: v })}
            />
            <SliderField
              label="Midpoint"
              value={params.gradMidpoint}
              onChange={v => onChange({ gradMidpoint: v })}
              min={0.01}
              max={0.99}
              step={0.01}
            />
            <SliderField
              label="Size Start"
              value={params.gradSizeStart}
              onChange={v => onChange({ gradSizeStart: v })}
              min={0}
              max={3}
              step={0.05}
            />
            <SliderField
              label="Size End"
              value={params.gradSizeEnd}
              onChange={v => onChange({ gradSizeEnd: v })}
              min={0}
              max={3}
              step={0.05}
            />
            <SliderField
              label="Stretch Start"
              value={params.gradStretchStart}
              onChange={v => onChange({ gradStretchStart: v })}
              min={0.1}
              max={3}
              step={0.05}
            />
            <SliderField
              label="Stretch End"
              value={params.gradStretchEnd}
              onChange={v => onChange({ gradStretchEnd: v })}
              min={0.1}
              max={3}
              step={0.05}
            />
            <ToggleField
              label="Color transition"
              value={params.gradColorTrans}
              onChange={v => onChange({ gradColorTrans: v })}
            />
          </div>
        )}
      </div>

      {/* ── Rotation ── */}
      <div style={{ marginTop: 4, borderTop: `1px solid ${themeColor('sub-border')}` }}>
        <SectionHeader title="Rotation" expanded={isExpanded('rotation')} onToggle={() => toggleSection('rotation')} />
        {isExpanded('rotation') && (
          <div style={{ padding: '4px 8px 8px', background: themeColor('sub-bg') }}>
            <NumberField
              label="Canvas"
              value={params.rotCanvas}
              onChange={v => onChange({ rotCanvas: v })}
              min={-180}
              max={180}
              step={1}
              suffix="°"
            />
            <NumberField
              label="Pattern"
              value={params.rotPattern}
              onChange={v => onChange({ rotPattern: v })}
              min={-180}
              max={180}
              step={1}
              suffix="°"
            />
          </div>
        )}
      </div>

      {/* ── Size & Units ── */}
      <div style={{ marginTop: 4, borderTop: `1px solid ${themeColor('sub-border')}` }}>
        <SectionHeader title="Size & Units" expanded={isExpanded('units')} onToggle={() => toggleSection('units')} />
        {isExpanded('units') && (
          <div style={{ padding: '4px 8px 8px', background: themeColor('sub-bg') }}>
            <SelectField
              label="Unit"
              value={params.unit}
              onChange={v => onChange({ unit: v })}
              options={SIZE_UNITS}
            />
            <SelectField
              label="Mode"
              value={params.sizeMode}
              onChange={v => onChange({ sizeMode: v })}
              options={SIZE_MODES.map(m => ({ value: m.value, label: m.label }))}
            />
            {params.sizeMode === 'tile' && (
              <>
                <NumberField
                  label="Tile W"
                  value={params.tileWidth}
                  onChange={v => onChange({ tileWidth: Math.round(v) })}
                  min={1}
                  step={1}
                  suffix="px"
                />
                <NumberField
                  label="Tile H"
                  value={params.tileHeight}
                  onChange={v => onChange({ tileHeight: Math.round(v) })}
                  min={1}
                  step={1}
                  suffix="px"
                />
              </>
            )}
            {params.sizeMode === 'custom' && (
              <>
                <NumberField
                  label="Custom W"
                  value={params.customWidth}
                  onChange={v => onChange({ customWidth: Math.round(v) })}
                  min={1}
                  step={1}
                  suffix="px"
                />
                <NumberField
                  label="Custom H"
                  value={params.customHeight}
                  onChange={v => onChange({ customHeight: Math.round(v) })}
                  min={1}
                  step={1}
                  suffix="px"
                />
              </>
            )}
            <ToggleField
              label="Seamless tiling"
              value={params.seamless}
              onChange={v => onChange({ seamless: v })}
            />
          </div>
        )}
      </div>

      {/* ── Image Mask (legacy) ── */}
      <div style={{ marginTop: 4, borderTop: `1px solid ${themeColor('sub-border')}` }}>
        <SectionHeader title="Image Mask (legacy)" expanded={isExpanded('imgmask')} onToggle={() => toggleSection('imgmask')} />
        {isExpanded('imgmask') && (
          <div style={{ padding: '4px 8px 8px', background: themeColor('sub-bg') }}>
            <SelectField
              label="Source"
              value={params.maskSource}
              onChange={v => onChange({ maskSource: v })}
              options={[
                { value: 'none', label: 'None' },
                { value: 'image_brightness', label: 'Image Brightness' },
                { value: 'image_alpha', label: 'Image Alpha' },
              ]}
            />
            <ToggleField
              label="Invert"
              value={params.maskInvert}
              onChange={v => onChange({ maskInvert: v })}
            />
            <SliderField
              label="Threshold"
              value={params.maskThreshold}
              onChange={v => onChange({ maskThreshold: v })}
              min={0}
              max={1}
              step={0.01}
            />
            <SliderField
              label="Smoothness"
              value={params.maskSmoothness}
              onChange={v => onChange({ maskSmoothness: v })}
              min={0}
              max={5}
              step={0.1}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// TransformPanel — REMOVED. Replaced by external ./transform-panel.tsx
// (imported as TransformPanelOverlay above) which provides:
//   • Drag handles (move/scale/rotate/skew/perspective)
//   • Selection tools (rect/ellipse marquee, lasso, polygonal lasso)
//   • Free Transform 4-corner (v2.2)
// The right sidebar still shows numeric X/Y/Scale/Rotation/Skew fields
// for precise editing — see App() render below.
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// LayerPanel — list of layers with controls
// ────────────────────────────────────────────────────────────

interface LayerPanelProps {
  layers: Layer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onAddScreentone: () => void;
  onAddTransparent: () => void;
  onAddImage: (file: File) => void;
  onChangeBlend: (id: string, blend: BlendMode) => void;
  onChangeOpacity: (id: string, opacity: number) => void;
  /** NEW v2.1: Open mask editor for this layer. */
  onEditMask?: (id: string) => void;
  /** NEW A2.2: Creation of localized layer from selection */
  activeSelection: ActiveSelection | null;
  onAddScreentoneFromSelection: () => void;
  onApplySelectionAsMask: () => void;
  /** NEW A2.1a: Selection modes */
  selectionOpMode: SelectionOpMode;
  onSelectionOpModeChange: (mode: SelectionOpMode) => void;
  /** NEW A3-fix-2: active tool, used to hide Selection Modes panel
      when a transform tool (move/scale/rotate/skew/perspective) is active. */
  activeTool: ToolId;
  /* A3-fix-2: LayerPanel accepts activeTool */
  /** v2.10: Bucket tool state — mode + fill color. */
  bucketMode: BucketMode;
  onBucketModeChange: (mode: BucketMode) => void;
  bucketColor: string;
  onBucketColorChange: (color: string) => void;
  /** v2.10: Whether there's an active selection (for bucket 'selection' modes). */
  hasSelection: boolean;
}

const LAYER_TYPE_ICONS: Record<LayerType, string> = {
  screentone: '▦',
  image: '🖼',
  solid: '■',
  transparent: '▢',
  text: 'T',       // v2.9: text layer icon
  vector: '◯',     // v2.9: vector layer icon
};


// ────────────────────────────────────────────────────────────
// Unified "New Layer" button with dropdown (Photoshop/Krita standard)
// ────────────────────────────────────────────────────────────

interface LayerCreationDropdownProps {
  onAddScreentone: () => void;
  onAddScreentoneFromSelection: () => void;
  onAddTransparent: () => void;
  onAddImage: () => void;
  onApplySelectionAsMask: () => void;
  hasSelection: boolean;
  hasSelectedLayer: boolean;
}

function LayerCreationDropdown({
  onAddScreentone, onAddScreentoneFromSelection, onAddTransparent,
  onAddImage, onApplySelectionAsMask, hasSelection, hasSelectedLayer,
}: LayerCreationDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const items = [
    { label: 'Screentone Layer', onClick: onAddScreentone, disabled: false },
    { label: 'Transparent Layer', onClick: onAddTransparent, disabled: false },
    { label: 'Image Layer', onClick: onAddImage, disabled: false },
    { label: '--- separator ---', onClick: () => {}, disabled: true },
    { label: 'Screentone from Sel', onClick: onAddScreentoneFromSelection, disabled: !hasSelection },
    { label: 'Mask from Sel', onClick: onApplySelectionAsMask, disabled: !hasSelection || !hasSelectedLayer },
  ];

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex' }}>
      <button onClick={onAddScreentone}
        style={{ ...styles.button, padding: '4px 8px', fontSize: 11, borderRadius: '4px 0 0 4px', borderRight: 'none' }}
        title="New screentone layer">+ New Layer</button>
      <button onClick={() => setOpen(o => !o)}
        style={{ ...styles.button, padding: '4px 4px', fontSize: 10, borderRadius: '0 4px 4px 0', minWidth: 20 }}
        title="Layer type menu">▼</button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 2, zIndex: 1000, minWidth: 200,
          background: themeColor('sidebar-bg'), border: `1px solid ${themeColor('border')}`, borderRadius: 4,
          boxShadow: '0 4px 16px rgba(0,0,0,0.2)', overflow: 'hidden' }}>
          {items.map((item, i) => (
            <button key={i} onClick={() => { if (!item.disabled) { item.onClick(); setOpen(false); } }}
              disabled={item.disabled}
              style={{ display: 'block', width: '100%', padding: '6px 12px', fontSize: 11, textAlign: 'left',
                background: 'transparent', color: item.disabled ? themeColor('text-dim') : themeColor('text'),
                border: 'none', cursor: item.disabled ? 'not-allowed' : 'pointer', opacity: item.disabled ? 0.5 : 1 }}
              onMouseEnter={(e) => { if (!item.disabled) e.currentTarget.style.background = themeColor('input-bg'); }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              {item.label.startsWith('---') ? '──────────' : item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LayerPanel({
  layers, selectedId, onSelect, onToggleVisible, onRename, onDelete,
  onDuplicate, onMoveUp, onMoveDown, onAddScreentone, onAddTransparent,
  onAddImage, onChangeBlend, onChangeOpacity, onEditMask,
  activeSelection, onAddScreentoneFromSelection, onApplySelectionAsMask,
  selectionOpMode, onSelectionOpModeChange,
  activeTool,
  bucketMode, onBucketModeChange, bucketColor, onBucketColorChange,
  hasSelection,
}: LayerPanelProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);

  const startRename = (layer: Layer) => {
    setRenamingId(layer.id);
    setRenameValue(layer.name);
  };

  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  // Reverse order for display: top of list = top of stack
  const displayLayers = [...layers].reverse();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '6px 8px', borderBottom: `1px solid ${themeColor('border')}`, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <LayerCreationDropdown
          onAddScreentone={onAddScreentone}
          onAddScreentoneFromSelection={onAddScreentoneFromSelection}
          onAddTransparent={onAddTransparent}
          onAddImage={() => imageInputRef.current?.click()}
          onApplySelectionAsMask={onApplySelectionAsMask}
          hasSelection={!!(activeSelection && activeSelection.entries.length > 0)}
          hasSelectedLayer={!!selectedId}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) onAddImage(file);
            e.target.value = '';
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }} className="custom-scroll">
        {displayLayers.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, textAlign: 'center', ...styles.textDim }}>
            No layers yet. Add one above.
          </div>
        ) : (
          displayLayers.map(layer => {
            const isSelected = layer.id === selectedId;
            return (
              <div
                key={layer.id}
                onClick={() => onSelect(layer.id)}
                style={{
                  padding: '4px 6px',
                  borderBottom: `1px solid ${themeColor('sub-border')}`,
                  cursor: 'pointer',
                  background: isSelected ? themeColor('input-focus') : 'transparent',
                  color: isSelected ? '#fff' : themeColor('text'),
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button
                    onClick={e => { e.stopPropagation(); onToggleVisible(layer.id); }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: 14,
                      width: 18,
                      opacity: layer.visible ? 1 : 0.4,
                    }}
                    title={layer.visible ? 'Hide' : 'Show'}
                  >
                    {layer.visible ? '👁' : '⊘'}
                  </button>
                  <span style={{ fontSize: 14 }}>{LAYER_TYPE_ICONS[layer.type]}</span>
                  {renamingId === layer.id ? (
                    <input
                      type="text"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onClick={e => e.stopPropagation()}
                      autoFocus
                      style={{
                        flex: 1,
                        background: 'transparent',
                        border: `1px solid ${themeColor('input-border')}`,
                        color: 'inherit',
                        padding: '1px 4px',
                        fontSize: 12,
                      }}
                    />
                  ) : (
                    <span
                      onDoubleClick={e => { e.stopPropagation(); startRename(layer); }}
                      style={{
                        flex: 1,
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {layer.name}
                    </span>
                  )}
                </div>

                {/* Per-layer controls — only show when selected */}
                {isSelected && (
                  <div style={{ marginTop: 4, paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 2 }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <select
                        value={layer.blendMode}
                        onChange={e => onChangeBlend(layer.id, e.target.value as BlendMode)}
                        style={{
                          flex: 1,
                          background: themeColor('input-bg'),
                          color: themeColor('text'),
                          border: `1px solid ${themeColor('input-border')}`,
                          padding: '2px 4px',
                          fontSize: 11,
                        }}
                      >
                        {BLEND_MODES.map(b => (
                          <option key={b.value} value={b.value}>{b.label}</option>
                        ))}
                      </select>
                      <span style={{ fontSize: 10, opacity: 0.8 }}>
                        {Math.round(layer.opacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={layer.opacity}
                      onChange={e => onChangeOpacity(layer.id, parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: themeColor('input-focus') }}
                    />
                    <div style={{ display: 'flex', gap: 2 }}>
                      <button onClick={() => onMoveUp(layer.id)} style={{ ...styles.button, padding: '2px 6px', fontSize: 10, flex: 1 }} title="Move up">▲</button>
                      <button onClick={() => onMoveDown(layer.id)} style={{ ...styles.button, padding: '2px 6px', fontSize: 10, flex: 1 }} title="Move down">▼</button>
                      <button onClick={() => onDuplicate(layer.id)} style={{ ...styles.button, padding: '2px 6px', fontSize: 10, flex: 1 }} title="Duplicate">⧉</button>
                      {onEditMask && (
                        <button
                          onClick={() => onEditMask(layer.id)}
                          style={{ ...styles.button, padding: '2px 6px', fontSize: 10, flex: 1 }}
                          title="Edit mask"
                        >
                          🎭
                        </button>
                      )}
                      <button onClick={() => onDelete(layer.id)} style={{ ...styles.button, padding: '2px 6px', fontSize: 10, flex: 1, color: '#f87171' }} title="Delete">✕</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ── v2.10.1: Tool Properties (unified panel) ────────── */}
      {/* Shows different properties depending on the active tool:
            - Selection tools (rect/ellipse/lasso/polygonal): Selection Modes
            - Bucket tool: Bucket Fill Mode + color picker
            - Transform/Zoom/Cursor: hidden */}
      <div
        style={{
          borderTop: '1px solid var(--gt-border, #333)',
          padding: '8px 6px',
          display: ['move', 'scale', 'rotate', 'skew', 'perspective', 'zoom', 'none'].includes(activeTool) ? 'none' : 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--gt-text-muted, #888)',
          marginBottom: 2,
        }}>
          {activeTool === 'bucket' ? 'Tool Properties — Bucket Fill' : 'Tool Properties — Selection'}
        </div>
        {/* Selection Modes — only for selection tools (not bucket) */}
        {activeTool !== 'bucket' && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 4,
          }}>
            <SelectionModeButton
              mode="new"
              active={selectionOpMode === 'new'}
              onClick={() => onSelectionOpModeChange('new')}
              title="New Selection (N) — replace existing"
            />
            <SelectionModeButton
              mode="add"
              active={selectionOpMode === 'add'}
              onClick={() => onSelectionOpModeChange('add')}
              title="Add to Selection (Shift while dragging)"
            />
            <SelectionModeButton
              mode="subtract"
              active={selectionOpMode === 'subtract'}
              onClick={() => onSelectionOpModeChange('subtract')}
              title="Subtract from Selection (Alt while dragging)"
            />
            <SelectionModeButton
              mode="intersect"
              active={selectionOpMode === 'intersect'}
              onClick={() => onSelectionOpModeChange('intersect')}
              title="Intersect with Selection (Shift+Alt while dragging)"
            />
          </div>
        )}
      </div>

      {/* v2.10: Bucket Tool settings — part of the unified Tool Properties panel above. */}
      {activeTool === 'bucket' && (
        <div
          style={{
            padding: '0 6px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {([
              { mode: 'solid-canvas',       label: 'Solid → Canvas (new layer)',      title: 'Fill entire canvas with solid color on a new layer' },
              { mode: 'solid-selection',    label: 'Solid → Selection (new layer)',   title: 'Fill active selection with solid color on a new layer' },
              { mode: 'solid-into-layer',   label: 'Solid → Into Layer',              title: 'Paint solid color into the selected layer (modifies content)' },
              { mode: 'screentone-canvas',  label: 'Screentone → Canvas (new layer)', title: 'Fill entire canvas with screentone on a new layer' },
              { mode: 'screentone-selection', label: 'Screentone → Selection (new layer)', title: 'Fill active selection with screentone on a new layer' },
            ] as Array<{ mode: BucketMode; label: string; title: string }>).map(item => (
              <button
                key={item.mode}
                onClick={() => onBucketModeChange(item.mode)}
                title={item.title}
                style={{
                  padding: '4px 8px',
                  fontSize: 11,
                  textAlign: 'left',
                  background: bucketMode === item.mode ? themeColor('input-focus') : 'transparent',
                  color: bucketMode === item.mode ? '#fff' : themeColor('text'),
                  border: `1px solid ${bucketMode === item.mode ? themeColor('input-focus') : themeColor('border')}`,
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          {/* Color picker — only for solid modes */}
          {bucketMode.startsWith('solid') && (
            <ColorField
              label="Fill Color"
              value={bucketColor}
              onChange={onBucketColorChange}
            />
          )}
          {/* Hint about selection requirement */}
          {bucketMode.endsWith('selection') && !hasSelection && (
            <div style={{ fontSize: 10, color: themeColor('text-dim'), fontStyle: 'italic' }}>
              No active selection — make a selection first (Rect/Ellipse/Lasso tools).
            </div>
          )}
          {/* Hint about layer requirement */}
          {bucketMode === 'solid-into-layer' && !selectedId && (
            <div style={{ fontSize: 10, color: themeColor('text-dim'), fontStyle: 'italic' }}>
              No active layer — select a layer first.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// PresetBrowser — preset grid with search/filter
// ────────────────────────────────────────────────────────────

interface PresetBrowserProps {
  onApply: (preset: PresetV2) => void;
  onSaveCurrent: () => void;
  onEdit: (preset: PresetV2) => void;
  onExport: () => void;
  onImport: () => void;
  refreshKey: number;
}

function PresetBrowser({
  onApply, onSaveCurrent, onEdit, onExport, onImport, refreshKey,
}: PresetBrowserProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');

  // refreshKey forces re-read from presetStore after CRUD
  const categories = useMemo(() => ['All', ...presetStore.getAllCategories()], [refreshKey]);

  const filtered = useMemo(() => {
    return presetStore.searchPresets(query, category);
  }, [query, category, refreshKey]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '6px 8px', borderBottom: `1px solid ${themeColor('border')}` }}>
        <input
          type="text"
          placeholder="Search presets…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{ ...styles.input, width: '100%', padding: '4px 6px', fontSize: 12, marginBottom: 4, boxSizing: 'border-box' }}
        />
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          style={{ ...styles.input, width: '100%', padding: '3px 4px', fontSize: 11, boxSizing: 'border-box' }}
        >
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 4 }} className="custom-scroll">
        {filtered.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, textAlign: 'center', ...styles.textDim }}>
            No presets match.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
            {filtered.map(preset => (
              <button
                key={preset.id}
                onClick={() => onApply(preset)}
                onDoubleClick={() => onEdit(preset)}
                title={`${preset.name}\n${preset.description ?? ''}\n\nClick: apply to layer\nDouble-click: edit preset`}
                style={{
                  padding: 6,
                  background: themeColor('input-bg'),
                  border: `1px solid ${preset.id.startsWith('classic') || preset.isBuiltIn ? themeColor('sub-border') : themeColor('input-border')}`,
                  borderRadius: 4,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 2,
                  color: themeColor('text'),
                }}
              >
                <span style={{ fontSize: 24 }}>{preset.icon}</span>
                <span style={{ fontSize: 10, textAlign: 'center', lineHeight: 1.2 }}>
                  {preset.name}
                </span>
                {preset.isBuiltIn && (
                  <span style={{ fontSize: 8, ...styles.textDim }}>built-in</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: '6px 8px', borderTop: `1px solid ${themeColor('border')}`, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button onClick={onSaveCurrent} style={{ ...styles.button, padding: '3px 8px', fontSize: 11, flex: 1 }} title="Save current layer params as a new preset">
          + Save
        </button>
        <button onClick={onExport} style={{ ...styles.button, padding: '3px 8px', fontSize: 11 }} title="Export user presets as JSON">
          ↓
        </button>
        <button onClick={onImport} style={{ ...styles.button, padding: '3px 8px', fontSize: 11 }} title="Import presets from JSON">
          ↑
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// PresetEditorModal — create/edit user preset
// ────────────────────────────────────────────────────────────

interface PresetEditorModalProps {
  preset: PresetV2 | null; // null = creating new from current params
  currentParams: ScreentoneParams | null; // when creating new
  onClose: () => void;
  onSave: (data: { id?: string; name: string; icon: string; category: string; description: string; tags: string[] }) => void;
}

function PresetEditorModal({ preset, currentParams, onClose, onSave }: PresetEditorModalProps) {
  const [name, setName] = useState(preset?.name ?? '');
  const [icon, setIcon] = useState(preset?.icon ?? '🎨');
  const [category, setCategory] = useState(preset?.category ?? 'User');
  const [description, setDescription] = useState(preset?.description ?? '');
  const [tagsStr, setTagsStr] = useState((preset?.tags ?? []).join(', '));

  const isEditing = preset !== null;
  const canSave = name.trim().length > 0 && (isEditing || currentParams !== null);

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      id: preset?.id,
      name: name.trim(),
      icon: icon.trim() || '🎨',
      category: category.trim() || 'User',
      description: description.trim(),
      tags: tagsStr.split(',').map(t => t.trim()).filter(Boolean),
    });
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: themeColor('overlay-bg'),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: themeColor('info-bg'),
          border: `1px solid ${themeColor('info-border')}`,
          borderRadius: 6,
          padding: 16,
          width: 360,
          maxWidth: '90vw',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
        className="custom-scroll"
      >
        <h2 style={{ fontSize: 14, marginTop: 0, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {isEditing ? 'Edit Preset' : 'Save Preset'}
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ width: 60, fontSize: 12, ...styles.textMuted }}>Icon</span>
            <input
              type="text"
              value={icon}
              onChange={e => setIcon(e.target.value)}
              maxLength={2}
              style={{ ...styles.input, width: 40, padding: '4px 6px', fontSize: 16, textAlign: 'center' }}
            />
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Preset name"
              autoFocus
              style={{ ...styles.input, flex: 1, padding: '4px 6px', fontSize: 13 }}
            />
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ width: 60, fontSize: 12, ...styles.textMuted }}>Category</span>
            <input
              type="text"
              value={category}
              onChange={e => setCategory(e.target.value)}
              placeholder="Category"
              list="preset-categories"
              style={{ ...styles.input, flex: 1, padding: '4px 6px', fontSize: 13 }}
            />
            <datalist id="preset-categories">
              {presetStore.getAllCategories().map(c => <option key={c} value={c} />)}
            </datalist>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, ...styles.textMuted }}>Description</span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={2}
              style={{ ...styles.input, padding: '4px 6px', fontSize: 12, resize: 'vertical' }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, ...styles.textMuted }}>Tags (comma-separated)</span>
            <input
              type="text"
              value={tagsStr}
              onChange={e => setTagsStr(e.target.value)}
              placeholder="manga, dark, shadow"
              style={{ ...styles.input, padding: '4px 6px', fontSize: 12 }}
            />
          </label>

          {!isEditing && currentParams && (
            <div style={{ fontSize: 11, ...styles.textDim, padding: 6, background: themeColor('sub-bg'), borderRadius: 3 }}>
              Will save current parameters: {currentParams.patternType} / {currentParams.dotShape} / size {currentParams.dotSize}px
            </div>
          )}

          {isEditing && preset?.isBuiltIn && (
            <div style={{ fontSize: 11, color: '#fbbf24', padding: 6, background: 'rgba(251, 191, 36, 0.1)', borderRadius: 3 }}>
              ⚠ Built-in preset — saving will create a duplicate as a user preset.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...styles.button, padding: '6px 14px', fontSize: 12 }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              background: canSave ? themeColor('input-focus') : themeColor('btn-secondary'),
              color: canSave ? '#fff' : themeColor('text-dim'),
              border: `1px solid ${themeColor('input-border')}`,
              cursor: canSave ? 'pointer' : 'not-allowed',
              borderRadius: 3,
            }}
          >
            {isEditing ? (preset?.isBuiltIn ? 'Save as New' : 'Save Changes') : 'Create Preset'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// CanvasView — the main canvas with pan/zoom
// ────────────────────────────────────────────────────────────

interface CanvasViewProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  docSize: { w: number; h: number };
  zoom: number;
  panX: number;
  panY: number;
  onZoom: (z: number) => void;
  onPan: (x: number, y: number) => void;
  selectedLayer: Layer | null;
  compositeCtx: CompositeContext;
  /** v2.5: active tool — when 'zoom', mouse events drive the Zoom tool. */
  activeTool: ToolId;
  /** v2.10: Bucket fill callback — called on click when activeTool === 'bucket'. */
  onBucketFill?: () => void;
}

/** v2.5: Zoom tool zoom factor per click. */
const ZOOM_TOOL_FACTOR = 1.5;
/** v2.5: Drag threshold (px) — below this, pointerup is a click, not a marquee. */
const ZOOM_DRAG_THRESHOLD = 5;

function CanvasView({
  canvasRef, docSize, zoom, panX, panY, onZoom, onPan, selectedLayer, compositeCtx,
  activeTool, onBucketFill,
}: CanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  // v2.5: Zoom tool marquee state. When non-null, user is dragging out a zoom rect.
  const zoomMarqueeRef = useRef<{ startX: number; startY: number; altKey: boolean } | null>(null);
  const [zoomMarquee, setZoomMarquee] = useState<{ x: number; y: number; w: number; h: number; altKey: boolean } | null>(null);

  // Calculate selected layer's on-screen bounding box for the selection overlay
  const selectionOverlay = useMemo(() => {
    if (!selectedLayer) return null;
    return getLayerCanvasBounds(selectedLayer, compositeCtx);
  }, [selectedLayer, compositeCtx]);

  const handleWheel = (e: React.WheelEvent) => {
    // v2.11: Zoom = Ctrl+scroll (Photoshop convention).
    // - Ctrl/Cmd+scroll = zoom canvas at any tool. preventDefault stops
    //   the browser from zooming the entire page UI.
    // - Plain scroll (no modifier) = zoom ONLY for Cursor ('none') and
    //   Zoom tools. For all other tools, plain scroll does nothing
    //   (prevents accidental zoom while using bucket/selection/etc).
    // - Z+scroll removed (was unreliable, caused side effects with Ctrl+Z).
    const isCtrlZoom = e.ctrlKey || e.metaKey;
    if (!isCtrlZoom && activeTool !== 'none' && activeTool !== 'zoom') {
      return;
    }
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Zoom factor
    const delta = -e.deltaY * 0.001;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * (1 + delta)));

    // Zoom toward mouse position: keep the point under cursor stable
    // World point under cursor before zoom:
    //   worldX = (mouseX - panX) / zoom
    // After zoom we want: mouseX = worldX * newZoom + newPanX
    //   newPanX = mouseX - worldX * newZoom
    const worldX = (mouseX - panX) / zoom;
    const worldY = (mouseY - panY) / zoom;
    onPan(mouseX - worldX * newZoom, mouseY - worldY * newZoom);
    onZoom(newZoom);
  };

  // v2.5: Helper — zoom by a factor centered on a screen-space point.
  // Keeps the document point under (mouseX, mouseY) stationary on screen.
  const zoomTowardPoint = (mouseX: number, mouseY: number, factor: number) => {
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (newZoom === zoom) return;
    const worldX = (mouseX - panX) / zoom;
    const worldY = (mouseY - panY) / zoom;
    onPan(mouseX - worldX * newZoom, mouseY - worldY * newZoom);
    onZoom(newZoom);
  };

  // v2.5: Helper — zoom to fit a screen-space rectangle (marquee zoom).
  // The marquee rect becomes the new viewport content for that area.
  const zoomToScreenRect = (rect: { x: number; y: number; w: number; h: number }) => {
    if (rect.w < 2 || rect.h < 2) return; // ignore tiny drags
    const container = containerRef.current;
    if (!container) return;
    const viewportW = container.clientWidth;
    const viewportH = container.clientHeight;
    // Zoom so that the marquee fits the viewport (with small padding).
    const padding = 16;
    const availableW = viewportW - padding * 2;
    const availableH = viewportH - padding * 2;
    const zoomX = availableW / rect.w;
    const zoomY = availableH / rect.h;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(zoomX, zoomY)));
    // Pan so the marquee center aligns with viewport center.
    const marqueeCenterX = rect.x + rect.w / 2;
    const marqueeCenterY = rect.y + rect.h / 2;
    // World point under marquee center (in doc-px, using OLD zoom):
    const worldX = (marqueeCenterX - panX) / zoom;
    const worldY = (marqueeCenterY - panY) / zoom;
    onPan(viewportW / 2 - worldX * newZoom, viewportH / 2 - worldY * newZoom);
    onZoom(newZoom);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // v2.10: Bucket tool — click fills canvas/selection/layer.
    // No drag, no marquee — just a single click triggers the fill.
    if (activeTool === 'bucket' && e.button === 0) {
      e.preventDefault();
      onBucketFill?.();
      return;
    }
    // v2.5: Zoom tool — always handle left-click (no Alt = zoom in, Alt = zoom out).
    // Marquee-zoom starts on drag; if no drag, single-click zoom on pointerup.
    if (activeTool === 'zoom' && e.button === 0) {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      zoomMarqueeRef.current = { startX: mouseX, startY: mouseY, altKey: e.altKey };
      return;
    }
    if (e.button === 1 || (e.button === 0 && (e.altKey || e.metaKey))) {
      // Middle mouse or Alt+click → pan
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startY: e.clientY, panX, panY };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      onPan(dragRef.current.panX + dx, dragRef.current.panY + dy);
      return;
    }
    // v2.5: Zoom tool marquee drag — update live marquee rect.
    if (zoomMarqueeRef.current) {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const curX = e.clientX - rect.left;
      const curY = e.clientY - rect.top;
      const start = zoomMarqueeRef.current;
      const x = Math.min(start.startX, curX);
      const y = Math.min(start.startY, curY);
      const w = Math.abs(curX - start.startX);
      const h = Math.abs(curY - start.startY);
      // Only show marquee if drag exceeds threshold (else it's a click).
      if (w >= ZOOM_DRAG_THRESHOLD || h >= ZOOM_DRAG_THRESHOLD) {
        setZoomMarquee({ x, y, w, h, altKey: start.altKey });
      } else {
        setZoomMarquee(null);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (dragRef.current) {
      dragRef.current = null;
      return;
    }
    // v2.5: Zoom tool — finalize click or marquee.
    if (zoomMarqueeRef.current) {
      const container = containerRef.current;
      const start = zoomMarqueeRef.current;
      zoomMarqueeRef.current = null;
      const marquee = zoomMarquee;
      setZoomMarquee(null);
      if (marquee && container) {
        // Drag exceeded threshold → marquee zoom.
        if (start.altKey) {
          // Alt+drag = zoom OUT (Photoshop: Alt+drag does opposite of marquee).
          // We zoom out centered on marquee center.
          const cx = marquee.x + marquee.w / 2;
          const cy = marquee.y + marquee.h / 2;
          // Out-zoom factor: inverse of how much the marquee covers viewport.
          const containerRect = container.getBoundingClientRect();
          const viewportDiag = Math.hypot(containerRect.width, containerRect.height);
          const marqueeDiag = Math.hypot(marquee.w, marquee.h);
          const factor = Math.max(0.1, marqueeDiag / viewportDiag);
          zoomTowardPoint(cx, cy, factor);
        } else {
          // Normal drag = marquee zoom IN to that rect.
          zoomToScreenRect(marquee);
        }
      } else if (container) {
        // No drag → single-click zoom.
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        if (start.altKey) {
          zoomTowardPoint(mouseX, mouseY, 1 / ZOOM_TOOL_FACTOR);
        } else {
          zoomTowardPoint(mouseX, mouseY, ZOOM_TOOL_FACTOR);
        }
      }
    }
  };

  const handleMouseLeave = () => {
    dragRef.current = null;
    // Cancel any in-progress marquee on leave (Photoshop behaviour).
    zoomMarqueeRef.current = null;
    setZoomMarquee(null);
  };

  // Convert selection overlay (doc-space) to screen-space for rendering
  const screenOverlay = selectionOverlay
    ? {
        left: panX + selectionOverlay.x * zoom,
        top: panY + selectionOverlay.y * zoom,
        width: selectionOverlay.w * zoom,
        height: selectionOverlay.h * zoom,
      }
    : null;

  // v2.5: Cursor based on active tool.
  // Zoom tool shows magnifying-glass cursor (with +/- depending on Alt state,
  // approximated by cursor: zoom-in / zoom-out).
  const cursor = activeTool === 'zoom'
    ? (zoomMarqueeRef.current?.altKey ? 'zoom-out' : 'zoom-in')
    : activeTool === 'bucket'
      ? 'crosshair'
      : (dragRef.current ? 'grabbing' : 'default');

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      style={{
        position: 'relative',
        flex: 1,
        overflow: 'hidden',
        // Photoshop-style dark workspace background — the document
        // surface itself is on a checkerboard, this is the area around it.
        background: themeColor('app-bg'),
        cursor,
      }}
      className="gt-noselect"
    >
      {/* Document surface wrapper — positioned in screen-space using pan/zoom.
          Photoshop-style: document floats on dark workspace, has a thin
          light/dark outline so the user can see where the canvas ends. */}
      <div
        style={{
          position: 'absolute',
          left: panX,
          top: panY,
          width: docSize.w * zoom,
          height: docSize.h * zoom,
          transform: 'translateZ(0)', // GPU layer
          boxShadow:
            '0 0 0 1px rgba(255,255,255,0.18), 0 0 0 2px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.45)',
        }}
      >
        {/* Checkerboard background to show transparency */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `
              linear-gradient(45deg, ${themeColor('checker1')} 25%, transparent 25%),
              linear-gradient(-45deg, ${themeColor('checker1')} 25%, transparent 25%),
              linear-gradient(45deg, transparent 75%, ${themeColor('checker1')} 75%),
              linear-gradient(-45deg, transparent 75%, ${themeColor('checker1')} 75%)
            `,
            backgroundSize: `${CHECKERBOARD_SIZE}px ${CHECKERBOARD_SIZE}px`,
            backgroundPosition: `0 0, 0 ${CHECKERBOARD_SIZE / 2}px, ${CHECKERBOARD_SIZE / 2}px ${-CHECKERBOARD_SIZE / 2}px, ${-CHECKERBOARD_SIZE / 2}px 0`,
            backgroundColor: themeColor('checker2'),
          }}
        />
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            imageRendering: zoom >= 4 ? 'pixelated' : 'auto',
          }}
        />
      </div>

      {/* Selection overlay — dim blue dashed rect showing selected layer's bounds.
          This is the "marching ants" hint for which layer is active. */}
      {screenOverlay && (
        <div
          style={{
            position: 'absolute',
            left: screenOverlay.left,
            top: screenOverlay.top,
            width: screenOverlay.width,
            height: screenOverlay.height,
            border: '1px dashed #4d9fff',
            pointerEvents: 'none',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
          }}
        />
      )}

      {/* v2.5: Zoom tool marquee — drawn while user drags out a zoom rectangle.
          Solid border + semi-transparent fill, Photoshop style. */}
      {zoomMarquee && (
        <div
          style={{
            position: 'absolute',
            left: zoomMarquee.x,
            top: zoomMarquee.y,
            width: zoomMarquee.w,
            height: zoomMarquee.h,
            border: '1px solid #fff',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
            background: zoomMarquee.altKey
              ? 'rgba(255, 80, 80, 0.12)'  // Alt+drag (zoom out) — red tint
              : 'rgba(80, 180, 255, 0.12)', // Normal drag (zoom in) — blue tint
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Zoom badge removed — zoom/dims/DPI now live in the bottom Status Bar */}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Toolbox — left vertical strip with tools (Photoshop/Krita style)
// ────────────────────────────────────────────────────────────
//
// Tools are grouped into sections:
//   • Navigate  — cursor (no tool / pure canvas pan)
//   • Transform — move / scale / rotate / skew / free (perspective)
//   • Selection — rect / ellipse / lasso / polygonal  (marquee → mask)
//
// The Toolbox only emits `onToolChange(toolId)`. It does NOT render
// handles itself — the `<TransformPanelOverlay>` over the canvas does.
// This keeps the canvas area free of floating UI (Kimi analysis rec #1).

interface ToolboxProps {
  activeTool: ToolId;
  onToolChange: (t: ToolId) => void;
  disabledAffine?: boolean; // perspective mode disables affine tools
  hasActiveLayer: boolean;
}

interface ToolGroup {
  id: string;
  label: string;
  tools: Array<{ id: ToolId; icon: string; label: string; hint: string }>;
}

// v2.10: Bucket tool fill modes.
// See [bucketMode] state in App for detailed descriptions.
type BucketMode =
  | 'solid-canvas'
  | 'solid-selection'
  | 'solid-into-layer'
  | 'screentone-canvas'
  | 'screentone-selection';

// ────────────────────────────────────────────────────────────
// A2.1a: SVG icons for selection tools — replace Unicode glyphs.
//
// Previous icons (Unicode): ▭ ◯ ✎ ⬠ — looked like plain geometric
// shapes, not like selection tools. New SVG icons follow Photoshop /
// Clip Studio Paint conventions:
//   • Rect / Ellipse  — dashed border + corner dots (marquee handles)
//   • Lasso           — freehand curve (lasso rope metaphor)
//   • Polygonal       — angular polyline + vertex dots
//
// 20x20 viewBox to match Toolbox button size (~36px after padding).
// ────────────────────────────────────────────────────────────
function SelectionToolIcon({ toolId }: { toolId: ToolId }) {
  const stroke = 'currentColor';
  const dash = '3 2';
  const sw = 1.5;
  const dot = 1.6;

  switch (toolId) {
    case 'rect':
      // Dashed rectangle + 4 corner dots (marquee handles).
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <rect
            x="3.5" y="3.5" width="13" height="13"
            stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
          />
          <circle cx="3.5" cy="3.5" r={dot} fill={stroke} />
          <circle cx="16.5" cy="3.5" r={dot} fill={stroke} />
          <circle cx="16.5" cy="16.5" r={dot} fill={stroke} />
          <circle cx="3.5" cy="16.5" r={dot} fill={stroke} />
        </svg>
      );

    case 'ellipse':
      // Dashed ellipse + 4 handle dots at N/S/E/W extremes.
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <ellipse
            cx="10" cy="10" rx="7" ry="6"
            stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
          />
          <circle cx="10" cy="4" r={dot} fill={stroke} />
          <circle cx="17" cy="10" r={dot} fill={stroke} />
          <circle cx="10" cy="16" r={dot} fill={stroke} />
          <circle cx="3" cy="10" r={dot} fill={stroke} />
        </svg>
      );

    case 'lasso':
      // Freehand lasso: organic curve + small handle dot at start point.
      // Path: starts top-left, curves around clockwise, almost-closed.
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path
            d="M 4 6 Q 6 3, 11 4 T 17 9 Q 18 14, 13 17 Q 8 18, 4 14 Q 2 10, 4 6 Z"
            stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
            fill="none" strokeLinejoin="round"
          />
          {/* Start-point handle — indicates where the lasso begins */}
          <circle cx="4" cy="6" r={dot} fill={stroke} />
        </svg>
      );

    case 'polygonal':
      // Angular polyline (5 vertices) + vertex dots.
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <polygon
            points="4,15 6,5 14,4 17,11 12,17"
            stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
            fill="none" strokeLinejoin="round"
          />
          {/* Vertex dots */}
          <circle cx="4" cy="15" r={dot} fill={stroke} />
          <circle cx="6" cy="5" r={dot} fill={stroke} />
          <circle cx="14" cy="4" r={dot} fill={stroke} />
          <circle cx="17" cy="11" r={dot} fill={stroke} />
          <circle cx="12" cy="17" r={dot} fill={stroke} />
        </svg>
      );

    default:
      return null;
  }
}

// ────────────────────────────────────────────────────────────
// A2.1a: SelectionModeButton — single operation mode button
// (New / Add / Subtract / Intersect). SVG icons per user mockup.
// ────────────────────────────────────────────────────────────
interface SelectionModeButtonProps {
  mode: SelectionOpMode;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}

function SelectionModeButton({ mode, active, onClick, disabled, title }: SelectionModeButtonProps) {
  return (
    <button
      type="button"
      className="gt-tool-btn gt-tooltip-top"
      data-active={active}
      data-tooltip={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        // Slightly smaller than Toolbox buttons — fit 4 across Layers panel width.
        width: '100%',
        aspectRatio: '1 / 1',
        padding: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <SelectionModeIcon mode={mode} />
    </button>
  );
}

// SVG icons for selection operation modes.
// Style: 16x16 viewBox, stroke=currentColor, dashed border for "selection" feel.
function SelectionModeIcon({ mode }: { mode: SelectionOpMode }) {
  const stroke = 'currentColor';
  const dash = '3 2';
  const sw = 1.5;

  switch (mode) {
    case 'new':
      // Single dashed square (no symbol inside) — represents "fresh selection".
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect
            x="2.5" y="2.5" width="11" height="11"
            stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
          />
        </svg>
      );

    case 'add':
      // Dashed square + plus sign inside.
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect
            x="2.5" y="2.5" width="11" height="11"
            stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
          />
          <line x1="8" y1="5.5" x2="8" y2="10.5" stroke={stroke} strokeWidth={sw + 0.3} strokeLinecap="round" />
          <line x1="5.5" y1="8" x2="10.5" y2="8" stroke={stroke} strokeWidth={sw + 0.3} strokeLinecap="round" />
        </svg>
      );

    case 'subtract':
      // Dashed square + minus sign inside.
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect
            x="2.5" y="2.5" width="11" height="11"
            stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
          />
          <line x1="5.5" y1="8" x2="10.5" y2="8" stroke={stroke} strokeWidth={sw + 0.3} strokeLinecap="round" />
        </svg>
      );

    case 'intersect':
      // Two overlapping dashed squares.
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect
            x="1.5" y="3.5" width="9" height="9"
            stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
          />
          <rect
            x="5.5" y="1.5" width="9" height="9"
            stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
          />
        </svg>
      );
  }
}

const TOOLBOX_GROUPS: ToolGroup[] = [
  {
    id: 'navigate',
    label: 'Navigate',
    tools: [
      { id: 'none', icon: '▷', label: 'Cursor', hint: 'Cursor (no tool) — pan/zoom only' },
      { id: 'zoom', icon: '🔍', label: 'Zoom', hint: 'Zoom tool (Z) — click=zoom in, Alt+click=zoom out, drag=marquee' },
    ],
  },
  {
    id: 'transform',
    label: 'Transform',
    tools: [
      { id: 'move',        icon: '✥', label: 'Move',     hint: 'Move (V)' },
      { id: 'scale',       icon: '⤢', label: 'Scale',    hint: 'Scale (S)' },
      { id: 'rotate',      icon: '⟲', label: 'Rotate',   hint: 'Rotate (R)' },
      { id: 'skew',        icon: '⤡', label: 'Skew',     hint: 'Skew (K)' },
      { id: 'perspective', icon: '⬔', label: 'Free',     hint: 'Perspective / Free Transform (F)' },
    ],
  },
  {
    id: 'selection',
    label: 'Selection',
    tools: [
      { id: 'rect',      icon: '', label: 'Rect',     hint: 'Rectangular Marquee (M)' },
      { id: 'ellipse',   icon: '', label: 'Ellipse',  hint: 'Elliptical Marquee (E)' },
      { id: 'lasso',     icon: '', label: 'Lasso',    hint: 'Freehand Lasso (L)' },
      { id: 'polygonal', icon: '', label: 'Polygon',  hint: 'Polygonal Lasso (P)' },
    ],
  },
  {
    id: 'paint',
    label: 'Paint',
    tools: [
      { id: 'bucket', icon: '🪣', label: 'Bucket', hint: 'Bucket fill (B) — fill canvas/selection with solid color or screentone' },
    ],
  },
];

function Toolbox({ activeTool, onToolChange, disabledAffine, hasActiveLayer }: ToolboxProps) {
  return (
    <div
      style={{
        ...styles.toolbox,
        width: 52,
        minWidth: 52,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '8px 0',
        gap: 2,
      }}
      className="gt-noselect"
    >
      {TOOLBOX_GROUPS.map((group, gi) => (
        <div key={group.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
          {gi > 0 && <div className="gt-tool-divider" style={{ width: 28 }} />}
          {group.tools.map(t => {
            // BUG-1 FIX: Affine tool buttons (move/scale/rotate/skew) MUST stay
            // clickable even when the layer is in perspective mode (corners set).
            // Clicking them triggers handleToolChange, which bakes the perspective
            // into an affine approximation (see handleToolChange in App.tsx) and
            // clears corners — exactly the workflow the user expects.
            // Previously these buttons were disabled via `disabledAffine`, which
            // left the user stuck in perspective mode with no visible way to
            // switch to rotate/scale/etc (the keyboard shortcut worked, but the
            // button did not — confusing UX and the root cause of BUG-1).
            const disabled = !hasActiveLayer;
            return (
              <button
                key={t.id}
                type="button"
                className="gt-tool-btn"
                data-active={activeTool === t.id}
                data-tooltip={`${t.label} — ${t.hint}`}
                disabled={disabled}
                onClick={() => onToolChange(t.id)}
              >
                {(t.id === 'rect' || t.id === 'ellipse' || t.id === 'lasso' || t.id === 'polygonal')
                  ? <SelectionToolIcon toolId={t.id} />
                  : t.icon}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// StatusBar — bottom strip with zoom/dims/DPI/mode/context-help
// ────────────────────────────────────────────────────────────

interface StatusBarProps {
  zoom: number;
  onZoomChange: (z: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoom100: () => void;
  onFitView: () => void;
  docWidth: number;
  docHeight: number;
  dpi: number;
  activeTool: ToolId;
  activeLayerName: string | null;
  perspectiveMode: boolean;
  maskPresent: boolean;
  showRulers: boolean;
  onToggleRulers: () => void;
}

const TOOL_LABELS: Record<ToolId, string> = {
  none: 'Cursor',
  move: 'Move',
  scale: 'Scale',
  rotate: 'Rotate',
  skew: 'Skew',
  perspective: 'Free Transform',
  rect: 'Rect Marquee',
  ellipse: 'Ellipse Marquee',
  lasso: 'Lasso',
  polygonal: 'Polygonal Lasso',
  zoom: 'Zoom',
  bucket: 'Bucket Fill',
};

const TOOL_HINTS: Record<ToolId, string> = {
  none: 'Space-drag to pan · ⌘/Ctrl+wheel to zoom',
  move: 'Drag to move · Shift+edge-handle to skew · V',
  scale: 'Drag corner to scale · Shift+edge-handle to skew · S',
  rotate: 'Drag to rotate (Shift = 45° snap) · Shift+edge-handle to skew · R',
  skew: 'Drag side handles to skew (one edge fixed) · K',
  perspective: 'Drag corner handles to deform perspective · F',
  rect: 'Click-drag to mark rectangular selection · M',
  ellipse: 'Click-drag to mark elliptical selection · E',
  lasso: 'Draw freehand · release to close selection · L',
  polygonal: 'Click to add points · double-click to close · P',
  zoom: 'Click to zoom in · Alt+click to zoom out · drag to marquee-zoom · Z',
  bucket: 'Click to fill canvas or selection · B — choose mode in panel below',
};

function StatusBar({
  zoom, onZoomChange, onZoomIn, onZoomOut, onZoom100, onFitView,
  docWidth, docHeight, dpi, activeTool, activeLayerName,
  perspectiveMode, maskPresent, showRulers, onToggleRulers,
}: StatusBarProps) {
  const zoomPct = Math.round(zoom * 100);
  return (
    <div className="gt-statusbar" style={{ ...styles.statusbar }}>
      <div className="gt-status-item">
        <button
          onClick={onZoomOut}
          style={{ ...styles.button, padding: '1px 6px', fontSize: 12, lineHeight: '14px' }}
          title="Zoom out"
        >−</button>
        <input
          type="range"
          min={5}
          max={1600}
          value={Math.max(5, Math.min(1600, zoomPct))}
          onChange={e => onZoomChange(parseInt(e.target.value) / 100)}
          style={{ width: 90 }}
          title="Zoom"
        />
        <button
          onClick={onZoomIn}
          style={{ ...styles.button, padding: '1px 6px', fontSize: 12, lineHeight: '14px' }}
          title="Zoom in"
        >+</button>
        <span style={{ minWidth: 42, textAlign: 'right' }}>{zoomPct}%</span>
        <button
          onClick={onZoom100}
          style={{ ...styles.button, padding: '1px 8px', fontSize: 11 }}
          title="Actual size (100%)"
        >1:1</button>
        <button
          onClick={onFitView}
          style={{ ...styles.button, padding: '1px 8px', fontSize: 11 }}
          title="Fit to screen"
        >Fit</button>
      </div>

      <div className="gt-status-sep" />

      <div className="gt-status-item" title="Document size">
        {docWidth}×{docHeight}px
      </div>

      <div className="gt-status-sep" />

      <div className="gt-status-item" title="Resolution">
        {dpi} DPI
      </div>

      <div className="gt-status-sep" />

      <div className="gt-status-item" title="Active tool">
        <strong style={{ color: 'var(--c-text)' }}>{TOOL_LABELS[activeTool]}</strong>
      </div>

      {activeLayerName && (
        <>
          <div className="gt-status-sep" />
          <div className="gt-status-item" title="Active layer">
            {activeLayerName}
          </div>
        </>
      )}

      {perspectiveMode && (
        <>
          <div className="gt-status-sep" />
          <div className="gt-status-item" style={{ color: '#f8a' }}>
            ◆ Perspective mode
          </div>
        </>
      )}

      {maskPresent && (
        <>
          <div className="gt-status-sep" />
          <div className="gt-status-item" title="Layer has mask">
            ◫ Mask
          </div>
        </>
      )}

      <div className="gt-status-sep" />

      {/* Rulers toggle — indicator + button. Click to show/hide.
          Also toggled via Ctrl/Cmd+R. */}
      <button
        onClick={onToggleRulers}
        className="gt-status-item"
        data-active={showRulers}
        title={showRulers ? 'Hide rulers (Ctrl+R)' : 'Show rulers (Ctrl+R)'}
        style={{
          ...styles.button,
          padding: '1px 8px',
          fontSize: 11,
          background: showRulers ? themeColor('input-focus') : 'transparent',
          color: showRulers ? '#fff' : themeColor('text-muted'),
          border: `1px solid ${showRulers ? themeColor('input-focus') : themeColor('border')}`,
          cursor: 'pointer',
        }}
      >
        ⊐ Rulers
      </button>

      <div className="gt-status-hint">
        {TOOL_HINTS[activeTool]} · Right-click for palette
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// CanvasScrollbar — Photoshop-style custom scrollbar
// ────────────────────────────────────────────────────────────
//
// Why custom (not native overflow:auto):
//   The canvas content uses CSS transform to position layer quads in screen
//   space; switching to native overflow:auto would break the screenToCanvas
//   math used by every selection/transform tool.
//
// Photoshop behaviour we replicate:
//   • Scrollbar is always visible when content > viewport.
//   • Thumb size = viewport / content ratio (min 24px so it's grabbable).
//   • Drag thumb = direct pan (1:1, no acceleration).
//   • Click on empty track = page-jump toward click.
//   • Hover over scrollbar + wheel = pan by notches (40px per notch).
//   • Visual: thin (~12px) track with rounded thumb; Photoshop's modern look.
//
// Drag-vs-click disambiguation:
//   pointerdown anywhere on track starts a "potential drag".
//   If pointer moves > 3px before pointerup → it was a drag (thumb follows).
//   If pointer stays within 3px → it was a click → page-jump toward click.
//   This is the standard Photoshор/Krita behaviour.

interface CanvasScrollbarProps {
  orientation: 'horizontal' | 'vertical';
  pan: number;          // panX for horizontal, panY for vertical
  zoom: number;
  docExtent: number;    // docSize.w or docSize.h
  viewportExtent: number; // pixel size of the viewport (container.clientWidth/Height)
  onChange: (newPan: number) => void;
}

/** Extra virtual space around the document, in screen-px. Lets the user pan
 *  past the doc edges (Photoshop allows ~1 viewport worth of slack). */
const SCROLL_PADDING_SCREEN = 200;
/** Pixels per wheel notch. */
const SCROLL_WHEEL_STEP = 60;
/** Drag-vs-click threshold (px). Below this, pointerup is treated as a click. */
const DRAG_THRESHOLD = 3;

function CanvasScrollbar({
  orientation, pan, zoom, docExtent, viewportExtent, onChange,
}: CanvasScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  // drag state: startPan = pan at pointerdown; startMouse = clientX/Y at pointerdown;
  // isDragging = true once movement exceeds DRAG_THRESHOLD (so click can still fire).
  const dragRef = useRef<{
    startPan: number;
    startMouse: number;
    isDragging: boolean;
    pointerId: number;
  } | null>(null);

  const isH = orientation === 'horizontal';

  // ── Pan convention (preserved from existing code) ────────
  //   pan = 0 → doc top-left aligns with viewport top-left.
  //   pan > 0 → doc shifted right/down (padding visible on left/top).
  //   pan < 0 → doc shifted left/up (right/bottom part visible).
  //
  // ── Photoshop scrollbar convention ───────────────────────
  //   Thumb at TOP of track = viewport shows TOP of doc (pan = panMax = padding).
  //   Thumb at BOTTOM of track = viewport shows BOTTOM of doc (pan = panMin, most negative).
  //   Drag thumb DOWN → viewport scrolls DOWN → pan DECREASES (toward panMin).
  //   Drag thumb UP → viewport scrolls UP → pan INCREASES (toward panMax).
  //
  // This is the OPPOSITE of the naive "thumb position = pan value" mapping.
  // We invert both the thumb position formula and the drag delta sign.
  //
  // ── Compute geometry ─────────────────────────────────────
  const docScreenExtent = docExtent * zoom;
  // Virtual content = doc + padding on both sides.
  const virtualExtent = docScreenExtent + SCROLL_PADDING_SCREEN * 2;

  // Range of valid pan values:
  //   panMax = padding  → doc top-left aligns with viewport top-left (with padding above).
  //   panMin = -(docScreen - viewport) - padding  → doc bottom-right aligns (with padding below).
  const panMax = SCROLL_PADDING_SCREEN;
  const panMin = -(docScreenExtent - viewportExtent) - SCROLL_PADDING_SCREEN;
  const panClamped = Math.max(Math.min(panMin, panMax), Math.min(Math.max(panMin, panMax), pan));

  // Track length = viewportExtent (scrollbar fills the viewport edge).
  // Thumb size proportional to viewport / virtualExtent, clamped to [24, viewportExtent].
  const trackExtent = viewportExtent;
  const thumbSize = Math.max(24, Math.min(viewportExtent, (viewportExtent / virtualExtent) * viewportExtent));
  const thumbTravelRange = Math.max(1, trackExtent - thumbSize);
  // Thumb position: 0 (top) .. thumbTravelRange (bottom), INVERTED from pan.
  //   pan = panMax (top of doc visible) → thumbPos = 0 (thumb at top).
  //   pan = panMin (bottom of doc visible) → thumbPos = max (thumb at bottom).
  const panRange = panMax - panMin;
  const thumbPos = panRange > 0
    ? ((panMax - panClamped) / panRange) * thumbTravelRange
    : 0;

  // ── Convert screen-px delta → pan delta (INVERTED) ───────
  // Drag thumb down (positive screen delta) → scroll down → pan decreases.
  // Drag thumb up (negative screen delta) → scroll up → pan increases.
  const screenDeltaToPan = (delta: number) => -delta;

  // ── Pointer handlers ─────────────────────────────────────
  const handlePointerDown = (e: React.PointerEvent) => {
    // Only left button starts drag/click.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startMouse = isH ? e.clientX : e.clientY;
    // If pointer down on the thumb, start dragging from current pan.
    // If pointer down on the track (not thumb), Photoshop does a page-jump on
    // click — we delay that decision until pointerup (so we can tell drag from click).
    dragRef.current = {
      startPan: panClamped,
      startMouse,
      isDragging: false,
      pointerId: e.pointerId,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const cur = isH ? e.clientX : e.clientY;
    const delta = cur - dragRef.current.startMouse;
    if (!dragRef.current.isDragging) {
      // Threshold check: only start dragging after meaningful movement.
      if (Math.abs(delta) < DRAG_THRESHOLD) return;
      dragRef.current.isDragging = true;
    }
    // Thumb follows pointer 1:1 (pan delta = screen delta).
    const newPan = dragRef.current.startPan + screenDeltaToPan(delta);
    onChange(Math.max(panMin, Math.min(panMax, newPan)));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    // If it was a click (no significant movement), do page-jump toward click position.
    if (!d.isDragging && trackRef.current) {
      const rect = trackRef.current.getBoundingClientRect();
      const clickPos = isH ? e.clientX - rect.left : e.clientY - rect.top;
      // Page-jump: center the thumb on the click position.
      // Direction: jump toward click (up if click above thumb, down if below).
      const targetThumbCenter = clickPos;
      const newThumbPos = Math.max(0, Math.min(thumbTravelRange, targetThumbCenter - thumbSize / 2));
      // Invert: thumbPos = ((panMax - pan) / panRange) * travelRange
      //   → pan = panMax - (thumbPos / travelRange) * panRange
      const newPan = panMax - (newThumbPos / thumbTravelRange) * panRange;
      onChange(Math.max(panMin, Math.min(panMax, newPan)));
    }
  };

  // ── Wheel handler (Photoshop-style: wheel over scrollbar = pan by notches) ──
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Vertical scrollbar: deltaY scrolls; horizontal: deltaX (or deltaY if no deltaX).
    const delta = isH ? (e.deltaX !== 0 ? e.deltaX : e.deltaY) : e.deltaY;
    // Normalise to "notches" (wheel events can be in pixels, lines, or pages).
    // INVERTED: wheel down (positive delta) = scroll down = pan decreases.
    const notch = -Math.sign(delta) * SCROLL_WHEEL_STEP;
    onChange(Math.max(panMin, Math.min(panMax, pan + notch)));
  };

  const border = themeColor('border');
  const trackBg = themeColor('sub-bg');
  const thumbBg = themeColor('text-muted');
  const thumbHoverBg = themeColor('text');

  return (
    <div
      ref={trackRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      style={{
        position: 'relative',
        background: trackBg,
        ...(isH
          ? { height: 12, width: '100%', borderTop: `1px solid ${border}` }
          : { width: 12, height: '100%', borderLeft: `1px solid ${border}` }),
        cursor: 'default',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      <div
        className="gt-scrollbar-thumb"
        style={{
          position: 'absolute',
          background: thumbBg,
          borderRadius: 3,
          cursor: 'grab',
          transition: 'background 0.15s ease',
          ...(isH
            ? { left: thumbPos, top: 2, width: thumbSize, height: 8 }
            : { top: thumbPos, left: 2, height: thumbSize, width: 8 }),
          // CSS variables for hover style
          ['--thumb-bg' as string]: thumbBg,
          ['--thumb-hover-bg' as string]: thumbHoverBg,
        }}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Ruler — top (horizontal) or left (vertical) ruler around canvas
// ────────────────────────────────────────────────────────────
//
// Renders tick marks at "nice" intervals (1/2/5 * 10^n) chosen so
// ticks are ~80px apart on screen. Labels are document-space coordinates
// in the chosen unit (px / mm / in), so the user sees where the cursor is.
//
// Synchronised with pan/zoom: a tick at doc-coord X is drawn at
// screen position `panX + X * zoom` (or panY/zoom for vertical).
//
// v2.4 enhancements:
//   • `unit` prop — labels shown in 'px' (default), 'mm', or 'in'
//     (converted from doc pixels via `dpi`).
//   • `cursorPos` prop — when set, draws a thin indicator line across
//     the ruler at the cursor's current document-space position.
//   • Zero-marker — tick at doc position 0 gets bold styling + extended
//     tick line so the doc origin is always visible at a glance.

interface RulerProps {
  orientation: 'horizontal' | 'vertical';
  pan: number;       // panX for horizontal, panY for vertical
  zoom: number;
  docExtent: number; // docSize.w for horizontal, docSize.h for vertical
  /** Unit for tick labels. Default 'px'. */
  unit?: 'px' | 'mm' | 'in';
  /** DPI for px→mm/in conversion. Required if unit !== 'px'. */
  dpi?: number;
  /** Cursor position in document-space px (same axis as this ruler).
   *  When set, draws a thin indicator line. */
  cursorPos?: number | null;
}

function niceStep(target: number): number {
  if (target <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const candidates = [pow, 2 * pow, 5 * pow, 10 * pow];
  for (const c of candidates) if (c >= target) return c;
  return 10 * pow;
}

/** Convert document-space pixels → display value in the chosen unit. */
function pxToUnit(px: number, unit: 'px' | 'mm' | 'in', dpi: number): number {
  if (unit === 'px') return px;
  if (unit === 'mm') return (px * 25.4) / dpi;
  if (unit === 'in') return px / dpi;
  return px;
}

/** Format a unit value for display (truncated to readable precision). */
function formatUnitValue(value: number, unit: 'px' | 'mm' | 'in'): string {
  if (unit === 'px') return String(Math.round(value));
  if (unit === 'mm') {
    // mm typically needs 1 decimal for sub-mm steps
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  if (unit === 'in') {
    // in typically needs 2 decimals
    return value.toFixed(2);
  }
  return String(value);
}

/** Unit suffix shown once near the start of the ruler. */
const UNIT_SUFFIX: Record<'px' | 'mm' | 'in', string> = {
  px: 'px',
  mm: 'mm',
  in: 'in',
};

// ────────────────────────────────────────────────────────────
// RulerUnitSelector — small clickable corner that cycles px → mm → in → px
// ────────────────────────────────────────────────────────────
//
// Occupies the 20×20 corner square where the two rulers meet. Clicking it
// cycles through ruler units. Tooltip explains the current unit + DPI used
// for conversion.

interface RulerUnitSelectorProps {
  unit: 'px' | 'mm' | 'in';
  onChange: (unit: 'px' | 'mm' | 'in') => void;
}

function RulerUnitSelector({ unit, onChange }: RulerUnitSelectorProps) {
  const next: 'px' | 'mm' | 'in' = unit === 'px' ? 'mm' : unit === 'mm' ? 'in' : 'px';
  return (
    <button
      onClick={() => onChange(next)}
      title={`Ruler unit: ${UNIT_SUFFIX[unit]} (click to switch to ${UNIT_SUFFIX[next]})`}
      style={{
        width: 20,
        height: 20,
        flexShrink: 0,
        background: themeColor('topbar-bg'),
        border: 'none',
        borderRight: `1px solid ${themeColor('border')}`,
        borderBottom: `1px solid ${themeColor('border')}`,
        color: themeColor('text'),
        fontSize: 9,
        fontWeight: 700,
        cursor: 'pointer',
        padding: 0,
        fontFamily: 'ui-monospace, Menlo, monospace',
      }}
    >
      {UNIT_SUFFIX[unit]}
    </button>
  );
}

function Ruler({
  orientation, pan, zoom, docExtent,
  unit = 'px', dpi = 300, cursorPos = null,
}: RulerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [extent, setExtent] = useState(0); // pixel size of the ruler

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setExtent(orientation === 'horizontal' ? el.clientWidth : el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [orientation]);

  const isH = orientation === 'horizontal';

  // ── Tick step calculation ─────────────────────────────────
  // In 'px' mode: choose doc-px step so screen ticks are ~80px apart.
  // In 'mm'/'in' mode: choose a "nice" step in the DISPLAY unit (1/2/5/10/20/50/100…),
  // convert back to px, then to screen px. This gives labels like 10, 20, 30 mm
  // at appropriate density regardless of zoom.
  let docStep: number;        // step in document-px
  let stepInUnit: number;     // step in display unit (for label)
  if (unit === 'px') {
    docStep = niceStep(80 / zoom);
    stepInUnit = docStep;
  } else {
    // target: screen ticks ~80px apart → in unit space that's 80/zoom px,
    // converted to unit. Pick the next "nice" value >= that target.
    const targetInUnit = pxToUnit(80 / zoom, unit, dpi);
    stepInUnit = niceStep(targetInUnit);
    // Convert back to px for screen-position math
    if (unit === 'mm') docStep = (stepInUnit * dpi) / 25.4;
    else docStep = stepInUnit * dpi; // 'in'
  }
  const screenStep = docStep * zoom;

  // First doc-tick whose screen position is >= 0
  const firstTickDoc = Math.ceil((-pan) / zoom / docStep) * docStep;
  const firstTickScreen = pan + firstTickDoc * zoom;

  const majorTicks: Array<{ screen: number; label: string; isZero: boolean }> = [];
  const minorTicks: Array<number> = [];
  for (let s = firstTickScreen, d = firstTickDoc; s <= extent; s += screenStep, d += docStep) {
    const valueInUnit = pxToUnit(d, unit, dpi);
    const isZero = Math.abs(d) < docStep / 2; // doc-px 0 (within half-step tolerance)
    majorTicks.push({
      screen: s,
      label: formatUnitValue(valueInUnit, unit),
      isZero,
    });
    // Half-step minor ticks
    const half = s + screenStep / 2;
    if (half <= extent) minorTicks.push(half);
  }

  // Highlight: show doc-extent end with a shaded region past the document edge
  const docEndScreen = pan + docExtent * zoom;

  // Cursor indicator: thin line at the cursor's doc-pixel position.
  const cursorScreen = cursorPos != null ? pan + cursorPos * zoom : null;

  const dim = themeColor('text-dim');
  const muted = themeColor('text-muted');
  const border = themeColor('border');
  const accent = themeColor('input-focus');
  const text = themeColor('text');

  return (
    <div
      ref={ref}
      className="gt-ruler"
      style={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        background: themeColor('topbar-bg'),
        ...(isH
          ? { borderBottom: `1px solid ${border}` }
          : { borderRight: `1px solid ${border}` }),
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, display: 'block' }}
        preserveAspectRatio="none"
      >
        {/* Shade the area past the document edge so user sees doc extent */}
        {isH ? (
          docEndScreen < extent && (
            <rect x={docEndScreen} y={0} width={extent - docEndScreen} height="100%"
                  fill={themeColor('sub-bg')} />
          )
        ) : (
          docEndScreen < extent && (
            <rect x={0} y={docEndScreen} width="100%" height={extent - docEndScreen}
                  fill={themeColor('sub-bg')} />
          )
        )}

        {/* Minor ticks (half-step, no labels) */}
        {minorTicks.map((s, i) => isH ? (
          <line key={`m${i}`} x1={s} y1={0} x2={s} y2={5} stroke={dim} strokeWidth={1} />
        ) : (
          <line key={`m${i}`} x1={0} y1={s} x2={5} y2={s} stroke={dim} strokeWidth={1} />
        ))}

        {/* Major ticks + labels. Zero-marker gets bold styling + extended tick. */}
        {majorTicks.map((t, i) => {
          const tickLen = t.isZero ? 18 : 11;
          const tickStroke = t.isZero ? accent : muted;
          const tickWidth = t.isZero ? 1.5 : 1;
          const labelFill = t.isZero ? accent : muted;
          const labelFontWeight = t.isZero ? 700 : 400;
          return isH ? (
            <g key={`M${i}`}>
              <line x1={t.screen} y1={0} x2={t.screen} y2={tickLen} stroke={tickStroke} strokeWidth={tickWidth} />
              <text x={t.screen + 2} y={15} fontSize={9} fill={labelFill} fontWeight={labelFontWeight}
                    fontFamily="ui-monospace, Menlo, monospace">{t.label}</text>
            </g>
          ) : (
            <g key={`M${i}`}>
              <line x1={0} y1={t.screen} x2={tickLen} y2={t.screen} stroke={tickStroke} strokeWidth={tickWidth} />
              <text x={14} y={t.screen + 7} fontSize={9} fill={labelFill} fontWeight={labelFontWeight}
                    fontFamily="ui-monospace, Menlo, monospace">{t.label}</text>
            </g>
          );
        })}

        {/* Unit suffix — small label at the start of the ruler */}
        {extent > 30 && (
          isH ? (
            <text x={4} y={9} fontSize={8} fill={text} fontWeight={600}
                  fontFamily="ui-monospace, Menlo, monospace">{UNIT_SUFFIX[unit]}</text>
          ) : (
            <text x={2} y={extent - 4} fontSize={8} fill={text} fontWeight={600}
                  fontFamily="ui-monospace, Menlo, monospace">{UNIT_SUFFIX[unit]}</text>
          )
        )}

        {/* Cursor indicator — thin line tracking mouse position */}
        {cursorScreen != null && cursorScreen >= 0 && cursorScreen <= extent && (
          isH ? (
            <>
              <line x1={cursorScreen} y1={0} x2={cursorScreen} y2="100%" stroke={accent} strokeWidth={1} opacity={0.8} />
              <rect x={cursorScreen - 18} y={0} width={36} height={11} fill={accent} rx={2} />
              <text x={cursorScreen} y={9} fontSize={8} fill="#fff" fontWeight={600}
                    textAnchor="middle"
                    fontFamily="ui-monospace, Menlo, monospace">
                {formatUnitValue(pxToUnit(cursorPos ?? 0, unit, dpi), unit)}
              </text>
            </>
          ) : (
            <>
              <line x1={0} y1={cursorScreen} x2="100%" y2={cursorScreen} stroke={accent} strokeWidth={1} opacity={0.8} />
              <rect x={0} y={cursorScreen - 7} width={22} height={14} fill={accent} rx={2} />
              <text x={11} y={cursorScreen + 3} fontSize={8} fill="#fff" fontWeight={600}
                    textAnchor="middle"
                    fontFamily="ui-monospace, Menlo, monospace">
                {formatUnitValue(pxToUnit(cursorPos ?? 0, unit, dpi), unit)}
              </text>
            </>
          )
        )}
      </svg>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// PopupPalette — Krita-style right-click quick tool palette
// ────────────────────────────────────────────────────────────
//
// Appears at cursor position on right-click over the canvas.
// Renders a small grid of all tools (same as the left Toolbox),
// then a divider, then quick view actions (Fit / 100% / Rulers).
// Dismiss on: tool pick, action, Escape, or click outside.

interface PopupPaletteProps {
  x: number;                  // clientX
  y: number;                  // clientY
  activeTool: ToolId;
  hasActiveLayer: boolean;
  disabledAffine: boolean;
  showRulers: boolean;
  onToolChange: (t: ToolId) => void;
  onFitView: () => void;
  onZoom100: () => void;
  onToggleRulers: () => void;
  onClose: () => void;
}

const PALETTE_TOOLS: Array<{ id: ToolId; icon: string; label: string; key: string }> = [
  { id: 'none',        icon: '▷', label: 'Cursor',  key: 'C' },
  { id: 'zoom',        icon: '🔍', label: 'Zoom',    key: 'Z' },
  { id: 'bucket',      icon: '🪣', label: 'Bucket',  key: 'B' },
  { id: 'move',        icon: '✥', label: 'Move',    key: 'V' },
  { id: 'scale',       icon: '⤢', label: 'Scale',   key: 'S' },
  { id: 'rotate',      icon: '⟲', label: 'Rotate',  key: 'R' },
  { id: 'skew',        icon: '⤡', label: 'Skew',    key: 'K' },
  { id: 'perspective', icon: '⬔', label: 'Free',    key: 'F' },
  { id: 'rect',        icon: '▭', label: 'Rect',    key: 'M' },
  { id: 'ellipse',     icon: '◯', label: 'Ellipse', key: 'E' },
  { id: 'lasso',       icon: '✎', label: 'Lasso',   key: 'L' },
  { id: 'polygonal',   icon: '⬠', label: 'Polygon', key: 'P' },
];

function PopupPalette({
  x, y, activeTool, hasActiveLayer, disabledAffine, showRulers,
  onToolChange, onFitView, onZoom100, onToggleRulers, onClose,
}: PopupPaletteProps) {
  // Clamp to viewport so the palette never goes off-screen
  const PALETTE_W = 200;
  const PALETTE_H = 220;
  const clampedX = Math.min(Math.max(4, x), window.innerWidth - PALETTE_W - 4);
  const clampedY = Math.min(Math.max(4, y), window.innerHeight - PALETTE_H - 4);

  return (
    <>
      {/* Click-away backdrop */}
      <div
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
      />
      <div
        className="gt-popup-palette"
        style={{
          position: 'fixed',
          left: clampedX,
          top: clampedY,
          width: PALETTE_W,
          zIndex: 9999,
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        <div className="gt-popup-header">Tools</div>
        <div className="gt-popup-grid">
          {PALETTE_TOOLS.map(t => {
            // BUG-1 FIX: Same as Toolbox — affine tools must stay clickable in
            // perspective mode. Clicking them triggers handleToolChange which
            // bakes the perspective. See Toolbox comment for full rationale.
            const disabled =
              !hasActiveLayer && t.id !== 'none';
            return (
              <button
                key={t.id}
                type="button"
                className="gt-popup-tool"
                data-active={activeTool === t.id}
                disabled={disabled}
                onClick={() => { onToolChange(t.id); onClose(); }}
                title={`${t.label} (${t.key})`}
              >
                <span className="gt-popup-icon">{t.icon}</span>
                <span className="gt-popup-label">{t.label}</span>
                <span className="gt-popup-key">{t.key}</span>
              </button>
            );
          })}
        </div>

        <div className="gt-popup-divider" />

        <div className="gt-popup-header">View</div>
        <div className="gt-popup-actions">
          <button
            type="button"
            className="gt-popup-action"
            onClick={() => { onFitView(); onClose(); }}
          >
            <span className="gt-popup-icon">⤧</span>
            <span className="gt-popup-label">Fit View</span>
            <span className="gt-popup-key">0</span>
          </button>
          <button
            type="button"
            className="gt-popup-action"
            onClick={() => { onZoom100(); onClose(); }}
          >
            <span className="gt-popup-icon">1:1</span>
            <span className="gt-popup-label">Actual Size</span>
            <span className="gt-popup-key">1</span>
          </button>
          <button
            type="button"
            className="gt-popup-action"
            data-active={showRulers}
            onClick={() => { onToggleRulers(); onClose(); }}
          >
            <span className="gt-popup-icon">⊐</span>
            <span className="gt-popup-label">Rulers</span>
            <span className="gt-popup-key">⌘R</span>
          </button>
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────
// Toolbar — top bar with file ops + view controls
// ────────────────────────────────────────────────────────────

interface ToolbarProps {
  onNewDoc: () => void;
  onOpenOra: () => void;
  onSaveOra: () => void;
  onExportPng: () => void;
  onImportPng: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  paramMode: 'simple' | 'advanced';
  onToggleParamMode: () => void;
  /** v2.9.1: Bake Transform — re-tessellate screentone with scaled spacing, convert to image. */
  onBakeTransform: () => void;
  /** v2.9.1: Whether Bake button should be enabled (screentone layer with transform). */
  canBake: boolean;
  docWidth: number;
  docHeight: number;
  onDocSizeChange: (w: number, h: number) => void;
  dpi: number;
  onDpiChange: (dpi: number) => void;
  // 1.8: color profile change (Image → Mode)
  colorProfile: ColorProfile;
  onChangeColorProfile: (profile: ColorProfile) => void;
  mirrored: boolean;
  onToggleMirror: () => void;
}

// ────────────────────────────────────────────────────────────
// MenuBarDropdown — classic desktop-app dropdown menu
// (Gemini 2.4.3 — replaces the flat button row in the top bar)
// ────────────────────────────────────────────────────────────

interface MenuItem {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean; // if true, render a divider instead
}

interface MenuBarDropdownProps {
  label: string;
  items: MenuItem[];
}

function MenuBarDropdown({ label, items }: MenuBarDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className="gt-menubar-item"
      style={{ position: 'relative', padding: 0 }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: open ? themeColor('hover') : 'transparent',
          border: 'none',
          color: themeColor('text'),
          fontSize: 12,
          padding: '4px 10px',
          borderRadius: 3,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {label}
      </button>
      {open && (
        <div
          className="gt-menu-dropdown"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            minWidth: 180,
            marginTop: 2,
            zIndex: 100,
          }}
        >
          {items.map((item, i) => item.separator ? (
            <div key={`s${i}`} className="gt-menu-separator" />
          ) : (
            <button
              key={i}
              type="button"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick?.();
              }}
              className="gt-menu-item"
              style={item.disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
            >
              <span className="gt-menu-label">{item.label}</span>
              {item.shortcut && <span className="gt-menu-shortcut">{item.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 1.7: New Document dialog (Photoshop-style)
// ────────────────────────────────────────────────────────────

interface NewDocumentDialogProps {
  onCreate: (opts: NewDocumentOptions) => void;
  onCancel: () => void;
}

function NewDocumentDialog({ onCreate, onCancel }: NewDocumentDialogProps) {
  const [name, setName] = useState('Untitled-1');
  const [presetId, setPresetId] = useState('b5-manga');
  const [width, setWidth] = useState(2079);
  const [height, setHeight] = useState(2953);
  const [dpi, setDpi] = useState(300);
  const [colorProfile, setColorProfileState] = useState<ColorProfile>('gray8');
  const [background, setBackground] = useState<DocBackground>('white');
  const [unit, setUnit] = useState<'px' | 'mm' | 'in'>('px');

  // Load last-used settings from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('gentonik-new-doc-settings');
      if (saved) {
        const s = JSON.parse(saved);
        if (s.name) setName(s.name);
        if (s.presetId) setPresetId(s.presetId);
        if (s.width) setWidth(s.width);
        if (s.height) setHeight(s.height);
        if (s.dpi) setDpi(s.dpi);
        if (s.colorProfile) setColorProfileState(s.colorProfile);
        if (s.background) setBackground(s.background);
        if (s.unit) setUnit(s.unit);
      }
    } catch { /* ignore */ }
  }, []);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = DOC_PRESETS.find(p => p.id === id);
    if (preset && id !== 'custom') {
      setWidth(preset.width);
      setHeight(preset.height);
      setDpi(preset.dpi);
      setColorProfileState(preset.colorProfile);
    }
  };

  const handleCreate = () => {
    // Save settings to localStorage
    try {
      localStorage.setItem('gentonik-new-doc-settings', JSON.stringify({
        name, presetId, width, height, dpi, colorProfile, background, unit,
      }));
    } catch { /* ignore */ }
    onCreate({ name, width, height, dpi, colorProfile, background });
  };

  // Unit conversion helpers
  const pxToUnit = (px: number, u: typeof unit, d: number) => {
    if (u === 'px') return px;
    if (u === 'mm') return px * 25.4 / d;
    if (u === 'in') return px / d;
    return px;
  };
  const unitToPx = (v: number, u: typeof unit, d: number) => {
    if (u === 'px') return v;
    if (u === 'mm') return v * d / 25.4;
    if (u === 'in') return v * d;
    return v;
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: themeColor('sidebar-bg'),
          border: `1px solid ${themeColor('border')}`,
          borderRadius: 8,
          padding: 24,
          minWidth: 400,
          maxWidth: 480,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: themeColor('text') }}>
          New Document
        </div>

        {/* Name */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, color: themeColor('text-dim'), marginBottom: 4 }}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 12,
              background: themeColor('input-bg'),
              color: themeColor('text'),
              border: `1px solid ${themeColor('border')}`,
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Preset */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, color: themeColor('text-dim'), marginBottom: 4 }}>Preset</label>
          <select
            value={presetId}
            onChange={(e) => applyPreset(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 12,
              background: themeColor('input-bg'),
              color: themeColor('text'),
              border: `1px solid ${themeColor('border')}`,
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          >
            {DOC_PRESETS.map(p => (
              <option key={p.id} value={p.id}>{p.label} — {p.description}</option>
            ))}
          </select>
        </div>

        {/* Width / Height */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: 11, color: themeColor('text-dim'), marginBottom: 4 }}>Width</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                type="number"
                value={Math.round(pxToUnit(width, unit, dpi))}
                onChange={(e) => setWidth(Math.round(unitToPx(Number(e.target.value), unit, dpi)))}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  fontSize: 12,
                  background: themeColor('input-bg'),
                  color: themeColor('text'),
                  border: `1px solid ${themeColor('border')}`,
                  borderRadius: 4,
                }}
              />
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as typeof unit)}
                style={{
                  padding: '6px 4px',
                  fontSize: 11,
                  background: themeColor('input-bg'),
                  color: themeColor('text'),
                  border: `1px solid ${themeColor('border')}`,
                  borderRadius: 4,
                }}
              >
                <option value="px">px</option>
                <option value="mm">mm</option>
                <option value="in">in</option>
              </select>
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: 11, color: themeColor('text-dim'), marginBottom: 4 }}>Height</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                type="number"
                value={Math.round(pxToUnit(height, unit, dpi))}
                onChange={(e) => setHeight(Math.round(unitToPx(Number(e.target.value), unit, dpi)))}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  fontSize: 12,
                  background: themeColor('input-bg'),
                  color: themeColor('text'),
                  border: `1px solid ${themeColor('border')}`,
                  borderRadius: 4,
                }}
              />
              <span style={{ padding: '6px 4px', fontSize: 11, color: themeColor('text-dim') }}>{unit}</span>
            </div>
          </div>
        </div>

        {/* Resolution */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, color: themeColor('text-dim'), marginBottom: 4 }}>Resolution (DPI)</label>
          <input
            type="number"
            value={dpi}
            onChange={(e) => setDpi(Number(e.target.value))}
            min={1}
            max={2400}
            style={{
              width: 100,
              padding: '6px 8px',
              fontSize: 12,
              background: themeColor('input-bg'),
              color: themeColor('text'),
              border: `1px solid ${themeColor('border')}`,
              borderRadius: 4,
            }}
          />
          <span style={{ marginLeft: 8, fontSize: 11, color: themeColor('text-dim') }}>pixels/inch</span>
        </div>

        {/* Color Profile */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, color: themeColor('text-dim'), marginBottom: 4 }}>Color Profile</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: themeColor('text'), cursor: 'pointer' }}>
              <input
                type="radio"
                checked={colorProfile === 'gray8'}
                onChange={() => setColorProfileState('gray8')}
              />
              Grayscale 8-bit <span style={{ color: themeColor('text-dim'), fontSize: 10 }}>(screentone/manga)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: themeColor('text'), cursor: 'pointer' }}>
              <input
                type="radio"
                checked={colorProfile === 'rgb8'}
                onChange={() => setColorProfileState('rgb8')}
              />
              RGB 8-bit <span style={{ color: themeColor('text-dim'), fontSize: 10 }}>(color/webtoon)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: themeColor('text-dim'), cursor: 'not-allowed' }}>
              <input
                type="radio"
                disabled
                checked={colorProfile === 'cmyk8'}
              />
              CMYK 8-bit <span style={{ fontSize: 10 }}>(future — WebToonTools)</span>
            </label>
          </div>
        </div>

        {/* Background — "create with a solid layer or without?" */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 11, color: themeColor('text-dim'), marginBottom: 4 }}>
            Background Layer
          </label>
          <div style={{ fontSize: 10, color: themeColor('text-dim'), marginBottom: 6 }}>
            Create the document with a solid white background layer, or without one (transparent checkerboard).
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: themeColor('text'), cursor: 'pointer' }}>
              <input
                type="radio"
                checked={background === 'white'}
                onChange={() => setBackground('white')}
              />
              With Solid Layer <span style={{ color: themeColor('text-dim'), fontSize: 10 }}>(white #ffffff)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: themeColor('text'), cursor: 'pointer' }}>
              <input
                type="radio"
                checked={background === 'transparent'}
                onChange={() => setBackground('transparent')}
              />
              Without Solid Layer <span style={{ color: themeColor('text-dim'), fontSize: 10 }}>(transparent)</span>
            </label>
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              ...styles.button,
              padding: '6px 16px',
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            style={{
              ...styles.button,
              padding: '6px 16px',
              fontSize: 12,
              background: themeColor('input-focus'),
              color: '#fff',
              border: 'none',
            }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function Toolbar({
  onNewDoc, onOpenOra, onSaveOra, onExportPng, onImportPng,
  onUndo, onRedo, canUndo, canRedo,
  paramMode, onToggleParamMode, onBakeTransform, canBake,
  docWidth, docHeight, onDocSizeChange, dpi, onDpiChange,
  colorProfile, onChangeColorProfile,
  mirrored, onToggleMirror,
}: ToolbarProps) {
  const [editingSize, setEditingSize] = useState(false);
  const [w, setW] = useState(docWidth);
  const [h, setH] = useState(docHeight);

  useEffect(() => { setW(docWidth); setH(docHeight); }, [docWidth, docHeight]);

  // Gemini 2.4.3 — File / Edit / View / Image dropdown menus
  const fileItems: MenuItem[] = [
    { label: 'New',           onClick: onNewDoc },
    { label: 'Open .ora…',    onClick: onOpenOra },
    { label: 'Save .ora…',    onClick: onSaveOra },
    { separator: true } as MenuItem,
    { label: 'Import PNG…',   onClick: onImportPng },
    { label: 'Export PNG…',   onClick: onExportPng },
  ];
  const editItems: MenuItem[] = [
    { label: 'Undo', shortcut: 'Ctrl+Z',     onClick: onUndo, disabled: !canUndo },
    { label: 'Redo', shortcut: 'Ctrl+⇧+Z',   onClick: onRedo, disabled: !canRedo },
  ];
  const viewItems: MenuItem[] = [
    { label: paramMode === 'simple' ? 'Switch to Advanced' : 'Switch to Simple',
      onClick: onToggleParamMode },
    { label: `Mirror Screen${mirrored ? ' ✓' : ''}`, shortcut: 'M', onClick: onToggleMirror },
  ];
  const imageItems: MenuItem[] = [
    { label: `${docWidth}×${docHeight} (resize)`, onClick: () => setEditingSize(true) },
    { label: `DPI: ${dpi}`, onClick: () => {
      const next = prompt('DPI:', String(dpi));
      if (next) {
        const n = parseInt(next, 10);
        if (n > 0) onDpiChange(n);
      }
    } },
    // 1.8: Image → Mode submenu (color profile change)
    { label: '─── Mode ───', onClick: () => {} },
    { label: `Grayscale 8-bit${colorProfile === 'gray8' ? ' ✓' : ''}`, onClick: () => onChangeColorProfile('gray8') },
    { label: `RGB 8-bit${colorProfile === 'rgb8' ? ' ✓' : ''}`, onClick: () => onChangeColorProfile('rgb8') },
    { label: 'CMYK 8-bit (future)', disabled: true, onClick: () => {} },
  ];

  return (
    <div
      style={{
        ...styles.menubar,
        padding: '0 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        height: 36,
        flexShrink: 0,
      }}
      className="gt-noselect"
    >
      <strong style={{ fontSize: 13, padding: '0 6px' }}>GenToniK</strong>
      <span style={{ ...styles.textDim, fontSize: 10 }}>v3</span>

      <div style={{ width: 1, height: 18, background: themeColor('border'), margin: '0 4px' }} />

      <MenuBarDropdown label="File"  items={fileItems} />
      <MenuBarDropdown label="Edit"  items={editItems} />
      <MenuBarDropdown label="View"  items={viewItems} />
      <MenuBarDropdown label="Image" items={imageItems} />

      {/* v2.6: Physical Undo/Redo buttons — always visible in the toolbar.
          Photoshop places these in the application bar; we put them right
          after the menus so they're easy to find. Disabled when history
          is empty (can't undo/redo). Tooltip shows the keyboard shortcut. */}
      <div style={{ width: 1, height: 18, background: themeColor('border'), margin: '0 4px' }} />
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        style={{
          ...styles.button,
          padding: '3px 8px',
          fontSize: 14,
          lineHeight: 1,
          minWidth: 28,
          opacity: canUndo ? 1 : 0.35,
          cursor: canUndo ? 'pointer' : 'not-allowed',
        }}
      >
        ↶
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo (Ctrl+Shift+Z)"
        style={{
          ...styles.button,
          padding: '3px 8px',
          fontSize: 14,
          lineHeight: 1,
          minWidth: 28,
          opacity: canRedo ? 1 : 0.35,
          cursor: canRedo ? 'pointer' : 'not-allowed',
        }}
      >
        ↷
      </button>

      {/* Inline image-size editor — appears when "resize" is clicked in the Image menu */}
      {editingSize && (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 8 }}>
          <input type="number" value={w} onChange={e => setW(parseInt(e.target.value) || 0)} style={{ ...styles.input, width: 56, padding: '2px 4px', fontSize: 11 }} />
          <span style={{ ...styles.textDim }}>×</span>
          <input type="number" value={h} onChange={e => setH(parseInt(e.target.value) || 0)} style={{ ...styles.input, width: 56, padding: '2px 4px', fontSize: 11 }} />
          <button onClick={() => { if (w > 0 && h > 0) onDocSizeChange(w, h); setEditingSize(false); }} style={{ ...styles.button, padding: '2px 6px', fontSize: 11 }}>✓</button>
          <button onClick={() => { setW(docWidth); setH(docHeight); setEditingSize(false); }} style={{ ...styles.button, padding: '2px 6px', fontSize: 11 }}>✕</button>
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* v2.9.1: Bake Transform — re-tessellate screentone with scaled spacing.
          Only enabled for screentone layers that have a non-identity transform.
          Clicking converts the layer to an image (params hidden, no re-edit). */}
      <button
        type="button"
        onClick={onBakeTransform}
        disabled={!canBake}
        title="Bake Transform — re-render screentone with scaled spacing, convert to image layer (no re-edit)"
        style={{
          ...styles.button,
          padding: '3px 10px',
          fontSize: 11,
          opacity: canBake ? 1 : 0.35,
          cursor: canBake ? 'pointer' : 'not-allowed',
          marginRight: 4,
        }}
      >
        🔥 Bake
      </button>

      <button
        onClick={onToggleParamMode}
        title="Toggle Simple / Advanced parameter editor"
        style={{
          ...styles.button,
          padding: '3px 10px',
          fontSize: 11,
          background: paramMode === 'advanced' ? themeColor('input-focus') : themeColor('btn-secondary'),
          color: paramMode === 'advanced' ? '#fff' : themeColor('text'),
        }}
      >
        {paramMode === 'simple' ? 'Simple' : 'Advanced'}
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Main App component
// ────────────────────────────────────────────────────────────

export default function App() {
  // ── State ──────────────────────────────────────────────
  const [layers, setLayers] = useState<Layer[]>(() => [
    createSolidLayer('Background', '#ffffff'),
    createScreentoneLayer('Screentone 1', DEFAULT_PARAMS),
  ]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [docSize, setDocSize] = useState(DEFAULT_DOC_SIZE);
  const [dpi, setDpi] = useState(300);
  const [zoom, setZoom] = useState(0.25);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [paramMode, setParamMode] = useState<'simple' | 'advanced'>('simple');
  const [presetRefreshKey, setPresetRefreshKey] = useState(0);
  const [editingPreset, setEditingPreset] = useState<PresetV2 | null>(null);
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  const [presetEditorCurrentParams, setPresetEditorCurrentParams] = useState<ScreentoneParams | null>(null);

  // ── NEW (v2.1): History manager (undo/redo) ─────────────
  const historyRef = useRef<HistoryManager | null>(null);
  if (!historyRef.current) {
    historyRef.current = new HistoryManager({ maxEntries: 100 });
  }
  const [, forceRender] = useState(0);

  // ── NEW (v2.1): Mask editor state ──────────────────────
  const [maskEditorLayerId, setMaskEditorLayerId] = useState<string | null>(null);

  // ── NEW (A2.2): Selection state for "Layer from Selection" ──
  const [activeSelection, setActiveSelection] = useState<ActiveSelection | null>(null);

  // ── NEW (A2.1a): Selection operation mode (New / Add / Subtract / Intersect) ──
  const [selectionOpMode, setSelectionOpMode] = useState<SelectionOpMode>('new');

  // ── NEW (v2.2): Transform tool (controlled by App, shared with overlay) ──
  const [activeTool, setActiveTool] = useState<ToolId>('move');

  // ── NEW (v2.0): Debug panel state (toggle via Ctrl+`) ──
  const [debugOpen, setDebugOpen] = useState(false);

  // ── NEW (v2.3): Rulers around the canvas (Ctrl+R to toggle) ──
  const [showRulers, setShowRulers] = useState(true);
  // NEW (v2.4): Ruler units — 'px' (always), 'mm' or 'in' (converted via DPI).
  // Affects Ruler tick labels AND CanvasScrollbar labels (when shown).
  const [rulerUnit, setRulerUnit] = useState<'px' | 'mm' | 'in'>('px');
  // NEW (v2.4): Mouse position in canvas-pixel space — used by Ruler cursor indicator.
  // Updated on mousemove over <main>. null = mouse left canvas.
  const [mouseCanvasPos, setMouseCanvasPos] = useState<{ x: number; y: number } | null>(null);
  // 1.5: Mirror Screen (display-only horizontal flip)
  const [mirrored, setMirrored] = useState(false);

  // v2.10: Bucket tool settings
  // Modes:
  //   'solid-canvas'      — fill entire canvas with solid color (new layer)
  //   'solid-selection'   — fill active selection with solid color (new layer)
  //   'solid-into-layer'  — fill solid color into the currently selected layer
  //                         (modifies the layer's content — for solid: changes color;
  //                          for screentone: changes colorBg; for image: paint onto pixels)
  //   'screentone-canvas'    — fill entire canvas with screentone (new layer)
  //   'screentone-selection' — fill active selection with screentone (new layer)
  const [bucketMode, setBucketMode] = useState<BucketMode>('solid-canvas');
  const [bucketColor, setBucketColor] = useState('#000000');

  // ── NEW (v2.3): Right-click popup palette (Krita-style) ──
  // Null = hidden; otherwise {x, y} = clientX/clientY where it appeared.
  const [popupPalette, setPopupPalette] = useState<{ x: number; y: number } | null>(null);

  // PRESERVE-PERSPECTIVE: Mask-from-Sel mode picker modal.
  // When the user clicks "Mask from Sel" on a layer with perspective (corners set),
  // we show this modal asking: "by canvas shape" or "by object shape".
  // - 'canvas': mask polygon lives in canvas space; visible area = exact selection
  //   outline regardless of perspective (mask follows the selection, not the layer).
  // - 'object': mask polygon lives in layer-local space (mapped through inverse
  //   perspective); visible area = selection outline deformed BY the perspective,
  //   so the mask boundary follows the layer's deformed shape.
  // For non-perspective layers, no modal is shown (both modes are equivalent).
  const [maskModeModal, setMaskModeModal] = useState<null | { pending: () => void }>(null);

  // ── NEW (v2.3 = Gemini 2.3): Adaptive perspective subdivision ──
  // During a live perspective drag, drop to 2×2 grid (8 triangles)
  // for ~16× speedup vs the 8×8 default. On commit, restore to 8×8
  // (or 16×16 for export) for high-quality final render.
  const [perspectiveSubdivisions, setPerspectiveSubdivisions] = useState<number>(8);

  // ── NEW (v2.4 = Gemini 2.4.1): Active tab in left sidebar ──
  // 'layers' shows the Layers panel full-height; 'presets' shows
  // the Preset browser full-height. Tabs free up vertical space
  // (previously split 40/60) so long lists are easier to scan.
  const [leftPanelTab, setLeftPanelTab] = useState<'layers' | 'presets'>('layers');

  // ── 1.6-1.8: Multi-document state (tabs + color profile) ──
  //
  // The App keeps an array of DocumentState snapshots + an activeDocId.
  // The "live" state above (layers, docSize, dpi, etc.) always reflects the
  // ACTIVE document. When switching tabs:
  //   1. Save current live state → active doc's snapshot
  //   2. Load target doc's snapshot → live state
  // This is the "snapshot" approach (vs. full React Context per doc) —
  // minimally invasive to the existing 4300-line App.
  const [documents, setDocuments] = useState<DocumentState[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [colorProfile, setColorProfile] = useState<ColorProfile>('gray8');
  // New Document dialog visibility
  const [showNewDocDialog, setShowNewDocDialog] = useState(false);

  // Untitled document counter (for "Untitled-1", "Untitled-2", etc.)
  const untitledCounterRef = useRef(0);

  /**
   * Create a new DocumentState from options (called by the New Document dialog).
   * Returns the new doc's ID. Does NOT switch to it — caller handles that.
   */
  const createDocument = useCallback((opts: NewDocumentOptions): string => {
    const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const layers: Layer[] = [];
    if (opts.background === 'white') {
      layers.push(createSolidLayer('Background', '#ffffff'));
    }
    layers.push(createScreentoneLayer('Screentone 1', DEFAULT_PARAMS));
    const selectedId = layers[layers.length - 1].id;

    const newDoc: DocumentState = {
      id,
      name: opts.name || `Untitled-${++untitledCounterRef.current}`,
      layers,
      docSize: { w: opts.width, h: opts.height },
      dpi: opts.dpi,
      colorProfile: opts.colorProfile,
      activeSelection: null,
      viewport: { panX: 0, panY: 0, zoom: 0.25 },
      selectedLayerId: selectedId,
      historySnapshot: null,  // history is per-doc, initialized on switch
      dirty: false,
      createdAt: Date.now(),
    };

    setDocuments(prev => [...prev, newDoc]);
    return id;
  }, []);

  /**
   * Save current live state into the active document's snapshot.
   * Called before switching tabs or closing the active doc.
   *
   * NOTE: History is NOT serialized per-document (HistoryManager doesn't
   * expose serialize/deserialize). Undo/Redo works within the current tab
   * session. When switching tabs, history is re-initialized from the
   * document's current state. This is acceptable for MVP — full per-doc
   * history serialization is a future enhancement (see Plan.md 1.3).
   */
  const saveActiveDocState = useCallback(() => {
    if (!activeDocId) return;
    setDocuments(prev => prev.map(d =>
      d.id === activeDocId
        ? {
            ...d,
            layers,
            docSize,
            dpi,
            colorProfile,
            activeSelection,
            viewport: { panX, panY, zoom },
            selectedLayerId,
            historySnapshot: null,  // not serialized (see note above)
            dirty: true,
          }
        : d
    ));
  }, [activeDocId, layers, docSize, dpi, colorProfile, activeSelection, panX, panY, zoom, selectedLayerId]);

  /**
   * Load a document's snapshot into live state. Called when switching tabs.
   */
  const loadDocState = useCallback((doc: DocumentState) => {
    setLayers(doc.layers);
    setSelectedLayerId(doc.selectedLayerId);
    setDocSize(doc.docSize);
    setDpi(doc.dpi);
    setColorProfile(doc.colorProfile);
    setActiveSelection(doc.activeSelection);
    setZoom(doc.viewport.zoom);
    setPanX(doc.viewport.panX);
    setPanY(doc.viewport.panY);
    // Re-initialize history from the doc's current state
    // (undo/redo doesn't persist across tab switches — see saveActiveDocState note)
    if (historyRef.current) {
      historyRef.current.initialize(
        makeSnapshot(doc.layers, { width: doc.docSize.w, height: doc.docSize.h }, doc.selectedLayerId, doc.name)
      );
    }
  }, []);

  /**
   * Switch to a different document tab. Saves current state first.
   */
  const switchToDocument = useCallback((docId: string) => {
    if (docId === activeDocId) return;
    // Save current state to active doc
    const currentDocId = activeDocId;
    if (currentDocId) {
      setDocuments(prev => prev.map(d =>
        d.id === currentDocId
          ? {
              ...d,
              layers,
              docSize,
              dpi,
              colorProfile,
              activeSelection,
              viewport: { panX, panY, zoom },
              selectedLayerId,
              historySnapshot: null,
              dirty: true,
            }
          : d
      ));
    }
    // Load target doc
    const targetDoc = documents.find(d => d.id === docId);
    if (targetDoc) {
      setActiveDocId(docId);
      loadDocState(targetDoc);
    }
  }, [activeDocId, layers, docSize, dpi, colorProfile, activeSelection, panX, panY, zoom, selectedLayerId, documents, loadDocState]);

  /**
   * Close a document tab. If dirty, confirm with user.
   * Switches to neighbor tab (or null if last doc closed).
   */
  const closeDocument = useCallback((docId: string) => {
    const doc = documents.find(d => d.id === docId);
    if (!doc) return;
    if (doc.dirty && !confirm(`Close "${doc.name}"? Unsaved changes will be lost.`)) return;

    setDocuments(prev => {
      const idx = prev.findIndex(d => d.id === docId);
      if (idx < 0) return prev;
      const newDocs = prev.filter(d => d.id !== docId);
      // If closing active doc, switch to neighbor
      if (docId === activeDocId) {
        if (newDocs.length === 0) {
          // Last doc closed — create a fresh default doc
          const freshId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const freshDoc: DocumentState = {
            id: freshId,
            name: `Untitled-${++untitledCounterRef.current}`,
            layers: [createSolidLayer('Background', '#ffffff'), createScreentoneLayer('Screentone 1', DEFAULT_PARAMS)],
            docSize: DEFAULT_DOC_SIZE,
            dpi: 300,
            colorProfile: 'gray8',
            activeSelection: null,
            viewport: { panX: 0, panY: 0, zoom: 0.25 },
            selectedLayerId: null,
            historySnapshot: null,
            dirty: false,
            createdAt: Date.now(),
          };
          setActiveDocId(freshId);
          loadDocState(freshDoc);
          // BUG-C FIX: loadDocState applied pan=(0,0) from the snapshot,
          // which pins the fresh doc to the top-left. Compute proper
          // fit-to-view immediately, with a small retry in case the
          // container hasn't been laid out yet.
          const fit = computeFitView(DEFAULT_DOC_SIZE.w, DEFAULT_DOC_SIZE.h);
          if (fit) {
            setZoom(fit.zoom);
            setPanX(fit.panX);
            setPanY(fit.panY);
          } else {
            setTimeout(() => {
              const retry = computeFitView(DEFAULT_DOC_SIZE.w, DEFAULT_DOC_SIZE.h);
              if (retry) {
                setZoom(retry.zoom);
                setPanX(retry.panX);
                setPanY(retry.panY);
              }
            }, 100);
          }
          return [freshDoc];
        }
        // Switch to neighbor (prefer right, else left)
        const neighbor = newDocs[Math.min(idx, newDocs.length - 1)];
        setActiveDocId(neighbor.id);
        loadDocState(neighbor);
      }
      return newDocs;
    });
  }, [documents, activeDocId, loadDocState]);

  /**
   * Create a new document and switch to it (called by File → New after dialog).
   */
  const handleCreateNewDocument = useCallback((opts: NewDocumentOptions) => {
    const newId = createDocument(opts);
    // Save current state to old active doc, then switch
    if (activeDocId) {
      setDocuments(prev => prev.map(d =>
        d.id === activeDocId
          ? {
              ...d,
              layers,
              docSize,
              dpi,
              colorProfile,
              activeSelection,
              viewport: { panX, panY, zoom },
              selectedLayerId,
              historySnapshot: null,
              dirty: true,
            }
          : d
      ));
    }
    // Switch to new doc — use setTimeout to let setDocuments update first
    setTimeout(() => {
      setActiveDocId(newId);
      // Load the new doc's initial state (from opts, since documents array
      // may not have updated yet in this closure)
      const newLayers: Layer[] = [];
      if (opts.background === 'white') {
        newLayers.push(createSolidLayer('Background', '#ffffff'));
      }
      newLayers.push(createScreentoneLayer('Screentone 1', DEFAULT_PARAMS));
      setLayers(newLayers);
      setSelectedLayerId(newLayers[newLayers.length - 1].id);
      setDocSize({ w: opts.width, h: opts.height });
      setDpi(opts.dpi);
      setColorProfile(opts.colorProfile);
      setActiveSelection(null);

      // BUG-C FIX: previously used setPanX(0);setPanY(0);setZoom(0.25) —
      // this left the new doc pinned to the top-left of the viewport
      // instead of centred. Compute proper fit-to-view here. If the
      // container isn't laid out yet (e.g. cold start), fall back to a
      // reasonable default and let the mount useEffect re-fit shortly.
      const fit = computeFitView(opts.width, opts.height);
      if (fit) {
        setZoom(fit.zoom);
        setPanX(fit.panX);
        setPanY(fit.panY);
      } else {
        // Container not measured yet — defer to a follow-up tick.
        setZoom(0.25);
        setTimeout(() => {
          const retry = computeFitView(opts.width, opts.height);
          if (retry) {
            setZoom(retry.zoom);
            setPanX(retry.panX);
            setPanY(retry.panY);
          }
        }, 100);
      }

      // Initialize history for the new doc
      if (historyRef.current) {
        historyRef.current.initialize(
          makeSnapshot(newLayers, { width: opts.width, height: opts.height }, newLayers[newLayers.length - 1].id, 'New Document')
        );
      }
    }, 0);
    setShowNewDocDialog(false);
  }, [activeDocId, layers, docSize, dpi, colorProfile, activeSelection, panX, panY, zoom, selectedLayerId, createDocument]);

  // Initialize first document on mount (if no documents exist)
  useEffect(() => {
    if (documents.length === 0 && !activeDocId) {
      const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const initialLayers = [
        createSolidLayer('Background', '#ffffff'),
        createScreentoneLayer('Screentone 1', DEFAULT_PARAMS),
      ];
      const initialDoc: DocumentState = {
        id,
        name: `Untitled-${++untitledCounterRef.current}`,
        layers: initialLayers,
        docSize: DEFAULT_DOC_SIZE,
        dpi: 300,
        colorProfile: 'gray8',
        activeSelection: null,
        viewport: { panX: 0, panY: 0, zoom: 0.25 },
        selectedLayerId: initialLayers[1].id,
        historySnapshot: null,
        dirty: false,
        createdAt: Date.now(),
      };
      setDocuments([initialDoc]);
      setActiveDocId(id);
      // Initialize history
      if (historyRef.current) {
        historyRef.current.initialize(
          makeSnapshot(initialLayers, { width: DEFAULT_DOC_SIZE.w, height: DEFAULT_DOC_SIZE.h }, initialLayers[1].id, 'Initial')
        );
      }
    }
  }, []);  // run once on mount

  // ── NEW (v2.1): Pre-drag snapshot ref for undo ─────────
  // Captures the layers state BEFORE a transform drag begins so we
  // can push the correct "pre" snapshot to history. Without this,
  // undo would return to the end of the drag (live updates already
  // mutated state), not the start.
  const preDragLayersRef = useRef<Layer[] | null>(null);

  // ── Select first screentone layer by default ──────────
  useEffect(() => {
    if (selectedLayerId === null) {
      const firstTone = layers.find(l => l.type === 'screentone');
      if (firstTone) setSelectedLayerId(firstTone.id);
    }
  }, [layers, selectedLayerId]);

  // Expose state on window for automated test suite verification
  useEffect(() => {
    (window as any).__gentonikState = {
      layers,
      activeSelection,
      selectionOpMode,
      selectedLayerId,
      zoom,
      panX,
      panY,
    };
  }, [layers, activeSelection, selectionOpMode, selectedLayerId, zoom, panX, panY]);

  // A2.1b: Clear selection on active layer change
  useEffect(() => {
    setActiveSelection(null);
  }, [selectedLayerId]);

  // ── Derived ────────────────────────────────────────────
  const imageCache = useImageCache(layers);
  const selectedLayer = layers.find(l => l.id === selectedLayerId) ?? null;

  const compositeCtx: CompositeContext = useMemo(() => ({
    docWidth: docSize.w,
    docHeight: docSize.h,
    imageCache,
    dpi,
    perspectiveSubdivisions,
  }), [docSize, imageCache, dpi, perspectiveSubdivisions]);

  // ── Canvas composite ───────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  // NEW (v2.4): Track the canvas viewport size for CanvasScrollbar.
  // Updated via ResizeObserver on the <main> container.
  // We use a ref-callback to attach the observer as soon as <main> mounts
  // (containerRef.current is null on the first useEffect pass when <main>
  // is conditionally rendered inside the rulers-visible branch).
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const viewportResizeObserverRef = useRef<ResizeObserver | null>(null);
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    // Tear down any previous observer
    if (viewportResizeObserverRef.current) {
      viewportResizeObserverRef.current.disconnect();
      viewportResizeObserverRef.current = null;
    }
    if (!el) return;
    // Measure immediately
    setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    // Watch for size changes
    const ro = new ResizeObserver(() => {
      setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    viewportResizeObserverRef.current = ro;
  }, []);

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== docSize.w) canvas.width = docSize.w;
      if (canvas.height !== docSize.h) canvas.height = docSize.h;
      debug.time('composite');
      // Try WebGL2 first; on any failure (no WebGL2, context lost,
      // shader compile error, FBO incomplete, etc.) the function
      // silently falls back to the existing canvas2D compositeLayers
      // path. During dev: no UI warning. Final GenTonik release will
      // show a toast on first fallback (TBD).
      compositeLayersWithFallback(canvas, layers, compositeCtx);
      debug.timeEnd('composite', 'composite');
    });
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [layers, docSize, imageCache, dpi, compositeCtx]);

  // ── Layer operations ───────────────────────────────────
  const updateLayer = useCallback((id: string, patch: Partial<Layer>) => {
    setLayers(prev => prev.map(l => l.id === id ? { ...l, ...patch, updatedAt: Date.now() } : l));
  }, []);

  const updateSelectedLayer = useCallback((patch: Partial<Layer>) => {
    if (selectedLayerId) updateLayer(selectedLayerId, patch);
  }, [selectedLayerId, updateLayer]);

  const updateParams = useCallback((patch: Partial<ScreentoneParams>) => {
    if (!selectedLayerId) return;
    setLayers(prev => prev.map(l =>
      l.id === selectedLayerId && l.params
        ? { ...l, params: { ...l.params, ...patch }, updatedAt: Date.now() }
        : l
    ));
  }, [selectedLayerId]);

  const updateTransform = useCallback((patch: Partial<LayerTransform>) => {
    if (!selectedLayerId) return;
    setLayers(prev => prev.map(l =>
      l.id === selectedLayerId
        ? { ...l, transform: { ...l.transform, ...patch }, updatedAt: Date.now() }
        : l
    ));
  }, [selectedLayerId]);

  // ── NEW (v2.1): pushHistory + undo/redo + keyboard shortcuts ──
  //
  // pushHistory takes a SNAPSHOT of the current state. To make undo work
  // correctly, the snapshot must be captured BEFORE the mutation. So callers
  // should call pushHistory(...) FIRST, then setLayers(...).
  //
  // For slider drags and brush strokes, use coalescing via the second arg
  // so multiple micro-edits collapse into one undo step.
  // pushHistory records a snapshot of the document state.
  //
  // v2.6: Two calling conventions are supported:
  //
  //   1. pushHistory(label) — captures the CURRENT state (layers/docSize/
  //      selectedLayerId/activeSelection from React state). Use this for
  //      actions that have ALREADY been applied to state (e.g., after a
  //      setLayers call in the same handler). The snapshot = the new state.
  //      Undo will restore the PREVIOUS top-of-stack (which is the old state).
  //
  //   2. pushHistory(label, { layers: newLayers, ... }) — captures an
  //      explicit state. Use this when you mutate state via setLayers(prev => ...)
  //      and need to push the RESULTING layers (which you can't read from
  //      the closure because React hasn't re-rendered yet).
  //
  // IMPORTANT: push AFTER the mutation, not before. The snapshot must
  // represent the state AFTER the user's action, so that:
  //   - undo() restores the previous top-of-stack (= state before action)
  //   - redo() restores this snapshot (= state after action)
  //
  // Earlier versions called pushHistory BEFORE setLayers, which made redo
  // silently no-op (the post-mutation state was never recorded).
  const pushHistory = useCallback((
    label: string,
    coalesceOrOpts: boolean | { coalesce?: boolean; layers?: Layer[]; selectedLayerId?: string | null; activeSelection?: ActiveSelection | null } = false,
  ) => {
    const hm = historyRef.current;
    if (!hm) return;
    // Accept both (label, coalesce:boolean) and (label, opts:object) signatures.
    const opts = typeof coalesceOrOpts === 'boolean'
      ? { coalesce: coalesceOrOpts }
      : coalesceOrOpts;
    const snapshotLayers = opts.layers ?? layers;
    const snapshotSelectedId = opts.selectedLayerId ?? selectedLayerId;
    const snapshotSelection = opts.activeSelection ?? activeSelection;
    hm.push(
      makeSnapshot(snapshotLayers, { width: docSize.w, height: docSize.h }, snapshotSelectedId, label, snapshotSelection),
      { coalesce: opts.coalesce === true },
    );
    forceRender(n => n + 1);
  }, [layers, docSize, selectedLayerId, activeSelection]);

  const handleUndo = useCallback(() => {
    const snap = historyRef.current?.undo();
    if (!snap) return;
    setLayers(snap.layers.slice() as Layer[]);
    setDocSize({ w: snap.docSize.width, h: snap.docSize.height });
    setSelectedLayerId(snap.activeLayerId);
    // v2.6: restore selection state too — otherwise undoing a "Mask from Sel"
    // would leave the marching ants visible even though the mask was reverted.
    setActiveSelection(snap.activeSelection ? { entries: snap.activeSelection.entries.slice() } : null);
    forceRender(n => n + 1);
    debug.info('history', `Undo: ${snap.label}`);
  }, []);

  const handleRedo = useCallback(() => {
    const snap = historyRef.current?.redo();
    if (!snap) return;
    setLayers(snap.layers.slice() as Layer[]);
    setDocSize({ w: snap.docSize.width, h: snap.docSize.height });
    setSelectedLayerId(snap.activeLayerId);
    setActiveSelection(snap.activeSelection ? { entries: snap.activeSelection.entries.slice() } : null);
    forceRender(n => n + 1);
    debug.info('history', `Redo: ${snap.label}`);
  }, []);

  // History init (once) + subscribe for live canUndo/canRedo updates
  useEffect(() => {
    const hm = historyRef.current!;
    hm.initialize(makeSnapshot(layers, { width: docSize.w, height: docSize.h }, selectedLayerId, 'Initial'));
    const unsub = hm.subscribe(() => forceRender(n => n + 1));
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts:
  //   Ctrl/Cmd+Z         → undo
  //   Ctrl/Cmd+Shift+Z   → redo  (or Ctrl+Y)
  //   Ctrl/Cmd+`         → toggle debug panel
  //   Ctrl/Cmd+R         → toggle rulers
  //   Escape             → close popup palette (if open)
  //   No-modifier single-letter keys → tool hotkeys
  //     V move · S scale · R rotate · K skew · F perspective
  //     M rect · E ellipse · L lasso · P polygonal · C cursor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      // Escape closes popup palette or clears active selection
      if (e.key === 'Escape') {
        if (popupPalette) {
          e.preventDefault();
          setPopupPalette(null);
        } else if (activeSelection) {
          e.preventDefault();
          // v2.6: clear selection first, then push the post-mutation state
          // (no selection) to history. Undo restores the previous selection.
          setActiveSelection(null);
          pushHistory('Clear Selection', { activeSelection: null });
          debug.info('ui', 'Selection cleared (Escape)');
        }
        return;
      }

      if (mod) {
        // Modifier shortcuts — only act on specific keys, ignore others
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          handleUndo();
        } else if (k === 'z' && e.shiftKey) {
          e.preventDefault();
          handleRedo();
        } else if (k === 'y') {
          e.preventDefault();
          handleRedo();
        } else if (k === 'r') {
          e.preventDefault();
          setShowRulers(s => !s);
        } else if (k === '`' || e.key === '`') {
          e.preventDefault();
          setDebugOpen(prev => !prev);
        }
        return;
      }

      // 1.5: Mirror Screen toggle (hotkey M)
      if (k === 'm') {
        e.preventDefault();
        setMirrored(prev => !prev);
        return;
      }
      // No-modifier tool hotkeys (M removed — now used for Mirror)
      // v2.10.1: Z removed from tool hotkeys — Z is now a modifier for
      // Z+scroll=zoom (temporary zoom at any tool). To select the Zoom tool,
      // use the toolbox button or right-click popup palette.
      const TOOL_KEYS: Record<string, ToolId> = {
        v: 'move', s: 'scale', r: 'rotate', k: 'skew', f: 'perspective',
        e: 'ellipse', l: 'lasso', p: 'polygonal', c: 'none', b: 'bucket',
      };
      const tool = TOOL_KEYS[k];
      if (tool) {
        e.preventDefault();
        handleToolChange(tool);
        return;
      }

      // A2.1a: Selection op mode shortcuts (N key for New mode)
      const OP_MODE_KEYS: Record<string, SelectionOpMode> = {
        n: 'new',
      };
      const opMode = OP_MODE_KEYS[k];
      if (opMode) {
        e.preventDefault();
        setSelectionOpMode(opMode);
        return;
      }

      // NEW (v2.4): Keyboard scrolling for canvas viewport.
      //   ArrowUp/Down/Left/Right — pan by ~30 screen-px
      //   PageUp/PageDown        — pan by viewport-height (minus small margin)
      //   Home/End               — pan to top/bottom of doc
      //   Ctrl+Home/End          — pan to left/right of doc
      // Only fires when no input/textarea is focused (already checked above).
      //
      // v2.9.1: Arrow keys INVERTED to match the Photoshop-style scrollbar
      // convention (v2.5.1). In Photoshop:
      //   ArrowUp = scroll up = see content above = pan INCREASES (doc moves down)
      //   ArrowDown = scroll down = see content below = pan DECREASES (doc moves up)
      // Previously ArrowUp did panY -= step (wrong direction after scrollbar
      // inversion). Now it does panY += step (correct).
      // We don't preventDefault for arrow keys if a tool would normally use them
      // (currently no tool does, so it's safe).
      const container = containerRef.current;
      if (container) {
        const viewportW = container.clientWidth;
        const viewportH = container.clientHeight;
        const panStep = 30; // screen-px per arrow press
        let newPanX = panX;
        let newPanY = panY;
        let handled = false;
        switch (e.key) {
          case 'ArrowUp':    newPanY += panStep; handled = true; break;   // v2.9.1: inverted
          case 'ArrowDown':  newPanY -= panStep; handled = true; break;   // v2.9.1: inverted
          case 'ArrowLeft':  newPanX += panStep; handled = true; break;   // v2.9.1: inverted
          case 'ArrowRight': newPanX -= panStep; handled = true; break;   // v2.9.1: inverted
          case 'PageUp':     newPanY += viewportH * 0.9; handled = true; break;   // v2.9.1: inverted
          case 'PageDown':   newPanY -= viewportH * 0.9; handled = true; break;   // v2.9.1: inverted
          case 'Home':
            // Home = scroll to top = pan to max (doc top visible, with padding above)
            if (e.ctrlKey || e.metaKey) { newPanX = 200; }
            else { newPanY = 200; }
            handled = true;
            break;
          case 'End':
            // End = scroll to bottom = pan to min (doc bottom visible, with padding below)
            if (e.ctrlKey || e.metaKey) {
              newPanX = -(docSize.w * zoom - viewportW) - 200;
            } else {
              newPanY = -(docSize.h * zoom - viewportH) - 200;
            }
            handled = true;
            break;
        }
        if (handled) {
          e.preventDefault();
          setPanX(newPanX);
          setPanY(newPanY);
          return;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, popupPalette, activeSelection, debug, panX, panY, zoom, docSize, pushHistory]);

  const handleAddScreentone = useCallback(() => {
    const newLayer = createScreentoneLayer(`Screentone ${layers.filter(l => l.type === 'screentone').length + 1}`, DEFAULT_PARAMS);
    const newLayers = [...layers, newLayer];
    setLayers(newLayers);
    setSelectedLayerId(newLayer.id);
    // v2.6: push AFTER mutation with the NEW state so redo restores it.
    pushHistory('Add Screentone', { layers: newLayers, selectedLayerId: newLayer.id });
    debug.info('ui', 'Added screentone layer', { name: newLayer.name });
  }, [layers, pushHistory]);

  const handleSelectionCommit = useCallback(
    (entry: {
      canvasPolygon: Vec2[];
      layerLocalPolygon: Vec2[];
      kind: 'rect' | 'ellipse' | 'lasso' | 'polygonal';
      shiftKey: boolean;
      altKey: boolean;
    }) => {
      const op: SelectionOpMode = entry.shiftKey && entry.altKey
        ? 'intersect'
        : entry.shiftKey
          ? 'add'
          : entry.altKey
            ? 'subtract'
            : selectionOpMode;

      // v2.6: compute the NEW selection state explicitly so we can push it
      // to history AFTER the mutation. This makes redo work correctly:
      //   - undo() restores the previous top-of-stack (no selection / older
      //     selection)
      //   - redo() restores this snapshot (the new selection)
      const newEntry: SelectionEntry = {
        op: op === 'new' ? 'new' : op,
        canvasPolygon: entry.canvasPolygon,
        layerLocalPolygon: entry.layerLocalPolygon,
        kind: entry.kind,
      };
      let newSelection: ActiveSelection;
      if (!activeSelection || activeSelection.entries.length === 0 || op === 'new') {
        newSelection = { entries: [{ ...newEntry, op: 'new' }] };
      } else {
        newSelection = { entries: [...activeSelection.entries, newEntry] };
      }
      setActiveSelection(newSelection);

      const historyLabel =
        op === 'new' ? 'Selection'
        : op === 'add' ? 'Add Selection'
        : op === 'subtract' ? 'Subtract Selection'
        : 'Intersect Selection';
      // Push AFTER mutation with the NEW selection state.
      pushHistory(historyLabel, { activeSelection: newSelection });

      debug.info('ui', `Commit: op=${op}, kind=${entry.kind}, points=${entry.canvasPolygon.length}`);

      // BUG-2 diagnostic: log layerLocalPolygon range for perspective layers
      if (entry.layerLocalPolygon.length > 0) {
        let lpMinX = Infinity, lpMaxX = -Infinity, lpMinY = Infinity, lpMaxY = -Infinity;
        for (const p of entry.layerLocalPolygon) {
          if (p.x < lpMinX) lpMinX = p.x;
          if (p.y < lpMinY) lpMinY = p.y;
          if (p.x > lpMaxX) lpMaxX = p.x;
          if (p.y > lpMaxY) lpMaxY = p.y;
        }
        debug.info('mask', `layerLocal bbox: x=[${lpMinX.toFixed(1)},${lpMaxX.toFixed(1)}] y=[${lpMinY.toFixed(1)},${lpMaxY.toFixed(1)}]`);
      }
    },
    [selectionOpMode, debug, pushHistory, activeSelection],
  );

  const handleSelectionOpModeChange = useCallback((mode: SelectionOpMode) => {
    setSelectionOpMode(mode);
    debug.info('ui', `Op mode changed: ${mode}`);
  }, [debug]);

  const handleAddScreentoneFromSelection = useCallback(() => {
    if (!activeSelection || activeSelection.entries.length === 0) return;

    // 1. Compute tight union bbox of all selection polygons (canvas-space)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const entry of activeSelection.entries) {
      for (const p of entry.canvasPolygon) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX)) return; // degenerate

    const floorX = Math.floor(minX);
    const floorY = Math.floor(minY);
    const bboxW = Math.max(1, Math.ceil(maxX) - floorX);
    const bboxH = Math.max(1, Math.ceil(maxY) - floorY);

    // 2. Create screentone layer with natural size override
    pushHistory('Add Layer from Selection');
    const layerName = `From Selection ${layers.filter(l => l.type === 'screentone').length + 1}`;
    const newLayer = createScreentoneLayer(layerName, DEFAULT_PARAMS);

    newLayer.naturalWidth = bboxW;
    newLayer.naturalHeight = bboxH;

    const docW = docSize.w;
    const docH = docSize.h;
    newLayer.transform = {
      ...DEFAULT_TRANSFORM,
      x: floorX + bboxW / 2 - docW / 2,
      y: floorY + bboxH / 2 - docH / 2,
    };

    // 3. Rasterize and combine via boolean ops
    const rasterized: Uint8Array[] = activeSelection.entries.map(entry =>
      rasterizePolygonAtSize(entry.canvasPolygon, bboxW, bboxH, floorX, floorY),
    );

    const finalMask = new Uint8Array(bboxW * bboxH);
    for (let i = 0; i < activeSelection.entries.length; i++) {
      const entry = activeSelection.entries[i];
      const poly = rasterized[i];
      switch (entry.op) {
        case 'new':
          for (let j = 0; j < finalMask.length; j++) finalMask[j] = poly[j];
          break;
        case 'add':
          for (let j = 0; j < finalMask.length; j++) finalMask[j] = finalMask[j] | poly[j];
          break;
        case 'subtract':
          for (let j = 0; j < finalMask.length; j++) finalMask[j] = finalMask[j] & (255 - poly[j]);
          break;
        case 'intersect':
          for (let j = 0; j < finalMask.length; j++) finalMask[j] = finalMask[j] & poly[j];
          break;
      }
    }

    newLayer.mask = {
      type: 'painted',
      width: bboxW,
      height: bboxH,
      data: finalMask,
      offsetX: 0,
      offsetY: 0,
      invert: false,
    };

    // 4. Add layer, select it, clear active selection
    setLayers(prev => [...prev, newLayer]);
    setSelectedLayerId(newLayer.id);
    setActiveSelection(null);

    debug.info('ui', 'Added screentone layer from selection', {
      name: newLayer.name,
      bbox: { x: floorX, y: floorY, w: bboxW, h: bboxH },
      entries: activeSelection.entries.length,
    });
  }, [activeSelection, layers, pushHistory, docSize, debug]);

  // PRESERVE-PERSPECTIVE: wrapper that shows the mode-picker modal when the
  // active layer has perspective (corners set), or calls handleApplySelectionAsMask
  // directly (default 'object' mode) for non-perspective layers.
  // Defined AFTER handleApplySelectionAsMask (below) to avoid TDZ.
  // (The actual definition is further down; this comment is a placeholder.)
  // handleApplySelectionAsMaskWithModal and handleMaskModePick are defined
  // after handleApplySelectionAsMask.

  const handleApplySelectionAsMask = useCallback((mode: 'object' | 'canvas' = 'object') => {
    if (!activeSelection || activeSelection.entries.length === 0 || !selectedLayerId) return;

    // PRESERVE-PERSPECTIVE: 'canvas' mode uses canvas-space polygon (clip after
    // perspective). 'object' mode uses layer-local polygon (painted mask before
    // perspective). The selection's layerLocalPolygon is already computed in
    // commitSelection (homography inverse) — that's the 'object' mode data.
    // For 'canvas' mode, we use canvasPolygon directly as the clip polygon.
    const layer = layers.find(l => l.id === selectedLayerId);
    const hasPerspective = !!layer?.transform.corners;

    // If 'canvas' mode on a perspective layer, build a canvas-space mask.
    if (mode === 'canvas' && hasPerspective) {
      // Combine all selection entries' canvasPolygons into a single polygon list.
      // For boolean ops (add/subtract/intersect), we'd need polygon clipping here.
      // MVP: use the first 'new' entry's canvasPolygon as the clip polygon.
      // (Multi-entry boolean clip is a future enhancement.)
      const newEntries = activeSelection.entries.filter(e => e.op === 'new');
      const primaryEntry = newEntries[0] ?? activeSelection.entries[0];
      if (!primaryEntry || primaryEntry.canvasPolygon.length < 3) {
        // Empty selection → clear mask
        pushHistory('Apply Selection as Mask (empty)');
        setLayers(prev => prev.map(l =>
          l.id === selectedLayerId
            ? { ...l, mask: undefined, updatedAt: Date.now() }
            : l
        ));
        setActiveSelection(null);
        return;
      }

      // Build a minimal painted mask (1×1 placeholder data) + canvasSpacePolygon.
      // The canvasSpacePolygon is what composite.ts actually uses (as a clip).
      const layerMask: LayerMask = {
        type: 'painted',
        width: 1,
        height: 1,
        data: new Uint8Array([255]),
        offsetX: 0,
        offsetY: 0,
        invert: false,
        canvasSpacePolygon: primaryEntry.canvasPolygon,
      };
    
      pushHistory('Apply Selection as Mask (canvas shape)');
      setLayers(prev => prev.map(l =>
        l.id === selectedLayerId
          ? { ...l, mask: layerMask, updatedAt: Date.now() }
          : l
      ));
      setActiveSelection(null);
      debug.info('mask', `Applied canvas-space mask: ${primaryEntry.canvasPolygon.length} pts`);
      return;
    }

    // 'object' mode (default): existing layer-local painted mask path.
    // BUG-3 FIX (Sutherland-Hodgman): clip the selection polygon (in
    // layer-local space) to the layer's natural bounds [0, w] × [0, h].
    // This prevents the inverse-perspective from mapping out-of-quad canvas
    // points to extreme layer-local coordinates, which previously produced
    // huge mask bounding boxes (e.g. 7798×6002) and triggered MAX_MASK_DIM.
    //
    // Clipping (not clamping) is mathematically correct: parts of the
    // selection outside the layer bounds are simply cut off, preserving the
    // shape of the in-bounds portion. The previous clamp distorted the polygon
    // by collapsing out-of-bounds vertices onto the bounds edge.
    const layerSize = layer
      ? getLayerNaturalSize(layer, {
          docWidth: docSize.w,
          docHeight: docSize.h,
          imageSizes: imageCache.sizes,
        })
      : null;
    if (layerSize && layerSize.w > 0 && layerSize.h > 0) {
      const clipBounds = { left: 0, top: 0, right: layerSize.w, bottom: layerSize.h };
      for (const entry of activeSelection.entries) {
        const clipped = clipPolygonToRect(entry.layerLocalPolygon, clipBounds);
        if (clipped.length >= 3) {
          entry.layerLocalPolygon = clipped;
        } else {
          // Polygon entirely outside layer bounds → mark as empty (single point
          // at origin, length 0 — computeCombinedSelectionMask will skip it).
          entry.layerLocalPolygon = [];
        }
      }
    }

    const combined = computeCombinedSelectionMask(activeSelection.entries);
    if (!combined) {
      // Empty selection (all subtracted) → clear mask
      pushHistory('Apply Selection as Mask (empty)');
      setLayers(prev => prev.map(l =>
        l.id === selectedLayerId
          ? { ...l, mask: undefined, updatedAt: Date.now() }
          : l
      ));
      setActiveSelection(null);
      return;
    }

    // A2.1b-fix: Rect optimization.
    // If the selection is a single axis-aligned rectangle AND the layer size matches
    // the selection bounding box, we skip mask creation.
    if (isRectangularSelection(activeSelection.entries)) {
      const layer = layers.find(l => l.id === selectedLayerId);
      const layerSize = layer
        ? getLayerNaturalSize(layer, {
            docWidth: docSize.w,
            docHeight: docSize.h,
            imageSizes: imageCache.sizes,
          })
        : null;
      if (layerSize &&
          Math.abs(layerSize.w - combined.width) < 2 &&
          Math.abs(layerSize.h - combined.height) < 2) {
        // Layer size matches selection bbox → mask redundant.
        pushHistory('Apply Selection as Mask (rect, no mask needed)');
        setLayers(prev => prev.map(l =>
          l.id === selectedLayerId
            ? { ...l, mask: undefined, updatedAt: Date.now() }
            : l
        ));
        setActiveSelection(null);
        debug.info('ui', 'Rect selection: mask skipped (layer bbox matches)');
        return;
      }
    }

    // Default path: create painted mask from combined result.
    const { mask, width, height, offsetX, offsetY } = combined;
    const layerMask: LayerMask = {
      type: 'painted',
      width,
      height,
      data: mask,
      offsetX,
      offsetY,
      invert: false,
    };

    pushHistory('Apply Selection as Mask');
    setLayers(prev => prev.map(l =>
      l.id === selectedLayerId
        ? { ...l, mask: layerMask, updatedAt: Date.now() }
        : l
    ));
    setActiveSelection(null);
    debug.info('mask', `Applied multi-entry mask: ${activeSelection.entries.length} entries, ${width}x${height}px`);
  }, [activeSelection, selectedLayerId, layers, docSize, imageCache, pushHistory, setLayers, setActiveSelection, debug]);

  // PRESERVE-PERSPECTIVE: wrapper that shows the mode-picker modal when the
  // active layer has perspective (corners set), or calls handleApplySelectionAsMask
  // directly (default 'object' mode) for non-perspective layers.
  const handleApplySelectionAsMaskWithModal = useCallback(() => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (layer?.transform.corners) {
      // Perspective layer → show modal
      setMaskModeModal({ pending: () => {} });
    } else {
      // Non-perspective layer → no modal needed (both modes equivalent)
      handleApplySelectionAsMask('object');
    }
  }, [layers, selectedLayerId, handleApplySelectionAsMask]);

  // Called by the modal when the user picks a mode.
  const handleMaskModePick = useCallback((mode: 'object' | 'canvas') => {
    setMaskModeModal(null);
    handleApplySelectionAsMask(mode);
  }, [handleApplySelectionAsMask]);

  const handleAddTransparent = useCallback(() => {
    const existing = layers.filter(l => l.type === 'transparent').length;
    const newLayer = createTransparentLayer(`Transparent ${existing + 1}`);
    const newLayers = [...layers, newLayer];
    setLayers(newLayers);
    setSelectedLayerId(newLayer.id);
    // v2.6: push AFTER mutation so redo restores the new layer.
    pushHistory('Add Transparent Layer', { layers: newLayers, selectedLayerId: newLayer.id });
    debug.info('ui', 'Added transparent layer', { name: newLayer.name });
  }, [layers, pushHistory]);

  const handleAddImage = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const newLayer = createImageLayer(file.name.replace(/\.[^.]+$/, ''), src);
      // v2.6: compute newLayers explicitly so we can push the post-mutation
      // state to history. setLayers(prev => ...) can't be read synchronously.
      setLayers(prev => {
        const newLayers = [...prev, newLayer];
        // Push inside the updater so we have access to the fresh prev array.
        // queueMicrotask ensures pushHistory runs after state commit.
        queueMicrotask(() => pushHistory('Add Image', { layers: newLayers, selectedLayerId: newLayer.id }));
        return newLayers;
      });
      setSelectedLayerId(newLayer.id);
      debug.info('ui', 'Added image layer', { name: newLayer.name, size: file.size });
    };
    reader.readAsDataURL(file);
  }, [pushHistory]);

  const handleDelete = useCallback((id: string) => {
    const newLayers = layers.filter(l => l.id !== id);
    setLayers(newLayers);
    const newSelectedId = selectedLayerId === id ? null : selectedLayerId;
    if (selectedLayerId === id) setSelectedLayerId(null);
    // v2.6: push AFTER mutation so redo restores the deleted state.
    pushHistory('Delete Layer', { layers: newLayers, selectedLayerId: newSelectedId });
    debug.info('ui', 'Deleted layer', { id });
  }, [layers, selectedLayerId, pushHistory]);

  const handleDuplicate = useCallback((id: string) => {
    const idx = layers.findIndex(l => l.id === id);
    if (idx < 0) return;
    const source = layers[idx];
    const now = Date.now();
    const copy: Layer = {
      ...source,
      id: `layer-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${source.name} copy`,
      params: source.params ? { ...source.params } : undefined,
      transform: { ...source.transform },
      mask: source.mask ? { ...source.mask } : undefined,
      createdAt: now,
      updatedAt: now,
    };
    const newLayers = [...layers];
    newLayers.splice(idx + 1, 0, copy);
    setLayers(newLayers);
    setSelectedLayerId(copy.id);
    // v2.6: push AFTER mutation so redo restores the duplicate.
    pushHistory('Duplicate Layer', { layers: newLayers, selectedLayerId: copy.id });
  }, [layers, pushHistory]);

  const handleMoveUp = useCallback((id: string) => {
    const idx = layers.findIndex(l => l.id === id);
    if (idx < 0 || idx >= layers.length - 1) return;
    const next = [...layers];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    setLayers(next);
    pushHistory('Reorder Layers', { layers: next });
  }, [layers, pushHistory]);

  const handleMoveDown = useCallback((id: string) => {
    const idx = layers.findIndex(l => l.id === id);
    if (idx <= 0) return;
    const next = [...layers];
    [next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
    setLayers(next);
    pushHistory('Reorder Layers', { layers: next });
  }, [layers, pushHistory]);

  const handleToggleVisible = useCallback((id: string) => {
    setLayers(prev => prev.map(l => l.id === id ? { ...l, visible: !l.visible } : l));
  }, []);

  const handleRename = useCallback((id: string, name: string) => {
    updateLayer(id, { name });
  }, [updateLayer]);

  const handleChangeBlend = useCallback((id: string, blend: BlendMode) => {
    updateLayer(id, { blendMode: blend });
  }, [updateLayer]);

  const handleChangeOpacity = useCallback((id: string, opacity: number) => {
    updateLayer(id, { opacity: Math.max(0, Math.min(1, opacity)) });
  }, [updateLayer]);

  // ── Preset operations ──────────────────────────────────
  const handleApplyPreset = useCallback((preset: PresetV2) => {
    // If a screentone layer is selected, replace its params.
    // Otherwise, create a new screentone layer with the preset params.
    if (selectedLayer?.type === 'screentone') {
      const newLayers = layers.map(l =>
        l.id === selectedLayer.id ? { ...l, params: { ...preset.params }, updatedAt: Date.now() } : l
      );
      setLayers(newLayers);
      pushHistory('Apply Preset', { layers: newLayers });
    } else {
      const newLayer = createScreentoneLayer(preset.name, preset.params);
      const newLayers = [...layers, newLayer];
      setLayers(newLayers);
      setSelectedLayerId(newLayer.id);
      pushHistory('Apply Preset', { layers: newLayers, selectedLayerId: newLayer.id });
    }
    debug.info('preset', `Applied preset: ${preset.name}`);
  }, [selectedLayer, layers, pushHistory]);

  // v2.11.1: Bake Transform — rasterize screentone layer with its FULL transform.
  //
  // Two paths to avoid moire/waves:
  //
  // A) Scale-only (no rotation/skew/perspective):
  //    Render screentone at bakedW×bakedH (= naturalSize × scale) with scaled
  //    spacing. No interpolation → no moire. This is the old approach that
  //    worked for scale.
  //
  // B) Rotation/skew/perspective:
  //    Render screentone at SUPER-SAMPLED resolution (2× the baked bounding box)
  //    with scaled spacing, then apply rotation/skew/perspective via Canvas2D
  //    transform, then downscale to final size. Supersampling reduces moire.
  //
  // In both cases, the result is an image layer with identity transform that
  // looks exactly like the transformed screentone.
  const handleBakeTransform = useCallback(() => {
    if (!selectedLayer || selectedLayer.type !== 'screentone' || !selectedLayer.params) {
      alert('Bake Transform requires a screentone layer.');
      return;
    }
    const t = selectedLayer.transform;
    const hasTransform = t.scaleX !== 1 || t.scaleY !== 1 || t.rotation !== 0
                         || t.skewX !== 0 || t.skewY !== 0 || t.corners;
    if (!hasTransform) {
      alert('Layer has no transform to bake. Apply scale/rotate/skew/perspective first.');
      return;
    }

    const hasRotationOrSkew = t.rotation !== 0 || t.skewX !== 0 || t.skewY !== 0 || !!t.corners;

    // Scaled spacing (variant a: dotSize stays, spacing scales)
    const bakedParams = { ...selectedLayer.params };
    if (!t.corners) {
      bakedParams.spacingX = bakedParams.spacingX * Math.abs(t.scaleX);
      bakedParams.spacingY = bakedParams.spacingY * Math.abs(t.scaleY);
    }

    if (!hasRotationOrSkew) {
      // ── Path A: Scale-only — render at baked size, no interpolation ──
      const baseW = selectedLayer.naturalWidth ?? docSize.w;
      const baseH = selectedLayer.naturalHeight ?? docSize.h;
      const bakedW = Math.max(1, Math.round(baseW * Math.abs(t.scaleX)));
      const bakedH = Math.max(1, Math.round(baseH * Math.abs(t.scaleY)));

      const MAX_BAKE = 8192;
      if (bakedW > MAX_BAKE || bakedH > MAX_BAKE) {
        if (!confirm(`Baked size ${bakedW}×${bakedH} is very large. Continue?`)) return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = bakedW;
      canvas.height = bakedH;
      const ctx = canvas.getContext('2d');
      if (!ctx) { alert('Failed to get 2D context.'); return; }
      renderScreentone(ctx, bakedW, bakedH, bakedParams);
      const dataUrl = canvas.toDataURL('image/png');

      const bakedLayer: Layer = {
        id: selectedLayer.id,
        name: selectedLayer.name + ' (baked)',
        type: 'image',
        visible: selectedLayer.visible,
        opacity: selectedLayer.opacity,
        blendMode: selectedLayer.blendMode,
        transform: { ...DEFAULT_TRANSFORM, x: t.x, y: t.y },
        imageSrc: dataUrl,
        mask: selectedLayer.mask,
        naturalWidth: bakedW,
        naturalHeight: bakedH,
        colorSpace: selectedLayer.colorSpace ?? 'srgb',
        meta: { ...(selectedLayer.meta ?? {}), bakedFrom: 'screentone', bakedAt: Date.now() },
        createdAt: selectedLayer.createdAt,
        updatedAt: Date.now(),
      };
      const newLayers = layers.map(l => l.id === selectedLayer.id ? bakedLayer : l);
      setLayers(newLayers);
      pushHistory('Bake Transform', { layers: newLayers });
      debug.info('bake', `Baked (scale-only) ${bakedW}×${bakedH}`);
      return;
    }

    // ── Path B: Rotation/skew/perspective — supersampled composite ──
    //
    // For perspective (corners): compute the bounding box of the warped quad.
    // For rotation/skew: compute the bounding box of the rotated/skewed rect.
    // Then render at 2× that size with scaled spacing, apply the transform,
    // and downscale to 1× for the final image.
    //
    // We use the composite pipeline which already handles all transforms.

    // Create a temp screentone layer with modified params but SAME transform.
    const tempLayer: Layer = { ...selectedLayer, params: bakedParams };

    // Render at 2× docSize for supersampling (reduces moire from interpolation)
    const SS = 2; // supersampling factor
    const renderW = docSize.w * SS;
    const renderH = docSize.h * SS;

    // Temporarily override docSize in compositeCtx for supersampled render
    const ssCompositeCtx: CompositeContext = {
      ...compositeCtx,
      docWidth: renderW,
      docHeight: renderH,
    };

    // Temp layer with supersampled naturalSize
    const ssLayer: Layer = {
      ...tempLayer,
      // Scale transform to match supersampled space
      transform: {
        ...t,
        x: t.x * SS,
        y: t.y * SS,
        // For corners, scale them too
        corners: t.corners
          ? t.corners.map(c => ({ x: c.x * SS, y: c.y * SS })) as [Vec2, Vec2, Vec2, Vec2]
          : null,
      },
      naturalWidth: tempLayer.naturalWidth ? tempLayer.naturalWidth * SS : undefined,
      naturalHeight: tempLayer.naturalHeight ? tempLayer.naturalHeight * SS : undefined,
    };

    const ssCanvas = document.createElement('canvas');
    ssCanvas.width = renderW;
    ssCanvas.height = renderH;
    const ssCtx = ssCanvas.getContext('2d');
    if (!ssCtx) { alert('Failed to get 2D context.'); return; }
    ssCtx.clearRect(0, 0, renderW, renderH);

    // Also scale the screentone params for supersampled space
    const ssParams = {
      ...bakedParams,
      spacingX: bakedParams.spacingX * SS,
      spacingY: bakedParams.spacingY * SS,
      dotSize: bakedParams.dotSize * SS,
      lineWidth: bakedParams.lineWidth * SS,
    };
    const ssLayerWithParams: Layer = { ...ssLayer, params: ssParams };

    compositeSingleLayerPublic(ssCtx, ssLayerWithParams, ssCompositeCtx);

    // Downscale to docSize using high-quality image smoothing
    const bakedCanvas = document.createElement('canvas');
    bakedCanvas.width = docSize.w;
    bakedCanvas.height = docSize.h;
    const bakedCtx = bakedCanvas.getContext('2d');
    if (!bakedCtx) { alert('Failed to get 2D context.'); return; }
    bakedCtx.imageSmoothingEnabled = true;
    bakedCtx.imageSmoothingQuality = 'high';
    bakedCtx.drawImage(ssCanvas, 0, 0, renderW, renderH, 0, 0, docSize.w, docSize.h);

    const dataUrl = bakedCanvas.toDataURL('image/png');

    const bakedLayer: Layer = {
      id: selectedLayer.id,
      name: selectedLayer.name + ' (baked)',
      type: 'image',
      visible: selectedLayer.visible,
      opacity: selectedLayer.opacity,
      blendMode: selectedLayer.blendMode,
      transform: { ...DEFAULT_TRANSFORM },
      imageSrc: dataUrl,
      mask: selectedLayer.mask,
      naturalWidth: docSize.w,
      naturalHeight: docSize.h,
      colorSpace: selectedLayer.colorSpace ?? 'srgb',
      meta: { ...(selectedLayer.meta ?? {}), bakedFrom: 'screentone', bakedAt: Date.now() },
      createdAt: selectedLayer.createdAt,
      updatedAt: Date.now(),
    };

    const newLayers = layers.map(l => l.id === selectedLayer.id ? bakedLayer : l);
    setLayers(newLayers);
    pushHistory('Bake Transform', { layers: newLayers });
    debug.info('bake', `Baked (supersampled 2×) ${docSize.w}×${docSize.h} with rotation/perspective`);
  }, [selectedLayer, layers, docSize, compositeCtx, pushHistory, debug]);

  // v2.10: Bucket fill — called when user clicks canvas with Bucket tool.
  // Behavior depends on bucketMode:
  //   solid-canvas:       new solid layer covering whole canvas
  //   solid-selection:    new solid layer covering selection bbox (with mask)
  //   solid-into-layer:   modify selected layer's content (solid color, screentone bg, or image pixels)
  //   screentone-canvas:  new screentone layer covering whole canvas
  //   screentone-selection: new screentone layer covering selection bbox (with mask)
  const handleBucketFill = useCallback(() => {
    const hasSelection = !!(activeSelection && activeSelection.entries.length > 0);

    // ── solid-into-layer: modify the selected layer ──
    if (bucketMode === 'solid-into-layer') {
      if (!selectedLayer) {
        alert('Select a layer first.');
        return;
      }
      let newLayer: Layer;
      if (selectedLayer.type === 'solid') {
        newLayer = { ...selectedLayer, solidColor: bucketColor, updatedAt: Date.now() };
      } else if (selectedLayer.type === 'screentone' && selectedLayer.params) {
        // Change the screentone's background color
        newLayer = {
          ...selectedLayer,
          params: { ...selectedLayer.params, colorBg: bucketColor },
          updatedAt: Date.now(),
        };
      } else if (selectedLayer.type === 'image' && selectedLayer.imageSrc) {
        // Paint solid color onto the image's pixels (within selection if any)
        // This is a destructive pixel operation.
        const img = imageCache.images.get(selectedLayer.imageSrc);
        if (!img) { alert('Image not loaded.'); return; }
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { alert('No 2D context.'); return; }
        ctx.drawImage(img, 0, 0);
        // Fill with color (optionally clipped to selection mapped to layer-local)
        ctx.save();
        ctx.fillStyle = bucketColor;
        if (hasSelection) {
          // Clip to selection polygon (mapped to layer-local space)
          // For simplicity, fill the whole image — selection clipping on image
          // layers requires inverse-transform mapping which is complex.
          // Future: implement proper selection clip.
        }
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        newLayer = {
          ...selectedLayer,
          imageSrc: canvas.toDataURL('image/png'),
          updatedAt: Date.now(),
        };
      } else if (selectedLayer.type === 'transparent') {
        // Convert transparent to solid
        newLayer = { ...selectedLayer, type: 'solid', solidColor: bucketColor, updatedAt: Date.now() };
      } else {
        alert('Cannot fill into a ' + selectedLayer.type + ' layer.');
        return;
      }
      const newLayers = layers.map(l => l.id === selectedLayer.id ? newLayer : l);
      setLayers(newLayers);
      pushHistory('Bucket: Fill Into Layer', { layers: newLayers });
      debug.info('bake', `Bucket fill into layer "${selectedLayer.name}" with ${bucketColor}`);
      return;
    }

    // ── New-layer modes (solid-canvas, solid-selection, screentone-canvas, screentone-selection) ──
    if (bucketMode === 'solid-canvas' || bucketMode === 'solid-selection') {
      if (bucketMode === 'solid-selection' && !hasSelection) {
        alert('Make a selection first (Rect/Ellipse/Lasso tools).');
        return;
      }
      const newLayer = createSolidLayer(`Fill ${layers.filter(l => l.type === 'solid').length + 1}`, bucketColor);
      if (bucketMode === 'solid-selection' && activeSelection) {
        // Set naturalWidth/Height to selection bbox, position via transform
        // Compute selection bbox in canvas space
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const entry of activeSelection.entries) {
          for (const p of entry.canvasPolygon) {
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = minY;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
            if (p.y < minY) minY = p.y;
          }
        }
        const selW = Math.round(maxX - minX);
        const selH = Math.round(maxY - minY);
        if (selW < 1 || selH < 1) { alert('Selection too small.'); return; }
        newLayer.naturalWidth = selW;
        newLayer.naturalHeight = selH;
        newLayer.transform = {
          ...DEFAULT_TRANSFORM,
          x: (minX + selW / 2) - docSize.w / 2,
          y: (minY + selH / 2) - docSize.h / 2,
        };
      }
      const newLayers = [...layers, newLayer];
      setLayers(newLayers);
      setSelectedLayerId(newLayer.id);
      pushHistory(`Bucket: ${bucketMode === 'solid-canvas' ? 'Fill Canvas' : 'Fill Selection'}`, { layers: newLayers, selectedLayerId: newLayer.id });
      debug.info('bake', `Bucket solid fill: ${bucketMode}, color ${bucketColor}`);
      return;
    }

    if (bucketMode === 'screentone-canvas' || bucketMode === 'screentone-selection') {
      if (bucketMode === 'screentone-selection' && !hasSelection) {
        alert('Make a selection first (Rect/Ellipse/Lasso tools).');
        return;
      }
      const newLayer = createScreentoneLayer(`Screentone ${layers.filter(l => l.type === 'screentone').length + 1}`, DEFAULT_PARAMS);
      if (bucketMode === 'screentone-selection' && activeSelection) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const entry of activeSelection.entries) {
          for (const p of entry.canvasPolygon) {
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
          }
        }
        const selW = Math.round(maxX - minX);
        const selH = Math.round(maxY - minY);
        if (selW < 1 || selH < 1) { alert('Selection too small.'); return; }
        newLayer.naturalWidth = selW;
        newLayer.naturalHeight = selH;
        newLayer.transform = {
          ...DEFAULT_TRANSFORM,
          x: (minX + selW / 2) - docSize.w / 2,
          y: (minY + selH / 2) - docSize.h / 2,
        };
      }
      const newLayers = [...layers, newLayer];
      setLayers(newLayers);
      setSelectedLayerId(newLayer.id);
      pushHistory(`Bucket: ${bucketMode === 'screentone-canvas' ? 'Screentone Canvas' : 'Screentone Selection'}`, { layers: newLayers, selectedLayerId: newLayer.id });
      debug.info('bake', `Bucket screentone fill: ${bucketMode}`);
      return;
    }
  }, [bucketMode, bucketColor, selectedLayer, layers, activeSelection, docSize, imageCache, pushHistory, debug]);

  // ── NEW (v2.2): Transform live/commit + screenToCanvas + mask change ──
  //
  // CRITICAL UNDO FIX (bugs 1+2 from review):
  //   • onTransformLive is called on EVERY pointermove during a drag.
  //   • We can't push history on every live call — would create 100s of
  //     undo steps for one drag.
  //   • We can't push only on commit either — by then, layers state has
  //     been mutated many times and the "pre-drag" state is lost.
  //
  // Solution: preDragLayersRef captures the layers array on the FIRST
  // live call (when the ref is null). We push THAT snapshot to history,
  // then immediately clear the ref so subsequent live calls skip the push.
  // On commit, we just reset the ref (no extra history push needed).
  //
  // Edge case: if user clicks a handle but doesn't actually drag (no
  // live calls with different transform), preDragLayersRef stays null
  // and no history entry is created. Correct.
  //
  // We also deduplicate: if the incoming transform is identical to the
  // current one (e.g., a stray pointermove with no actual delta), skip
  // both the live update AND the history push.
  const handleTransformLive = useCallback((transform: LayerTransform) => {
    if (!selectedLayerId) return;
    const current = layers.find(l => l.id === selectedLayerId);
    if (!current) return;
    // Skip no-op live updates (prevents empty history entries on stray clicks)
    if (
      current.transform.x === transform.x &&
      current.transform.y === transform.y &&
      current.transform.scaleX === transform.scaleX &&
      current.transform.scaleY === transform.scaleY &&
      current.transform.rotation === transform.rotation &&
      current.transform.skewX === transform.skewX &&
      current.transform.skewY === transform.skewY &&
      current.transform.corners === transform.corners
    ) {
      return;
    }
    // First live call of a drag → capture pre-drag state into history
    if (preDragLayersRef.current === null) {
      preDragLayersRef.current = layers;
      const hm = historyRef.current;
      if (hm) {
        hm.push(
          makeSnapshot(layers, { width: docSize.w, height: docSize.h }, selectedLayerId, 'Transform'),
        );
        forceRender(n => n + 1);
      }
      // Gemini 2.3 fix: drop perspective subdivision to 2 during drag
      // for instant feedback. Restored to 8 on commit. Only relevant
      // when the active layer has perspective corners.
      if (transform.corners || current.transform.corners) {
        setPerspectiveSubdivisions(2);
      }
    }
    setLayers(prev => prev.map(l =>
      l.id === selectedLayerId
        ? { ...l, transform, updatedAt: Date.now() }
        : l
    ));
  }, [selectedLayerId, layers, docSize]);

  const handleTransformCommit = useCallback((_transform: LayerTransform, _label: string) => {
    // History was already pushed in handleTransformLive (first call).
    // Here we just reset the ref so the next drag starts fresh.
    preDragLayersRef.current = null;
    // Gemini 2.3 fix: restore high-quality subdivision after drag ends.
    // 8×8 = 128 triangles — good visual quality at interactive speeds.
    setPerspectiveSubdivisions(8);
  }, []);

  const handleMaskChange = useCallback((mask: LayerMask | undefined, label: string) => {
    if (!selectedLayerId) return;
    pushHistory(label);
    setLayers(prev => prev.map(l =>
      l.id === selectedLayerId
        ? { ...l, mask, updatedAt: Date.now() }
        : l
    ));
    debug.info('mask', `Mask changed: ${label}`);
  }, [selectedLayerId, pushHistory]);

  // ── NEW (v2.1): Mask editor wiring ─────────────────────
  const handleOpenMaskEditor = useCallback((layerId: string) => {
    setMaskEditorLayerId(layerId);
    debug.info('mask', 'Opening mask editor', { layerId });
  }, []);

  const handleCloseMaskEditor = useCallback(() => {
    setMaskEditorLayerId(null);
  }, []);

  const handleMaskStrokeComplete = useCallback((mask: Extract<LayerMask, { type: 'painted' }>) => {
    if (!maskEditorLayerId) return;
    pushHistory('Paint Mask');
    setLayers(prev => prev.map(l =>
      l.id === maskEditorLayerId
        ? { ...l, mask, updatedAt: Date.now() }
        : l
    ));
    debug.info('mask', 'Stroke complete', { width: mask.width, height: mask.height });
  }, [maskEditorLayerId, pushHistory]);

  const maskEditorLayer = layers.find(l => l.id === maskEditorLayerId) ?? null;

  // screenToCanvas — convert browser client coords → canvas-pixel coords
  // (used by TransformPanelOverlay to map pointer events).
  const screenToCanvas = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    if (mirrored) {
      return {
        x: (rect.width - (clientX - rect.left) - panX) / zoom,
        y: (clientY - rect.top - panY) / zoom,
      };
    }
    return {
      x: (clientX - rect.left - panX) / zoom,
      y: (clientY - rect.top - panY) / zoom,
    };
  }, [panX, panY, zoom, mirrored]);

  // Natural rendered size of the active layer's content (px)
  const activeLayerNaturalSize = useMemo<{ w: number; h: number }>(() => {
    if (!selectedLayer) return { w: 0, h: 0 };
    // A3-fix-7: solid naturalSize = docSize (matches composite).
    // getLayerNaturalSize returns {1,1} for solid layers, but
    // composite.ts overrides renderW/H to docSize when drawing.
    // The transform overlay MUST use the same size, otherwise
    // layerMatrix maps the 1×1 box to a single point at the
    // document center, clustering all handles there and making
    // transform tools appear broken on solid layers.
    //
    // v2.9: text/vector layers also get docSize override (no intrinsic size).
    if (selectedLayer.type === 'solid' || selectedLayer.type === 'transparent'
        || selectedLayer.type === 'text' || selectedLayer.type === 'vector') {
      return { w: docSize.w, h: docSize.h };
    }
    return getLayerNaturalSize(selectedLayer, {
      docWidth: docSize.w,
      docHeight: docSize.h,
      imageSizes: imageCache.sizes,
    });
  }, [selectedLayer, docSize, imageCache]);

  // ── Tool switch (no bake — preserve perspective) ──────────────
  // PRESERVE-PERSPECTIVE FIX (2026-06-28, replaces premature-bake approach):
  //
  // Earlier this function "baked" the perspective (corners) into an affine
  // approximation (x/y/scale/rotation/skew) when the user switched to an
  // affine tool (move/scale/rotate/skew), then cleared `corners`. That made
  // affine tools work but DESTROYED the perspective: the layer snapped from
  // a trapezoid to a rectangle the moment the user picked Rotate, which is
  // not what the user wants. The user wants to APPLY Free Transform once,
  // then KEEP the deformed shape and continue editing with Rotate/Scale/etc.
  // on top of the deformed shape (Photoshop behavior).
  //
  // New behavior: switching tools NEVER modifies the layer. The layer keeps
  // its `corners` (perspective). Affine tools operate ON the corners (each
  // corner is treated as a point in canvas space; rotate/scale/skew/move
  // transforms all 4 corners as a rigid/affine group). See computeMove /
  // computeScale / computeRotate / computeSkewedTransform in
  // transform-overlay-canvas.tsx for the corners-aware branches.
  //
  // Tool UI: when `corners ≠ null`, the overlay renders the perspective
  // quad (pink dashed, 4 corner handles) PLUS the affine handles for the
  // active tool (rotate circle / scale squares / skew handles) over the
  // quad's bounding box. Corner handles of the perspective quad are
  // editable only in the Free Transform tool; in affine tools they are
  // visual-only (so the user can see the deformed shape).
  const handleToolChange = useCallback((newTool: ToolId) => {
    setActiveTool(newTool);
  }, []);

  const handleSavePreset = useCallback(() => {
    if (selectedLayer?.type !== 'screentone' || !selectedLayer.params) {
      alert('Select a screentone layer first to save its parameters as a preset.');
      return;
    }
    setEditingPreset(null);
    setPresetEditorCurrentParams(selectedLayer.params);
    setShowPresetEditor(true);
  }, [selectedLayer]);

  const handleEditPreset = useCallback((preset: PresetV2) => {
    setEditingPreset(preset);
    setPresetEditorCurrentParams(null);
    setShowPresetEditor(true);
  }, []);

  const handlePresetSave = useCallback((data: { id?: string; name: string; icon: string; category: string; description: string; tags: string[] }) => {
    try {
      if (data.id) {
        // Editing existing — but if it's a built-in, duplicate first
        const existing = presetStore.getPresetById(data.id);
        if (existing?.isBuiltIn) {
          presetStore.createPreset(data.name, existing.params, data.category, data.icon, data.description, data.tags);
        } else {
          presetStore.updatePreset(data.id, {
            name: data.name,
            icon: data.icon,
            category: data.category,
            description: data.description,
            tags: data.tags,
          });
        }
      } else if (presetEditorCurrentParams) {
        presetStore.createPreset(data.name, presetEditorCurrentParams, data.category, data.icon, data.description, data.tags);
      }
      setPresetRefreshKey(k => k + 1);
      setShowPresetEditor(false);
      setEditingPreset(null);
      setPresetEditorCurrentParams(null);
    } catch (err) {
      alert(`Failed to save preset: ${(err as Error).message}`);
    }
  }, [presetEditorCurrentParams]);

  const handleExportPresets = useCallback(() => {
    const json = presetStore.exportPresets();
    if (!json) {
      alert('No user presets to export.');
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gentonik-presets-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const handleImportPresets = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = presetStore.importPresets(reader.result as string);
        setPresetRefreshKey(k => k + 1);
        alert(`Imported: ${result.imported}, skipped: ${result.skipped}${result.errors.length ? '\n\nErrors:\n' + result.errors.join('\n') : ''}`);
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  // ── File operations ────────────────────────────────────
  // 1.7: File → New now opens the New Document dialog (Photoshop-style).
  // The dialog lets the user choose name, size, resolution, color profile,
  // and background. On "Create", a new document opens in a NEW TAB — it
  // does NOT destroy the current document (unlike the old behavior).
  const handleNewDoc = useCallback(() => {
    setShowNewDocDialog(true);
  }, []);

  // 1.6: File → Open now opens the .ora in a NEW TAB (not replacing current doc).
  // The current document is preserved in its tab.
  const handleOpenOra = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ORA_FILE_ACCEPT;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !isOraFile(file)) {
        alert('Please select an .ora file.');
        return;
      }
      try {
        const result: OraImportResult = await openOraFile(file);
        // 1.6: Save current doc state, then create a new doc for the opened file
        if (activeDocId) {
          setDocuments(prev => prev.map(d =>
            d.id === activeDocId
              ? {
                  ...d,
                  layers,
                  docSize,
                  dpi,
                  colorProfile,
                  activeSelection,
                  viewport: { panX, panY, zoom },
                  selectedLayerId,
                  historySnapshot: null,
                  dirty: true,
                }
              : d
          ));
        }
        // Create new doc for opened file
        const newId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const selectedId = result.layers.find(l => l.type === 'screentone')?.id ?? result.layers[0]?.id ?? null;
        const newDoc: DocumentState = {
          id: newId,
          name: file.name.replace(/\.ora$/i, ''),
          layers: result.layers,
          docSize: { w: result.docWidth, h: result.docHeight },
          dpi: 300,
          colorProfile: 'gray8',  // ORA doesn't store colorProfile yet — default to gray8
          activeSelection: null,
          viewport: { panX: 0, panY: 0, zoom: 0.25 },
          selectedLayerId: selectedId,
          historySnapshot: null,
          dirty: false,
          filePath: file.name,
          createdAt: Date.now(),
        };
        setDocuments(prev => [...prev, newDoc]);
        debug.info('ora', `Opened .ora: ${result.layers.length} layers, ${result.docWidth}x${result.docHeight}`);
        if (result.warnings.length > 0) {
          debug.warn('ora', `${result.warnings.length} warnings on import`, result.warnings);
        }
        if (result.downgradedLayers > 0) {
          debug.info('ora', `${result.downgradedLayers} layer(s) imported as image (no GenToniK metadata).`);
        }
        // Switch to the new doc
        setTimeout(() => {
          setActiveDocId(newId);
          setLayers(result.layers);
          setSelectedLayerId(selectedId);
          setDocSize({ w: result.docWidth, h: result.docHeight });
          setActiveSelection(null);
          if (historyRef.current) {
            historyRef.current.initialize(
              makeSnapshot(result.layers, { width: result.docWidth, height: result.docHeight }, selectedId, `Open ${file.name}`)
            );
          }
          // Fit view to new doc
          handleFitView(result.docWidth, result.docHeight);
        }, 0);
      } catch (err) {
        debug.error('ora', 'Open failed', err);
        alert(`Failed to open .ora: ${(err as Error).message}`);
      }
    };
    input.click();
  }, [activeDocId, layers, docSize, dpi, colorProfile, activeSelection, panX, panY, zoom, selectedLayerId]);

  const handleSaveOra = useCallback(async () => {
    try {
      await saveOraFile(layers, compositeCtx, `gentonik-${Date.now()}`);
      debug.info('ora', `Saved .ora: ${layers.length} layers`);
    } catch (err) {
      debug.error('ora', 'Save failed', err);
      alert(`Failed to save .ora: ${(err as Error).message}`);
    }
  }, [layers, compositeCtx]);

  const handleExportPng = useCallback(async () => {
    try {
      const result = await exportCompositeToFile(
        pngBridge, layers, { width: docSize.w, height: docSize.h },
        imageCache, { fileName: `gentonik-${Date.now()}` }, dpi,
      );
      debug.info('bridge', `Exported PNG: ${result.fileName} (${result.bytes} bytes)`);
    } catch (err) {
      debug.error('bridge', 'Export failed', err);
      alert(`Export failed: ${(err as Error).message}`);
    }
  }, [layers, docSize, imageCache, dpi]);

  // ── NEW (v2.0): Import PNG via PS bridge ──────────────
  const handleImportPng = useCallback(async () => {
    try {
      const result: BridgeImportResult | null = await pngBridge.importFromPicker();
      if (!result) return; // user canceled
      const newLayer = createImageLayer(result.baseName, result.imageSrc);
      setLayers(prev => {
        const newLayers = [...prev, newLayer];
        queueMicrotask(() => pushHistory('Import PNG', { layers: newLayers, selectedLayerId: newLayer.id }));
        return newLayers;
      });
      setSelectedLayerId(newLayer.id);
      debug.info('bridge', `Imported PNG: ${result.baseName} (${result.width}x${result.height})`);
    } catch (err) {
      debug.error('bridge', 'Import failed', err);
      alert(`Import failed: ${(err as Error).message}`);
    }
  }, [pushHistory]);

  // ── View operations ────────────────────────────────────
  // (containerRef declared above, near canvasRef — needed by screenToCanvas)

  /**
   * Pure helper: compute zoom + pan to fit a document of (docW × docH)
   * inside the canvas viewport with `padding` px around it. Does NOT
   * touch React state — callers do that via setZoom/setPanX.
   *
   * Returns null if the container isn't laid out yet (zero size).
   *
   * Extracted as a top-level function (not a useCallback) so it can be
   * called from any handler that needs to fit a fresh doc to view —
   * handleCreateNewDocument, closeDocument, handleFitView, etc. — without
   * each of them depending on docSize from their own closure.
   */
  const computeFitView = (
    docW: number, docH: number,
    padding = 32,
  ): { zoom: number; panX: number; panY: number } | null => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const z = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, Math.min((rect.width - padding * 2) / docW, (rect.height - padding * 2) / docH))
    );
    return {
      zoom: z,
      panX: (rect.width - docW * z) / 2,
      panY: (rect.height - docH * z) / 2,
    };
  };

  const handleFitView = useCallback((w?: number, h?: number) => {
    const docW = w ?? docSize.w;
    const docH = h ?? docSize.h;
    const fit = computeFitView(docW, docH);
    if (!fit) return;
    setZoom(fit.zoom);
    setPanX(fit.panX);
    setPanY(fit.panY);
  }, [docSize]);

  // Fit on mount
  useEffect(() => {
    setTimeout(() => handleFitView(), 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleZoomIn = useCallback(() => setZoom(z => Math.min(MAX_ZOOM, z * 1.25)), []);
  const handleZoomOut = useCallback(() => setZoom(z => Math.max(MIN_ZOOM, z / 1.25)), []);

  // ── Render ─────────────────────────────────────────────
  // Photoshop-style 3-panel layout (Kimi Variant A):
  //   ┌─ MenuBar ──────────────────────────────────────────────┐
  //   ├─ Toolbox ┬─ Layers ──────────┬─ Canvas ───┬─ Properties ─┐
  //   │  (52px)  │  + Presets (260)  │  (flex:1)  │   (320px)    │
  //   ├──────────┴───────────────────┴────────────┴──────────────┘
  //   └─ StatusBar ───────────────────────────────────────────┘
  //
  // No floating panels over the canvas — all tools live in the
  // Toolbox (left) and Properties (right), as recommended by the
  // Kimi UI analysis. Drag handles still render on the canvas via
  // <TransformPanelOverlay>, but its own toolbar/status panels were
  // stripped (see transform-overlay-movable.tsx).
  return (
    <div style={{ ...styles.app, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Toolbar
        onNewDoc={handleNewDoc}
        onOpenOra={handleOpenOra}
        onSaveOra={handleSaveOra}
        onExportPng={handleExportPng}
        onImportPng={handleImportPng}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={historyRef.current?.canUndo() ?? false}
        canRedo={historyRef.current?.canRedo() ?? false}
        paramMode={paramMode}
        onToggleParamMode={() => setParamMode(m => m === 'simple' ? 'advanced' : 'simple')}
        onBakeTransform={handleBakeTransform}
        canBake={
          !!selectedLayer
          && selectedLayer.type === 'screentone'
          && (selectedLayer.transform.scaleX !== 1
              || selectedLayer.transform.scaleY !== 1
              || selectedLayer.transform.rotation !== 0
              || selectedLayer.transform.skewX !== 0
              || selectedLayer.transform.skewY !== 0
              || !!selectedLayer.transform.corners)
        }
        docWidth={docSize.w}
        docHeight={docSize.h}
        onDocSizeChange={(w, h) => setDocSize({ w, h })}
        dpi={dpi}
        onDpiChange={setDpi}
        colorProfile={colorProfile}
        onChangeColorProfile={async (p) => {
          if (p === colorProfile) return;
          if (p === 'cmyk8' || colorProfile === 'cmyk8') {
            alert('CMYK conversion is not supported in GenToniK core — use WebToonTools.');
            return;
          }
          if (!confirm(`Convert document from ${colorProfile} to ${p}? This will convert all layers (destructive).`)) return;
          // v2.9.1: Real conversion — not just metadata.
          // convertLayersColorProfile rewrites solid/screentone colors and
          // image pixels. Push history with the NEW state after conversion.
          try {
            const newLayers = await convertLayersColorProfile(layers, colorProfile, p);
            setLayers(newLayers);
            setColorProfile(p);
            pushHistory(`Convert to ${p === 'gray8' ? 'Grayscale' : 'RGB'}`, { layers: newLayers });
            debug.info('doc', `Converted ${layers.length} layers from ${colorProfile} to ${p}`);
          } catch (err) {
            alert(`Conversion failed: ${(err as Error).message}`);
          }
        }}
        mirrored={mirrored}
        onToggleMirror={() => setMirrored(m => !m)}
      />

      {/* 1.6: Tab strip (Photoshop-style document tabs) */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        background: themeColor('topbar-bg'),
        borderBottom: `1px solid ${themeColor('border')}`,
        padding: '0 4px',
        height: 32,
        flexShrink: 0,
        overflowX: 'auto',
        gap: 2,
      }}>
        {documents.map(doc => (
          <div
            key={doc.id}
            onClick={() => switchToDocument(doc.id)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeDocument(doc.id); } }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              fontSize: 11,
              cursor: 'pointer',
              background: doc.id === activeDocId ? themeColor('sidebar-bg') : 'transparent',
              border: `1px solid ${doc.id === activeDocId ? themeColor('border') : 'transparent'}`,
              borderBottom: doc.id === activeDocId ? 'none' : `1px solid ${themeColor('border')}`,
              borderRadius: '4px 4px 0 0',
              color: doc.id === activeDocId ? themeColor('text') : themeColor('text-dim'),
              whiteSpace: 'nowrap',
              userSelect: 'none',
              minWidth: 0,
            }}
            title={doc.filePath || doc.name}
          >
            {doc.dirty && <span style={{ color: '#ffcc00' }}>●</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>
              {doc.name}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); closeDocument(doc.id); }}
              style={{
                background: 'none',
                border: 'none',
                color: themeColor('text-dim'),
                cursor: 'pointer',
                fontSize: 14,
                padding: '0 2px',
                lineHeight: 1,
              }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        ))}
        {/* New tab button */}
        <button
          onClick={() => setShowNewDocDialog(true)}
          style={{
            background: 'none',
            border: `1px solid ${themeColor('border')}`,
            color: themeColor('text-dim'),
            cursor: 'pointer',
            fontSize: 14,
            padding: '2px 8px',
            borderRadius: 4,
            lineHeight: 1,
          }}
          title="New document"
        >
          +
        </button>
      </div>

      {/* 1.7: New Document dialog (Photoshop-style) */}
      {showNewDocDialog && (
        <NewDocumentDialog
          onCreate={handleCreateNewDocument}
          onCancel={() => setShowNewDocDialog(false)}
        />
      )}

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left: Toolbox (vertical, 52px) — Photoshop/Krita style */}
        <Toolbox
          activeTool={activeTool}
          onToolChange={handleToolChange}
          disabledAffine={!!selectedLayer?.transform.corners}
          hasActiveLayer={!!selectedLayer}
        />

        {/* Left-mid: Layers + Presets as tabs (Gemini 2.4.1) */}
        <aside
          style={{
            ...styles.sidebar,
            width: 260,
            minWidth: 220,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Tab strip — switches between Layers and Presets.
              Each tab gets the full sidebar height when active,
              which gives long lists room to breathe. */}
          <div style={{
            display: 'flex',
            borderBottom: `1px solid ${themeColor('border')}`,
            background: themeColor('topbar-bg'),
            flexShrink: 0,
          }}>
            {(['layers', 'presets'] as const).map(tab => {
              const active = leftPanelTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setLeftPanelTab(tab)}
                  style={{
                    flex: 1,
                    padding: '7px 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                    color: active ? themeColor('text') : themeColor('text-dim'),
                    background: active ? themeColor('sidebar-bg') : 'transparent',
                    border: 'none',
                    borderBottom: active ? `2px solid ${themeColor('input-focus')}` : '2px solid transparent',
                    cursor: 'pointer',
                    transition: 'color 80ms, border-color 80ms',
                  }}
                >
                  {tab === 'layers' ? 'Layers' : 'Presets'}
                </button>
              );
            })}
          </div>

          {/* Active panel fills the rest of the sidebar */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {leftPanelTab === 'layers' ? (
              <LayerPanel
                layers={layers}
                selectedId={selectedLayerId}
                onSelect={setSelectedLayerId}
                onToggleVisible={handleToggleVisible}
                onRename={handleRename}
                onDelete={handleDelete}
                onDuplicate={handleDuplicate}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onAddScreentone={handleAddScreentone}
                onAddTransparent={handleAddTransparent}
                onAddImage={handleAddImage}
                onChangeBlend={handleChangeBlend}
                onChangeOpacity={handleChangeOpacity}
                onEditMask={handleOpenMaskEditor}
                activeSelection={activeSelection}
                onAddScreentoneFromSelection={handleAddScreentoneFromSelection}
                onApplySelectionAsMask={handleApplySelectionAsMaskWithModal}
                selectionOpMode={selectionOpMode}
                onSelectionOpModeChange={handleSelectionOpModeChange}
                activeTool={activeTool}
                bucketMode={bucketMode}
                onBucketModeChange={setBucketMode}
                bucketColor={bucketColor}
                onBucketColorChange={setBucketColor}
                hasSelection={!!(activeSelection && activeSelection.entries.length > 0)}
                /* A3-fix-2: activeTool passed to LayerPanel */
              />
            ) : (
              <PresetBrowser
                onApply={handleApplyPreset}
                onSaveCurrent={handleSavePreset}
                onEdit={handleEditPreset}
                onExport={handleExportPresets}
                onImport={handleImportPresets}
                refreshKey={presetRefreshKey}
              />
            )}
          </div>
        </aside>

        {/* Center: canvas with rulers (Ctrl+R to toggle, or right-click → Rulers) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {showRulers && (
            <div style={{ display: 'flex', height: 20, flexShrink: 0, background: themeColor('topbar-bg') }}>
              {/* Corner square where the two rulers meet — also shows unit selector */}
              <RulerUnitSelector unit={rulerUnit} onChange={setRulerUnit} />
              <Ruler
                orientation="horizontal"
                pan={panX}
                zoom={zoom}
                docExtent={docSize.w}
                unit={rulerUnit}
                dpi={dpi}
                cursorPos={mouseCanvasPos?.x ?? null}
              />
            </div>
          )}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              {showRulers && (
                <div style={{ width: 20, flexShrink: 0, background: themeColor('topbar-bg'), display: 'flex', flexDirection: 'column' }}>
                  <Ruler
                    orientation="vertical"
                    pan={panY}
                    zoom={zoom}
                    docExtent={docSize.h}
                    unit={rulerUnit}
                    dpi={dpi}
                    cursorPos={mouseCanvasPos?.y ?? null}
                  />
                </div>
              )}
              <main
                ref={setContainerRef}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setPopupPalette({ x: e.clientX, y: e.clientY });
                }}
                onMouseMove={(e) => {
                  // Track mouse position in document-px space for Ruler cursor indicator.
                  const rect = e.currentTarget.getBoundingClientRect();
                  const screenX = e.clientX - rect.left;
                  const screenY = e.clientY - rect.top;
                  // Convert screen-px → doc-px: docX = (screenX - panX) / zoom
                  // (mirrored mode doesn't affect the doc-space cursor for rulers,
                  // since the ruler itself isn't mirrored — only the canvas content.)
                  const docX = (screenX - panX) / zoom;
                  const docY = (screenY - panY) / zoom;
                  setMouseCanvasPos({ x: docX, y: docY });
                }}
                onMouseLeave={() => setMouseCanvasPos(null)}
                style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}
              >
              <div style={{
                flex: 1, display: 'flex', position: 'relative',
                transform: mirrored ? 'scaleX(-1)' : 'none',
              }}>
              <CanvasView
                canvasRef={canvasRef}
                docSize={docSize}
                zoom={zoom}
                panX={panX}
                panY={panY}
                onZoom={setZoom}
                onPan={(x, y) => { setPanX(x); setPanY(y); }}
                selectedLayer={selectedLayer}
                compositeCtx={compositeCtx}
                activeTool={activeTool}
                onBucketFill={handleBucketFill}
              />
              {selectedLayer && (
                <TransformOverlayCanvas
                  docSize={docSize}
                  activeLayer={selectedLayer}
                  activeLayerNaturalSize={activeLayerNaturalSize}
                  screenToCanvas={screenToCanvas}
                  viewportScale={zoom}
                  panX={panX}
                  panY={panY}
                  onTransformLive={handleTransformLive}
                  onTransformCommit={handleTransformCommit}
                  onMaskChange={handleMaskChange}
                  onSelectionCommit={handleSelectionCommit}
                  activeSelection={activeSelection}
                  tool={activeTool}
                  onToolChange={handleToolChange}
                  selectionOpMode={selectionOpMode}
                />
              )}

              {mirrored && (
                <div style={{
                  position: 'absolute', top: 8, right: 8,
                  padding: '2px 8px', fontSize: 10, fontWeight: 600,
                  color: '#fff', background: 'rgba(13,153,255,0.8)',
                  borderRadius: 4, zIndex: 1000, pointerEvents: 'none',
                }}>↔ Mirrored</div>
              )}
              </div>

              {/* Right-click popup palette (Krita-style).
                  Renders above all other canvas children; closes on Escape,
                  tool pick, action pick, or click outside. */}
              {popupPalette && (
                <PopupPalette
                  x={popupPalette.x}
                  y={popupPalette.y}
                  activeTool={activeTool}
                  hasActiveLayer={!!selectedLayer}
                  disabledAffine={!!selectedLayer?.transform.corners}
                  showRulers={showRulers}
                  onToolChange={handleToolChange}
                  onFitView={() => handleFitView()}
                  onZoom100={() => setZoom(1)}
                  onToggleRulers={() => setShowRulers(s => !s)}
                  onClose={() => setPopupPalette(null)}
                />
              )}

              {/* PRESERVE-PERSPECTIVE: Mask-from-Sel mode picker modal.
                  Shown when the user clicks "Mask from Sel" on a perspective layer. */}
              {maskModeModal && (
                <div
                  style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.4)',
                    zIndex: 9999,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  onClick={() => setMaskModeModal(null)}
                >
                  <div
                    style={{
                      background: themeColor('sidebar-bg'),
                      border: `1px solid ${themeColor('border')}`,
                      borderRadius: 8,
                      padding: 24,
                      minWidth: 360,
                      maxWidth: 440,
                      boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{
                      fontSize: 14,
                      fontWeight: 600,
                      marginBottom: 8,
                      color: themeColor('text'),
                    }}>
                      Mask from Selection — mode
                    </div>
                    <div style={{
                      fontSize: 12,
                      color: themeColor('text-dim'),
                      marginBottom: 16,
                      lineHeight: 1.5,
                    }}>
                      The layer has a Free Transform (perspective) applied.
                      Choose how the mask should behave:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <button
                        type="button"
                        style={{
                          ...styles.button,
                          padding: '10px 12px',
                          textAlign: 'left',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                        onClick={() => handleMaskModePick('canvas')}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          By canvas shape
                        </span>
                        <span style={{ fontSize: 11, color: themeColor('text-dim'), fontWeight: 400 }}>
                          Mask = exact selection outline on canvas. The mask boundary stays as drawn, regardless of the layer's perspective.
                        </span>
                      </button>
                      <button
                        type="button"
                        style={{
                          ...styles.button,
                          padding: '10px 12px',
                          textAlign: 'left',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                        onClick={() => handleMaskModePick('object')}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          By object shape
                        </span>
                        <span style={{ fontSize: 11, color: themeColor('text-dim'), fontWeight: 400 }}>
                          Mask follows the layer's perspective deformation. The mask boundary is the selection outline warped by the perspective transform.
                        </span>
                      </button>
                    </div>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      marginTop: 16,
                      gap: 8,
                    }}>
                      <button
                        type="button"
                        style={{ ...styles.button, padding: '6px 12px', fontSize: 12 }}
                        onClick={() => setMaskModeModal(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </main>
              {/* Vertical scrollbar — sits to the right of <main> within the row.
                  Always visible (Photoshop-style): even when doc < viewport, the user
                  can pan into the padding area, and the scrollbar reflects that. */}
              {viewportSize.h > 0 && (
                <CanvasScrollbar
                  orientation="vertical"
                  pan={panY}
                  zoom={zoom}
                  docExtent={docSize.h}
                  viewportExtent={viewportSize.h}
                  onChange={setPanY}
                />
              )}
            </div>
            {/* Horizontal scrollbar — below the row of (ruler + main + vscroll).
                Always visible (matches vertical). */}
            {viewportSize.w > 0 && (
              <div style={{ display: 'flex', height: 12, flexShrink: 0 }}>
                {/* Spacer under the vertical ruler (20px) */}
                <div style={{ width: 20, flexShrink: 0, background: themeColor('sub-bg'), borderRight: `1px solid ${themeColor('border')}` }} />
                <CanvasScrollbar
                  orientation="horizontal"
                  pan={panX}
                  zoom={zoom}
                  docExtent={docSize.w}
                  viewportExtent={viewportSize.w - 20 /* ruler */ - 12 /* vscroll */}
                  onChange={setPanX}
                />
              </div>
            )}
          </div>
        </div>

        {/* Right sidebar: Properties (collapsible sections) */}
        <aside
          style={{
            ...styles.sidebar,
            width: 320,
            minWidth: 280,
            borderRight: 'none',
            borderLeft: `1px solid ${themeColor('border')}`,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
          className="custom-scroll"
        >
          {selectedLayer ? (
            <>
              {/* Layer header — name + type + param-mode toggle */}
              <div style={{
                padding: '8px 10px',
                borderBottom: `1px solid ${themeColor('border')}`,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: themeColor('topbar-bg'),
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: themeColor('text'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedLayer.name}
                  </div>
                  <div style={{ fontSize: 10, color: themeColor('text-dim'), textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {selectedLayer.type}
                  </div>
                </div>
                {selectedLayer.type === 'screentone' && (
                  <button
                    onClick={() => setParamMode(m => m === 'simple' ? 'advanced' : 'simple')}
                    title="Toggle Simple / Advanced parameter editor"
                    style={{
                      ...styles.button,
                      padding: '2px 8px',
                      fontSize: 10,
                      background: paramMode === 'advanced' ? themeColor('input-focus') : themeColor('btn-secondary'),
                      color: paramMode === 'advanced' ? '#fff' : themeColor('text'),
                    }}
                  >
                    {paramMode === 'simple' ? 'Simple' : 'Advanced'}
                  </button>
                )}
              </div>

              {/* ── Screentone / Solid / Image / Transparent params (collapsible) ── */}
              <CollapsibleSection title="Properties" defaultOpen>
                {selectedLayer.type === 'screentone' && selectedLayer.params ? (
                  paramMode === 'simple'
                    ? <ParamEditorSimple params={selectedLayer.params} onChange={updateParams} dpi={dpi} />
                    : <ParamEditorAdvanced params={selectedLayer.params} onChange={updateParams} dpi={dpi} />
                ) : selectedLayer.type === 'solid' ? (
                  <div style={{ padding: 8 }}>
                    <ColorField
                      label="Color"
                      value={selectedLayer.solidColor ?? '#000000'}
                      onChange={v => updateSelectedLayer({ solidColor: v })}
                    />
                  </div>
                ) : selectedLayer.type === 'transparent' ? (
                  <div style={{ padding: 8, fontSize: 12, ...styles.textDim }}>
                    Empty transparent layer — transform &amp; mask controls only.
                    Apply a mask via "Mask from Sel" to use as a stencil cut-out.
                  </div>
                ) : selectedLayer.type === 'text' ? (
                  <div style={{ padding: 8, fontSize: 12, ...styles.textDim }}>
                    Text layer (STUB) — rendering not yet implemented.
                    Transform &amp; mask controls work; text content editing
                    will be added with the future TextRenderer plugin.
                  </div>
                ) : selectedLayer.type === 'vector' ? (
                  <div style={{ padding: 8, fontSize: 12, ...styles.textDim }}>
                    Vector layer (STUB) — rendering not yet implemented.
                    Transform &amp; mask controls work; shape editing will be
                    added with the future VectorRenderer plugin.
                  </div>
                ) : (
                  <div style={{ padding: 8, fontSize: 12, ...styles.textDim }}>
                    Image layer — transform controls only.
                  </div>
                )}
              </CollapsibleSection>

              {/* ── Transform (collapsible, always shown for active layer) ── */}
              <CollapsibleSection title="Transform" defaultOpen>
                {/* A3-fix-2: duplicate Submode panel removed */}
                <NumberField label="Offset X" value={selectedLayer.transform.x}
                  onChange={v => { pushHistory('Edit X'); updateTransform({ x: v }); }}
                  step={1} suffix="px" />
                <NumberField label="Offset Y" value={selectedLayer.transform.y}
                  onChange={v => { pushHistory('Edit Y'); updateTransform({ y: v }); }}
                  step={1} suffix="px" />
                <NumberField label="Scale X" value={selectedLayer.transform.scaleX}
                  onChange={v => { pushHistory('Edit ScaleX'); updateTransform({ scaleX: v }); }}
                  min={0.01} step={0.01} />
                <NumberField label="Scale Y" value={selectedLayer.transform.scaleY}
                  onChange={v => { pushHistory('Edit ScaleY'); updateTransform({ scaleY: v }); }}
                  min={0.01} step={0.01} />
                <NumberField label="Rotation" value={selectedLayer.transform.rotation}
                  onChange={v => { pushHistory('Edit Rotation'); updateTransform({ rotation: v }); }}
                  min={-180} max={180} step={1} suffix="°" />
                <NumberField label="Skew X" value={selectedLayer.transform.skewX}
                  onChange={v => { pushHistory('Edit SkewX'); updateTransform({ skewX: v }); }}
                  min={-89} max={89} step={1} suffix="°" />
                <NumberField label="Skew Y" value={selectedLayer.transform.skewY}
                  onChange={v => { pushHistory('Edit SkewY'); updateTransform({ skewY: v }); }}
                  min={-89} max={89} step={1} suffix="°" />
                <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                  <button
                    onClick={() => { pushHistory('Reset Transform'); updateTransform({ ...DEFAULT_TRANSFORM }); }}
                    style={{ ...styles.button, padding: '3px 8px', fontSize: 11, flex: 1 }}
                  >
                    Reset
                  </button>
                  <button
                    onClick={() => {
                      pushHistory('Reset Perspective');
                      updateTransform({ corners: null });
                    }}
                    disabled={!selectedLayer.transform.corners}
                    style={{
                      ...styles.button,
                      padding: '3px 8px', fontSize: 11, flex: 1,
                      opacity: selectedLayer.transform.corners ? 1 : 0.4,
                    }}
                    title="Clear perspective corners"
                  >
                    Reset Persp.
                  </button>
                </div>
                <div style={{ marginTop: 4, fontSize: 10, ...styles.textDim }}>
                  Doc: {docSize.w}×{docSize.h}px
                  {selectedLayer.transform.corners && ' • perspective mode'}
                </div>
                {/* 1.1 Gemini patch: DOM badge "АФФИННЫЙ РЕЖИМ" — replaces the
                    old canvas-drawn yellow hint that had no visual anchor.
                    Visible only when the user is in the Free Transform tool
                    (perspective) but the layer has NO corners set yet — i.e.
                    the layer is still in affine mode within the perspective
                    tool. Dragging any corner will enter perspective mode and
                    hide this badge. */}
                {activeTool === 'perspective' && !selectedLayer.transform.corners && (
                  <div style={{
                    marginTop: 6,
                    padding: '4px 8px',
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    color: '#8a6d00',
                    background: 'rgba(255, 204, 0, 0.18)',
                    border: '1px solid rgba(255, 204, 0, 0.5)',
                    borderRadius: 4,
                    textAlign: 'center',
                  }}>
                    💡 Аффинный режим — потяните за угол, чтобы войти в перспективу
                  </div>
                )}
              </CollapsibleSection>

              {/* ── Mask section (only if mask exists) ── */}
              {selectedLayer.mask && (
                <CollapsibleSection title="Mask" defaultOpen>
                  <div style={{ fontSize: 11, ...styles.textMuted, marginBottom: 6 }}>
                    Type: <strong style={{ color: themeColor('text') }}>{selectedLayer.mask.type}</strong>
                    {selectedLayer.mask.type === 'shape'
                      ? ` (${selectedLayer.mask.shape})`
                      : ` (${selectedLayer.mask.width}×${selectedLayer.mask.height})`}
                    {selectedLayer.mask.invert ? ' [inverted]' : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={() => handleMaskChange(undefined, 'Clear Mask')}
                      style={{ ...styles.button, padding: '3px 8px', fontSize: 11, flex: 1 }}
                    >
                      Clear Mask
                    </button>
                  </div>
                </CollapsibleSection>
              )}
            </>
          ) : (
            <div style={{ padding: 16, fontSize: 12, ...styles.textDim, textAlign: 'center' }}>
              Select a layer to edit its parameters.
            </div>
          )}
        </aside>
      </div>

      <StatusBar
        zoom={zoom}
        onZoomChange={setZoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoom100={() => setZoom(1)}
        onFitView={() => handleFitView()}
        docWidth={docSize.w}
        docHeight={docSize.h}
        dpi={dpi}
        activeTool={activeTool}
        activeLayerName={selectedLayer?.name ?? null}
        perspectiveMode={!!selectedLayer?.transform.corners}
        maskPresent={!!selectedLayer?.mask}
        showRulers={showRulers}
        onToggleRulers={() => setShowRulers(s => !s)}
      />

      {/* Preset editor modal */}
      {showPresetEditor && (
        <PresetEditorModal
          preset={editingPreset}
          currentParams={presetEditorCurrentParams}
          onClose={() => {
            setShowPresetEditor(false);
            setEditingPreset(null);
            setPresetEditorCurrentParams(null);
          }}
          onSave={handlePresetSave}
        />
      )}

      {/* Mask editor overlay (v2.1) */}
      {maskEditorLayer && (
        <MaskEditor
          layer={maskEditorLayer}
          initialMask={
            maskEditorLayer.mask?.type === 'painted' ? maskEditorLayer.mask : undefined
          }
          layerWidth={activeLayerNaturalSize.w || docSize.w}
          layerHeight={activeLayerNaturalSize.h || docSize.h}
          docWidth={docSize.w}
          docHeight={docSize.h}
          viewTransform={{ zoom, panX, panY }}
          layerTransform={maskEditorLayer.transform}
          onStrokeComplete={handleMaskStrokeComplete}
          onClose={handleCloseMaskEditor}
        />
      )}

      {/* Debug panel overlay (v2.0) — toggle with Ctrl+` */}
      <DebugPanel
        isOpen={debugOpen}
        onClose={() => setDebugOpen(false)}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// CollapsibleSection — accordion-style section for the Properties panel
// ────────────────────────────────────────────────────────────

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function CollapsibleSection({ title, defaultOpen = true, children }: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState(!defaultOpen);
  return (
    <div style={{ borderBottom: `1px solid ${themeColor('border')}` }}>
      <div
        className="gt-section-header"
        data-collapsed={collapsed}
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="gt-caret">▼</span>
        <span>{title}</span>
      </div>
      {!collapsed && (
        <div className="gt-section-body">
          {children}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// A2.1b-fix: Selection helpers for Rect Mask Optimization
// ────────────────────────────────────────────────────────────

function isRectangularSelection(entries: SelectionEntry[]): boolean {
  if (entries.length !== 1) return false; // strict single entry
  const e = entries[0];
  return e.op === 'new' && e.kind === 'rect' && isAxisAlignedRect(e.layerLocalPolygon);
}

function isAxisAlignedRect(poly: Vec2[]): boolean {
  if (poly.length !== 4) return false;
  const xs = poly.map(p => Math.round(p.x));
  const ys = poly.map(p => Math.round(p.y));
  const uniqueXs = new Set(xs);
  const uniqueYs = new Set(ys);
  if (uniqueXs.size !== 2 || uniqueYs.size !== 2) return false;
  const xArr = [...uniqueXs];
  const yArr = [...uniqueYs];
  for (const x of xArr) {
    for (const y of yArr) {
      if (!poly.some(p => Math.round(p.x) === x && Math.round(p.y) === y)) return false;
    }
  }
  return true;
}
