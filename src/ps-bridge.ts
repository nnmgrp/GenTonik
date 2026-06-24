// ============================================================
// ps-bridge.ts — Photoshop ↔ Standalone round-trip via PNG
// ============================================================
//
// ARCHITECTURE ("Gigapixel model")
// ────────────────────────────────────────────────────────────
// Photoshop and the Standalone app communicate by exchanging PNG
// files. The Standalone does all screentone creation / editing;
// Photoshop is used only to apply the result.
//
//   ┌───────────────┐   PNG (selection or doc)   ┌──────────────┐
//   │   Photoshop   │ ─────────────────────────▶ │  Standalone  │
//   │               │                            │              │
//   │   • export    │                            │  • new layer │
//   │     selection │                            │  • edit tone │
//   │     as PNG    │                            │  • composite │
//   │               │ ◀───────────────────────── │              │
//   │   • place PNG │   PNG (composite result)   │  • export    │
//   │   as new layer│                            │    canvas    │
//   └───────────────┘                            └──────────────┘
//
// Why PNG (not PSD/TIFF/UXP messaging):
//   • PSD parsing in browser is huge (psd.js ~500KB) and brittle.
//   • TIFF similarly complex, and Photoshop TIFF variants are messy.
//   • UXP cannot send arbitrary messages to a separate process; the
//     UXP→Standalone link would need a hidden file-poll anyway.
//   • PNG is universal, lossless, supports alpha, and is trivial to
//     encode/decode via canvas.
//
// METADATA
// ────────────────────────────────────────────────────────────
// To make the round-trip idempotent we attach metadata:
//   • In Tauri mode: a sidecar JSON file next to the PNG
//     (e.g. `image.png` + `image.gentonik.json`)
//   • In browser mode: metadata is returned from importPng() as
//     a separate object; caller (App.tsx) stores it on the layer.
//
// Metadata fields:
//   source:           'photoshop' | 'standalone'
//   docSize:          { width, height } in px (PS document size)
//   selectionBounds:  { left, top, right, bottom } | null
//   sourceLayerId:    string | null (for "update existing layer" flows)
//   exportedAt:       ISO timestamp
//   gentonikVersion:  string
//
// ENVIRONMENT DETECTION
// ────────────────────────────────────────────────────────────
// The bridge auto-detects Tauri vs browser:
//   • Tauri: uses @tauri-apps/api/dialog + @tauri-apps/api/fs for
//     native file pickers and direct file writes. Best UX.
//   • Browser: uses <input type=file> + URL.createObjectURL for
//     import, and download attribute / clipboard API for export.
//     Falls back gracefully; no native file watcher.
//
// All Tauri imports are DYNAMIC and wrapped in try/catch so the
// module loads fine in a pure browser build (e.g., dev mode without
// Tauri).
// ============================================================

import { debug } from './debug-tools';
import type { Layer } from './types';
import {
  compositeLayers,
  type CompositeContext,
  type ImageCache,
} from './composite';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type BridgeEnvironment = 'tauri' | 'browser';

export type BridgeSource = 'photoshop' | 'standalone' | 'unknown';

export interface BridgeSelectionBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BridgeMetadata {
  source: BridgeSource;
  docSize: { width: number; height: number };
  selectionBounds: BridgeSelectionBounds | null;
  sourceLayerId: string | null;
  exportedAt: string;
  gentonikVersion: string;
}

export interface BridgeImportResult {
  /** Object URL or data URL — suitable for `<img src>` or canvas drawImage. */
  imageSrc: string;
  /** Image dimensions in pixels. */
  width: number;
  height: number;
  /** Metadata parsed from sidecar (Tauri) or null (browser). */
  metadata: BridgeMetadata | null;
  /** The raw PNG bytes (for re-export without re-encoding). */
  blob: Blob;
  /** Original file name (without extension). */
  baseName: string;
}

export interface BridgeExportOptions {
  /** Suggested file name (without extension). Default: `gentonik-export-${timestamp}`. */
  fileName?: string;
  /** If true, also writes a sidecar JSON with metadata. Tauri only. */
  writeSidecar?: boolean;
  /** Metadata to embed in sidecar. Required if writeSidecar is true. */
  metadata?: Partial<BridgeMetadata>;
}

