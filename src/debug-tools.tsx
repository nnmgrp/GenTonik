// ============================================================
// debug-tools.tsx — Structured runtime diagnostics for GenToniK
// ============================================================
//
// WHY:
//   The codebase had scattered console.warn / throw new Error / silent
//   try-catch (Safari filter fallback in composite.ts). When something
//   breaks in the multi-layer composite pipeline or PS-bridge round-trip,
//   the user has no way to see WHAT failed and WHERE. This module gives
//   us one structured log surface with:
//
//     • Categorized entries (render / composite / mask / ora / preset /
//       history / bridge / error / warn / info)
//     • Global error handlers (window.onerror, unhandledrejection)
//     • Performance timers (time/timeEnd — like console.time but captured)
//     • Canvas snapshots (visual debugging — store a thumbnail data URL)
//     • Bridge tracer (step-by-step PS round-trip logging)
//     • Ring buffer (max 500 entries) + localStorage persistence (last 100)
//     • React <DebugPanel> overlay with filters / export / clear
//     • window.__gentonikDebug console access for power users
//
// DESIGN:
//   • Framework-agnostic core (DebugLogger class) + thin React UI on top.
//   • Singleton — one logger per page. Import `debug` from anywhere.
//   • Safe in production: never throws, never blocks the main thread.
//     localStorage writes are debounced 500ms. Canvas dumps are throttled
//     (max 1 per 100ms per label).
//   • All entries are immutable; UI gets a fresh array on each notify.
//
// USAGE:
//   import { debug } from './debug-tools';
//   debug.info('ora', 'Loading file', { name: file.name });
//   debug.error('composite', 'Failed to apply mask', err);
//   debug.time('composite.render');
//   ... render ...
//   debug.timeEnd('composite.render');
//   debug.dumpCanvas(canvas, 'after-mask');
//   debug.bridge('send', { width, height });
//
//   // React:
//   import { DebugPanel } from './debug-tools';
//   <DebugPanel />  // mounts overlay; toggle with Ctrl+`
// ============================================================

import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type DebugCategory =
  | 'render'
  | 'composite'
  | 'mask'
  | 'ora'
  | 'preset'
  | 'history'
  | 'bridge'
  | 'engine'
  | 'ui'
  | 'system'
  | 'bake'    // v2.9.1: Bake Transform
  | 'doc'     // v2.9.1: Document-level operations (color profile conversion etc.)
  | 'export'; // v2.16: Image export (PNG/JPG/TIFF/AVIF, tiled rendering)

export type DebugLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface DebugEntry {
  /** Unique monotonic ID. */
  id: number;
  /** Epoch milliseconds. */
  timestamp: number;
  category: DebugCategory;
  level: DebugLevel;
  /** Human-readable message. */
  message: string;
  /** Optional structured data (JSON-serializable). */
  data?: unknown;
  /** Optional stack trace (for errors). */
  stack?: string;
  /** Optional thumbnail data URL (for canvas dumps). */
  thumbnail?: string;
  /** Optional duration in ms (for timeEnd entries). */
  durationMs?: number;
}

export interface DebugSnapshot {
  entries: DebugEntry[];
  /** Total entries ever recorded (may exceed entries.length due to ring buffer). */
  totalEver: number;
  /** Whether localStorage persistence is active. */
  persisted: boolean;
}

// ────────────────────────────────────────────────────────────
// DebugLogger — framework-agnostic core
// ────────────────────────────────────────────────────────────

const MAX_ENTRIES = 500;
const PERSIST_KEY = 'gentonik:debug-log:v1';
const PERSIST_COUNT = 100;
const PERSIST_DEBOUNCE_MS = 500;
const THUMBNAIL_MAX = 256;
const THUMBNAIL_THROTTLE_MS = 100;

