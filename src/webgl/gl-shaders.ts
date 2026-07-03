// ============================================================
// gl-shaders.ts — vertex/fragment shader source for all GL passes
// ============================================================
//
// Shader program inventory:
//
//   1. composite-quad   — draws a textured quad (the layer's offscreen
//      FBO content) onto the destination FBO with affine or perspective
//      transform + opacity + blend mode. This is the WORKHORSE — every
//      visible layer goes through it at least once.
//
//   2. solid-fill       — fills an FBO with a solid color (used for
//      'solid' layer type, and as a fast path for solid-color masks).
//
//   3. image-upload     — uploads an HTMLImageElement as a texture and
//      draws it into an FBO at natural size. Trivial pass (no transform).
//
//   4. screentone-dots  — procedural dot pattern (GLSL).
//   5. screentone-lines — procedural line pattern (GLSL).
//   6. screentone-crosshatch — two crossed line grids (GLSL).
//   7. screentone-checker — checkerboard pattern (GLSL).
//
// For the remaining 8 screentone pattern types (noise, hexgrid,
// concentric, stars, hearts, triangles, gaussian_noise, stipple),
// we use a HYBRID path: the existing CPU `renderScreentone` from
// engine.ts renders to a 2D canvas, which is then uploaded as a
// texture and drawn into the layer's FBO via image-upload. This
// keeps visual fidelity 100% identical to canvas2D for those
// patterns while the GLSL versions are being ported incrementally.
//
// All shaders are GLSL ES 3.00 (#version 300 es) — WebGL2 only.
// ============================================================

// ────────────────────────────────────────────────────────────
// GLSL blend function block (shared between COMPOSITE_FRAG and
// any other shader that needs manual blending).
// Declared EARLY so it can be referenced by template literals below.
// ────────────────────────────────────────────────────────────

const BLEND_FUNCTIONS = /* glsl */ `
vec3 unpremult(vec4 c) {
  if (c.a <= 0.0) return vec3(0.0);
  return clamp(c.rgb / c.a, 0.0, 1.0);
}
vec4 premult(vec3 rgb, float a) { return vec4(rgb * a, a); }
vec3 blendMultiply(vec3 s, vec3 d) { return s * d; }
vec3 blendScreen(vec3 s, vec3 d)  { return 1.0 - (1.0 - s) * (1.0 - d); }
vec3 blendOverlay(vec3 s, vec3 d) {
  return mix(2.0 * s * d,
             1.0 - 2.0 * (1.0 - s) * (1.0 - d),
             step(0.5, d));
}
vec3 blendDarken(vec3 s, vec3 d)  { return min(s, d); }
vec3 blendLighten(vec3 s, vec3 d) { return max(s, d); }
vec4 blendPremultiplied(vec4 srcPremult, vec4 dstPremult, int mode) {
  // Early-outs for fully transparent inputs.
  if (srcPremult.a <= 0.0) return dstPremult;
  if (dstPremult.a <= 0.0) return srcPremult;

  // Normal mode (mode=0): optimized premultiplied src-over.
  // This is the most common case (~90% of layers), so we avoid the
  // unpremult → blend → premult roundtrip and use the direct formula:
  //   out.rgb = src.rgb + dst.rgb * (1 - src.a)
  //   out.a   = src.a   + dst.a   * (1 - src.a)
  // Mathematically equivalent to the general path below but faster.
  if (mode == 0) {
    float invSrcA = 1.0 - srcPremult.a;
    return vec4(
      srcPremult.rgb + dstPremult.rgb * invSrcA,
      srcPremult.a   + dstPremult.a   * invSrcA
    );
  }

  // Non-normal blend modes: unpremult → blend → composite → premult.
  // The blended RGB is computed in straight-alpha space, then composited
  // with Porter-Duff src-over, then converted back to premultiplied.
  vec3 s = unpremult(srcPremult);
  vec3 d = unpremult(dstPremult);
  vec3 blendedRGB;
  if (mode == 1)      blendedRGB = blendMultiply(s, d);
  else if (mode == 2) blendedRGB = blendScreen(s, d);
  else if (mode == 3) blendedRGB = blendOverlay(s, d);
  else if (mode == 4) blendedRGB = blendDarken(s, d);
  else if (mode == 5) blendedRGB = blendLighten(s, d);
  else                blendedRGB = s;

  float srcA = srcPremult.a;
  float dstA = dstPremult.a;
  float outA = srcA + dstA * (1.0 - srcA);
  if (outA <= 0.0) return vec4(0.0);
  // Porter-Duff src-over with blended RGB:
  //   outRGB = (srcA * blendedRGB + dstA * (1-srcA) * dstStraightRGB) / outA
  // This correctly blends the result of the blend function with the
  // destination color, weighted by alpha. DO NOT simplify to
  // premult(blendedRGB, outA) — that drops the dst contribution!
  vec3 outRGB = (srcA * blendedRGB + dstA * (1.0 - srcA) * d) / outA;
  return premult(outRGB, outA);
}
`;