export interface BridgeExportResult {
  /** Path (Tauri) or empty string (browser download). */
  path: string;
  /** File name written. */
  fileName: string;
  /** Size in bytes. */
  bytes: number;
}

export type BridgeSessionState =
  | 'idle'
  | 'importing'
  | 'editing'
  | 'exporting'
  | 'done'
  | 'error';

export interface BridgeSessionSnapshot {
  state: BridgeSessionState;
  lastImport: BridgeImportResult | null;
  lastExport: BridgeExportResult | null;
  lastError: string | null;
  /** Monotonic counter — increments on every state transition. */
  revision: number;
}

// ────────────────────────────────────────────────────────────
// Environment detection
// ────────────────────────────────────────────────────────────

let cachedEnv: BridgeEnvironment | null = null;

/**
 * Detect whether we're running inside Tauri or a plain browser.
 * Uses the `window.__TAURI__` global that Tauri injects.
 */
export function detectEnvironment(): BridgeEnvironment {
  if (cachedEnv) return cachedEnv;
  const w = typeof window !== 'undefined' ? (window as unknown as { __TAURI__?: unknown }) : undefined;
  cachedEnv = w && typeof w.__TAURI__ !== 'undefined' ? 'tauri' : 'browser';
  debug.debug('bridge', `Environment detected: ${cachedEnv}`);
  return cachedEnv;
}

// ────────────────────────────────────────────────────────────
// Use new Function to bypass Vite's static analysis of the dynamic import
const _dynamicImport = new Function('m', 'return import(m)');

export interface TauriDialogApi {
  open(options?: any): Promise<string | string[] | null>;
  save(options?: any): Promise<string | null>;
}

export interface TauriFsApi {
  readBinaryFile(path: string): Promise<Uint8Array | number[]>;
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, contents: any): Promise<void>;
  writeTextFile(path: string, contents: string): Promise<void>;
}

/**
 * Dynamically import @tauri-apps/api/dialog. Returns null if not
 * available (browser mode or Tauri not installed).
 */
async function loadTauriDialog(): Promise<TauriDialogApi | null> {
  if (detectEnvironment() !== 'tauri') return null;
  try {
    return await _dynamicImport('@tauri-apps/api/dialog');
  } catch (err) {
    debug.warn('bridge', 'Tauri dialog API unavailable, falling back to browser', err);
    return null;
  }
}

async function loadTauriFs(): Promise<TauriFsApi | null> {
  if (detectEnvironment() !== 'tauri') return null;
  try {
    return await _dynamicImport('@tauri-apps/api/fs');
  } catch (err) {
    debug.warn('bridge', 'Tauri fs API unavailable, falling back to browser', err);
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Metadata helpers
// ────────────────────────────────────────────────────────────

export const GENTONIK_VERSION = '2.0.0-bridge';

/** Build a default metadata object for an export from Standalone. */
export function buildExportMetadata(
  docSize: { width: number; height: number },
  selectionBounds: BridgeSelectionBounds | null = null,
  sourceLayerId: string | null = null,
): BridgeMetadata {
  return {
    source: 'standalone',
    docSize,
    selectionBounds,
    sourceLayerId,
    exportedAt: new Date().toISOString(),
    gentonikVersion: GENTONIK_VERSION,
  };
}

/** Parse a sidecar JSON string into BridgeMetadata, or null on failure. */
export function parseSidecarMetadata(json: string): BridgeMetadata | null {
  try {
    const obj = JSON.parse(json) as Partial<BridgeMetadata>;
    if (!obj || typeof obj !== 'object') return null;
    return {
      source: obj.source ?? 'unknown',
      docSize: obj.docSize ?? { width: 0, height: 0 },
      selectionBounds: obj.selectionBounds ?? null,
      sourceLayerId: obj.sourceLayerId ?? null,
      exportedAt: obj.exportedAt ?? new Date().toISOString(),
      gentonikVersion: obj.gentonikVersion ?? 'unknown',
    };
  } catch (err) {
    debug.warn('bridge', 'Failed to parse sidecar metadata', err);
    return null;
  }
}

/** Serialize metadata to a pretty-printed JSON string. */
export function serializeSidecarMetadata(meta: BridgeMetadata): string {
  return JSON.stringify(meta, null, 2);
}

// ────────────────────────────────────────────────────────────
// PNG image dimension probing
// ────────────────────────────────────────────────────────────

/**
 * Read PNG dimensions from the first 24 bytes of the file without
 * decoding the whole image. PNG header is 8 bytes signature + 4 bytes
 * length + 4 bytes "IHDR" + 4 bytes width + 4 bytes height (big-endian).
 *
 * Returns null if the bytes are not a valid PNG.
 */
export function probePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG signature: 137 80 78 71 13 10 26 10
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) return null;
  }
  // Width is at bytes 16-19 (big-endian uint32), height 20-23.
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

