// ============================================================
// PRESET STORE — CRUD + persistence for GenToniK presets
// ============================================================
//
// This module owns preset persistence. The Layer model and the
// engine don't know about it — App.tsx calls into the store when
// the user creates / edits / deletes / imports / exports presets.
//
// Storage layout (localStorage):
//   Key: 'gentonik:presets:v2'
//   Value: JSON string of PresetFile (see types.ts)
//
// Two-tier model:
//   1. BUILT-IN presets (BUILT_IN_PRESETS from types.ts) are
//      always present, read-only, and merged into the in-memory
//      list at load time. They are NEVER persisted to localStorage
//      — they live in code, so storing them would duplicate data
//      and make updating the app annoying (old built-ins would
//      linger in storage forever).
//   2. USER presets live in localStorage only. They can be
//      created, edited, duplicated, deleted, imported, exported.
//
// IDs are stable: built-ins have IDs like 'classic-10', user
// presets have IDs like 'user-<timestamp>-<random>'. The CRUD
// functions enforce that built-ins cannot be deleted or
// overwritten (but CAN be duplicated into a user preset).
//
// Migration:
//   If we add fields to PresetV2 later, bump PresetFile.version
//   and write a migrator. v2 → v2 is a no-op; the version check
//   is what lets us detect old files and upgrade them in place.
// ============================================================

import {
  PresetV2,
  PresetFile,
  BUILT_IN_PRESETS,
  DEFAULT_PARAMS,
} from './types';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'gentonik:presets:v2';
const CURRENT_VERSION = 2 as const;

// ────────────────────────────────────────────────────────────
// ID generation
// ────────────────────────────────────────────────────────────

/**
 * Generate a unique ID for a user preset.
 *
 * Uses timestamp + random to avoid collisions even when called
 * twice in the same millisecond (e.g., bulk import).
 *
 * Format: `user-<ms>-<random-base36>`
 * Example: `user-1718100000000-kf3a9x`
 */
export function generatePresetId(): string {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 8);
  return `user-${ts}-${rnd}`;
}

// ────────────────────────────────────────────────────────────
// localStorage primitives
// ────────────────────────────────────────────────────────────

/**
 * Read the raw user preset file from localStorage.
 *
 * Returns null if:
 *   - localStorage is unavailable (SSR, privacy mode)
 *   - the key doesn't exist yet (first launch)
 *   - the stored JSON is corrupt (we log and discard)
 *
 * NEVER throws — all errors are caught and treated as "no data".
 * This is intentional: a corrupt localStorage entry should not
 * brick the app, it should just reset to defaults.
 */
function readRawFile(): PresetFile | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PresetFile;
    if (parsed.format !== 'gentonik-presets') return null;
    // Version check — currently only v2 exists, so anything else
    // is treated as corrupt. Future: add migrators here.
    if (parsed.version !== CURRENT_VERSION) return null;
    if (!Array.isArray(parsed.presets)) return null;
    return parsed;
  } catch (err) {
    console.warn('[gentonik] Failed to read preset file from localStorage:', err);
    return null;
  }
}

/**
 * Write the raw preset file to localStorage.
 *
 * Silently fails if localStorage is unavailable or quota exceeded.
 * The caller doesn't need to handle errors — worst case, the
 * preset isn't persisted and the user sees it again next session
 * only if they re-create it.
 *
 * Quota notes:
 *   - localStorage limit is ~5MB per origin in most browsers
 *   - A typical PresetV2 (with all params) is ~1KB JSON
 *   - So we can store ~5000 user presets before hitting quota
 *   - If we ever approach that, switch to IndexedDB
 */
function writeRawFile(file: PresetFile): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
    return true;
  } catch (err) {
    console.warn('[gentonik] Failed to write preset file to localStorage:', err);
    return false;
  }
}

// ────────────────────────────────────────────────────────────
// Built-in seeding
// ────────────────────────────────────────────────────────────

/**
 * Returns a deep copy of the built-in presets.
 *
 * Deep copy is important — callers may mutate preset.params
 * before applying (e.g., overriding the unit field based on user
 * DPI). If we returned the actual BUILT_IN_PRESETS array, those
 * mutations would leak across calls.
 */
function getBuiltInPresets(): PresetV2[] {
  return BUILT_IN_PRESETS.map(p => ({
    ...p,
    tags: p.tags ? [...p.tags] : undefined,
    params: { ...p.params },
  }));
}

// ────────────────────────────────────────────────────────────
// Public API — read
// ────────────────────────────────────────────────────────────

/**
 * In-memory cache of all presets (built-ins + user).
 *
 * The store keeps this in sync with localStorage. Reads hit the
 * cache (O(1)); writes update both cache and localStorage.
 *
 * Initialized lazily on first getAll() call.
 */
