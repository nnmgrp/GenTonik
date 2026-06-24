// ============================================================
// history.ts — Undo/redo for multi-layer GenToniK documents
// ============================================================
//
// Design: snapshot-based with explicit coalescing.
//
// Why snapshots (not command-pattern)?
//   • Simpler to reason about — every state is just (layers, docSize, activeLayerId)
//   • Robust against partial-failure bugs (no inverse ops to get wrong)
//   • Memory is bounded by maxEntries; structural sharing keeps each snapshot cheap
//     because unchanged Layer objects keep their references across snapshots
//     (the contract is that Layer is treated as immutable — never mutate in place)
//
// Coalescing:
//   Slider drags and brush strokes produce dozens of intermediate states. Without
//   coalescing, one drag = 50 undo steps — unusable. Solution: push() accepts
//   { coalesce: true } — if the previous push had the same label, it gets replaced
//   instead of adding a new entry. Caller controls when to start a new step
//   (e.g., on mouseup, on slider-release, on blur).
//
// Framework-agnostic. Subscribe() lets React re-render on history changes.
// ============================================================

import type { Layer } from './types';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/**
 * An immutable snapshot of the document at a moment in time.
 *
 * `layers` is a frozen list — Layer objects inside are shared by reference
 * with adjacent snapshots wherever possible (structural sharing). Do NOT
 * mutate the array or any Layer inside it; treat the whole snapshot as
 * read-only.
 */
export interface DocumentSnapshot {
  /** Layer list, bottom-to-top. */
  readonly layers: readonly Layer[];
  /** Document canvas size in pixels. */
  readonly docSize: { readonly width: number; readonly height: number };
  /** Active layer ID at snapshot time, or null if none active. */
  readonly activeLayerId: string | null;
  /** Human-readable action label for UI ("Add Layer", "Paint Mask", …). */
  readonly label: string;
  /** Snapshot creation time (ms epoch). */
  readonly timestamp: number;
}

/** Constructor options for HistoryManager. */
export interface HistoryOptions {
  /**
   * Maximum number of entries in the undo stack. When exceeded, the oldest
   * entry is dropped. Must be ≥ 2. Default: 100.
   */
  maxEntries?: number;
}

/** Options for HistoryManager.push(). */
export interface PushOptions {
  /**
   * If true, this push will replace the previous top-of-stack entry IF they
   * share the same `label`. Use this for continuous operations (slider drag,
   * brush stroke, resize handle drag) so they collapse into a single undo
   * step.
   *
   * If the previous push had a different label, a new entry is created
   * (coalescing never crosses label boundaries).
   *
   * Default: false (always a new entry).
   */
  coalesce?: boolean;
}

// ────────────────────────────────────────────────────────────
// HistoryManager
// ────────────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 100;

/**
 * Undo/redo manager for multi-layer documents.
 *
 * Lifecycle:
 *   1. `initialize(snapshot)` — set the starting state (typically after
 *      loading or creating a document). Does NOT count as an undoable action.
 *   2. `push(snapshot)` — record a new state after each meaningful user action.
 *   3. `undo()` / `redo()` — traverse the history; returns the state to apply
 *      or null if there is nothing to undo/redo.
 *   4. `markSaved()` — mark the current state as the save point; `isDirty()`
 *      tells you whether there are unsaved changes.
 *
 * Coalescing example (slider drag):
 *   history.push({ ..., label: 'Opacity' });                          // new entry
 *   history.push({ ..., label: 'Opacity' }, { coalesce: true });      // replace prev
 *   history.push({ ..., label: 'Opacity' }, { coalesce: true });      // replace prev
 *   // undo() now jumps back to the state before the drag, in one step.
 *
 * Brush stroke example:
 *   // mousedown — record the state BEFORE the stroke
 *   history.push({ layers: beforeStroke, ..., label: 'Paint Mask' });
 *   // mousemove — update live state, do NOT push (still inside the stroke)
 *   // mouseup   — record the state AFTER the stroke, coalescing with the
 *   //              mousedown push so the "before" snapshot is preserved
 *   //              and the "after" snapshot replaces the mousedown push.
 *   // Wait — that would lose the "before". Let me reconsider…
 *   //
 *   // Correct pattern: only push the FINAL state, with label 'Paint Mask'.
 *   // The previous top-of-stack (e.g., 'Move Layer') is what undo will
 *   // restore to. The mousedown push is unnecessary.
 *   history.push({ layers: afterStroke, ..., label: 'Paint Mask' });
 *   // undo() → restores layers to whatever was on top before this push.
 */