// ────────────────────────────────────────────────────────────
// Canvas → PNG blob
// ────────────────────────────────────────────────────────────

/**
 * Encode a canvas as a PNG Blob. Returns a Promise that resolves
 * with the blob, or rejects on encode failure.
 *
 * Uses canvas.toBlob (async, off-main-thread in some browsers).
 * Falls back to toDataURL if toBlob is unavailable.
 */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        blob => {
          if (blob) resolve(blob);
          else reject(new Error('canvas.toBlob returned null'));
        },
        'image/png',
      );
    } else {
      // Legacy fallback (older Safari).
      try {
        const dataUrl = canvas.toDataURL('image/png');
        const bytes = base64ToBytes(dataUrl.split(',')[1] ?? '');
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (err) {
        reject(err);
      }
    }
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ────────────────────────────────────────────────────────────
// PNG blob → image source (object URL or data URL)
// ────────────────────────────────────────────────────────────

/**
 * Convert a PNG Blob into a string URL usable as `<img src>` or
 * `canvas.drawImage` source. Uses URL.createObjectURL when available
 * (more efficient for large images); falls back to data URL.
 */
export function blobToImageSrc(blob: Blob): string {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(blob);
  }
  // Fallback: data URL (synchronous via FileReader would be better but
  // this is a sync utility — caller can use blobToImageSrcAsync instead).
  return '';
}

/**
 * Async version that always works (uses FileReader for data URL fallback).
 */
export function blobToImageSrcAsync(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      resolve(URL.createObjectURL(blob));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Revoke an object URL previously created by blobToImageSrc. Safe to
 * call with any string — no-op for data URLs or invalid URLs.
 */
export function revokeImageSrc(src: string): void {
  if (src.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(src);
    } catch {
      // Ignore — already revoked or invalid.
    }
  }
}

// ────────────────────────────────────────────────────────────
// PngBridge — import/export operations
// ────────────────────────────────────────────────────────────

/**
 * Main PNG bridge. Methods are framework-agnostic; UI integration
 * lives in App.tsx.
 */
export class PngBridge {
  /**
   * Open a file picker (Tauri native or browser <input type=file>)
   * and import the selected PNG.
   *
   * In Tauri mode, also looks for a sidecar `*.gentonik.json` next to
   * the PNG and parses it.
   *
   * Returns null if the user cancels.
   */
  async importFromPicker(): Promise<BridgeImportResult | null> {
    debug.bridge('import-start');
    try {
      if (detectEnvironment() === 'tauri') {
        const result = await this.importViaTauriDialog();
        debug.bridge('import-end', result ? { name: result.baseName, bytes: result.blob.size } : { canceled: true });
        return result;
      }
      const result = await this.importViaBrowserPicker();
      debug.bridge('import-end', result ? { name: result.baseName, bytes: result.blob.size } : { canceled: true });
      return result;
    } catch (err) {
      debug.error('bridge', 'Import failed', err);
      throw err;
    }
  }