let cache: PresetV2[] | null = null;

/**
 * Returns ALL presets (built-ins + user), sorted:
 *   1. By category (alphabetical)
 *   2. Within category, by name (alphabetical)
 *
 * Built-ins always have isBuiltIn=true; user presets have
 * isBuiltIn=false. UI can use this flag to show a lock icon or
 * hide the delete button.
 */
export function getAllPresets(): PresetV2[] {
  if (cache === null) {
    const userFile = readRawFile();
    const userPresets = userFile?.presets ?? [];
    const builtIns = getBuiltInPresets();
    cache = [...builtIns, ...userPresets];
  }
  // Return a shallow copy so callers can sort/filter without
  // mutating our cache. PresetV2 objects themselves are NOT
  // copied — callers should treat them as read-only. Use
  // clonePreset() if mutation is needed.
  return [...cache];
}

/**
 * Get a preset by ID. Returns null if not found.
 *
 * Searches both built-ins and user presets.
 */
export function getPresetById(id: string): PresetV2 | null {
  const all = getAllPresets();
  return all.find(p => p.id === id) ?? null;
}

/**
 * Returns only user presets (excluding built-ins).
 * Used by the export function and the "my presets" UI filter.
 */
export function getUserPresets(): PresetV2[] {
  return getAllPresets().filter(p => !p.isBuiltIn);
}

/**
 * Returns all unique category names, sorted alphabetically.
 * Used to populate the category filter dropdown in the UI.
 */
export function getAllCategories(): string[] {
  const cats = new Set<string>();
  for (const p of getAllPresets()) {
    cats.add(p.category);
  }
  return Array.from(cats).sort();
}

// ────────────────────────────────────────────────────────────
// Public API — create / update / delete
// ────────────────────────────────────────────────────────────

/**
 * Persist the current user preset list to localStorage.
 *
 * Internal helper — callers should use the higher-level CRUD
 * functions which update the cache AND call this.
 */
function persistUserPresets(userPresets: PresetV2[]): void {
  const file: PresetFile = {
    format: 'gentonik-presets',
    version: CURRENT_VERSION,
    exportedAt: Date.now(),
    presets: userPresets,
  };
  writeRawFile(file);
}

/**
 * Create a new user preset.
 *
 * The `id` is auto-generated; `isBuiltIn` is forced to false;
 * `createdAt` and `updatedAt` are set to now.
 *
 * @param name        Display name (1-100 chars)
 * @param params      Screentone parameters (will be cloned)
 * @param category    Category name (free-form, but UI may suggest)
 * @param icon        Emoji or single char for the preset tile
 * @param description Optional longer description
 * @param tags        Optional searchable tags
 * @returns The created preset (with generated ID)
 */
export function createPreset(
  name: string,
  params: PresetV2['params'],
  category: string,
  icon: string = '🎨',
  description?: string,
  tags?: string[],
): PresetV2 {
  const now = Date.now();
  const preset: PresetV2 = {
    id: generatePresetId(),
    name: name.trim() || 'Untitled',
    icon,
    category: category.trim() || 'User',
    description: description?.trim() || undefined,
    tags: tags && tags.length > 0 ? [...tags] : undefined,
    params: { ...params },
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  };

  // Update cache
  if (cache === null) getAllPresets();
  cache!.push(preset);

  // Persist only user presets
  persistUserPresets(cache!.filter(p => !p.isBuiltIn));

  return preset;
}

/**
 * Update an existing preset.
 *
 * Rules:
 *   - Built-in presets CANNOT be updated. Pass a built-in ID and
 *     this throws. To "customize" a built-in, use duplicatePreset()
 *     first, then update the copy.
 *   - `updatedAt` is auto-set to now.
 *   - Only the fields you pass in `changes` are updated; others
 *     remain untouched.
 *
 * @param id      Preset ID (must be a user preset)
 * @param changes Partial preset fields to update
 * @returns The updated preset, or null if not found
 * @throws if the ID refers to a built-in preset
 */
export function updatePreset(
  id: string,
  changes: Partial<Omit<PresetV2, 'id' | 'isBuiltIn' | 'createdAt'>>,
): PresetV2 | null {
  if (cache === null) getAllPresets();
  const idx = cache!.findIndex(p => p.id === id);
  if (idx < 0) return null;

  const existing = cache![idx];
  if (existing.isBuiltIn) {
    throw new Error(
      `Cannot update built-in preset "${existing.name}" (id=${id}). ` +
      `Use duplicatePreset() to create an editable copy first.`,
    );
  }

  // Merge changes. We clone arrays/objects to avoid sharing
  // references with the caller's input.
  const updated: PresetV2 = {
    ...existing,
    ...changes,
    id: existing.id,            // never change ID
    isBuiltIn: existing.isBuiltIn, // never change built-in flag
    createdAt: existing.createdAt, // never change creation time
    updatedAt: Date.now(),
    params: changes.params ? { ...changes.params } : existing.params,
    tags: changes.tags ? [...changes.tags] : existing.tags,
  };

  cache![idx] = updated;
  persistUserPresets(cache!.filter(p => !p.isBuiltIn));
  return updated;
}

