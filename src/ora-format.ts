// ============================================================
// ORA FORMAT — OpenRaster export/import for GenToniK
// ============================================================
//
// OpenRaster (.ora) is an open standard for layered raster images.
// It's a ZIP archive with a specific layout:
//
//   mimetype             — must be "image/openraster", STORE'd (uncompressed)
//   settings.json        — optional app settings (we write ours here)
//   stack.xml            — layer structure (XML)
//   mergedimage.png      — flattened preview (what other apps see)
//   Thumbnails/thumbnail.png — 256×256 preview for file browsers
//   data/layerN.png      — each layer's content as PNG
//
// Why ORA over PSD/TIFF:
//   • Open standard (Creative Commons BY-SA), GPLv3-friendly
//   • Trivially parseable (just unzip + read XML + decode PNGs)
//   • Supported by Krita, MyPaint, GIMP-ORA-plugin, Drawpile
//   • No proprietary binary formats, no Adobe licensing
//
// Why ORA for GenToniK specifically:
//   • Round-trip with Krita (artist's main editor) is critical
//   • Krita can apply screentone layers non-destructively via
//     its own mask system if needed
//   • Free, doesn't lock us into Adobe's UXP/CEP ecosystem
//
// Limitations of the ORA spec we work around:
//   1. <layer> only supports x/y offset — no scale or rotation.
//      → We bake the layer's TRANSFORMED bounds into the PNG, and
//        store the original transform in custom gentonik:* attrs.
//        Other apps see a properly positioned layer; GenToniK
//        restores the full transform on round-trip.
//
//   2. No native layer mask concept (Krita extensions exist but
//      aren't standard ORA).
//      → We encode masks as base64 JSON in gentonik:mask attribute.
//      → Painted masks are stored as data/layerN-mask.png and
//        referenced from the attribute.
//
//   3. composite-op values must be SVG namespaced (svg:src-over,
//      svg:multiply, etc.). We map from our BlendMode to these.
//
// Dependency: JSZip (https://stuk.github.io/jszip/)
//   npm install jszip
//   The browser build is ~95KB minified, well within budget.
//
// All file ops are async because PNG encoding and zip compression
// happen off the main thread (canvas.toBlob is async, JSZip's
// generateAsync is async). Caller (App.tsx) must await.
// ============================================================

import JSZip from 'jszip';
import {
  Layer,
  LayerMask,
  BlendMode,
  ScreentoneParams,
  DEFAULT_PARAMS,
  getLayerNaturalSize,
  Vec2,
} from './types';
import { renderScreentone } from './engine';
import { CompositeContext } from './composite';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const ORA_MIMETYPE = 'image/openraster';

/** SVG composite-op names for ORA. Must match the SVG compositing spec. */
const BLEND_TO_SVG_OP: Record<BlendMode, string> = {
  normal: 'svg:src-over',
  multiply: 'svg:multiply',
  screen: 'svg:screen',
  overlay: 'svg:overlay',
  darken: 'svg:darken',
  lighten: 'svg:lighten',
};

const SVG_OP_TO_BLEND: Record<string, BlendMode> = Object.fromEntries(
  Object.entries(BLEND_TO_SVG_OP).map(([mode, svg]) => [svg, mode as BlendMode]),
) as Record<string, BlendMode>;

// ────────────────────────────────────────────────────────────
// Canvas helpers
// ────────────────────────────────────────────────────────────

/**
 * Create a fresh canvas of the given size, returning both the canvas
 * and its 2D context. Throws if 2D context can't be acquired (very
 * rare — only happens if the browser is out of canvas contexts).
 */
function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to acquire 2D canvas context');
  return { canvas, ctx };
}

/**
 * Encode a canvas to a PNG Blob (async). Uses canvas.toBlob which
 * defers to the browser's native PNG encoder (fast, optimized).
 */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob returned null'));
      },
      'image/png',
    );
  });
}

/**
 * Decode a PNG Blob to an HTMLImageElement. Used at import time.
 */