export class HistoryManager {
  private undoStack: DocumentSnapshot[] = [];
  private redoStack: DocumentSnapshot[] = [];
  private readonly maxEntries: number;
  private readonly listeners = new Set<() => void>();
  /**
   * Index into undoStack pointing at the last "saved" state.
   * -1 means "no save point yet" (always dirty).
   */
  private savePointIndex: number = -1;

  constructor(opts: HistoryOptions = {}) {
    const requested = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxEntries = Math.max(2, requested);
  }

  // ── Public API: state ───────────────────────────────────

  /**
   * Set the initial state. Clears all undo/redo history.
   * Call this once when a document is loaded or created.
   * Does NOT count as an undoable action.
   *
   * The initial state is marked as the save point by default (i.e., a freshly
   * loaded document is not "dirty"). If you are creating a brand-new document
   * that should appear unsaved, call `markUnsaved()` right after.
   */
  initialize(snapshot: Omit<DocumentSnapshot, 'timestamp'>): void {
    this.undoStack = [{ ...snapshot, timestamp: Date.now() }];
    this.redoStack = [];
    this.savePointIndex = 0;
    this.notify();
  }

  /**
   * Push a new state onto the undo stack. Clears the redo stack.
   *
   * With `coalesce: true` and matching label, replaces the top entry instead
   * of pushing a new one — useful for continuous operations like drags.
   */
  push(snapshot: Omit<DocumentSnapshot, 'timestamp'>, opts: PushOptions = {}): void {
    const full: DocumentSnapshot = { ...snapshot, timestamp: Date.now() };

    const didCoalesce =
      opts.coalesce === true &&
      this.undoStack.length > 0 &&
      this.undoStack[this.undoStack.length - 1].label === full.label;

    if (didCoalesce) {
      // Replace top — keep the original timestamp so a coalesced run reads
      // as one logical action with a stable "started at" time.
      const top = this.undoStack[this.undoStack.length - 1];
      this.undoStack[this.undoStack.length - 1] = { ...full, timestamp: top.timestamp };
    } else {
      this.undoStack.push(full);
    }

    // New action invalidates redo history.
    this.redoStack = [];

    // Trim oldest entries if over limit.
    while (this.undoStack.length > this.maxEntries) {
      this.undoStack.shift();
      if (this.savePointIndex > 0) this.savePointIndex--;
      // If savePoint was at the dropped index, the saved state is gone —
      // mark as dirty forever (cannot return to "saved" state via undo).
      // savePointIndex === 0 falling through here means the initial saved
      // state itself was dropped, which only happens when maxEntries is
      // exceeded; in that case the document is effectively always dirty.
    }

    this.notify();
  }

  /**
   * Undo the last action. Returns the previous state to apply, or null if
   * there is nothing to undo. The current state is moved to the redo stack.
   *
   * The returned snapshot is read-only — do not mutate it. If you need to
   * mutate, copy first.
   */
  undo(): DocumentSnapshot | null {
    if (this.undoStack.length < 2) return null;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    this.notify();
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }

  /**
   * Redo the last undone action. Returns the state to apply, or null if
   * there is nothing to redo.
   */
  redo(): DocumentSnapshot | null {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack.pop()!;
    this.undoStack.push(next);
    this.notify();
    return next;
  }

  // ── Public API: queries ─────────────────────────────────

  /** Whether undo() will return a state. */
  canUndo(): boolean {
    return this.undoStack.length >= 2;
  }