  /**
   * Import a PNG from a File or Blob (e.g., from a drag-drop event).
   * Use this instead of importFromPicker when you already have the
   * bytes (e.g., the user dropped a file onto the canvas).
   */
  async importFromFile(file: File | Blob, fileName = 'image.png'): Promise<BridgeImportResult> {
    debug.bridge('import-start', { name: fileName, size: file.size });
    const blob = file instanceof Blob ? file : new Blob([file], { type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dims = probePngDimensions(bytes);
    if (!dims) {
      const err = new Error(`Not a valid PNG file: ${fileName}`);
      debug.error('bridge', 'Import failed — not a PNG', err);
      throw err;
    }
    const imageSrc = await blobToImageSrcAsync(blob);
    const baseName = fileName.replace(/\.png$/i, '');
    const result: BridgeImportResult = {
      imageSrc,
      width: dims.width,
      height: dims.height,
      metadata: null, // No sidecar from drag-drop; caller can attach later.
      blob,
      baseName,
    };
    debug.bridge('import-end', { name: baseName, bytes: blob.size });
    return result;
  }

  /**
   * Export a canvas as a PNG file. In Tauri mode, opens a native save
   * dialog and writes the file (plus optional sidecar JSON). In browser
   * mode, triggers a download.
   */
  async exportToFile(
    canvas: HTMLCanvasElement,
    options: BridgeExportOptions = {},
  ): Promise<BridgeExportResult> {
    debug.bridge('export-start', options);
    const blob = await canvasToPngBlob(canvas);
    const fileName = (options.fileName ?? `gentonik-export-${Date.now()}`).replace(/\.png$/i, '') + '.png';

    try {
      if (detectEnvironment() === 'tauri') {
        const result = await this.exportViaTauri(blob, fileName, options);
        debug.bridge('export-end', result);
        return result;
      }
      const result = this.exportViaBrowserDownload(blob, fileName);
      debug.bridge('export-end', result);
      return result;
    } catch (err) {
      debug.error('bridge', 'Export failed', err);
      throw err;
    }
  }

  /**
   * Copy a canvas PNG to the clipboard. Returns true on success.
   * Works in browsers with the Clipboard API (HTTPS or localhost only).
   */
  async exportToClipboard(canvas: HTMLCanvasElement): Promise<boolean> {
    debug.bridge('clipboard-start');
    try {
      const blob = await canvasToPngBlob(canvas);
      if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
        debug.warn('bridge', 'Clipboard API unavailable');
        return false;
      }
      const item = new ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([item]);
      debug.bridge('clipboard-end', { bytes: blob.size });
      return true;
    } catch (err) {
      debug.error('bridge', 'Clipboard write failed', err);
      return false;
    }
  }

  // ── Tauri-specific implementations ─────────────────────

  private async importViaTauriDialog(): Promise<BridgeImportResult | null> {
    const dialog = await loadTauriDialog();
    const fs = await loadTauriFs();
    if (!dialog || !fs) {
      // Tauri APIs not actually available — fall through to browser.
      return this.importViaBrowserPicker();
    }

    const selected = await dialog.open({
      multiple: false,
      filters: [{ name: 'PNG images', extensions: ['png'] }],
    });
    if (!selected || Array.isArray(selected)) return null;
    const pngPath = selected as string;

    const bytes = await fs.readBinaryFile(pngPath);
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    const uint8 = new Uint8Array(bytes);
    const dims = probePngDimensions(uint8);
    if (!dims) throw new Error(`Not a valid PNG: ${pngPath}`);

    // Look for sidecar: same name with .gentonik.json extension.
    let metadata: BridgeMetadata | null = null;
    const sidecarPath = pngPath.replace(/\.png$/i, '.gentonik.json');
    try {
      const sidecarText = await fs.readTextFile(sidecarPath);
      metadata = parseSidecarMetadata(sidecarText);
    } catch {
      // No sidecar — that's fine, metadata stays null.
    }

    const imageSrc = await blobToImageSrcAsync(blob);
    const baseName = pngPath.split(/[\\/]/).pop()?.replace(/\.png$/i, '') ?? 'image';

    return {
      imageSrc,
      width: dims.width,
      height: dims.height,
      metadata,
      blob,
      baseName,
    };
  }

  private async exportViaTauri(
    blob: Blob,
    fileName: string,
    options: BridgeExportOptions,
  ): Promise<BridgeExportResult> {
    const dialog = await loadTauriDialog();
    const fs = await loadTauriFs();
    if (!dialog || !fs) {
      return this.exportViaBrowserDownload(blob, fileName);
    }

    const savePath = await dialog.save({
      defaultPath: fileName,
      filters: [{ name: 'PNG images', extensions: ['png'] }],
    });
    if (!savePath) {
      // User canceled — return a synthetic "no-op" result.
      return { path: '', fileName, bytes: 0 };
    }

    const finalPath = savePath.toLowerCase().endsWith('.png') ? savePath : `${savePath}.png`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await fs.writeFile(finalPath, Array.from(bytes));

    // Write sidecar if requested.
    if (options.writeSidecar && options.metadata) {
      const meta: BridgeMetadata = {
        ...buildExportMetadata({ width: 0, height: 0 }),
        ...options.metadata,
      };
      const sidecarPath = finalPath.replace(/\.png$/i, '.gentonik.json');
      await fs.writeTextFile(sidecarPath, serializeSidecarMetadata(meta));
    }

    return {
      path: finalPath,
      fileName: finalPath.split(/[\\/]/).pop() ?? fileName,
      bytes: blob.size,
    };
  }

  // ── Browser-specific implementations ───────────────────

  private importViaBrowserPicker(): Promise<BridgeImportResult | null> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png';
      input.style.display = 'none';
      document.body.appendChild(input);

      input.onchange = async () => {
        const file = input.files?.[0];
        document.body.removeChild(input);
        if (!file) {
          resolve(null);
          return;
        }
        try {
          const result = await this.importFromFile(file, file.name);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };

      // If the user cancels, the change event never fires. There's no
      // reliable way to detect cancel in browser mode — the promise
      // stays pending. This is acceptable; the caller can wrap with a
      // timeout if needed.
      input.click();
    });
  }

  private exportViaBrowserDownload(blob: Blob, fileName: string): BridgeExportResult {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a short delay to ensure the download started.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { path: '', fileName, bytes: blob.size };
  }
}