const LEVEL_ORDER: Record<DebugLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export class DebugLogger {
  private entries: DebugEntry[] = [];
  private nextId = 1;
  private totalEver = 0;
  private readonly listeners = new Set<(snapshot: DebugSnapshot) => void>();
  private readonly timers = new Map<string, number>();
  private readonly lastDumpTime = new Map<string, number>();
  private globalHandlersInstalled = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistEnabled = true;

  constructor() {
    // Load persisted entries on construction (best-effort).
    this.loadFromStorage();
  }

  // ── Public API: logging ─────────────────────────────────

  error(category: DebugCategory, message: string, err?: unknown, data?: unknown): void {
    this.push({
      category,
      level: 'error',
      message,
      data: data ?? this.serializeError(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // Mirror to console for devtools users.
    // eslint-disable-next-line no-console
    console.error(`[${category}] ${message}`, err ?? '', data ?? '');
  }

  warn(category: DebugCategory, message: string, data?: unknown): void {
    this.push({ category, level: 'warn', message, data: this.safeSerialize(data) });
    // eslint-disable-next-line no-console
    console.warn(`[${category}] ${message}`, data ?? '');
  }

  info(category: DebugCategory, message: string, data?: unknown): void {
    this.push({ category, level: 'info', message, data: this.safeSerialize(data) });
  }

  debug(category: DebugCategory, message: string, data?: unknown): void {
    this.push({ category, level: 'debug', message, data: this.safeSerialize(data) });
  }

  trace(category: DebugCategory, message: string, data?: unknown): void {
    this.push({ category, level: 'trace', message, data: this.safeSerialize(data) });
  }

  // ── Public API: performance timers ─────────────────────

  time(label: string): void {
    this.timers.set(label, performance.now());
  }

  timeEnd(label: string, category: DebugCategory = 'render'): void {
    const start = this.timers.get(label);
    if (start === undefined) {
      this.warn('system', `timeEnd called without matching time()`, { label });
      return;
    }
    this.timers.delete(label);
    const durationMs = performance.now() - start;
    this.push({
      category,
      level: 'debug',
      message: `${label}: ${durationMs.toFixed(2)}ms`,
      durationMs,
    });
  }

  // ── Public API: canvas dump ─────────────────────────────

  /**
   * Capture a thumbnail of a canvas and log it. Useful for visual debugging
   * of composite pipeline stages.
   *
   * Throttled: max 1 dump per `label` per 100ms. This prevents log spam
   * if called inside a render loop.
   */
  dumpCanvas(canvas: HTMLCanvasElement, label: string, category: DebugCategory = 'composite'): void {
    const now = performance.now();
    const last = this.lastDumpTime.get(label) ?? 0;
    if (now - last < THUMBNAIL_THROTTLE_MS) return;
    this.lastDumpTime.set(label, now);

    try {
      const thumb = makeThumbnail(canvas, THUMBNAIL_MAX);
      this.push({
        category,
        level: 'debug',
        message: `canvas: ${label} (${canvas.width}×${canvas.height})`,
        thumbnail: thumb,
        data: { width: canvas.width, height: canvas.height, label },
      });
    } catch (err) {
      this.warn('system', `Failed to dump canvas "${label}"`, this.serializeError(err));
    }
  }

  // ── Public API: PS-bridge tracing ──────────────────────

  /**
   * Log a Photoshop-bridge round-trip step.
   * `step` should be one of: 'send-start', 'send-end', 'receive-start',
   * 'receive-end', 'apply-start', 'apply-end', 'error'.
   */
  bridge(step: string, payload?: unknown): void {
    this.push({
      category: 'bridge',
      level: step === 'error' ? 'error' : 'info',
      message: `bridge: ${step}`,
      data: this.safeSerialize(payload),
    });
  }

  // ── Public API: subscription ────────────────────────────

  subscribe(listener: (snapshot: DebugSnapshot) => void): () => void {
    this.listeners.add(listener);
    // Immediately notify the new listener with the current state.
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Public API: queries ─────────────────────────────────

  getSnapshot(): DebugSnapshot {
    return {
      entries: this.entries.slice(),
      totalEver: this.totalEver,
      persisted: this.persistEnabled,
    };
  }

  getEntries(filter?: { category?: DebugCategory; level?: DebugLevel }): DebugEntry[] {
    if (!filter) return this.entries.slice();
    const minLevel = filter.level ? LEVEL_ORDER[filter.level] : Infinity;
    return this.entries.filter(e => {
      if (filter.category && e.category !== filter.category) return false;
      if (filter.level && LEVEL_ORDER[e.level] > minLevel) return false;
      return true;
    });
  }

  // ── Public API: bulk operations ─────────────────────────

  clear(): void {
    this.entries = [];
    this.totalEver = 0;
    this.timers.clear();
    this.lastDumpTime.clear();
    this.schedulePersist();
    this.notify();
  }

  /** Export all entries as a JSON string for bug reports. */
  exportJson(): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        totalEver: this.totalEver,
        entries: this.entries,
      },
      null,
      2,
    );
  }

  /** Disable localStorage persistence (e.g., for incognito mode). */
  disablePersistence(): void {
    this.persistEnabled = false;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  // ── Public API: global error handlers ───────────────────

  /**
   * Install window-level error and unhandledrejection handlers.
   * Safe to call multiple times — handlers are only installed once.
   */
  installGlobalHandlers(): void {
    if (this.globalHandlersInstalled || typeof window === 'undefined') return;
    this.globalHandlersInstalled = true;

    window.addEventListener('error', (event: ErrorEvent) => {
      this.error(
        'system',
        `Uncaught error: ${event.message}`,
        event.error ?? new Error(event.message),
        {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      );
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const err = reason instanceof Error ? reason : new Error(String(reason));
      this.error('system', `Unhandled promise rejection: ${err.message}`, err);
    });
  }

  // ── Internal ────────────────────────────────────────────

  private push(partial: Omit<DebugEntry, 'id' | 'timestamp'>): void {
    const entry: DebugEntry = {
      ...partial,
      id: this.nextId++,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.totalEver++;
    // Trim ring buffer.
    while (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    this.schedulePersist();
    this.notify();
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        // Listener threw — log to console but don't break other listeners.
        // eslint-disable-next-line no-console
        console.error('[debug-tools] Listener threw:', err);
      }
    }
  }

  private safeSerialize(value: unknown): unknown {
    if (value === undefined || value === null) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (value instanceof Error) {
      return this.serializeError(value);
    }
    try {
      // Test JSON-serializability; if it throws, return a placeholder.
      JSON.stringify(value);
      return value;
    } catch {
      return `[unserializable: ${typeof value}]`;
    }
  }

  private serializeError(err: unknown): unknown {
    if (err === undefined) return undefined;
    if (err instanceof Error) {
      return {
        name: err.name,
        message: err.message,
        stack: err.stack,
        ...(err.cause ? { cause: this.serializeError(err.cause) } : {}),
      };
    }
    return String(err);
  }

  private schedulePersist(): void {
    if (!this.persistEnabled) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistToStorage();
    }, PERSIST_DEBOUNCE_MS);
  }

  private persistToStorage(): void {
    if (!this.persistEnabled) return;
    try {
      const toStore = this.entries.slice(-PERSIST_COUNT);
      const payload = JSON.stringify({
        entries: toStore,
        totalEver: this.totalEver,
        nextId: this.nextId,
      });
      localStorage.setItem(PERSIST_KEY, payload);
    } catch {
      // localStorage full or disabled — silently disable persistence.
      this.persistEnabled = false;
    }
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        entries: DebugEntry[];
        totalEver: number;
        nextId: number;
      };
      if (Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.slice(-MAX_ENTRIES);
        this.totalEver = parsed.totalEver ?? this.entries.length;
        this.nextId = parsed.nextId ?? this.entries.length + 1;
      }
    } catch {
      // Corrupt storage — ignore.
    }
  }
}

