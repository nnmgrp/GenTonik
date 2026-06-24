# Third-Party Notices — GenToniK Screentone Generator

This file attributes third-party code and patterns used by the GenToniK
Screentone Generator.

## react-moveable

- **Source:** https://github.com/daybrush/moveable
- **Package:** `react-moveable` (npm)
- **License:** MIT (© Daybrush)
- **Used in:** `src/transform-overlay-movable.tsx`
- **Purpose:** Overlay transform-handles (move / scale / rotate / warp) over
  the canvas. The library handles all pointer math, matrix inversion, and
  gesture recognition internally. The GenToniK project integrates it via
  a "ghost div" pattern — a transparent absolutely-positioned div that
  represents the active layer's on-screen rectangle, with moveable
  rendering the handles and emitting drag/scale/rotate/warp events.

## fabric.js (math reference, not as a dependency)

- **Source:** https://github.com/fabricjs/fabric.js
- **License:** MIT (© Printio, Andrea Bogazzi et al.)
- **Used in:** `src/transform-matrix.ts` (pattern only — no code copied verbatim)
- **Purpose:** The inverse-transform pattern in `screenToLocal` is adapted
  from fabric.js's `sendPointToPlane` (`src/util/misc/planeChange.ts`).
  fabric.js's insight — that mapping a pointer from screen-space to
  scene-space requires multiplying by the INVERSE of the composed
  viewport transform, not just subtracting the canvas offset — was the
  direct inspiration for the v2 fix to the "brush рисует не там /
  инвертированно" bug in `mask-editor.tsx`.
- **No code from fabric.js is included in this project.** Only the
  mathematical pattern (point × inverse matrix) is used; the implementation
  in `transform-matrix.ts` is original.

## @scena/matrix

- **Source:** https://github.com/daybrush/matrix
- **Package:** `@scena/matrix` (npm)
- **License:** MIT (© Daybrush)
- **Used in:** indirect dependency of `react-moveable`. Not imported
  directly by GenToniK code.

## Selection tool logic (internal)

The selection-tool pointer logic (rect/ellipse marquee, freehand lasso,
polygonal lasso) in `src/transform-overlay-movable.tsx` is adapted from
the original GenToniK `src/transform-panel.tsx` (v1). All such code is
original to the GenToniK project.

## Project license

The GenToniK Screentone Generator project source code is provided under
the terms documented in the project root `LICENSE` file. Third-party
components retain their original licenses as listed above.