// ────────────────────────────────────────────────────────────
// BridgeSession — state machine for a round-trip
// ────────────────────────────────────────────────────────────

/**
 * Tracks the state of a PS↔Standalone round-trip session.
 *
 * State transitions:
 *   idle ──import──▶ importing ──ok──▶ editing
 *   editing ──export──▶ exporting ──ok──▶ done
 *   any ──error──▶ error ──reset──▶ idle
 *
 * The session stores the last import result so the UI can show
 * "imported from PS at HH:MM:SS" and the last export result so the
 * UI can show "saved to /path/file.png".
 */
export class BridgeSession {
  private snapshot: BridgeSessionSnapshot = {
    state: 'idle',
    lastImport: null,
    lastExport: null,
    lastError: null,
    revision: 0,
  };
  private readonly listeners = new Set<(snapshot: BridgeSessionSnapshot) => void>();

  /** Transition to a new state and notify listeners. */
  setState(state: BridgeSessionState, error?: string): void {
    this.snapshot = {
      ...this.snapshot,
      state,
      lastError: error ?? null,
      revision: this.snapshot.revision + 1,
    };
    debug.bridge('session-state', { state, error });
    this.notify();
  }

  /** Record a successful import. */
  recordImport(result: BridgeImportResult): void {
    this.snapshot = {
      ...this.snapshot,
      lastImport: result,
      state: 'editing',
      lastError: null,
      revision: this.snapshot.revision + 1,
    };
    debug.bridge('session-import', { name: result.baseName, bytes: result.blob.size });
    this.notify();
  }

  /** Record a successful export. */
  recordExport(result: BridgeExportResult): void {
    this.snapshot = {
      ...this.snapshot,
      lastExport: result,
      state: 'done',
      lastError: null,
      revision: this.snapshot.revision + 1,
    };
    debug.bridge('session-export', result);
    this.notify();
  }

  /** Reset the session back to idle (e.g., user starts a new document). */
  reset(): void {
    this.snapshot = {
      state: 'idle',
      lastImport: null,
      lastExport: null,
      lastError: null,
      revision: this.snapshot.revision + 1,
    };
    debug.bridge('session-reset');
    this.notify();
  }