// ────────────────────────────────────────────────────────────
// Singleton + global access
// ────────────────────────────────────────────────────────────

export const debug = new DebugLogger();

// Install global handlers eagerly (safe in non-browser — guarded inside).
debug.installGlobalHandlers();

// Expose on window for console access. Usage in devtools:
//   __gentonikDebug.getSnapshot().entries.slice(-20)
//   __gentonikDebug.clear()
//   __gentonikDebug.exportJson()
declare global {
  interface Window {
    __gentonikDebug?: DebugLogger;
  }
}
if (typeof window !== 'undefined') {
  window.__gentonikDebug = debug;
}

// ────────────────────────────────────────────────────────────
// Thumbnail helper
// ────────────────────────────────────────────────────────────

function makeThumbnail(source: HTMLCanvasElement, maxDim: number): string {
  const sw = source.width;
  const sh = source.height;
  if (sw === 0 || sh === 0) return '';
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const tw = Math.max(1, Math.round(sw * scale));
  const th = Math.max(1, Math.round(sh * scale));

  const thumb = document.createElement('canvas');
  thumb.width = tw;
  thumb.height = th;
  const ctx = thumb.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, tw, th);
  return thumb.toDataURL('image/png');
}

// ────────────────────────────────────────────────────────────
// React hook
// ────────────────────────────────────────────────────────────

/**
 * Subscribe to debug log updates. Returns the current snapshot.
 * Re-renders on every log entry — fine for the debug panel, do not
 * use in hot paths.
 */
export function useDebugLog(): DebugSnapshot {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const snapshotRef = useRef<DebugSnapshot>(debug.getSnapshot());

  useEffect(() => {
    return debug.subscribe(snap => {
      snapshotRef.current = snap;
      force();
    });
  }, []);

  return snapshotRef.current;
}