// ────────────────────────────────────────────────────────────
// Shared vertex shader for the composite-quad pass.
// Used by both affine and perspective paths.
// ────────────────────────────────────────────────────────────

export const COMPOSITE_VERT = /* glsl */ `#version 300 es
precision highp float;

// Quad corners, in LAYER-LOCAL space (0..naturalW, 0..naturalH).
// Specified as a triangle strip via gl_VertexID for zero-VBO drawing.
//
// Layout (TL, TR, BL, BR) — matches the quad winding used by
// homography.ts [TL, TR, BR, BL] (re-ordered here for tri-strip).
//
//   0: (0, 0)        — top-left
//   1: (naturalW, 0) — top-right
//   2: (0, naturalH) — bottom-left
//   3: (naturalW, naturalH) — bottom-right
//
// UV coordinates match (0,0), (1,0), (0,1), (1,1) — sampling the
// layer's offscreen texture.

uniform mat3 u_localToClip;      // affine: local → canvas-pixel → clip
uniform mat3 u_homography;       // perspective: local → canvas-pixel (mat3)
uniform mat3 u_ortho;            // canvas-pixel → clip
uniform vec2 u_naturalSize;      // layer natural width/height (px)
uniform vec2 u_canvasSize;       // canvas backing-store width/height (px)
uniform int  u_usePerspective;   // 0=affine, 1=perspective

out vec2 v_uv;                   // texture coordinate (0..1) into layer FBO

void main() {
  // Build quad via gl_VertexID — no VBO needed.
  vec2 localPos;
  vec2 uv;
  switch (gl_VertexID) {
    case 0: localPos = vec2(0.0, 0.0);            uv = vec2(0.0, 0.0); break;
    case 1: localPos = vec2(u_naturalSize.x, 0.0); uv = vec2(1.0, 0.0); break;
    case 2: localPos = vec2(0.0, u_naturalSize.y); uv = vec2(0.0, 1.0); break;
    case 3: localPos = u_naturalSize;              uv = vec2(1.0, 1.0); break;
    default: localPos = vec2(0.0); uv = vec2(0.0); break;
  }

  v_uv = uv;

  if (u_usePerspective == 1) {
    // Perspective path: apply homography, then output clip-space
    // position WITHOUT dividing by z — let the GPU's built-in
    // perspective divide handle it. This ensures v_uv is
    // interpolated perspective-correctly (the GPU divides all
    // varyings by gl_Position.w, then re-multiplies in the
    // fragment shader, giving correct perspective interpolation).
    //
    // Previously we divided by canvasPos.z manually and set
    // gl_Position.w = 1.0, which made the GPU use LINEAR
    // interpolation for v_uv. That caused diagonal seam artifacts
    // (one triangle correct, the other wrong) known as "nadlomy".
    vec3 canvasPos = u_homography * vec3(localPos, 1.0);
    // CRITICAL FIX (2026-06-28): also reject NEGATIVE z.
    // When canvasPos.z < 0, gl_Position.w becomes negative, which
    // causes the GPU to emit "inverted" triangles covering huge areas
    // of the viewport with clamped-edge UV samples (opaque edges of
    // the layer FBO). This makes lower layers completely invisible.
    // Original check only caught z ≈ 0, missing the negative case.
    if (canvasPos.z <= 1e-6) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0); // off-screen
      return;
    }
    // Compute clip-space coordinates in homogeneous form:
    //   clipX = 2 * canvasPos.x / (canvasPos.z * canvasW) - 1
    //         = (2 * canvasPos.x / canvasW - canvasPos.z) / canvasPos.z
    //   clipY = -(2 * canvasPos.y / (canvasPos.z * canvasH) - 1)
    //         = -(2 * canvasPos.y / canvasH - canvasPos.z) / canvasPos.z
    //
    // By setting gl_Position.w = canvasPos.z, the GPU divides
    // .xyz by .w automatically, yielding the correct screen position.
    // And because w != 1, the GPU applies perspective-correct
    // interpolation to ALL varyings (including v_uv).
    float clipX = 2.0 * canvasPos.x / u_canvasSize.x - canvasPos.z;
    float clipY = -(2.0 * canvasPos.y / u_canvasSize.y - canvasPos.z);
    gl_Position = vec4(clipX, clipY, 0.0, canvasPos.z);
  } else {
    // Affine path: direct local → clip via combined matrix.
    // w = 1.0 gives linear interpolation (correct for affine).
    vec3 clip = u_localToClip * vec3(localPos, 1.0);
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  }
}
`;