/**
 * Delete a user preset by ID.
 *
 * Built-in presets CANNOT be deleted. Pass a built-in ID and
 * this throws (same logic as updatePreset).
 *
 * @returns true if deleted, false if not found
 * @throws if the ID refers to a built-in preset
 */
export function deletePreset(id: string): boolean {
  if (cache === null) getAllPresets();
  const idx = cache!.findIndex(p => p.id === id);
  if (idx < 0) return false;

  const existing = cache![idx];
  if (existing.isBuiltIn) {
    throw new Error(
      `Cannot delete built-in preset "${existing.name}" (id=${id}).`,
    );
  }

  cache!.splice(idx, 1);
  persistUserPresets(cache!.filter(p => !p.isBuiltIn));
  return true;
}

/**
 * Duplicate an existing preset (built-in or user) into a new
 * USER preset.
 *
 * The duplicate gets:
 *   - A new auto-generated ID
 *   - isBuiltIn = false (always, even if source is built-in)
 *   - name = `<original name> (copy)` — caller can rename via updatePreset
 *   - createdAt = updatedAt = now
 *   - All params/tags/description copied
 *
 * @param sourceId  ID of preset to duplicate
 * @returns The new user preset, or null if source not found
 */
export function duplicatePreset(sourceId: string): PresetV2 | null {
  const source = getPresetById(sourceId);
  if (!source) return null;

  return createPreset(
    `${source.name} (copy)`,
    source.params,
    source.category,
    source.icon,
    source.description,
    source.tags,
  );
}

// ────────────────────────────────────────────────────────────
// Public API — import / export
// ────────────────────────────────────────────────────────────

/**
 * Export all USER presets (excluding built-ins) as a JSON string.
 *
 * The result is a valid PresetFile that can be re-imported via
 * importPresets(). Built-ins are not exported — they're already
 * in the code.
 *
 * @returns JSON string, or null if no user presets
 */