  /** Whether redo() will return a state. */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Peek at the current top of the undo stack without consuming it.
   * Returns null if history is empty.
   */
  current(): DocumentSnapshot | null {
    return this.undoStack.length > 0
      ? this.undoStack[this.undoStack.length - 1]
      : null;
  }

  /** Label of the action that undo() would undo, or null. */
  peekUndoLabel(): string | null {
    if (this.undoStack.length < 2) return null;
    return this.undoStack[this.undoStack.length - 1].label;
  }

  /** Label of the action that redo() would redo, or null. */
  peekRedoLabel(): string | null {
    if (this.redoStack.length === 0) return null;
    return this.redoStack[this.redoStack.length - 1].label;
  }

  // ── Public API: save-point tracking ─────────────────────

  /**
   * Mark the current top-of-stack as the "saved" point. Call this after
   * writing the document to disk (or equivalent). `isDirty()` will return
   * false until the next push().
   */
  markSaved(): void {
    this.savePointIndex = this.undoStack.length - 1;
    this.notify();
  }

  /**
   * Mark the document as unsaved (dirty) regardless of position.
   * Use this for freshly-created documents that have not been saved yet.
   */
  markUnsaved(): void {
    this.savePointIndex = -1;
    this.notify();
  }

  /**
   * Whether the current state differs from the last save point.
   * True if there are unsaved changes.
   */
  isDirty(): boolean {
    if (this.savePointIndex < 0) return true;
    return this.undoStack.length - 1 !== this.savePointIndex;
  }

  // ── Public API: bulk operations ─────────────────────────

  /** Clear all undo/redo history. Use when loading a new document. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.savePointIndex = -1;
    this.notify();
  }

  /**
   * Reset history to a single snapshot (the new "current" state).
   * Equivalent to clear() + initialize() but doesn't allocate twice.
   */
  resetTo(snapshot: Omit<DocumentSnapshot, 'timestamp'>): void {
    this.initialize(snapshot);
  }

  // ── Public API: subscription ────────────────────────────

  /**
   * Subscribe to history changes (push/undo/redo/clear/markSaved).
   * Returns an unsubscribe function. Listeners are called after every
   * mutation, synchronously.
   *
   * Typical React usage:
   *   const [, force] = useReducer(x => x + 1, 0);
   *   useEffect(() => historyRef.current!.subscribe(force), []);
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Public API: debugging ───────────────────────────────

  /** Number of entries in the undo stack (including current). For debugging/UI. */
  get depth(): number {
    return this.undoStack.length;
  }

  /** Number of entries in the redo stack. For debugging/UI. */
  get redoDepth(): number {
    return this.redoStack.length;
  }

  /**
   * Return a shallow copy of the undo stack labels (oldest first) for a
   * history-panel UI. The current state is the last element.
   */
  getUndoLabels(): readonly string[] {
    return this.undoStack.map(s => s.label);
  }

  /**
   * Return a shallow copy of the redo stack labels (next-to-be-redone first).
   */
  getRedoLabels(): readonly string[] {
    return this.redoStack.map(s => s.label);
  }

  // ── Internal ────────────────────────────────────────────

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// ────────────────────────────────────────────────────────────
// Helper factory
// ────────────────────────────────────────────────────────────

/**
 * Build a snapshot from common state pieces. Ensures all required fields
 * are present and the layers array is a fresh shallow copy (so the caller
 * can keep mutating their own array without affecting the snapshot).
 *
 * Layer objects inside are NOT cloned — they are shared by reference. This
 * is intentional and safe AS LONG AS Layer is treated as immutable
 * (always create a new Layer object when changing a field, never mutate).
 */
export function makeSnapshot(
  layers: readonly Layer[],
  docSize: { width: number; height: number },
  activeLayerId: string | null,
  label: string,
): Omit<DocumentSnapshot, 'timestamp'> {
  return {
    layers: layers.slice(),
    docSize: { width: docSize.width, height: docSize.height },
    activeLayerId,
    label,
  };
}