// ────────────────────────────────────────────────────────────
// Composite fragment shader — samples the layer FBO, applies blend.
// ────────────────────────────────────────────────────────────

export const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_layerTex;   // layer's offscreen FBO content
uniform sampler2D u_dstTex;     // PREVIOUS composite state (readDest.tex)
uniform float     u_opacity;    // layer opacity (0..1)
uniform int       u_blendMode;  // 0=normal, 1=multiply, 2=screen, ...
uniform int       u_needsBlend; // DEPRECATED — kept for ABI compat, ignored.
// PRESERVE-PERSPECTIVE: canvas-space clip mask.
// When u_useCanvasClip = 1, the layer is clipped to u_canvasClipTex (a
// single-channel mask rasterized from the selection polygon in canvas-pixel
// space). Pixels where mask alpha < 0.5 are fully transparent (layer invisible).
// This produces the "by canvas shape" mask mode: the visible area matches the
// selection outline exactly, regardless of the layer's perspective deformation.
uniform sampler2D u_canvasClipTex;  // canvas-space clip mask (alpha channel)
uniform int       u_useCanvasClip;  // 0 = disabled, 1 = enabled
uniform vec2      u_canvasSize;     // canvas px size (logical; used by COMPOSITE_VERT for perspective clip math)
// v2.15.2: Physical FBO render size. gl_FragCoord is in FBO-pixel space
// (0..renderW, 0..renderH), NOT logical canvas space. Using u_canvasSize
// for canvas-clip UV would produce wrong UVs when renderScale < 1.0
// (oversized documents). u_canvasSize is still used by COMPOSITE_VERT
// for perspective homogeneous clip math (that math is dimensionless).
uniform vec2      u_renderSize;     // physical FBO size (renderW, renderH)

in  vec2 v_uv;
out vec4 outColor;

${BLEND_FUNCTIONS}