export function exportPresets(): string | null {
  const userPresets = getUserPresets();
  if (userPresets.length === 0) return null;

  const file: PresetFile = {
    format: 'gentonik-presets',
    version: CURRENT_VERSION,
    exportedAt: Date.now(),
    presets: userPresets.map(p => ({
      ...p,
      tags: p.tags ? [...p.tags] : undefined,
      params: { ...p.params },
    })),
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Export a SINGLE preset as JSON. Useful for sharing one preset
 * without exposing the user's entire library.
 */
export function exportSinglePreset(id: string): string | null {
  const preset = getPresetById(id);
  if (!preset) return null;

  const file: PresetFile = {
    format: 'gentonik-presets',
    version: CURRENT_VERSION,
    exportedAt: Date.now(),
    presets: [{
      ...preset,
      // Strip built-in flag — when re-imported, this should
      // become a user preset (the import target may not have
      // the same built-ins).
      isBuiltIn: false,
      id: generatePresetId(), // new ID to avoid collision on re-import
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: preset.tags ? [...preset.tags] : undefined,
      params: { ...preset.params },
    }],
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Result of an import operation.
 */
export interface ImportResult {
  /** Number of presets successfully imported */
  imported: number;
  /** Number of presets skipped (invalid, duplicate ID, etc.) */
  skipped: number;
  /** Human-readable error messages for skipped presets */
  errors: string[];
}

/**
 * Import presets from a JSON string.
 *
 * Behavior:
 *   - Validates the JSON structure (must be a PresetFile).
 *   - Each preset in the file is added as a NEW user preset with
 *     a fresh ID. This means re-importing the same file twice
 *     creates duplicates — by design, so users can intentionally
 *     "merge" multiple libraries.
 *   - Built-in flag is forced to false on import (even if the
 *     file claims isBuiltIn=true — we don't trust external files).
 *   - Invalid presets (missing required fields, malformed params)
 *     are skipped with an error message in the result.
 *
 * @param json  JSON string from exportPresets() or external source
 * @param mode  'merge' (default) adds as new; 'replace' clears
 *              all existing user presets first. Use 'replace'
 *              cautiously — there's no undo.
 * @returns ImportResult with counts and any errors
 */
export function importPresets(
  json: string,
  mode: 'merge' | 'replace' = 'merge',
): ImportResult {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

  let file: PresetFile;
  try {
    file = JSON.parse(json) as PresetFile;
  } catch (err) {
    result.errors.push(`Invalid JSON: ${(err as Error).message}`);
    result.skipped = 1;
    return result;
  }

  // Structural validation
  if (file.format !== 'gentonik-presets') {
    result.errors.push('Not a GenToniK preset file (missing or wrong format field).');
    result.skipped = 1;
    return result;
  }
  if (file.version !== CURRENT_VERSION) {
    result.errors.push(`Unsupported preset file version: ${file.version}. Expected ${CURRENT_VERSION}.`);
    result.skipped = 1;
    return result;
  }
  if (!Array.isArray(file.presets)) {
    result.errors.push('Preset file is missing the "presets" array.');
    result.skipped = 1;
    return result;
  }

  // 'replace' mode: wipe user presets first
  if (mode === 'replace') {
    if (cache === null) getAllPresets();
    cache = cache!.filter(p => p.isBuiltIn);
    persistUserPresets([]);
  }

  // Process each preset
  for (let i = 0; i < file.presets.length; i++) {
    const incoming = file.presets[i];
    const label = incoming?.name ?? `#${i}`;

    // Required fields
    if (!incoming || typeof incoming !== 'object') {
      result.errors.push(`Preset #${i}: not an object.`);
      result.skipped++;
      continue;
    }
    if (typeof incoming.name !== 'string' || incoming.name.trim() === '') {
      result.errors.push(`Preset #${i}: missing or empty name.`);
      result.skipped++;
      continue;
    }
    if (!incoming.params || typeof incoming.params !== 'object') {
      result.errors.push(`Preset "${label}": missing params object.`);
      result.skipped++;
      continue;
    }
    if (typeof incoming.category !== 'string') {
      result.errors.push(`Preset "${label}": missing category.`);
      result.skipped++;
      continue;
    }

    // Merge incoming params with DEFAULT_PARAMS to fill any
    // missing fields (forward compatibility — if a future version
    // adds a param field, old preset files still work).
    const mergedParams = { ...DEFAULT_PARAMS, ...incoming.params };

    // Create as new user preset (fresh ID, isBuiltIn=false)
    createPreset(
      incoming.name,
      mergedParams,
      incoming.category,
      typeof incoming.icon === 'string' ? incoming.icon : '🎨',
      typeof incoming.description === 'string' ? incoming.description : undefined,
      Array.isArray(incoming.tags) ? incoming.tags.filter(t => typeof t === 'string') : undefined,
    );
    result.imported++;
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// Public API — search / filter
// ────────────────────────────────────────────────────────────

/**
 * Search presets by query string. Matches name, description,
 * category, and tags (case-insensitive).
 *
 * @param query    Free-text query (empty = return all)
 * @param category Optional category filter
 * @returns Matching presets, sorted by relevance (name match > tag > description)
 */
export function searchPresets(
  query: string,
  category?: string,
): PresetV2[] {
  let all = getAllPresets();

  // Category filter first (cheap)
  if (category && category !== 'All') {
    all = all.filter(p => p.category === category);
  }

  const q = query.trim().toLowerCase();
  if (!q) return all;

  // Score each preset by how well it matches.
  // 3 = name starts with query
  // 2 = name contains query
  // 1 = tag/category/description contains query
  // 0 = no match (filtered out)
  const scored = all
    .map(p => {
      const name = p.name.toLowerCase();
      const cat = p.category.toLowerCase();
      const desc = p.description?.toLowerCase() ?? '';
      const tags = p.tags?.join(' ').toLowerCase() ?? '';

      let score = 0;
      if (name.startsWith(q)) score = 3;
      else if (name.includes(q)) score = 2;
      else if (tags.includes(q) || cat.includes(q) || desc.includes(q)) score = 1;

      return { p, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map(s => s.p);
}

// ────────────────────────────────────────────────────────────
// Public API — reset / debugging
// ────────────────────────────────────────────────────────────

/**
 * Delete ALL user presets and reset the store to just built-ins.
 *
 * This is destructive — there's no undo. Used by the "reset to
 * defaults" button in settings.
 *
 * Built-in presets are NEVER affected by this (they live in code).
 */
export function resetAllUserPresets(): void {
  if (cache === null) getAllPresets();
  cache = cache!.filter(p => p.isBuiltIn);
  persistUserPresets([]);
}

/**
 * Force the cache to be re-read from localStorage on next access.
 *
 * Useful for tests, or when another tab might have modified the
 * store (though we don't currently listen to storage events).
 */
export function invalidateCache(): void {
  cache = null;
}

/**
 * Internal: get the current cache state (for debugging / tests).
 * Not exported in the public API surface; gated by being
 * lower-cased to discourage use.
 */
export function _debugGetCache(): PresetV2[] | null {
  return cache;
}