function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to decode PNG: ${err}`));
    };
    img.src = url;
  });
}

// ────────────────────────────────────────────────────────────
// Layer → PNG rendering (natural size, with mask, NO transform)
// ────────────────────────────────────────────────────────────

/**
 * Render a single layer to a canvas at its NATURAL size, with mask
 * applied, but WITHOUT any transform.
 *
 * This is the "what the layer actually contains" view — used for
 * ORA export (each layer's PNG must be its content, positioned via
 * x/y in stack.xml, not pre-transformed).
 *
 * For solid layers we use doc-size as the natural size — a 1×1 PNG
 * would be useless to other ORA readers.
 *
 * The transform is stored separately in gentonik:* attributes and
 * restored on import.
 */
function renderLayerToNaturalCanvas(
  layer: Layer,
  compositeCtx: CompositeContext,
): HTMLCanvasElement | null {
  const naturalSize = getLayerNaturalSize(layer, {
    docWidth: compositeCtx.docWidth,
    docHeight: compositeCtx.docHeight,
    imageSizes: compositeCtx.imageCache.sizes,
  });

  let renderW = naturalSize.w;
  let renderH = naturalSize.h;
  // v2.9: text/vector layers also get docSize override.
  if (layer.type === 'solid' || layer.type === 'transparent'
      || layer.type === 'text' || layer.type === 'vector') {
    renderW = compositeCtx.docWidth;
    renderH = compositeCtx.docHeight;
  }
  if (renderW <= 0 || renderH <= 0) return null;

  const { canvas, ctx } = makeCanvas(renderW, renderH);
  ctx.clearRect(0, 0, renderW, renderH);

  // Render content based on layer type
  switch (layer.type) {
    case 'screentone': {
      if (!layer.params) return null;
      renderScreentone(ctx, renderW, renderH, layer.params);
      break;
    }
    case 'image': {
      const img = layer.imageSrc
        ? compositeCtx.imageCache.images.get(layer.imageSrc)
        : undefined;
      if (!img) return null;
      ctx.drawImage(img, 0, 0, renderW, renderH);
      break;
    }
    case 'solid': {
      if (!layer.solidColor) return null;
      ctx.fillStyle = layer.solidColor;
      ctx.fillRect(0, 0, renderW, renderH);
      break;
    }
    case 'transparent': {
      // No content to render — the canvas is already cleared to transparent.
      // We still export an (empty) PNG so other ORA readers see a layer
      // entry; the gentonik:type="transparent" attribute signals that
      // the layer has no fill, and the mask (if any) is restored separately.
      break;
    }
    case 'text': {
      // v2.9 STUB: Text layers are not rendered by the core. We export an
      // empty PNG (so the layer entry exists in stack.xml) and serialize
      // the textData via gentonik:text-data attribute. A future TextRenderer
      // (or WebToonTools) will handle actual rendering on import.
      break;
    }
    case 'vector': {
      // v2.9 STUB: Vector layers are not rendered by the core. We export an
      // empty PNG and serialize the vectorData via gentonik:vector-data
      // attribute. A future VectorRenderer will handle rendering on import.
      break;
    }
  }

  // Apply mask (in layer-local space, same as composite.ts)
  applyMaskToCtx(ctx, layer.mask, renderW, renderH);

  return canvas;
}

/**
 * Apply a mask (shape or painted) to the given ctx using
 * destination-in compositing. Same logic as composite.ts but
 * standalone — duplicated here to avoid circular imports and
 * because the composite.ts version is tightly coupled to the
 * canvas pool.
 */
function applyMaskToCtx(
  ctx: CanvasRenderingContext2D,
  mask: LayerMask | undefined,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (!mask) return;

  if (mask.type === 'shape') {
    const { shape, bounds, feather, invert } = mask;
    const cx = (bounds.left + bounds.right) / 2;
    const cy = (bounds.top + bounds.bottom) / 2;
    const rx = (bounds.right - bounds.left) / 2;
    const ry = (bounds.bottom - bounds.top) / 2;

    ctx.save();
    if (feather > 0) {
      try { ctx.filter = `blur(${feather}px)`; } catch { /* unsupported */ }
    }
    ctx.globalCompositeOperation = invert ? 'destination-out' : 'destination-in';
    ctx.beginPath();
    if (shape === 'ellipse') {
      ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
    } else {
      ctx.rect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
    }
    ctx.fill();
    if (feather > 0) {
      ctx.filter = 'none';
      ctx.fill();
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  } else {
    // painted mask
    const { width: mw, height: mh, data, invert } = mask;
    if (mw <= 0 || mh <= 0 || data.length !== mw * mh) return;

    const { canvas: tmp, ctx: tmpCtx } = makeCanvas(mw, mh);
    const imgData = tmpCtx.createImageData(mw, mh);
    const dst = imgData.data;
    for (let i = 0; i < data.length; i++) {
      const a = data[i];
      dst[i * 4] = 255;
      dst[i * 4 + 1] = 255;
      dst[i * 4 + 2] = 255;
      dst[i * 4 + 3] = invert ? 255 - a : a;
    }
    tmpCtx.putImageData(imgData, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = invert ? 'destination-out' : 'destination-in';
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }
  void canvasWidth; void canvasHeight;
}

// ────────────────────────────────────────────────────────────
// Layer → stack.xml entry
// ────────────────────────────────────────────────────────────

/**
 * XML-escape a string for use in an attribute value.
 * Escapes: & < > " '
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Compute the layer's top-left position in document space AFTER
 * applying its transform. This is what goes into the ORA <layer>
 * x/y attributes — the position of the PNG's top-left corner
 * relative to the document's top-left.
 *
 * For layers with rotation/scale, we use the bounding box of the
 * transformed layer (so other apps see the layer positioned
 * correctly, even though they'll see a "baked" transform).
 *
 * However, for GenToniK round-trip fidelity, the PNG itself is
 * at NATURAL size (no transform baked in). So we set x/y to the
 * position where the natural-size PNG should be placed so its
 * CENTER aligns with the layer's destination center.
 *
 * This means:
 *   x = (docWidth/2 + transform.x) - naturalW/2
 *   y = (docHeight/2 + transform.y) - naturalH/2
 *
 * Other apps see a layer positioned correctly but untransformed.
 * GenToniK applies scale/rotation on top via gentonik:* attrs.
 */
function computeLayerXY(
  layer: Layer,
  compositeCtx: CompositeContext,
): { x: number; y: number; w: number; h: number } {
  const naturalSize = getLayerNaturalSize(layer, {
    docWidth: compositeCtx.docWidth,
    docHeight: compositeCtx.docHeight,
    imageSizes: compositeCtx.imageCache.sizes,
  });

  let renderW = naturalSize.w;
  let renderH = naturalSize.h;
  // v2.9: text/vector layers also get docSize override.
  if (layer.type === 'solid' || layer.type === 'transparent'
      || layer.type === 'text' || layer.type === 'vector') {
    renderW = compositeCtx.docWidth;
    renderH = compositeCtx.docHeight;
  }

  const centerX = compositeCtx.docWidth / 2 + layer.transform.x;
  const centerY = compositeCtx.docHeight / 2 + layer.transform.y;
  return {
    x: centerX - renderW / 2,
    y: centerY - renderH / 2,
    w: renderW,
    h: renderH,
  };
}

/**
 * Encode a LayerMask as a compact JSON string for storage in the
 * gentonik:mask attribute. Returns null if no mask.
 *
 * For painted masks, the alpha data is stored as a separate PNG
 * file (data/layerN-mask.png) and referenced by URL here.
 */
function encodeMaskAttr(
  mask: LayerMask | undefined,
  maskSrc: string | null,
): string | null {
  if (!mask) return null;
  if (mask.type === 'shape') {
    return JSON.stringify({
      type: 'shape',
      shape: mask.shape,
      bounds: mask.bounds,
      feather: mask.feather,
      invert: mask.invert,
    });
  } else {
    // painted — store reference to the PNG, plus metadata
    const result: Record<string, unknown> = {
      type: 'painted',
      src: maskSrc, // e.g. "data/layer3-mask.png"
      width: mask.width,
      height: mask.height,
      // A2-fix-mask-transform (2026-06-25): mask anchor in layer-local space.
      // Older .ora files (pre-fix) won't have these — import defaults to 0
      // (mask editor always paints at 0,0; selection tools always set them).
      offsetX: mask.offsetX,
      offsetY: mask.offsetY,
      invert: mask.invert,
    };
    // PRESERVE-PERSPECTIVE: canvas-space mask polygon (for "by canvas shape" mode).
    // Stored as part of the mask JSON so it round-trips through .ora save/load.
    if (mask.canvasSpacePolygon) {
      result.canvasSpacePolygon = mask.canvasSpacePolygon;
    }
    return JSON.stringify(result);
  }
}

/**
 * Build the <layer> XML element for a single layer.
 *
 * @param layer       The layer
 * @param layerIndex  0-based index (used for filename)
 * @param maskSrc     If layer has a painted mask, the filename
 *                    for the mask PNG; null otherwise
 * @param compositeCtx Document context
 */
function buildLayerElement(
  layer: Layer,
  layerIndex: number,
  maskSrc: string | null,
  compositeCtx: CompositeContext,
): string {
  const { x, y } = computeLayerXY(layer, compositeCtx);
  const src = `data/layer${layerIndex}.png`;
  const visibility = layer.visible ? 'visible' : 'hidden';
  const svgOp = BLEND_TO_SVG_OP[layer.blendMode];
  const opacity = layer.opacity.toFixed(3);

  // GenToniK-specific attributes (namespaced). Other ORA readers
  // will ignore these per XML rules.
  const gentonikAttrs: string[] = [
    `gentonik:layer-id="${xmlEscape(layer.id)}"`,
    `gentonik:type="${layer.type}"`,
    `gentonik:transform-x="${layer.transform.x.toFixed(2)}"`,
    `gentonik:transform-y="${layer.transform.y.toFixed(2)}"`,
    `gentonik:scale-x="${layer.transform.scaleX.toFixed(4)}"`,
    `gentonik:scale-y="${layer.transform.scaleY.toFixed(4)}"`,
    `gentonik:rotation="${layer.transform.rotation.toFixed(2)}"`,
    `gentonik:skew-x="${layer.transform.skewX.toFixed(2)}"`,
    `gentonik:skew-y="${layer.transform.skewY.toFixed(2)}"`,
    `gentonik:created-at="${layer.createdAt}"`,
    `gentonik:updated-at="${layer.updatedAt}"`,
  ];

  // A3: Serialize perspective corners (if set).
  if (layer.transform.corners) {
    const c = layer.transform.corners;
    gentonikAttrs.push(
      `gentonik:corner-tl-x="${c[0].x.toFixed(2)}"`,
      `gentonik:corner-tl-y="${c[0].y.toFixed(2)}"`,
      `gentonik:corner-tr-x="${c[1].x.toFixed(2)}"`,
      `gentonik:corner-tr-y="${c[1].y.toFixed(2)}"`,
      `gentonik:corner-br-x="${c[2].x.toFixed(2)}"`,
      `gentonik:corner-br-y="${c[2].y.toFixed(2)}"`,
      `gentonik:corner-bl-x="${c[3].x.toFixed(2)}"`,
      `gentonik:corner-bl-y="${c[3].y.toFixed(2)}"`,
    );
  }

  if (layer.naturalWidth !== undefined) {
    gentonikAttrs.push(`gentonik:natural-width="${layer.naturalWidth}"`);
  }
  if (layer.naturalHeight !== undefined) {
    gentonikAttrs.push(`gentonik:natural-height="${layer.naturalHeight}"`);
  }

  // Type-specific payload
  if (layer.type === 'solid' && layer.solidColor) {
    gentonikAttrs.push(`gentonik:solid-color="${xmlEscape(layer.solidColor)}"`);
  }
  if (layer.type === 'screentone' && layer.params) {
    // Encode full ScreentoneParams as base64 JSON so we don't lose
    // any setting on round-trip. The XML stays readable for the
    // common attrs (name, opacity, blend, position), and the dense
    // params blob is base64.
    const paramsJson = JSON.stringify(layer.params);
    const b64 = btoa(unescape(encodeURIComponent(paramsJson)));
    gentonikAttrs.push(`gentonik:params-b64="${b64}"`);
  }
  if (layer.type === 'image' && layer.imageSrc) {
    // For image layers, the imageSrc is a data: URL stored inline.
    // It's already base64 in that case, so we just reference it.
    gentonikAttrs.push(`gentonik:image-src-b64="${btoa(unescape(encodeURIComponent(layer.imageSrc)))}"`);
  }
  // v2.9: Text / Vector layer payload serialization (STUB).
  // We serialize the full textData / vectorData as base64 JSON so the .ora
  // round-trips perfectly. On import, the data is restored; the core just
  // doesn't render it (a future plugin will).
  if (layer.type === 'text' && layer.textData) {
    const json = JSON.stringify(layer.textData);
    gentonikAttrs.push(`gentonik:text-data-b64="${btoa(unescape(encodeURIComponent(json)))}"`);
  }
  if (layer.type === 'vector' && layer.vectorData) {
    const json = JSON.stringify(layer.vectorData);
    gentonikAttrs.push(`gentonik:vector-data-b64="${btoa(unescape(encodeURIComponent(json)))}"`);
  }
  // v2.9: colorSpace (per-layer) + meta (plugin metadata bag).
  if (layer.colorSpace && layer.colorSpace !== 'srgb') {
    gentonikAttrs.push(`gentonik:color-space="${xmlEscape(layer.colorSpace)}"`);
  }
  if (layer.meta && Object.keys(layer.meta).length > 0) {
    const json = JSON.stringify(layer.meta);
    gentonikAttrs.push(`gentonik:meta-b64="${btoa(unescape(encodeURIComponent(json)))}"`);
  }

  // Mask
  const maskAttr = encodeMaskAttr(layer.mask, maskSrc);
  if (maskAttr) {
    gentonikAttrs.push(`gentonik:mask="${xmlEscape(maskAttr)}"`);
  }

  return (
    `  <layer ` +
    `name="${xmlEscape(layer.name)}" ` +
    `src="${src}" ` +
    `x="${Math.round(x)}" y="${Math.round(y)}" ` +
    `opacity="${opacity}" ` +
    `composite-op="${svgOp}" ` +
    `visibility="${visibility}" ` +
    `${gentonikAttrs.join(' ')}` +
    `/>`
  );
}

// ────────────────────────────────────────────────────────────
// Export: Layers → .ora Blob
// ────────────────────────────────────────────────────────────

/**
 * Result of an export operation.
 */
export interface OraExportResult {
  /** The .ora file as a Blob (ready for download or Tauri save) */
  blob: Blob;
  /** Suggested filename including extension */
  suggestedFilename: string;
}

/**
 * Export the given layers as an OpenRaster (.ora) file.
 *
 * Pipeline:
 *   1. For each layer, render to PNG at natural size with mask
 *      applied. Painted masks are saved as separate PNGs.
 *   2. Composite all layers onto a single canvas for mergedimage.png
 *      (this BAKES transforms/blends — it's the "what you see" view).
 *   3. Generate a 256px thumbnail from the merged image.
 *   4. Build stack.xml with all layer entries + gentonik attrs.
 *   5. Write mimetype (STORE'd, MUST be first), then everything else.
 *
 * @param layers        Layers, bottom-to-top
 * @param compositeCtx  Document size + image cache
 * @param filename      Suggested filename (without extension)
 */
export async function exportOra(
  layers: Layer[],
  compositeCtx: CompositeContext,
  filename: string = 'untitled',
): Promise<OraExportResult> {
  const { docWidth, docHeight } = compositeCtx;
  const zip = new JSZip();

  // ── 1. mimetype MUST be first and uncompressed ──────────
  // JSZip doesn't guarantee file order, but if we add it first
  // and use compression:'STORE' it works in practice. This is
  // what the spec requires for ORA readers to identify the file.
  zip.file('mimetype', ORA_MIMETYPE, { compression: 'STORE' });

  // ── 2. Render each layer to PNG ─────────────────────────
  const layerCanvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const canvas = renderLayerToNaturalCanvas(layer, compositeCtx);
    if (canvas) {
      layerCanvases.push(canvas);
      const blob = await canvasToPngBlob(canvas);
      zip.file(`data/layer${i}.png`, blob);

      // If layer has a painted mask, save the mask as a separate PNG
      if (layer.mask?.type === 'painted') {
        const maskCanvas = makeCanvas(layer.mask.width, layer.mask.height).canvas;
        const maskCtx = maskCanvas.getContext('2d')!;
        const imgData = maskCtx.createImageData(layer.mask.width, layer.mask.height);
        const dst = imgData.data;
        for (let p = 0; p < layer.mask.data.length; p++) {
          const a = layer.mask.invert ? 255 - layer.mask.data[p] : layer.mask.data[p];
          dst[p * 4] = 255;
          dst[p * 4 + 1] = 255;
          dst[p * 4 + 2] = 255;
          dst[p * 4 + 3] = a;
        }
        maskCtx.putImageData(imgData, 0, 0);
        const maskBlob = await canvasToPngBlob(maskCanvas);
        zip.file(`data/layer${i}-mask.png`, maskBlob);
      }
    } else {
      // Layer couldn't be rendered (image not loaded, etc.)
      // We still need a placeholder so layer indices line up.
      const placeholder = makeCanvas(1, 1).canvas;
      const placeholderBlob = await canvasToPngBlob(placeholder);
      zip.file(`data/layer${i}.png`, placeholderBlob);
      layerCanvases.push(placeholder);
    }
  }

  // ── 3. Build mergedimage.png (flattened preview) ────────
  // We use composite.ts's compositeLayers via dynamic import to
  // avoid a static circular dependency (composite.ts imports from
  // engine.ts which imports from roundness.ts — none of those
  // import ora-format.ts, so this is actually safe to import
  // statically. But keeping it lazy for clarity.)
  const { compositeLayers } = await import('./composite');
  const mergedCanvas = makeCanvas(docWidth, docHeight).canvas;
  const mergedCtx = mergedCanvas.getContext('2d')!;
  // Start with transparent background — ORA spec says mergedimage
  // should be what the user sees, which for us is the composite
  // of all visible layers (no automatic white background).
  mergedCtx.clearRect(0, 0, docWidth, docHeight);
  compositeLayers(mergedCtx, layers, compositeCtx);
  const mergedBlob = await canvasToPngBlob(mergedCanvas);
  zip.file('mergedimage.png', mergedBlob);

  // ── 4. Build thumbnail (256px max dimension, preserving aspect) ──
  const thumbMaxSize = 256;
  const thumbScale = Math.min(
    thumbMaxSize / docWidth,
    thumbMaxSize / docHeight,
    1, // don't upscale tiny images
  );
  const thumbW = Math.max(1, Math.round(docWidth * thumbScale));
  const thumbH = Math.max(1, Math.round(docHeight * thumbScale));
  const thumbCanvas = makeCanvas(thumbW, thumbH).canvas;
  const thumbCtx = thumbCanvas.getContext('2d')!;
  thumbCtx.imageSmoothingEnabled = true;
  thumbCtx.imageSmoothingQuality = 'high';
  thumbCtx.drawImage(mergedCanvas, 0, 0, thumbW, thumbH);
  const thumbBlob = await canvasToPngBlob(thumbCanvas);
  zip.folder('Thumbnails')!.file('thumbnail.png', thumbBlob);

  // ── 5. Build stack.xml ──────────────────────────────────
  const layerXml = layers.map((layer, i) => {
    const maskSrc = layer.mask?.type === 'painted' ? `data/layer${i}-mask.png` : null;
    return buildLayerElement(layer, i, maskSrc, compositeCtx);
  }).join('\n');

  const stackXml = `<?xml version='1.0' encoding='UTF-8'?>
