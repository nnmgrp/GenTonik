// ============================================================
// geometry.ts — Pure geometry utilities for Measure/Straighten
// ============================================================
//
// v2.15: Extracted from inline code per Gemini consultation:
// "Isolate math from UI. Write pure functions in separate modules."
//
// All functions are pure (no side effects, no DOM access).
// ============================================================

export interface Point {
  x: number;
  y: number;
}

/**
 * Calculate the straighten angle for layer alignment.
 *
 * Given a line from p1 to p2 (in document pixel space), determines the
 * rotation angle needed to make that line either perfectly horizontal
 * (aligned to X axis) or perfectly vertical (aligned to Y axis).
 *
 * Logic:
 *   1. Compute base angle via atan2(dy, dx) in degrees.
 *   2. Determine if the line is closer to horizontal (0°/180°) or
 *      vertical (90°/-90°).
 *   3. Return the compensation angle that, when added to the layer's
 *      rotation, makes the line axis-aligned.
 *
 *   - For horizontal: compensation = -angle (rotates line to 0° or 180°)
 *   - For vertical: compensation = -(angle - 90) or -(angle + 90)
 *     (rotates line to 90° or -90°)
 *
 * @returns Compensation angle in degrees. Positive = clockwise.
 *          Returns 0 if p1 === p2 (degenerate line).
 */
export function calculateStraightenAngle(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return 0;

  const angleRad = Math.atan2(dy, dx);
  let angleDeg = (angleRad * 180) / Math.PI;

  // Normalize to [-180, 180]
  while (angleDeg > 180) angleDeg -= 360;
  while (angleDeg < -180) angleDeg += 360;

  // Determine closest axis:
  // Horizontal: 0° or 180° (or -180°)
  // Vertical: 90° or -90°
  //
  // Distance to horizontal = min(|angle|, |180 - |angle||)
  // Distance to vertical = |90 - |angle||

  const absAngle = Math.abs(angleDeg);
  const distToHorizontal = Math.min(absAngle, 180 - absAngle);
  const distToVertical = Math.abs(90 - absAngle);

  if (distToHorizontal <= distToVertical) {
    // Closer to horizontal — align to X axis
    // Compensation: negate the angle
    return -angleDeg;
  } else {
    // Closer to vertical — align to Y axis
    // We want the line to be at 90° or -90°.
    // If angle > 0, compensation = 90 - angle (rotates to 90°)
    // If angle < 0, compensation = -90 - angle (rotates to -90°)
    if (angleDeg > 0) {
      return 90 - angleDeg;
    } else {
      return -90 - angleDeg;
    }
  }
}

/**
 * Calculate distance between two points in pixels.
 */
export function distance(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate angle of a line in degrees (atan2).
 */
export function lineAngle(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return 0;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}
