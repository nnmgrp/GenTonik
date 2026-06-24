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
  type CSSProperties, type ChangeEvent, type DragEvent,
} from 'react';
import {
  type Layer, type ScreentoneParams, type PresetV2,
  type BlendMode, type LayerTransform, type LayerType,
  type LayerMask,
  type DotShape, type PatternType, type SizeUnit, type RenderSizeMode,
  DEFAULT_PARAMS, DEFAULT_TRANSFORM, BLEND_MODES,
  createScreentoneLayer, createImageLayer, createSolidLayer,
} from './types';
import {
  type CompositeContext, type ImageCache,
  compositeLayers, getLayerCanvasBounds, isPointInLayer,
} from './composite';
import { toPx, fromPx, formatInUnit } from './units';
import * as presetStore from './preset-store';
import {
  saveOraFile, openOraFile, isOraFile, ORA_FILE_ACCEPT,
  type OraImportResult,
} from './ora-format';

// ── NEW (v2.1): History (undo/redo) ───────────────────────────
import {
  HistoryManager, makeSnapshot,
  type DocumentSnapshot,
} from './history';

// ── NEW (v2.2): Transform Panel (drag handles, perspective, selection) ──
import {
  TransformOverlayMovable as TransformPanelOverlay,
  type TransformOverlayMovableProps as TransformPanelProps,
  type ToolId,
} from './transform-overlay-movable';

// ── NEW (v2.1): Mask Editor (brush + 4 selection tools) ───────
import {
  MaskEditor,
  type MaskEditorProps,
  type ViewTransform,
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

      <NumberField
        label="Spacing X"
        value={convertFromPx(params.spacingX)}
        onChange={v => onChange({ spacingX: convertToPx(v) })}
        min={0.1}
        step={0.1}
        suffix={unitLabel}
      />

      <NumberField
        label="Spacing Y"
        value={convertFromPx(params.spacingY)}
        onChange={v => onChange({ spacingY: convertToPx(v) })}
        min={0.1}
        step={0.1}
        suffix={unitLabel}
      />

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

      <ColorField
        label="Background"
        value={params.colorBg}
        onChange={v => onChange({ colorBg: v })}
      />

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
  onAddSolid: () => void;
  onAddImage: (file: File) => void;
  onChangeBlend: (id: string, blend: BlendMode) => void;
  onChangeOpacity: (id: string, opacity: number) => void;
  /** NEW v2.1: Open mask editor for this layer. */
  onEditMask?: (id: string) => void;
}

const LAYER_TYPE_ICONS: Record<LayerType, string> = {
  screentone: '▦',
  image: '🖼',
  solid: '■',
};

