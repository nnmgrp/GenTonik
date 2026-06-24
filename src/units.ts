// ============================================================
// UNITS — Conversion between px / mm / in / lpi
// ============================================================
//
// Used by engine.ts to convert user-facing size values
// (dotSize, spacing, lineWidth, satelliteSize, satelliteDistance)
// into pixels based on the document DPI.
//
// 'lpi' (lines per inch) is the industry-standard unit for
// screentone density. 60 lpi at 300 DPI → 5 px spacing.
// ============================================================

import { SizeUnit } from './types';

const MM_PER_INCH = 25.4;

/**
 * Convert a value from the given unit to pixels.
 *
 * @param value  The numeric value in `unit`.
 * @param unit   The unit to convert FROM.
 * @param dpi    Document DPI (e.g. 72, 300).
 * @returns      The equivalent value in pixels.
 *
 * Examples:
 *   toPx(10, 'mm', 300)  → 118.11
 *   toPx(1, 'in', 300)   → 300
 *   toPx(60, 'lpi', 300) → 5      (300 DPI / 60 lpi = 5 px between lines)
 *   toPx(20, 'px', 300)  → 20
 */
export function toPx(value: number, unit: SizeUnit, dpi: number): number {
  switch (unit) {
    case 'px':  return value;
    case 'mm':  return (value / MM_PER_INCH) * dpi;
    case 'in':  return value * dpi;
    case 'lpi': return dpi / Math.max(value, 0.0001); // avoid div-by-zero
  }
}

/**
 * Convert a pixel value back to the given unit.
 *
 * Inverse of toPx(). Used when displaying a px-based value back
 * to the user in their selected unit.
 */
export function fromPx(px: number, unit: SizeUnit, dpi: number): number {
  switch (unit) {
    case 'px':  return px;
    case 'mm':  return (px * MM_PER_INCH) / dpi;
    case 'in':  return px / dpi;
    case 'lpi': return dpi / Math.max(px, 0.0001);
  }
}

/**
 * Format a pixel value in the given unit for display.
 *
 * Picks a sensible number of decimal places per unit:
 *   px  → 0 decimals  ("20 px")
 *   mm  → 2 decimals   ("2.12 mm")
 *   in  → 3 decimals   ("0.083 in")
 *   lpi → 1 decimal    ("60.0 lpi")
 */
export function formatInUnit(
  px: number,
  unit: SizeUnit,
  dpi: number,
): string {
  const v = fromPx(px, unit, dpi);
  switch (unit) {
    case 'px':  return `${Math.round(v)} px`;
    case 'mm':  return `${v.toFixed(2)} mm`;
    case 'in':  return `${v.toFixed(3)} in`;
    case 'lpi': return `${v.toFixed(1)} lpi`;
  }
}