  getSnapshot(): BridgeSessionSnapshot {
    return { ...this.snapshot };
  }

  subscribe(listener: (snapshot: BridgeSessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (err) {
        debug.warn('bridge', 'BridgeSession listener threw', err);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────
// Composite → PNG round-trip helpers
// ────────────────────────────────────────────────────────────

/**
 * Render the full layer stack to an offscreen canvas and return the
 * canvas. Caller is responsible for transferring to PNG (via
 * canvasToPngBlob) or displaying.
 *
 * This is the canonical "export what you see" function — composites
 * all visible layers respecting opacity, blend, transform, and mask.
 */
export function renderCompositeToCanvas(
  layers: Layer[],
  docSize: { width: number; height: number },
  imageCache: ImageCache,
  dpi = 72,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, docSize.width);
  canvas.height = Math.max(1, docSize.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D context for composite export');
  }
  // Composite expects a transparent destination — do NOT clear with white.
  const compositeCtx: CompositeContext = {
    docWidth: docSize.width,
    docHeight: docSize.height,
    dpi,
    imageCache,
  };
  compositeLayers(ctx, layers, compositeCtx);
  return canvas;
}

/**
 * Convenience: render + export to PNG file in one call.
 */
export async function exportCompositeToFile(
  bridge: PngBridge,
  layers: Layer[],
  docSize: { width: number; height: number },
  imageCache: ImageCache,
  options: BridgeExportOptions = {},
  dpi = 72,
): Promise<BridgeExportResult> {
  debug.time('bridge.export-composite');
  const canvas = renderCompositeToCanvas(layers, docSize, imageCache, dpi);
  const result = await bridge.exportToFile(canvas, options);
  debug.timeEnd('bridge.export-composite', 'bridge');
  return result;
}

// ────────────────────────────────────────────────────────────
// Singletons
// ────────────────────────────────────────────────────────────

/** Shared PngBridge instance. */
export const pngBridge = new PngBridge();

/** Shared BridgeSession instance. */
export const bridgeSession = new BridgeSession();

// ────────────────────────────────────────────────────────────
// React hook (optional — only imported by App.tsx)
// ────────────────────────────────────────────────────────────

/**
 * Subscribe to bridge session state changes. Re-renders on every
 * state transition. Safe to use in App.tsx; do not use in hot paths.
 *
 * Lazy import of React via dynamic require keeps this module usable
 * from non-React contexts (e.g., a Tauri main-thread worker).
 */
export function createBridgeHook(react: {
  useReducer: <S, A>(reducer: (s: S, a: A) => S, init: S) => [S, (a: A) => void];
  useEffect: (fn: () => unknown, deps: unknown[]) => void;
}): () => BridgeSessionSnapshot {
  return function useBridgeSession(): BridgeSessionSnapshot {
    const [, force] = react.useReducer((x: number) => x + 1, 0);
    const ref = react.useReducer(
      (s: BridgeSessionSnapshot, n: BridgeSessionSnapshot) => n,
      bridgeSession.getSnapshot(),
    );
    react.useEffect(() => {
      return bridgeSession.subscribe(snap => {
        // ref[1] is the dispatch function — we ignore state and use force
        // to trigger re-render, then read fresh snapshot via getSnapshot().
        (ref[1] as unknown as (n: BridgeSessionSnapshot) => void)(snap);
        force(0);
      });
    }, []);
    return ref[0];
  };
}

// ────────────────────────────────────────────────────────────
// Default export
// ────────────────────────────────────────────────────────────

export default {
  PngBridge,
  BridgeSession,
  pngBridge,
  bridgeSession,
  detectEnvironment,
  buildExportMetadata,
  parseSidecarMetadata,
  serializeSidecarMetadata,
  probePngDimensions,
  canvasToPngBlob,
  blobToImageSrc,
  blobToImageSrcAsync,
  revokeImageSrc,
  renderCompositeToCanvas,
  exportCompositeToFile,
  createBridgeHook,
  GENTONIK_VERSION,
};