void main() {
  vec4 srcPremult = texture(u_layerTex, v_uv);

  // PRESERVE-PERSPECTIVE: canvas-space clip.
  // If enabled, sample the clip mask at the current canvas-pixel position.
  // gl_FragCoord is in canvas-pixel space (0..canvasW, 0..canvasH), but
  // WebGL Y is bottom-up while the mask was rasterized top-down (Canvas2D
  // convention). We flip Y when computing the mask UV.
  //
  // v2.15.2: gl_FragCoord is in FBO-pixel space (0..renderW, 0..renderH),
  // NOT logical canvas space. We use u_renderSize (physical FBO size) for
  // the UV denominator so the mask samples correctly even when renderScale
  // < 1.0 (oversized documents). The mask texture itself was rasterized at
  // renderW × renderH, so UV must map [0..renderW] → [0..1].
  if (u_useCanvasClip == 1) {
    vec2 maskUV = vec2(
      gl_FragCoord.x / u_renderSize.x,
      1.0 - (gl_FragCoord.y / u_renderSize.y)
    );
    float clipAlpha = texture(u_canvasClipTex, maskUV).a;
    if (clipAlpha < 0.5) {
      // Outside clip polygon → layer fully transparent → write dst unchanged.
      ivec2 px = ivec2(gl_FragCoord.xy);
      outColor = texelFetch(u_dstTex, px, 0);
      return;
    }
  }

  // Apply layer opacity. Multiply both RGB (premultiplied) and A by opacity,
  // so a 50% opaque layer becomes (rgb*0.5, 0.5) — correct premultiplied form.
  srcPremult *= u_opacity;

  // -- Always sample dst from u_dstTex and blend in-shader ----------------
  //
  // CRITICAL FIX (2026-06-27, fixes "solid layer invisible under Free
  // Transform" — and more generally, "lower layers vanish when an
  // upper layer has transparent areas"):
  //
  // The previous version short-circuited normal blend mode and relied
  // on GL fixed-function blending (gl.BLEND with ONE/ONE_MINUS_SRC_ALPHA).
  // That blend uses the CURRENT FRAMEBUFFER's existing content as dst.
  // But our current framebuffer is writeDest — the EMPTY half of the
  // ping-pong pair. The actual accumulated composite (lower layers)
  // lives in readDest.tex, which is bound as u_dstTex but NOT used by
  // GL fixed-function blending.
  //
  // Result: every layer overwrote writeDest with its own content,
  // losing the contribution of all layers below. For opaque layers
  // (e.g. screentone with opaque bg) this was invisible — the upper
  // layer was supposed to cover everything anyway. For layers with
  // transparent areas (e.g. screentone with gradColorTrans or
  // transparent bg, image layers with alpha, masked layers), the
  // lower layers SHOULD show through the transparency — but they
  // didn't, because writeDest's empty content was used as dst.
  //
  // Fix: ALWAYS do manual blending in the shader, sampling dst from
  // u_dstTex (readDest.tex). GL blend is always disabled by the caller.
  // The blendPremultiplied() function correctly handles src-over for
  // mode=0 (normal), so this works for all blend modes.
  //
  // We also removed the early "discard" for transparent src. With
  // manual blending, transparent src should write dst unchanged (so
  // the lower layer shows through). Discard would skip the write,
  // leaving writeDest's empty content in place — same bug.
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 dstPremult = texelFetch(u_dstTex, px, 0);
  outColor = blendPremultiplied(srcPremult, dstPremult, u_blendMode);

  // Defensive: blendPremultiplied returns dstPremult when src is
  // fully transparent, so we always write a valid color. No discard.
}
`;

// ────────────────────────────────────────────────────────────
// Solid-color fill shader (for 'solid' layer type)
// ────────────────────────────────────────────────────────────

export const SOLID_VERT = /* glsl */ `#version 300 es
precision highp float;

// Full-screen triangle via gl_VertexID (no VBO).
// Covers clip space [-1..1] × [-1..1].
out vec2 v_uv;

void main() {
  // Two triangles covering the screen via 3 vertices ( oversized triangle trick):
  //   0: (-1, -1)   uv (0, 1)
  //   1: ( 3, -1)   uv (2, 1)
  //   2: (-1,  3)   uv (0, -1)
  // Or simpler: 6 vertices for a quad (two triangles). We use 4 + triangle strip.
  // But the simplest is fullscreen-triangle with 3 verts. Let's go with that.
  float x = float((gl_VertexID & 1) << 2) - 1.0;  // -1, 3, -1, ...
  float y = float((gl_VertexID & 2) << 1) - 1.0;  // -1, -1, 3, ...
  gl_Position = vec4(x, y, 0.0, 1.0);
  v_uv = (gl_Position.xy * 0.5) + 0.5;
}
`;

export const SOLID_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform vec4 u_color; // premultiplied RGBA (rgb*alpha, alpha)

out vec4 outColor;

void main() {
  outColor = u_color;
}
`;