// ────────────────────────────────────────────────────────────
// <DebugPanel> — toggleable overlay UI
// ────────────────────────────────────────────────────────────

export interface DebugPanelProps {
  /** Controlled open state. If undefined, panel manages its own state. */
  isOpen?: boolean;
  /** Called when the user closes the panel. */
  onClose?: () => void;
  /** Initial level filter. Default: 'info'. */
  initialLevel?: DebugLevel;
  /** Initial category filter. Default: undefined (all). */
  initialCategory?: DebugCategory;
}

export function DebugPanel({
  isOpen,
  onClose,
  initialLevel = 'info',
  initialCategory,
}: DebugPanelProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [levelFilter, setLevelFilter] = useState<DebugLevel>(initialLevel);
  const [categoryFilter, setCategoryFilter] = useState<DebugCategory | ''>(
    initialCategory ?? '',
  );
  const [showThumbnails, setShowThumbnails] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState<DebugEntry | null>(null);

  const open = isOpen ?? internalOpen;

  // Toggle with Ctrl+` (backtick).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setInternalOpen(o => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-scroll to bottom on new entries.
  const listRef = useRef<HTMLDivElement | null>(null);
  const snapshot = useDebugLog();
  useEffect(() => {
    if (listRef.current && open) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [snapshot.entries.length, open]);

  if (!open) return null;

  const minLevel = LEVEL_ORDER[levelFilter];
  const filtered = snapshot.entries.filter(e => {
    if (LEVEL_ORDER[e.level] > minLevel) return false;
    if (categoryFilter && e.category !== categoryFilter) return false;
    return true;
  });

  const handleClose = () => {
    if (onClose) onClose();
    else setInternalOpen(false);
  };

  const handleExport = () => {
    const json = debug.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gentonik-debug-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 480,
        maxWidth: '90vw',
        background: 'rgba(20, 20, 24, 0.97)',
        color: '#eee',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 12,
        zIndex: 99999,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.5)',
        backdropFilter: 'blur(8px)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'rgba(40, 40, 48, 0.9)',
        }}
      >
        <strong style={{ fontSize: 13 }}>GenToniK Debug</strong>
        <span style={{ color: '#888', fontSize: 11 }}>
          {filtered.length} / {snapshot.entries.length} entries · {snapshot.totalEver} total
        </span>
        <div style={{ flex: 1 }} />
        <button style={btnStyle} onClick={handleExport} title="Export as JSON">
          ↓ Export
        </button>
        <button
          style={btnStyle}
          onClick={() => debug.clear()}
          title="Clear all entries"
        >
          ✕ Clear
        </button>
        <button style={closeBtnStyle} onClick={handleClose} title="Close (Ctrl+`)">
          ✕
        </button>
      </div>

      {/* Filter bar */}
      <div
        style={{
          padding: '6px 12px',
          borderBottom: '1px solid #333',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
          background: 'rgba(30, 30, 36, 0.6)',
        }}
      >
        <label style={filterLabelStyle}>
          Level
          <select
            value={levelFilter}
            onChange={e => setLevelFilter(e.target.value as DebugLevel)}
            style={selectStyle}
          >
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
            <option value="debug">debug</option>
            <option value="trace">trace</option>
          </select>
        </label>
        <label style={filterLabelStyle}>
          Cat
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value as DebugCategory | '')}
            style={selectStyle}
          >
            <option value="">all</option>
            <option value="render">render</option>
            <option value="composite">composite</option>
            <option value="mask">mask</option>
            <option value="ora">ora</option>
            <option value="preset">preset</option>
            <option value="history">history</option>
            <option value="bridge">bridge</option>
            <option value="engine">engine</option>
            <option value="ui">ui</option>
            <option value="system">system</option>
          </select>
        </label>
        <label
          style={{
            ...filterLabelStyle,
            flexDirection: 'row',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={showThumbnails}
            onChange={e => setShowThumbnails(e.target.checked)}
          />
          thumbnails
        </label>
      </div>

      {/* Entry list */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 0,
        }}
      >
        {filtered.length === 0 && (
          <div style={{ padding: 16, color: '#666', fontStyle: 'italic' }}>
            No entries match the current filter.
          </div>
        )}
        {filtered.map(entry => (
          <DebugEntryRow
            key={entry.id}
            entry={entry}
            showThumbnail={showThumbnails}
            isSelected={selectedEntry?.id === entry.id}
            onSelect={() => setSelectedEntry(entry)}
          />
        ))}
      </div>

      {/* Detail pane */}
      {selectedEntry && (
        <div
          style={{
            borderTop: '1px solid #333',
            padding: 8,
            background: 'rgba(30, 30, 36, 0.95)',
            maxHeight: '40%',
            overflow: 'auto',
            fontSize: 11,
          }}
        >
          <div style={{ marginBottom: 4, color: '#888' }}>
            #{selectedEntry.id} · {new Date(selectedEntry.timestamp).toISOString()} ·{' '}
            {selectedEntry.category} · {selectedEntry.level}
          </div>
          <div style={{ color: '#fff', marginBottom: 6 }}>{selectedEntry.message}</div>
          {selectedEntry.durationMs !== undefined && (
            <div style={{ color: '#a8c7fa' }}>
              duration: {selectedEntry.durationMs.toFixed(2)}ms
            </div>
          )}
          {selectedEntry.data !== undefined && (
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: '#b0e0b0',
                maxHeight: 200,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(selectedEntry.data, null, 2)}
            </pre>
          )}
          {selectedEntry.stack && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', color: '#888' }}>Stack</summary>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: '#e0a0a0',
                  fontSize: 10,
                }}
              >
                {selectedEntry.stack}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// DebugEntryRow
// ────────────────────────────────────────────────────────────

interface DebugEntryRowProps {
  entry: DebugEntry;
  showThumbnail: boolean;
  isSelected: boolean;
  onSelect: () => void;
}

function DebugEntryRow({
  entry,
  showThumbnail,
  isSelected,
  onSelect,
}: DebugEntryRowProps) {
  const levelColor = LEVEL_COLORS[entry.level] ?? '#ccc';
  const categoryColor = CATEGORY_COLORS[entry.category] ?? '#888';

  return (
    <div
      onClick={onSelect}
      style={{
        padding: '4px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        cursor: 'pointer',
        background: isSelected ? 'rgba(80, 100, 160, 0.3)' : 'transparent',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
      }}
    >
      {showThumbnail && entry.thumbnail && (
        <img
          src={entry.thumbnail}
          alt=""
          style={{
            width: 48,
            height: 48,
            objectFit: 'contain',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: 2,
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span style={{ color: '#666', fontSize: 10 }}>
            {formatTime(entry.timestamp)}
          </span>
          <span
            style={{
              color: '#fff',
              fontWeight: 600,
              fontSize: 10,
              background: categoryColor,
              padding: '1px 4px',
              borderRadius: 2,
            }}
          >
            {entry.category}
          </span>
          <span style={{ color: levelColor, fontSize: 10, fontWeight: 600 }}>
            {entry.level}
          </span>
          {entry.durationMs !== undefined && (
            <span style={{ color: '#a8c7fa', fontSize: 10 }}>
              {entry.durationMs.toFixed(1)}ms
            </span>
          )}
        </div>
        <div
          style={{
            color: '#eee',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.message}
        </div>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// ────────────────────────────────────────────────────────────
// Inline styles
// ────────────────────────────────────────────────────────────

const btnStyle: CSSProperties = {
  padding: '3px 8px',
  border: '1px solid #444',
  borderRadius: 3,
  background: '#2a2a2e',
  color: '#ccc',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
};

const closeBtnStyle: CSSProperties = {
  ...btnStyle,
  background: '#a33',
  color: '#fff',
  border: 'none',
  fontWeight: 700,
};

const selectStyle: CSSProperties = {
  padding: '2px 4px',
  background: '#2a2a2e',
  color: '#eee',
  border: '1px solid #444',
  borderRadius: 3,
  fontSize: 11,
  fontFamily: 'inherit',
};

const filterLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 10,
  color: '#888',
};

const LEVEL_COLORS: Record<DebugLevel, string> = {
  error: '#ff6b6b',
  warn: '#ffd166',
  info: '#8dd0ff',
  debug: '#b0b0b0',
  trace: '#888',
};

const CATEGORY_COLORS: Record<DebugCategory, string> = {
  render: '#7b68ee',
  composite: '#ffa500',
  mask: '#ff69b4',
  ora: '#20b2aa',
  preset: '#9370db',
  history: '#6495ed',
  bridge: '#32cd32',
  engine: '#ff8c00',
  ui: '#b0b0b0',
  system: '#666',
  bake: '#ff6347',    // v2.9.1
  doc: '#4682b4',     // v2.9.1
  export: '#00ced1',  // v2.16 — dark turquoise
};

// ────────────────────────────────────────────────────────────
// Default export
// ────────────────────────────────────────────────────────────

export default debug;