function LayerPanel({
  layers, selectedId, onSelect, onToggleVisible, onRename, onDelete,
  onDuplicate, onMoveUp, onMoveDown, onAddScreentone, onAddSolid,
  onAddImage, onChangeBlend, onChangeOpacity, onEditMask,
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
        <button onClick={onAddScreentone} style={{ ...styles.button, padding: '4px 8px', fontSize: 11 }} title="Add screentone layer">
          + Tone
        </button>
        <button onClick={() => imageInputRef.current?.click()} style={{ ...styles.button, padding: '4px 8px', fontSize: 11 }} title="Add image layer">
          + Image
        </button>
        <button onClick={onAddSolid} style={{ ...styles.button, padding: '4px 8px', fontSize: 11 }} title="Add solid color layer">
          + Solid
        </button>
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
  const allPresets = useMemo(() => presetStore.getAllPresets(), [refreshKey]);
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
}

function CanvasView({
  canvasRef, docSize, zoom, panX, panY, onZoom, onPan, selectedLayer, compositeCtx,
}: CanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  // Calculate selected layer's on-screen bounding box for the selection overlay
  const selectionOverlay = useMemo(() => {
    if (!selectedLayer) return null;
    return getLayerCanvasBounds(selectedLayer, compositeCtx);
  }, [selectedLayer, compositeCtx]);

  const handleWheel = (e: React.WheelEvent) => {
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

  const handleMouseDown = (e: React.MouseEvent) => {
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
    }
  };

  const handleMouseUp = () => {
    dragRef.current = null;
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

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{
        position: 'relative',
        flex: 1,
        overflow: 'hidden',
        // Photoshop-style dark workspace background — the document
        // surface itself is on a checkerboard, this is the area around it.
        background: themeColor('app-bg'),
        cursor: dragRef.current ? 'grabbing' : 'default',
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

const TOOLBOX_GROUPS: ToolGroup[] = [
  {
    id: 'navigate',
    label: 'Navigate',
    tools: [
      { id: 'none', icon: '▷', label: 'Cursor', hint: 'Cursor (no tool) — pan/zoom only' },
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
      { id: 'rect',      icon: '▭', label: 'Rect',     hint: 'Rectangular Marquee (M)' },
      { id: 'ellipse',   icon: '◯', label: 'Ellipse',  hint: 'Elliptical Marquee (E)' },
      { id: 'lasso',     icon: '✎', label: 'Lasso',    hint: 'Freehand Lasso (L)' },
      { id: 'polygonal', icon: '⬠', label: 'Polygon',  hint: 'Polygonal Lasso (P)' },
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
            const disabled =
              !hasActiveLayer ||
              (disabledAffine &&
                (t.id === 'move' || t.id === 'scale' || t.id === 'rotate' || t.id === 'skew'));
            return (
              <button
                key={t.id}
                type="button"
                className="gt-tool-btn"
                data-active={activeTool === t.id}
                data-tooltip={`${t.label} — ${t.hint}`}
                disabled={disabled}
                onClick={() => onToolChange(t.id)}
                title={t.hint}
              >
                {t.icon}
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
};

const TOOL_HINTS: Record<ToolId, string> = {
  none: 'Space-drag to pan · ⌘/Ctrl+wheel to zoom',
  move: 'Drag layer body or arrow handles to move · V',
  scale: 'Drag corner handles to scale · S',
  rotate: 'Drag top handle to rotate · R',
  skew: 'Drag side handles to skew · K',
  perspective: 'Drag corner handles to deform perspective · F',
  rect: 'Click-drag to mark rectangular selection · M',
  ellipse: 'Click-drag to mark elliptical selection · E',
  lasso: 'Draw freehand · release to close selection · L',
  polygonal: 'Click to add points · double-click to close · P',
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
// Ruler — top (horizontal) or left (vertical) ruler around canvas
// ────────────────────────────────────────────────────────────
//
// Renders tick marks at "nice" intervals (1/2/5 * 10^n) chosen so
// ticks are ~80px apart on screen. Labels are document-space pixel
// coordinates, so the user sees where the cursor is in the doc.
//
// Synchronised with pan/zoom: a tick at doc-coord X is drawn at
// screen position `panX + X * zoom` (or panY/zoom for vertical).

interface RulerProps {
  orientation: 'horizontal' | 'vertical';
  pan: number;       // panX for horizontal, panY for vertical
  zoom: number;
  docExtent: number; // docSize.w for horizontal, docSize.h for vertical
}

function niceStep(target: number): number {
  if (target <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const candidates = [pow, 2 * pow, 5 * pow, 10 * pow];
  for (const c of candidates) if (c >= target) return c;
  return 10 * pow;
}

function Ruler({ orientation, pan, zoom, docExtent }: RulerProps) {
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
  const targetPx = 80;
  const docStep = niceStep(targetPx / zoom);   // document-space tick step
  const screenStep = docStep * zoom;           // screen-space tick step

  // First doc-tick whose screen position is >= 0
  const firstTickDoc = Math.ceil((-pan) / zoom / docStep) * docStep;
  const firstTickScreen = pan + firstTickDoc * zoom;

  const majorTicks: Array<{ screen: number; label: string }> = [];
  const minorTicks: Array<number> = [];
  for (let s = firstTickScreen, d = firstTickDoc; s <= extent; s += screenStep, d += docStep) {
    majorTicks.push({ screen: s, label: String(Math.round(d)) });
    // Half-step minor ticks
    const half = s + screenStep / 2;
    if (half <= extent) minorTicks.push(half);
  }

  // Highlight: show doc-extent end with a shaded region past the document edge
  const docEndScreen = pan + docExtent * zoom;

  const dim = themeColor('text-dim');
  const muted = themeColor('text-muted');
  const border = themeColor('border');

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

        {/* Major ticks + labels */}
        {majorTicks.map((t, i) => isH ? (
          <g key={`M${i}`}>
            <line x1={t.screen} y1={0} x2={t.screen} y2={11} stroke={muted} strokeWidth={1} />
            <text x={t.screen + 2} y={15} fontSize={9} fill={muted}
                  fontFamily="ui-monospace, Menlo, monospace">{t.label}</text>
          </g>
        ) : (
          <g key={`M${i}`}>
            <line x1={0} y1={t.screen} x2={11} y2={t.screen} stroke={muted} strokeWidth={1} />
            <text x={14} y={t.screen + 7} fontSize={9} fill={muted}
                  fontFamily="ui-monospace, Menlo, monospace">{t.label}</text>
          </g>
        ))}
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
            const disabled =
              !hasActiveLayer && t.id !== 'none' ||
              (disabledAffine &&
                (t.id === 'move' || t.id === 'scale' || t.id === 'rotate' || t.id === 'skew'));
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
  docWidth: number;
  docHeight: number;
  onDocSizeChange: (w: number, h: number) => void;
  dpi: number;
  onDpiChange: (dpi: number) => void;
}

// Menu-bar style group label
function MenuGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        color: themeColor('text-dim'),
        padding: '0 4px',
        userSelect: 'none',
      }}
    >
      {children}
    </span>
  );
}

function Toolbar({
  onNewDoc, onOpenOra, onSaveOra, onExportPng, onImportPng,
  onUndo, onRedo, canUndo, canRedo,
  paramMode, onToggleParamMode,
  docWidth, docHeight, onDocSizeChange, dpi, onDpiChange,
}: ToolbarProps) {
  const [editingSize, setEditingSize] = useState(false);
  const [w, setW] = useState(docWidth);
  const [h, setH] = useState(docHeight);

  useEffect(() => { setW(docWidth); setH(docHeight); }, [docWidth, docHeight]);

  return (
    <div
      style={{
        ...styles.menubar,
        padding: '0 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        height: 36,
        flexShrink: 0,
      }}
      className="gt-noselect"
    >
      <strong style={{ fontSize: 13, padding: '0 6px' }}>GenToniK</strong>
      <span style={{ ...styles.textDim, fontSize: 10 }}>v3</span>

      <div style={{ width: 1, height: 18, background: themeColor('border'), margin: '0 4px' }} />

      <MenuGroupLabel>File</MenuGroupLabel>
      <button onClick={onNewDoc}     style={{ ...styles.button, padding: '3px 8px', fontSize: 11 }}>New</button>
      <button onClick={onOpenOra}    style={{ ...styles.button, padding: '3px 8px', fontSize: 11 }} title="Open .ora">Open</button>
      <button onClick={onSaveOra}    style={{ ...styles.button, padding: '3px 8px', fontSize: 11 }} title="Save .ora">Save</button>
      <button onClick={onImportPng}  style={{ ...styles.button, padding: '3px 8px', fontSize: 11 }}>Import</button>
      <button onClick={onExportPng}  style={{ ...styles.button, padding: '3px 8px', fontSize: 11 }}>Export</button>

      <div style={{ width: 1, height: 18, background: themeColor('border'), margin: '0 4px' }} />

      <MenuGroupLabel>Edit</MenuGroupLabel>
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        style={{ ...styles.button, padding: '3px 8px', fontSize: 11, opacity: canUndo ? 1 : 0.4 }}
      >↶ Undo</button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo (Ctrl+Shift+Z)"
        style={{ ...styles.button, padding: '3px 8px', fontSize: 11, opacity: canRedo ? 1 : 0.4 }}
      >↷ Redo</button>

      <div style={{ width: 1, height: 18, background: themeColor('border'), margin: '0 4px' }} />

      <MenuGroupLabel>Image</MenuGroupLabel>
      {editingSize ? (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="number" value={w} onChange={e => setW(parseInt(e.target.value) || 0)} style={{ ...styles.input, width: 56, padding: '2px 4px', fontSize: 11 }} />
          <span style={{ ...styles.textDim }}>×</span>
          <input type="number" value={h} onChange={e => setH(parseInt(e.target.value) || 0)} style={{ ...styles.input, width: 56, padding: '2px 4px', fontSize: 11 }} />
          <button onClick={() => { if (w > 0 && h > 0) onDocSizeChange(w, h); setEditingSize(false); }} style={{ ...styles.button, padding: '2px 6px', fontSize: 11 }}>✓</button>
          <button onClick={() => { setW(docWidth); setH(docHeight); setEditingSize(false); }} style={{ ...styles.button, padding: '2px 6px', fontSize: 11 }}>✕</button>
        </div>
      ) : (
        <button onClick={() => setEditingSize(true)} style={{ ...styles.button, padding: '3px 8px', fontSize: 11 }} title="Click to edit document size">
          {docWidth}×{docHeight}
        </button>
      )}
      <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span style={{ fontSize: 10, ...styles.textMuted }}>DPI</span>
        <input
          type="number"
          value={dpi}
          onChange={e => onDpiChange(Math.max(1, parseInt(e.target.value) || 72))}
          min={1}
          style={{ ...styles.input, width: 46, padding: '2px 4px', fontSize: 11 }}
        />
      </label>

      <div style={{ flex: 1 }} />

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

  // ── NEW (v2.2): Transform tool (controlled by App, shared with overlay) ──
  const [activeTool, setActiveTool] = useState<ToolId>('move');

  // ── NEW (v2.0): Debug panel state (toggle via Ctrl+`) ──
  const [debugOpen, setDebugOpen] = useState(false);

  // ── NEW (v2.3): Rulers around the canvas (Ctrl+R to toggle) ──
  const [showRulers, setShowRulers] = useState(true);

  // ── NEW (v2.3): Right-click popup palette (Krita-style) ──
  // Null = hidden; otherwise {x, y} = clientX/clientY where it appeared.
  const [popupPalette, setPopupPalette] = useState<{ x: number; y: number } | null>(null);

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

  // ── Derived ────────────────────────────────────────────
  const imageCache = useImageCache(layers);
  const selectedLayer = layers.find(l => l.id === selectedLayerId) ?? null;

  const compositeCtx: CompositeContext = useMemo(() => ({
    docWidth: docSize.w,
    docHeight: docSize.h,
    imageCache,
    dpi,
  }), [docSize, imageCache, dpi]);

  // ── Canvas composite ───────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== docSize.w) canvas.width = docSize.w;
      if (canvas.height !== docSize.h) canvas.height = docSize.h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, docSize.w, docSize.h);
      debug.time('composite');
      compositeLayers(ctx, layers, compositeCtx);
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
  const pushHistory = useCallback((label: string, coalesce = false) => {
    const hm = historyRef.current;
    if (!hm) return;
    hm.push(
      makeSnapshot(layers, { width: docSize.w, height: docSize.h }, selectedLayerId, label),
      { coalesce },
    );
    forceRender(n => n + 1);
  }, [layers, docSize, selectedLayerId]);

  const handleUndo = useCallback(() => {
    const snap = historyRef.current?.undo();
    if (!snap) return;
    setLayers(snap.layers.slice() as Layer[]);
    setDocSize({ w: snap.docSize.width, h: snap.docSize.height });
    setSelectedLayerId(snap.activeLayerId);
    forceRender(n => n + 1);
    debug.info('history', `Undo: ${snap.label}`);
  }, []);

  const handleRedo = useCallback(() => {
    const snap = historyRef.current?.redo();
    if (!snap) return;
    setLayers(snap.layers.slice() as Layer[]);
    setDocSize({ w: snap.docSize.width, h: snap.docSize.height });
    setSelectedLayerId(snap.activeLayerId);
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

      // Escape always closes the popup palette first
      if (e.key === 'Escape') {
        if (popupPalette) {
          e.preventDefault();
          setPopupPalette(null);
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

      // No-modifier tool hotkeys
      const TOOL_KEYS: Record<string, ToolId> = {
        v: 'move', s: 'scale', r: 'rotate', k: 'skew', f: 'perspective',
        m: 'rect', e: 'ellipse', l: 'lasso', p: 'polygonal', c: 'none',
      };
      const tool = TOOL_KEYS[k];
      if (tool) {
        e.preventDefault();
        setActiveTool(tool);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, popupPalette]);

  const handleAddScreentone = useCallback(() => {
    pushHistory('Add Screentone');
    const newLayer = createScreentoneLayer(`Screentone ${layers.filter(l => l.type === 'screentone').length + 1}`, DEFAULT_PARAMS);
    setLayers(prev => [...prev, newLayer]);
    setSelectedLayerId(newLayer.id);
    debug.info('ui', 'Added screentone layer', { name: newLayer.name });
  }, [layers, pushHistory]);

  const handleAddSolid = useCallback(() => {
    pushHistory('Add Solid');
    const newLayer = createSolidLayer(`Solid ${layers.filter(l => l.type === 'solid').length + 1}`, '#ffffff');
    setLayers(prev => [...prev, newLayer]);
    setSelectedLayerId(newLayer.id);
    debug.info('ui', 'Added solid layer', { name: newLayer.name });
  }, [layers, pushHistory]);

  const handleAddImage = useCallback((file: File) => {
    pushHistory('Add Image');
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const newLayer = createImageLayer(file.name.replace(/\.[^.]+$/, ''), src);
      setLayers(prev => [...prev, newLayer]);
      setSelectedLayerId(newLayer.id);
      debug.info('ui', 'Added image layer', { name: newLayer.name, size: file.size });
    };
    reader.readAsDataURL(file);
  }, [pushHistory]);

  const handleDelete = useCallback((id: string) => {
    pushHistory('Delete Layer');
    setLayers(prev => prev.filter(l => l.id !== id));
    if (selectedLayerId === id) setSelectedLayerId(null);
    debug.info('ui', 'Deleted layer', { id });
  }, [selectedLayerId, pushHistory]);

  const handleDuplicate = useCallback((id: string) => {
    pushHistory('Duplicate Layer');
    setLayers(prev => {
      const idx = prev.findIndex(l => l.id === id);
      if (idx < 0) return prev;
      const source = prev[idx];
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
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      setSelectedLayerId(copy.id);
      return next;
    });
  }, [pushHistory]);

  const handleMoveUp = useCallback((id: string) => {
    pushHistory('Reorder Layers');
    setLayers(prev => {
      const idx = prev.findIndex(l => l.id === id);
      if (idx < 0 || idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }, [pushHistory]);

  const handleMoveDown = useCallback((id: string) => {
    pushHistory('Reorder Layers');
    setLayers(prev => {
      const idx = prev.findIndex(l => l.id === id);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
      return next;
    });
  }, [pushHistory]);

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
    pushHistory('Apply Preset');
    // If a screentone layer is selected, replace its params.
    // Otherwise, create a new screentone layer with the preset params.
    if (selectedLayer?.type === 'screentone') {
      updateLayer(selectedLayer.id, { params: { ...preset.params } });
    } else {
      const newLayer = createScreentoneLayer(preset.name, preset.params);
      setLayers(prev => [...prev, newLayer]);
      setSelectedLayerId(newLayer.id);
    }
    debug.info('preset', `Applied preset: ${preset.name}`);
  }, [selectedLayer, updateLayer, pushHistory]);

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
    return {
      x: (clientX - rect.left - panX) / zoom,
      y: (clientY - rect.top - panY) / zoom,
    };
  }, [panX, panY, zoom]);

  // Natural rendered size of the active layer's content (px)
  const activeLayerNaturalSize = useMemo<{ w: number; h: number }>(() => {
    if (!selectedLayer) return { w: 0, h: 0 };
    if (selectedLayer.type === 'screentone') return docSize;
    if (selectedLayer.type === 'image') {
      const sz = imageCache.sizes.get(selectedLayer.imageSrc ?? '');
      return sz ?? { w: 0, h: 0 };
    }
    if (selectedLayer.type === 'solid') return docSize;
    return { w: 0, h: 0 };
  }, [selectedLayer, docSize, imageCache]);

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
  const handleNewDoc = useCallback(() => {
    if (layers.length > 0 && !confirm('Start a new document? Current layers will be lost (save first if needed).')) return;
    const bg = createSolidLayer('Background', '#ffffff');
    const tone = createScreentoneLayer('Screentone 1', DEFAULT_PARAMS);
    setLayers([bg, tone]);
    setSelectedLayerId(tone.id);
    setDocSize(DEFAULT_DOC_SIZE);
    setZoom(0.25);
    setPanX(0);
    setPanY(0);
  }, [layers.length]);

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
        setLayers(result.layers);
        setDocSize({ w: result.docWidth, h: result.docHeight });
        setSelectedLayerId(result.layers.find(l => l.type === 'screentone')?.id ?? result.layers[0]?.id ?? null);
        debug.info('ora', `Opened .ora: ${result.layers.length} layers, ${result.docWidth}x${result.docHeight}`);
        if (result.warnings.length > 0) {
          debug.warn('ora', `${result.warnings.length} warnings on import`, result.warnings);
        }
        if (result.downgradedLayers > 0) {
          debug.info('ora', `${result.downgradedLayers} layer(s) imported as image (no GenToniK metadata).`);
        }
        // Fit view to new doc
        setTimeout(() => handleFitView(result.docWidth, result.docHeight), 0);
      } catch (err) {
        debug.error('ora', 'Open failed', err);
        alert(`Failed to open .ora: ${(err as Error).message}`);
      }
    };
    input.click();
  }, []);

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
      pushHistory('Import PNG');
      const newLayer = createImageLayer(result.baseName, result.imageSrc);
      setLayers(prev => [...prev, newLayer]);
      setSelectedLayerId(newLayer.id);
      debug.info('bridge', `Imported PNG: ${result.baseName} (${result.width}x${result.height})`);
    } catch (err) {
      debug.error('bridge', 'Import failed', err);
      alert(`Import failed: ${(err as Error).message}`);
    }
  }, [pushHistory]);

  // ── View operations ────────────────────────────────────
  // (containerRef declared above, near canvasRef — needed by screenToCanvas)

  const handleFitView = useCallback((w?: number, h?: number) => {
    const docW = w ?? docSize.w;
    const docH = h ?? docSize.h;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const padding = 32;
    const z = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, Math.min((rect.width - padding * 2) / docW, (rect.height - padding * 2) / docH))
    );
    setZoom(z);
    setPanX((rect.width - docW * z) / 2);
    setPanY((rect.height - docH * z) / 2);
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
        docWidth={docSize.w}
        docHeight={docSize.h}
        onDocSizeChange={(w, h) => setDocSize({ w, h })}
        dpi={dpi}
        onDpiChange={setDpi}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left: Toolbox (vertical, 52px) — Photoshop/Krita style */}
        <Toolbox
          activeTool={activeTool}
          onToolChange={setActiveTool}
          disabledAffine={!!selectedLayer?.transform.corners}
          hasActiveLayer={!!selectedLayer}
        />

        {/* Left-mid: Layers + Presets (collapsed-friendly) */}
        <aside
          style={{
            ...styles.sidebar,
            width: 260,
            minWidth: 220,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Layer panel — fixed height ~40% */}
          <div style={{ height: '40%', borderBottom: `1px solid ${themeColor('border')}`, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '6px 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, ...styles.textMuted, borderBottom: `1px solid ${themeColor('border')}` }}>
              Layers
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
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
                onAddSolid={handleAddSolid}
                onAddImage={handleAddImage}
                onChangeBlend={handleChangeBlend}
                onChangeOpacity={handleChangeOpacity}
                onEditMask={handleOpenMaskEditor}
              />
            </div>
          </div>

          {/* Preset browser — fills the rest */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '6px 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, ...styles.textMuted, borderBottom: `1px solid ${themeColor('border')}` }}>
              Presets
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <PresetBrowser
                onApply={handleApplyPreset}
                onSaveCurrent={handleSavePreset}
                onEdit={handleEditPreset}
                onExport={handleExportPresets}
                onImport={handleImportPresets}
                refreshKey={presetRefreshKey}
              />
            </div>
          </div>
        </aside>

        {/* Center: canvas with rulers (Ctrl+R to toggle, or right-click → Rulers) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {showRulers && (
            <div style={{ display: 'flex', height: 20, flexShrink: 0, background: themeColor('topbar-bg') }}>
              {/* Corner square where the two rulers meet */}
              <div style={{ width: 20, flexShrink: 0, borderRight: `1px solid ${themeColor('border')}`, borderBottom: `1px solid ${themeColor('border')}` }} />
              <Ruler orientation="horizontal" pan={panX} zoom={zoom} docExtent={docSize.w} />
            </div>
          )}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {showRulers && (
              <div style={{ width: 20, flexShrink: 0, background: themeColor('topbar-bg') }}>
                <div style={{ height: '100%' }}>
                  <Ruler orientation="vertical" pan={panY} zoom={zoom} docExtent={docSize.h} />
                </div>
              </div>
            )}
            <main
              ref={containerRef}
              onContextMenu={(e) => {
                e.preventDefault();
                setPopupPalette({ x: e.clientX, y: e.clientY });
              }}
              style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}
            >
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
              />
              {/* Transform/Selection overlay — drag handles, perspective, marquee.
                  v3: floating toolbar & status panel REMOVED from the overlay;
                  tools now live in the left Toolbox, props in the right Properties
                  panel, and context hints in the bottom Status Bar. */}
              {selectedLayer && (
                <TransformPanelOverlay
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
                  tool={activeTool}
                  onToolChange={setActiveTool}
                />
              )}

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
                  onToolChange={setActiveTool}
                  onFitView={() => handleFitView()}
                  onZoom100={() => setZoom(1)}
                  onToggleRulers={() => setShowRulers(s => !s)}
                  onClose={() => setPopupPalette(null)}
                />
              )}
            </main>
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

              {/* ── Screentone / Solid / Image params (collapsible) ── */}
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
                ) : (
                  <div style={{ padding: 8, fontSize: 12, ...styles.textDim }}>
                    Image layer — transform controls only.
                  </div>
                )}
              </CollapsibleSection>

              {/* ── Transform (collapsible, always shown for active layer) ── */}
              <CollapsibleSection title="Transform" defaultOpen>
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