<image w="${docWidth}" h="${docHeight}">
  <stack>
${layerXml}
  </stack>
</image>`;

  zip.file('stack.xml', stackXml);

  // ── 6. settings.json (GenToniK-specific) ────────────────
  // Stores app version, export timestamp, etc. Other ORA readers
  // will ignore this file (it's not part of the spec).
  const settings = {
    'app': 'gentonik',
    'app-version': 2,
    'exported-at': Date.now(),
    'layer-count': layers.length,
  };
  zip.file('settings.json', JSON.stringify(settings, null, 2));

  // ── 7. Generate the zip ─────────────────────────────────
  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/octet-stream',
    // Default compression for everything except mimetype (which
    // we already marked STORE'd above).
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const safeFilename = filename.replace(/[^a-z0-9-_]/gi, '_').toLowerCase();
  return {
    blob,
    suggestedFilename: `${safeFilename || 'untitled'}.ora`,
  };
}

// ────────────────────────────────────────────────────────────
// Import: .ora Blob → Layers
// ────────────────────────────────────────────────────────────

/**
 * Result of an import operation.
 */
export interface OraImportResult {
  /** Decoded layers, in stack order (bottom-to-top) */
  layers: Layer[];
  /** Document width from <image w="..."> */
  docWidth: number;
  /** Document height from <image h="..."> */
  docHeight: number;
  /** Number of layers that had to be downgraded (lost transform info) */
  downgradedLayers: number;
  /** Any non-fatal warnings (e.g., missing thumbnail) */
  warnings: string[];
}

/**
 * Parse the stack.xml file and extract layer metadata.
 *
 * Returns an array of intermediate objects — the actual layer
 * creation (including loading PNGs) happens in importOra().
 */
interface ParsedLayerEntry {
  index: number;
  name: string;
  src: string;
  x: number;
  y: number;
  opacity: number;
  compositeOp: string;
  visibility: string;
  // gentonik:* attributes (optional — fall back to defaults if absent)
  gentonikLayerId?: string;
  gentonikType?: string;
  gentonikTransformX?: number;
  gentonikTransformY?: number;
  gentonikScaleX?: number;
  gentonikScaleY?: number;
  gentonikRotation?: number;
  gentonikSkewX?: number;
  gentonikSkewY?: number;
  gentonikCreatedAt?: number;
  gentonikUpdatedAt?: number;
  gentonikSolidColor?: string;
  gentonikParamsB64?: string;
  gentonikImageSrcB64?: string;
  gentonikTextDataB64?: string;       // v2.9: text layer payload
  gentonikVectorDataB64?: string;     // v2.9: vector layer payload
  gentonikColorSpace?: string;        // v2.9: per-layer color space
  gentonikMetaB64?: string;           // v2.9: plugin metadata bag
  gentonikMask?: string;
  gentonikNaturalWidth?: number;
  gentonikNaturalHeight?: number;
  gentonikCorners?: [Vec2, Vec2, Vec2, Vec2];
}

function parseStackXml(xml: string): { width: number; height: number; layers: ParsedLayerEntry[] } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`Invalid XML in stack.xml: ${parseError.textContent}`);
  }

  const imageEl = doc.querySelector('image');
  if (!imageEl) throw new Error('stack.xml: missing <image> root element');

  const width = parseInt(imageEl.getAttribute('w') ?? '0', 10);
  const height = parseInt(imageEl.getAttribute('h') ?? '0', 10);
  if (!width || !height) throw new Error(`stack.xml: invalid image dimensions (${width}×${height})`);

  // Query all <layer> elements anywhere in the stack (handles nested
  // <stack> elements too, which some ORA writers use for groups).
  const layerEls = Array.from(doc.querySelectorAll('layer'));
  const layers: ParsedLayerEntry[] = layerEls.map((el, i) => {
    const getAttr = (name: string) => el.getAttribute(name) ?? undefined;

    const entry: ParsedLayerEntry = {
      index: i,
      name: getAttr('name') ?? `Layer ${i}`,
      src: getAttr('src') ?? `data/layer${i}.png`,
      x: parseFloat(getAttr('x') ?? '0'),
      y: parseFloat(getAttr('y') ?? '0'),
      opacity: parseFloat(getAttr('opacity') ?? '1'),
      compositeOp: getAttr('composite-op') ?? 'svg:src-over',
      visibility: getAttr('visibility') ?? 'visible',
    };

    // Parse gentonik:* attributes (use getAttribute with full name
    // — namespace-prefixed attrs are stored as-is in the DOM).
    const gId = getAttr('gentonik:layer-id');
    if (gId) entry.gentonikLayerId = gId;
    const gType = getAttr('gentonik:type');
    if (gType) entry.gentonikType = gType;
    const gTx = getAttr('gentonik:transform-x');
    if (gTx !== undefined) entry.gentonikTransformX = parseFloat(gTx);
    const gTy = getAttr('gentonik:transform-y');
    if (gTy !== undefined) entry.gentonikTransformY = parseFloat(gTy);
    const gSx = getAttr('gentonik:scale-x');
    if (gSx !== undefined) entry.gentonikScaleX = parseFloat(gSx);
    const gSy = getAttr('gentonik:scale-y');
    if (gSy !== undefined) entry.gentonikScaleY = parseFloat(gSy);
    const gRot = getAttr('gentonik:rotation');
    if (gRot !== undefined) entry.gentonikRotation = parseFloat(gRot);
    const gSkewX = getAttr('gentonik:skew-x');
    if (gSkewX !== undefined) entry.gentonikSkewX = parseFloat(gSkewX);
    const gSkewY = getAttr('gentonik:skew-y');
    if (gSkewY !== undefined) entry.gentonikSkewY = parseFloat(gSkewY);
    const gCa = getAttr('gentonik:created-at');
    if (gCa !== undefined) entry.gentonikCreatedAt = parseInt(gCa, 10);
    const gUa = getAttr('gentonik:updated-at');
    if (gUa !== undefined) entry.gentonikUpdatedAt = parseInt(gUa, 10);
    const gSc = getAttr('gentonik:solid-color');
    if (gSc) entry.gentonikSolidColor = gSc;
    const gPb = getAttr('gentonik:params-b64');
    if (gPb) entry.gentonikParamsB64 = gPb;
    const gIs = getAttr('gentonik:image-src-b64');
    if (gIs) entry.gentonikImageSrcB64 = gIs;
    // v2.9: text / vector / colorSpace / meta
    const gTd = getAttr('gentonik:text-data-b64');
    if (gTd) entry.gentonikTextDataB64 = gTd;
    const gVd = getAttr('gentonik:vector-data-b64');
    if (gVd) entry.gentonikVectorDataB64 = gVd;
    const gCs = getAttr('gentonik:color-space');
    if (gCs) entry.gentonikColorSpace = gCs;
    const gMeta = getAttr('gentonik:meta-b64');
    if (gMeta) entry.gentonikMetaB64 = gMeta;
    const gM = getAttr('gentonik:mask');
    if (gM) entry.gentonikMask = gM;
    const gNw = getAttr('gentonik:natural-width');
    if (gNw !== undefined) entry.gentonikNaturalWidth = parseFloat(gNw);
    const gNh = getAttr('gentonik:natural-height');
    if (gNh !== undefined) entry.gentonikNaturalHeight = parseFloat(gNh);

    const gCTlx = getAttr('gentonik:corner-tl-x');
    const gCTly = getAttr('gentonik:corner-tl-y');
    const gCTrx = getAttr('gentonik:corner-tr-x');
    const gCTry = getAttr('gentonik:corner-tr-y');
    const gCBrx = getAttr('gentonik:corner-br-x');
    const gCBry = getAttr('gentonik:corner-br-y');
    const gCBlx = getAttr('gentonik:corner-bl-x');
    const gCBly = getAttr('gentonik:corner-bl-y');
    if (
      gCTlx !== undefined && gCTly !== undefined &&
      gCTrx !== undefined && gCTry !== undefined &&
      gCBrx !== undefined && gCBry !== undefined &&
      gCBlx !== undefined && gCBly !== undefined
    ) {
      entry.gentonikCorners = [
        { x: parseFloat(gCTlx), y: parseFloat(gCTly) },
        { x: parseFloat(gCTrx), y: parseFloat(gCTry) },
        { x: parseFloat(gCBrx), y: parseFloat(gCBry) },
        { x: parseFloat(gCBlx), y: parseFloat(gCBly) },
      ];
    }

    return entry;
  });

  return { width, height, layers };
}

/**
 * Decode a base64-encoded UTF-8 string back to its original string.
 * Inverse of btoa(unescape(encodeURIComponent(str))).
 */
function b64ToUtf8(b64: string): string {
  return decodeURIComponent(escape(atob(b64)));
}

/**
 * Import an OpenRaster (.ora) file and convert it to GenToniK layers.
 *
 * What's preserved on round-trip (GenToniK → ORA → GenToniK):
 *   • Layer order, names, visibility, opacity, blend mode
 *   • Layer type (screentone/image/solid/transparent)
 *   • Full ScreentoneParams (via gentonik:params-b64)
 *   • Full LayerTransform (via gentonik:transform-* / scale-* / rotation)
 *   • Layer masks (shape or painted, via gentonik:mask + data/layerN-mask.png)
 *   • Layer IDs and timestamps
 *
 * What falls back gracefully when opening files from OTHER apps:
 *   • Layers without gentonik:* attrs become 'image' layers (the
 *     PNG is loaded as a raster image)
 *   • Blend mode is mapped from the SVG composite-op (svg:multiply
 *     → multiply, etc.); unknown ops fall back to 'normal'
 *   • Transform is identity (x/y in stack.xml positions the image,
 *     but we don't know the original scale/rotation)
 *   • No mask info is recovered (other apps use their own mask
 *     conventions, which we don't try to parse)
 *
 * @param blob  The .ora file as a Blob (from file input or fetch)
 */
export async function importOra(blob: Blob): Promise<OraImportResult> {
  const warnings: string[] = [];
  let downgradedLayers = 0;

  // ── 1. Load the zip ─────────────────────────────────────
  const zip = await JSZip.loadAsync(blob);

  // Verify mimetype
  const mimetypeFile = zip.file('mimetype');
  if (!mimetypeFile) {
    throw new Error('Not an ORA file: missing mimetype entry');
  }
  const mimetype = await mimetypeFile.async('string');
  if (mimetype.trim() !== ORA_MIMETYPE) {
    throw new Error(`Not an ORA file: mimetype is "${mimetype}", expected "${ORA_MIMETYPE}"`);
  }

  // ── 2. Parse stack.xml ──────────────────────────────────
  const stackFile = zip.file('stack.xml');
  if (!stackFile) throw new Error('ORA file missing stack.xml');

  const stackXml = await stackFile.async('string');
  const { width: docWidth, height: docHeight, layers: parsed } = parseStackXml(stackXml);

  if (docWidth <= 0 || docHeight <= 0) {
    throw new Error(`Invalid document dimensions: ${docWidth}×${docHeight}`);
  }

  // ── 3. Decode each layer ────────────────────────────────
  const layers: Layer[] = [];
  let nextLayerId = 0;

  for (const entry of parsed) {
    nextLayerId++;

    // Extract the layer PNG
    const layerPngFile = zip.file(entry.src);
    if (!layerPngFile) {
      warnings.push(`Layer "${entry.name}": missing PNG at ${entry.src}, skipping.`);
      continue;
    }
    const layerPngBlob = await layerPngFile.async('blob');
    const layerImg = await blobToImage(layerPngBlob);

    // Convert the image to a data URL for storage in Layer.imageSrc
    // (composite.ts expects imageSrc to be a usable URL)
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(layerPngBlob);
    });

    // Map SVG composite-op back to our BlendMode
    const blendMode: BlendMode = SVG_OP_TO_BLEND[entry.compositeOp] ?? 'normal';
    if (!SVG_OP_TO_BLEND[entry.compositeOp]) {
      warnings.push(`Layer "${entry.name}": unknown composite-op "${entry.compositeOp}", using 'normal'.`);
    }

    // Reconstruct transform. If gentonik attrs are present, use them.
    // Otherwise, derive x/y from the ORA <layer> x/y (which positions
    // the PNG's top-left in document space → convert to center offset).
    const now = Date.now();
    const transform = {
      x: entry.gentonikTransformX ?? (
        // Fallback: derive from ORA x/y. PNG center is at
        // (x + imgW/2, y + imgH/2) in doc space. Layer transform.x
        // is offset from doc center, so:
        //   transformX = (x + imgW/2) - docWidth/2
        entry.x + layerImg.naturalWidth / 2 - docWidth / 2
      ),
      y: entry.gentonikTransformY ?? (
        entry.y + layerImg.naturalHeight / 2 - docHeight / 2
      ),
      scaleX: entry.gentonikScaleX ?? 1,
      scaleY: entry.gentonikScaleY ?? 1,
      rotation: entry.gentonikRotation ?? 0,
      skewX: entry.gentonikSkewX ?? 0,
      skewY: entry.gentonikSkewY ?? 0,
      corners: entry.gentonikCorners ?? null,
    };

    // Determine layer type. If gentonik:type is set, use it.
    // Otherwise, it's a foreign ORA → treat as 'image' layer.
    let layerType: Layer['type'] = 'image';
    if (entry.gentonikType === 'screentone') layerType = 'screentone';
    else if (entry.gentonikType === 'solid') layerType = 'solid';
    else if (entry.gentonikType === 'transparent') layerType = 'transparent';
    else if (entry.gentonikType === 'text') layerType = 'text';
    else if (entry.gentonikType === 'vector') layerType = 'vector';
    else if (entry.gentonikType === 'image') layerType = 'image';
    else downgradedLayers++;

    // Decode mask if present
    let mask: LayerMask | undefined;
    if (entry.gentonikMask) {
      try {
        const maskSpec = JSON.parse(entry.gentonikMask);
        if (maskSpec.type === 'shape') {
          mask = {
            type: 'shape',
            shape: maskSpec.shape,
            bounds: maskSpec.bounds,
            feather: maskSpec.feather,
            invert: maskSpec.invert,
          };
        } else if (maskSpec.type === 'painted' && maskSpec.src) {
          // Load the mask PNG and convert back to Uint8Array alpha
          const maskPngFile = zip.file(maskSpec.src);
          if (maskPngFile) {
            const maskPngBlob = await maskPngFile.async('blob');
            const maskImg = await blobToImage(maskPngBlob);
            const maskCanvas = makeCanvas(maskImg.naturalWidth, maskImg.naturalHeight).canvas;
            const maskCtx = maskCanvas.getContext('2d')!;
            maskCtx.drawImage(maskImg, 0, 0);
            const maskImageData = maskCtx.getImageData(0, 0, maskImg.naturalWidth, maskImg.naturalHeight);
            // Extract alpha channel only
            const alphaData = new Uint8Array(maskImageData.width * maskImageData.height);
            for (let p = 0; p < alphaData.length; p++) {
              // If invert was true at export time, the PNG already
              // contains inverted alpha. We invert again at apply
              // time, so we need to un-invert here to store the
              // "original" alpha. Actually, simpler: we store what
              // the PNG contains, and set invert=false on import.
              alphaData[p] = maskImageData.data[p * 4 + 3];
            }
            mask = {
              type: 'painted',
              width: maskImageData.width,
              height: maskImageData.height,
              data: alphaData,
              // A2-fix-mask-transform (2026-06-25): restore layer-local anchor.
              // Older .ora files (pre-fix) lack these fields → default to 0,
              // which is correct for mask-editor-painted full-size masks.
              offsetX: typeof maskSpec.offsetX === 'number' ? maskSpec.offsetX : 0,
              offsetY: typeof maskSpec.offsetY === 'number' ? maskSpec.offsetY : 0,
              invert: false, // already baked into the PNG at export
            };
            // PRESERVE-PERSPECTIVE: restore canvas-space mask polygon if present.
            if (Array.isArray(maskSpec.canvasSpacePolygon) && maskSpec.canvasSpacePolygon.length >= 3) {
              mask.canvasSpacePolygon = maskSpec.canvasSpacePolygon.map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }));
            }
          }
        }
      } catch (err) {
        warnings.push(`Layer "${entry.name}": failed to decode mask: ${(err as Error).message}`);
      }
    }

    // Build the layer object
    const layer: Layer = {
      id: entry.gentonikLayerId ?? `layer-${now}-${nextLayerId}`,
      name: entry.name,
      type: layerType,
      visible: entry.visibility !== 'hidden',
      opacity: Math.max(0, Math.min(1, entry.opacity)),
      blendMode,
      transform,
      mask,
      createdAt: entry.gentonikCreatedAt ?? now,
      updatedAt: entry.gentonikUpdatedAt ?? now,
    };

    if (entry.gentonikNaturalWidth !== undefined) {
      layer.naturalWidth = entry.gentonikNaturalWidth;
    }
    if (entry.gentonikNaturalHeight !== undefined) {
      layer.naturalHeight = entry.gentonikNaturalHeight;
    }

    // Type-specific payload
    if (layerType === 'screentone' && entry.gentonikParamsB64) {
      try {
        const paramsJson = b64ToUtf8(entry.gentonikParamsB64);
        const params = JSON.parse(paramsJson) as ScreentoneParams;
        // Merge with DEFAULT_PARAMS for forward-compat (new fields
        // added in future versions get default values)
        layer.params = { ...DEFAULT_PARAMS, ...params };
      } catch (err) {
        warnings.push(`Layer "${entry.name}": failed to decode params, falling back to image layer: ${(err as Error).message}`);
        layer.type = 'image';
        layer.imageSrc = dataUrl;
        downgradedLayers++;
      }
    } else if (layerType === 'solid' && entry.gentonikSolidColor) {
      layer.solidColor = entry.gentonikSolidColor;
    } else if (layerType === 'transparent') {
      // No payload to restore — transparent layers have no fill or image.
      // The mask (if any) was already decoded above and assigned to `mask`,
      // which gets attached to the layer below.
    } else if (layerType === 'text') {
      // v2.9: Restore text layer data from base64 JSON.
      if (entry.gentonikTextDataB64) {
        try {
          layer.textData = JSON.parse(b64ToUtf8(entry.gentonikTextDataB64));
        } catch (err) {
          warnings.push(`Layer "${entry.name}": failed to decode text-data: ${(err as Error).message}`);
        }
      }
    } else if (layerType === 'vector') {
      // v2.9: Restore vector layer data from base64 JSON.
      if (entry.gentonikVectorDataB64) {
        try {
          layer.vectorData = JSON.parse(b64ToUtf8(entry.gentonikVectorDataB64));
        } catch (err) {
          warnings.push(`Layer "${entry.name}": failed to decode vector-data: ${(err as Error).message}`);
        }
      }
    } else if (layerType === 'image') {
      // For image layers, prefer the gentonik:image-src-b64 if present
      // (it preserves the original data URL), otherwise use the
      // freshly-decoded PNG.
      if (entry.gentonikImageSrcB64) {
        try {
          layer.imageSrc = b64ToUtf8(entry.gentonikImageSrcB64);
        } catch {
          layer.imageSrc = dataUrl;
        }
      } else {
        layer.imageSrc = dataUrl;
      }
    } else {
      // Type mismatch — fall back to image layer
      layer.type = 'image';
      layer.imageSrc = dataUrl;
      downgradedLayers++;
    }

    // v2.9: Restore per-layer colorSpace and plugin metadata (meta).
    if (entry.gentonikColorSpace) {
      layer.colorSpace = entry.gentonikColorSpace as Layer['colorSpace'];
    }
    if (entry.gentonikMetaB64) {
      try {
        layer.meta = JSON.parse(b64ToUtf8(entry.gentonikMetaB64));
      } catch {
        // Ignore malformed meta — it's optional.
      }
    }

    layers.push(layer);
  }

  // ── 4. Verify mergedimage.png exists (informational) ────
  const mergedFile = zip.file('mergedimage.png');
  if (!mergedFile) {
    warnings.push('File missing mergedimage.png — preview may be unavailable in other apps.');
  }

  return {
    layers,
    docWidth,
    docHeight,
    downgradedLayers,
    warnings,
  };
}

// ────────────────────────────────────────────────────────────
// Convenience: round-trip helpers
// ────────────────────────────────────────────────────────────

/**
 * Save layers to a .ora file and trigger a browser download.
 *
 * Uses the standard browser download mechanism (anchor + click).
 * For Tauri builds, App.tsx may want to replace this with the
 * Tauri FS API for native save dialogs.
 *
 * @param layers        Layers to save
 * @param compositeCtx  Document context
 * @param filename      Suggested filename (without extension)
 * @returns The export result (in case the caller wants the Blob too)
 */
export async function saveOraFile(
  layers: Layer[],
  compositeCtx: CompositeContext,
  filename: string,
): Promise<OraExportResult> {
  const result = await exportOra(layers, compositeCtx, filename);

  // Trigger browser download
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.suggestedFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return result;
}

/**
 * Open a .ora file from a File input element and convert to layers.
 *
 * Convenience wrapper around importOra(blob) that handles the
 * File → Blob conversion (File extends Blob, so it's a no-op
 * cast, but this makes the API intent clear).
 */
export async function openOraFile(file: File): Promise<OraImportResult> {
  return importOra(file);
}

// ────────────────────────────────────────────────────────────
// Validation helpers (used by App.tsx for file-input acceptance)
// ────────────────────────────────────────────────────────────

/**
 * Check if a file looks like an ORA file based on extension and
 * MIME type. Doesn't actually open the file — just a quick check
 * for the file input's accept filter and drag-drop validation.
 *
 * Note: many operating systems don't have a registered MIME type
 * for .ora, so we can't rely on file.type alone. We accept any
 * file with .ora extension OR image/openraster MIME type.
 */
export function isOraFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.ora') || file.type === ORA_MIMETYPE;
}

/**
 * The accept string for an <input type="file"> that should only
 * accept ORA files. Used by App.tsx.
 */
export const ORA_FILE_ACCEPT = '.ora,image/openraster,application/octet-stream';