// ────────────────────────────────────────────────────────────
// Image texture upload shader (for 'image' layer type, and for
// hybrid screentone patterns rendered via CPU then uploaded)
// ────────────────────────────────────────────────────────────

export const IMAGE_VERT = SOLID_VERT; // same fullscreen-triangle trick

export const IMAGE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_imageTex;

in  vec2 v_uv;
out vec4 outColor;

void main() {
  // v_uv is in [0..1]; (0,0) = top-left in the convention used by
  // COMPOSITE_VERT (which builds the quad with TL=(0,0), BR=(1,1)).
  //
  // BUG FIX (v2.9.1): previously this did (1.0 - v_uv.y) to flip Y
  // because GL Y is up but image Y is down. That was WRONG — it caused
  // imported images to render upside-down. The flip is NOT needed here
  // because:
  //   1. texImage2D uploads the HTMLImageElement with its native row
  //      order (top row first). WebGL stores this in the texture as-is.
  //   2. Sampling at v_uv=(0,0) returns the TOP-left pixel of the image
  //      (because the texture row 0 = image top row, and GL samples
  //      row 0 at v=0 when UNPACK_FLIP_Y_WEBGL is false, which it is).
  //   3. COMPOSITE_VERT maps v_uv=(0,0) to the top-left of the layer
  //      quad on screen. So sampling at v_uv without flip = correct
  //      orientation (image top-left -> screen top-left).
  //
  // The previous flip was a double-flip: it flipped the image vertically,
  // then the composite pass displayed it flipped again relative to the
  // screen. Net result: upside-down image.
  //
  // The screentone hybrid path (uploadCanvasAsTexture) does NOT flip
  // and renders correctly — this confirms no flip is needed.
  vec4 c = texture(u_imageTex, v_uv);
  // Ensure premultiplied alpha (most PNG/JPEGs are not premultiplied;
  // the upload uses UNPACK_PREMULTIPLY_ALPHA_WEBGL = true, so this
  // is a no-op for the texture itself — but defensive in case.)
  outColor = c;
}
`;

// ────────────────────────────────────────────────────────────
// Procedural screentone shaders (GLSL)
// ────────────────────────────────────────────────────────────
//
// These replace the CPU renderScreentone for the patterns we've
// ported. They share a common fragment-shader skeleton with a
// switch on u_patternType. Sharing one program avoids the cost
// of linking 12 separate programs (each ~10ms link time × 12 =
// 120ms startup time, which we'd rather not pay).
//
// Ported (Q5=A):
//   • dots (with shapes: circle, square, diamond, hexagon)
//   • lines
//   • crosshatch (two crossed line grids)
//   • checker
//
// Hybrid (CPU renderScreentone → texture upload) — TODO future:
//   • noise, gaussian_noise, stipple   (need PRNG / hash in GLSL)
//   • hexgrid                           (needs hex tiling)
//   • concentric                        (needs concentric rings)
//   • stars, hearts, triangles          (need shape SDFs)

export const SCREENTONE_VERT = SOLID_VERT; // fullscreen triangle

export const SCREENTONE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform vec2  u_resolution;     // FBO size in px (== layer natural size)
uniform int   u_patternType;    // 0=dots, 1=lines, 2=crosshatch, 3=checker
uniform int   u_dotShape;       // 0=circle, 1=square, 2=diamond, 3=hexagon
uniform float u_dotSize;        // px
uniform float u_spacingX;       // px
uniform float u_spacingY;       // px
uniform float u_angle;          // deg
uniform float u_lineWidth;      // px
uniform float u_crossAngle;     // deg
uniform vec4  u_colorPattern;   // premultiplied RGBA (foreground)
uniform vec4  u_colorBg;        // premultiplied RGBA (background)

out vec4 outColor;

const float PI = 3.141592653589793;

// Rotate vec2 by angle (radians).
vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c) * p;
}

// SDF for a circle of radius r centered at origin.
float sdfCircle(vec2 p, float r) { return length(p) - r; }

// SDF for a square (axis-aligned) of half-size r.
float sdfSquare(vec2 p, float r) {
  vec2 d = abs(p) - vec2(r);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// SDF for a diamond (rotated square) of half-diagonal r.
float sdfDiamond(vec2 p, float r) {
  // Diamond = |x| + |y| <= r. Distance: max((|x|+|y|) - r, 0).
  return (abs(p.x) + abs(p.y)) - r;
}

// SDF for a hexagon of "radius" r (point-up orientation).
float sdfHexagon(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269); // sqrt(3)/2, 1/2, 1/sqrt(3)
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

// Antialiased step: returns 1.0 inside the SDF (negative), 0.0 outside,
// with a smooth transition at the boundary.
// v2.12: Uses fwidth() for screen-space adaptive AA.
// When the layer is zoomed out / perspective-warped, the screen pixel
// covers multiple texture pixels. fwidth(d) measures how fast d changes
// per screen pixel. We use this to set the smoothstep width = exactly
// 1 screen pixel, regardless of zoom level. This prevents moire/waves
// because the edge transition always spans exactly 1 screen pixel.
//
// Without fwidth (old code): smoothstep(-0.5, 0.5, d) — fixed 1px in
// TEXTURE space. When zoomed out 2x, 1 texture px = 0.5 screen px →
// hard edge → moire. With fwidth: smoothstep(-fw, fw, d) where fw =
// fwidth(d) = 1 screen px → always smooth, no moire.
float coverageAA(float d) {
  // v2.12.1: Clamp fw to avoid division by zero in smoothstep when d is
  // constant (inside/outside shapes where fwidth=0). Gemini correctly
  // identified this as a potential NaN source on some GPU drivers.
  float fw = max(fwidth(d), 0.0001);
  return 1.0 - smoothstep(-fw, fw, d);
}

void main() {
  // Pixel coordinate with (0,0) at top-left.
  vec2 px = gl_FragCoord.xy;
  px.y = u_resolution.y - px.y; // flip Y: GL bottom-left → top-left

  // Apply canvas rotation (radians) — pattern grid rotates around canvas center.
  // (Matches engine.ts rotCanvas behavior; we use u_angle here.)
  vec2 centered = px - u_resolution * 0.5;
  centered = rot(centered, u_angle * PI / 180.0);
  centered += u_resolution * 0.5;

  // Tile coordinate: integer cell index + fractional position within cell.
  // Spacing is (u_spacingX, u_spacingY).
  vec2 cellCoord = centered / vec2(u_spacingX, u_spacingY);
  vec2 cellFloor = floor(cellCoord);
  vec2 cellFrac  = cellCoord - cellFloor; // [0..1)² within the cell

  // Cell-local pixel coordinate, centered at the cell's center (0.5, 0.5).
  vec2 localPx = (cellFrac - 0.5) * vec2(u_spacingX, u_spacingY);

  // Default: background.
  vec4 result = u_colorBg;

  if (u_patternType == 0) {
    // ── DOTS ────────────────────────────────────────────────
    // Dot sits at cell center. Size = u_dotSize.
    float r = u_dotSize * 0.5;
    float d;
    if (u_dotShape == 0)      d = sdfCircle(localPx, r);
    else if (u_dotShape == 1) d = sdfSquare(localPx, r);
    else if (u_dotShape == 2) d = sdfDiamond(localPx, r);
    else                      d = sdfHexagon(localPx, r);
    float cov = coverageAA(d);
    result = mix(u_colorBg, u_colorPattern, cov);
  }
  else if (u_patternType == 1) {
    // ── LINES ───────────────────────────────────────────────
    // Vertical lines (post-rotation) at each cell column.
    // Distance from line center = |localPx.x|.
    float halfW = u_lineWidth * 0.5;
    float d = abs(localPx.x) - halfW;
    float cov = coverageAA(d);
    result = mix(u_colorBg, u_colorPattern, cov);
  }
  else if (u_patternType == 2) {
    // ── CROSSHATCH ──────────────────────────────────────────
    // Two line grids: one at u_angle, one at u_angle + u_crossAngle.
    // We compute the second grid by re-rotating the centered coord.
    vec2 centered2 = rot(centered - u_resolution * 0.5,
                        u_crossAngle * PI / 180.0) + u_resolution * 0.5;
    vec2 cellCoord2 = centered2 / vec2(u_spacingX, u_spacingY);
    vec2 cellFrac2  = cellCoord2 - floor(cellCoord2);
    vec2 localPx2   = (cellFrac2 - 0.5) * vec2(u_spacingX, u_spacingY);

    float halfW = u_lineWidth * 0.5;
    float d1 = abs(localPx.x) - halfW;
    float d2 = abs(localPx2.x) - halfW;
    float cov1 = coverageAA(d1);
    float cov2 = coverageAA(d2);
    // Union of the two grids: take max coverage (i.e., min distance).
    float cov = max(cov1, cov2);
    result = mix(u_colorBg, u_colorPattern, cov);
  }
  else if (u_patternType == 3) {
    // ── CHECKER ─────────────────────────────────────────────
    // Classic 2-color checker: cell index parity.
    float parity = mod(cellFloor.x + cellFloor.y, 2.0);
    result = mix(u_colorBg, u_colorPattern, step(0.5, parity));
  }

  // -- Output ------------------------------------------------------
  // u_colorPattern and u_colorBg are passed as premultiplied (rgb*a, a)
  // by the TypeScript caller. mix() of two premultiplied colors gives
  // correct premultiplied output directly:
  //   result = bg_premult * (1-cov) + fg_premult * cov
  // No further premultiplication needed — the composite-quad shader
  // expects premultiplied input and this is already it.
  outColor = result;
}
`;

// ────────────────────────────────────────────────────────────
// Mask shaders (shape: ellipse/rect, with feather + invert)
// ────────────────────────────────────────────────────────────

export const MASK_VERT = SOLID_VERT;

export const MASK_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform vec2  u_resolution;   // layer FBO size
uniform int   u_shape;        // 0=ellipse, 1=rect
uniform vec4  u_bounds;       // (left, top, right, bottom) in px
uniform float u_feather;      // px, 0 = hard edge
uniform int   u_invert;       // 0 = keep inside shape, 1 = keep outside
uniform sampler2D u_layerTex; // the layer content to mask

in  vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 px = gl_FragCoord.xy;
  px.y = u_resolution.y - px.y; // flip Y

  vec2 center = (u_bounds.xy + u_bounds.zw) * 0.5;
  vec2 halfSize = (u_bounds.zw - u_bounds.xy) * 0.5;

  float maskAlpha;
  if (u_shape == 0) {
    // Ellipse: normalized distance from center.
    vec2 d = (px - center) / max(halfSize, vec2(1e-4));
    float dist = length(d); // 0 at center, 1 at edge
    if (u_feather > 0.5) {
      maskAlpha = 1.0 - smoothstep(1.0 - u_feather / max(halfSize.x, 1.0),
                                    1.0,
                                    dist);
    } else {
      maskAlpha = step(dist, 1.0);
    }
  } else {
    // Rect: distance to AABB edge.
    vec2 d = abs(px - center) - halfSize;
    float dist = max(d.x, d.y); // 0 inside, >0 outside
    if (u_feather > 0.5) {
      maskAlpha = 1.0 - smoothstep(-u_feather, 0.0, dist);
    } else {
      maskAlpha = step(dist, 0.0);
    }
  }

  if (u_invert == 1) maskAlpha = 1.0 - maskAlpha;

  // Sample the layer content at this pixel and multiply its alpha by maskAlpha.
  // We render to the SAME FBO that already has the layer content (mask is the
  // second pass), so we read dst and write back the masked version.
  // (For painted masks, the caller uses a different code path: upload the
  // painted alpha array as a texture and use it directly here.)
  vec4 layerColor = texture(u_layerTex, vec2(v_uv.x, 1.0 - v_uv.y));
  outColor = vec4(layerColor.rgb, layerColor.a * maskAlpha);
}
`;

// ────────────────────────────────────────────────────────────
// Painted-mask shader — multiplies layer alpha by a mask texture
// ────────────────────────────────────────────────────────────

export const PAINTED_MASK_VERT = SOLID_VERT;

export const PAINTED_MASK_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_layerTex;   // layer content (current FBO state)
uniform sampler2D u_maskTex;    // painted mask (single-channel alpha)
uniform vec2  u_maskOffset;     // px offset of mask within layer-local space
uniform vec2  u_maskSize;       // mask texture size in px
uniform vec2  u_layerSize;      // layer FBO size in px (renderW, renderH)
uniform int   u_invert;

in  vec2 v_uv;
out vec4 outColor;

void main() {
  vec4 layerColor = texture(u_layerTex, vec2(v_uv.x, 1.0 - v_uv.y));

  // BUG-2 FIX: Correctly map layer-space UV to mask UV using the mask's
  // sub-region (offset + size) within the layer.
  //
  // Previously the shader sampled the mask at v_uv directly, which assumes
  // the mask covers the FULL layer (offset=0, size=layerSize). That is only
  // true for masks created by the mask editor. For masks created by
  // "Mask from Selection" — which are sub-region masks (size = selection
  // bbox, offset = selection bbox origin in layer-local space) — sampling
  // at v_uv stretches the mask's alpha pattern across the entire layer,
  // producing a wrong, stretched result. This was especially broken when
  // the layer also had a perspective transform, because the (already wrong)
  // mask was then forward-warped by the perspective, producing the
  // "stretched strip" artifact reported in BUG-2.
  //
  // Correct mapping:
  //   layerPx  = v_uv * u_layerSize            (layer-local px, 0..layerSize)
  //   maskPx   = layerPx - u_maskOffset         (mask-local px, 0..maskSize inside)
  //   maskUV   = maskPx / u_maskSize            (mask texture UV, 0..1 inside)
  //
  // Pixels outside [0, maskSize] are outside the mask region: alpha = 0
  // (or 1 if inverted). This matches the Canvas2D path in composite.ts
  // (applyPaintedMask uses drawImage at offset, with 'destination-in' which
  // zeroes alpha outside the drawn rect).
  vec2 layerPx = v_uv * u_layerSize;
  vec2 maskPx = layerPx - u_maskOffset;
  vec2 maskUV = maskPx / u_maskSize;

  float maskA;
  if (any(lessThan(maskUV, vec2(0.0))) || any(greaterThan(maskUV, vec2(1.0)))) {
    // Outside mask region — fully transparent (unless inverted).
    maskA = 0.0;
  } else {
    maskA = texture(u_maskTex, vec2(maskUV.x, 1.0 - maskUV.y)).a;
  }
  if (u_invert == 1) maskA = 1.0 - maskA;

  outColor = vec4(layerColor.rgb, layerColor.a * maskA);
}
`;

// ────────────────────────────────────────────────────────────
// Program registry — keys for caching compiled programs.
// (BLEND_FUNCTIONS is declared at the top of the file.)
// ────────────────────────────────────────────────────────────

export type ProgramKey =
  | 'composite-quad'
  | 'solid-fill'
  | 'image-upload'
  | 'screentone'
  | 'mask-shape'
  | 'mask-painted';

/**
 * Map from ProgramKey to {vert, frag} source strings.
 * Used by gl-resources.ts to compile/link via twgl.
 */
export const PROGRAM_SOURCES: Record<ProgramKey, { vert: string; frag: string }> = {
  'composite-quad': { vert: COMPOSITE_VERT, frag: COMPOSITE_FRAG },
  'solid-fill':     { vert: SOLID_VERT,     frag: SOLID_FRAG },
  'image-upload':   { vert: IMAGE_VERT,     frag: IMAGE_FRAG },
  'screentone':     { vert: SCREENTONE_VERT,frag: SCREENTONE_FRAG },
  'mask-shape':     { vert: MASK_VERT,      frag: MASK_FRAG },
  'mask-painted':   { vert: PAINTED_MASK_VERT, frag: PAINTED_MASK_FRAG },
};
