# GenToniK — Единый план (Plan.md)

> Обновлено: 2026-06-29 (transparent layers + BUG-C + rulers/scrollbar plan)
> Статус: Фаза стабилизации — transparent layers сделаны, BUG-C задокументирован, планируем rulers+scrollbar связкой

> ⚠️ АКТУАЛЬНЫЙ ПОРЯДОК РАБОТ — см. раздел 9 в конце файла.
> Раздел 0 ниже устарел и оставлен только для исторической справки.

---

## 0. Приоритетный порядок работ (УСТАРЕВШИЙ — см. раздел 9)

```
1. [30 мин]  1.1 Gemini patches (canvas-hint → DOM badge) — быстрый win
2. [2-3 дня] 1.6 Вкладки + 1.7 New Document dialog + 1.8 Color profile
             — ФУНДАМЕНТАЛЬНО: меняет архитектуру с single-doc на multi-doc
             — Вводит colorProfile в data model (forward-compat для WebToonTools/CMYK)
3. [1-2 дня] 1.3+1.4 Undo/Redo для selection + физические кнопки
4. [0.5 дня] 2.4 WebGL edge cases (context loss — stability)
5. [1 час]   1.5 Mirror Screen (hotkey M)
6. [0.5 дня] 1.2 Skew по образцу Krita
7. [1 день]  7. Forward-compat хуки (stubs + meta + plugin registry)
8. [дальше]  Stage 2-5: tile system, viewport culling, commit cache, tone
```

**Почему такой порядок:**
- Вкладки (1.6-1.8) делаются ДО Undo/Redo, потому что Undo/Redo должно работать
  per-document. Если сделать Undo/Redo сначала под single-doc, придётся переписывать.
- Color profile вводится СЕЙЧАС, потому что это влияет на data model документа.
  Вводить позже = миграция.

---

## 1. О проекте

**GenToniK** — FOSS многослойный растровый редактор screentone (точки, штриховка,
градиенты для манги/комиксов). React + TypeScript + Vite + Canvas2D + WebGL2 + Tauri.

**Скринтоны:** растровые по рендеру (генерируются алгоритмически → offscreen canvas →
`ImageData`/`Canvas`), но алгоритмические по природе (паттерн пересчитывается при
изменении параметров). Все трансформации применяются к растровому буферу.

**Принцип:** «Хирургия, не трансплантация» — минимальные изменения, не переписывать файлы.

---

## 2. ВЫПОЛНЕННЫЕ ФИКСЫ (2026-06-28)

### ✅ PRESERVE-PERSPECTIVE (часть a): Perspective сохраняется при переключении инструментов

**Симптом:** После применения Free Transform (perspective), при переключении на
Rotate/Scale/Skew/Move и drag — perspective терялась, слой "snapped back" к
прямоугольнику.

**Подход:** Вариант A (из Q1) — affine инструменты оперируют на 4 corners как на
группу точек в canvas space. Слой остаётся в perspective mode (`corners ≠ null`),
меняются только координаты углов.

**Изменения:**

1. **`handleToolChange` (App.tsx)** — убран premature bake. Переключение инструментов
   больше НЕ модифицирует слой. `corners` сохраняется.

2. **`computeMove` (transform-overlay-canvas.tsx)** — при `corners` set двигает 4
   corners на delta, не трогает x/y.

3. **`computeScale`** — при `corners` set масштабирует 4 corners от anchor
   (opposite corner / opposite edge midpoint / centroid при altKey).

4. **`computeRotate`** — при `corners` set вращает 4 corners вокруг layer center
   (computed via affine startMatrix → `applyToPoint(startM, {w/2, h/2})`).

5. **`computeSkewedTransform`** — при `corners` set применяет shear к 4 corners
   (X-shear для mt/mb, Y-shear для ml/mr), anchor = opposite edge.

6. **`cornerHandlePositions` (transform-overlay-canvas.tsx)** — новый useMemo,
   вычисляет позиции всех 9 handles напрямую из corners:
   - tl/tr/br/bl = perspective corners
   - ml/mr/mt/mb = edge midpoints
   - mtr = 30px выше top-edge midpoint по нормали (от centroid)
   - body = pointInQuad test

7. **`getHandlePos`** — helper: возвращает позицию handle из cornerHandlePositions
   при `corners` set, иначе через layerMatrix.

8. **RAF render loop** — при `corners` set рисует perspective quad (pink dashed) +
   affine handles через `getHandlePos` (точное совпадение с visual quad).

9. **Hit-test (onPointerDown + onPointerHover)** — при `corners` set использует
   corner-based hit-test с фильтром hidden handles (getHiddenControlIds).

**Верификация:**
- FT → Rotate: rotation 0° → 50.21°, perspective сохранена ✓
- FT → Scale: scaleX 1 → 0.83, perspective сохранена ✓
- FT → Skew: skewX 0° → -16.55°, perspective сохранена ✓
- FT → Move: layer перемещён, perspective сохранена ✓
- Status bar показывает "Rotate/Scale/Skew/Move" + "◆ Perspective mode" одновременно ✓

---

### ✅ PRESERVE-PERSPECTIVE (часть b): Mask from Sel с выбором режима

**Симптом:** Маска на FT-слое была растянутой/искажённой. Пользователь хочет выбор:
маска по форме canvas (чистый эллипс) или по форме объекта (perspective-деформированный эллипс).

**Подход:** Модалка при клике "Mask from Sel" на perspective-слое. Два режима:

- **"By canvas shape"**: mask polygon в canvas space. Применяется как `destCtx.clip()`
  ПОСЛЕ perspective render. Видимая область = точный outline selection.
- **"By object shape"**: mask polygon в layer-local space (homography inverse).
  Применяется как painted mask ДО perspective. Видимая область = selection outline,
  деформированный perspective.

**Изменения:**

1. **`LayerMask` type (types.ts)** — добавлен optional `canvasSpacePolygon?: Vec2[]`
  в painted mask.

2. **`compositeSingleLayer` (composite.ts)** — если mask имеет `canvasSpacePolygon`,
   пропускает layer-local painted mask и вместо этого clip'ит destCtx по polygon
   ДО drawImage (post-perspective clip).

3. **`compositeLayersWithFallback` (webgl/composite-gl.ts)** — если любой layer имеет
   canvasSpaceMask, fallback на Canvas2D (WebGL clip не реализован).

4. **`handleApplySelectionAsMask` (App.tsx)** — принимает `mode: 'object' | 'canvas'`.
   Для 'canvas' строит mask с `canvasSpacePolygon = primaryEntry.canvasPolygon`.
   Для 'object' — existing layer-local path.

5. **`handleApplySelectionAsMaskWithModal`** — wrapper: показывает модалку если layer
   has perspective, иначе вызывает сразу с 'object'.

6. **Модалка в JSX** — "Mask from Selection — mode" с двумя кнопками + Cancel.

7. **`encodeMaskAttr` / decode (ora-format.ts)** — `canvasSpacePolygon` сериализуется
   в .ora JSON и восстанавливается при load.

**Верификация:**
- "By canvas shape": visible area = чистый эллипс (не деформирован perspective) ✓
- "By object shape": visible area = perspective-деформированный эллипс ✓
- Non-perspective layer: модалка не показывается (оба режима эквивалентны) ✓
- .ora round-trip: canvasSpacePolygon сохраняется ✓

---

## 3. ОСТАЛЬНЫЕ БАГИ (не блокирующие)

### ✅ PRESERVE-BUG-1: "By canvas shape" mask не работает — ИСПРАВЛЕНО

**Симптом:** После "Mask from Sel → by canvas shape" на perspective-слое, masked слой
**вообще не рендерился**. Виден был только background.

**Корневая причина:**

HTML5 Canvas может иметь **только один контекст** — либо `2d`, либо `webgl`. Основной
canvas в GenToniK использует WebGL2. Когда `compositeLayersWithFallback` пытался сделать
Canvas2D fallback для canvas-space mask, `canvas.getContext('2d')` возвращал `null`.

**Решение (PRESERVE-FEATURE-1):** Реализован canvas-space clip **напрямую в WebGL shader**,
без Canvas2D fallback:

1. **`COMPOSITE_FRAG` (gl-shaders.ts)** — добавлены uniforms `u_canvasClipTex` (sampler),
   `u_useCanvasClip` (int flag), `u_canvasSize` (vec2). В `main()`: если clip включён,
   сэмплится mask texture по `gl_FragCoord.xy / canvasSize` (с Y-flip для Canvas2D→WebGL
   конвенции). Если alpha < 0.5 → pixel снаружи polygon → `outColor = dstPremult`
   (layer невидим, dst без изменений).

2. **`rasterizeCanvasClipToTexture` (composite-gl.ts)** — helper: rasterize polygon в
   offscreen Canvas2D (отдельный canvas, не основной!), upload как RGBA8 texture.
   Offscreen canvas создаётся per-layer per-frame, texture удаляется после drawArrays.

3. **`compositeSingleLayerGL` (composite-gl.ts)** — при `canvasSpacePolygon`:
   - пропускает `applyMaskGL` (layer-local painted mask не нужен)
   - rasterize polygon → texture
   - bind texture to unit 2, set `u_useCanvasClip = 1`
   - после drawArrays: `gl.deleteTexture(canvasClipTex)`

4. **`compositeLayersWithFallback`** — убран `hasCanvasSpaceMask` fallback check.
   WebGL path теперь обрабатывает canvas-space masks нативно.

**Верификация:**
- "By canvas shape": visible area = чистый эллипс (clean ellipse, не деформирован) ✓
- "By object shape": visible area = perspective-деформированный эллипс ✓
- Background остаётся белым (clip применяется только к слою с mask) ✓
- WebGL path работает без fallback ✓

---

### 🔧 PRESERVE-FEATURE-1: Canvas-space clip в WebGL shader — ВЫПОЛНЕНО ✅

**Реализация:** см. PRESERVE-BUG-1 выше. Canvas-space clip работает через:
- `u_canvasClipTex` sampler в COMPOSITE_FRAG
- `rasterizeCanvasClipToTexture` helper (offscreen Canvas2D → GL texture)
- Y-flip в shader (Canvas2D top-down → WebGL bottom-up)

**Производительность:** Offscreen canvas (canvasW × canvasH) создаётся per-layer per-frame.
Для 2000×2000 = 16MB RGBA texture per mask. Приемлемо для интерактивной работы, но можно
оптимизировать (кэшировать texture по polygon hash, или использовать меньшую texture с
bilinear filtering).

---

### ✅ BUG-3: Зависание/пустая маска при селекте вне FT-квадрата — ИСПРАВЛЕНО

**Симптом:** Selection частично вне FT quad → inverse homography даёт экстремальные
layer-local coords → mask bbox 7798×6002 → MAX_MASK_DIM guard → пустая/огромная маска.

**Решение:** Sutherland-Hodgman polygon clipping.
- `clipPolygonToRect` (composite.ts) — clip polygon к layer bounds `[0, w] × [0, h]`
- `handleApplySelectionAsMask` (App.tsx) — заменён clamp на clip: parts of selection
  outside layer bounds are cut off, preserving shape of in-bounds portion.

**Верификация:**
- Mask dimensions: 7798×6002 → 2002×2003 (within layer bounds) ✓
- "By object shape" с outside selection: mask = perspective-deformed, clipped to layer ✓
- "By canvas shape" с outside selection: mask = clean ellipse ✓

---

### ✅ BUG-4: Self-intersecting quad (butterfly/hourglass) — ИСПРАВЛЕНО

**Симптом:** Перетаскивание corner'а past opposite corner → "butterfly" quad →
`isQuadDegenerate` reject → drag "застревает", layer не обновляется.

**Решение:** `normalizeCorners` (homography.ts) — автоматически swap'ает crossed
corners (TL↔BR или TR↔BL) когда diagonals intersect, producing convex quad.
- `segmentsIntersect` — proper intersection test для 2 line segments
- `normalizeCorners` — если diagonals TL-BR и TR-BL пересекаются, swap TR↔BL
- В `computeDragResult` case 'perspective': после update corner, normalize, потом
  check isQuadDegenerate на normalized quad.

**Верификация:**
- Drag TL past BR: layer плавно "flips" (mirrored), не застревает ✓
- Layer рендерится корректно (dot pattern + pink quad visible) ✓
- No errors in console ✓

---

### ✅ Оптимизация: кэширование canvas-clip texture

**Проблема:** `rasterizeCanvasClipToTexture` создавал offscreen canvas (2000×2000 = 16MB)
per-layer per-frame — дорого при 60fps.

**Решение:** `getCanvasClipTexture` — per-layer кэш texture по hash(polygon + canvasSize).
- Cache hit: returns existing texture (0 allocation)
- Cache miss: rasterize + upload + store
- Invalidation: при изменении polygon (new mask) или canvas resize → delete old + create new
- Texture owned by cache, не удаляется после drawArrays

**Верификация:**
- Canvas-space clip работает (clean ellipse) ✓
- No errors/perf warnings ✓
- Cache reuses texture across frames ✓

---

### 🟡 BUG-5: Layer alignment из FT-состояния
**Статус:** Ожидаемо решён после PRESERVE-PERSPECTIVE (часть a).

### 🟡 BUG-6: Canvas-drawn hint "Affine mode" — UX проблема
**Статус:** НЕ РЕАЛИЗОВАНО. Заменить на DOM badge.

### 🟢 BUG-7: Legacy code masking
**Статус:** Низкий приоритет.

### 🟢 BUG-8: colorBg = '#ffffff' для screentone
**Статус:** Обсудить с пользователем.

---

## 3bis. НОВЫЕ ФИЧИ (вкладки + New Document + color profile)

### 🔴 1.6 Вкладки как в Photoshop (multi-document)

**Цель:** Пользователь может открыть несколько документов одновременно, каждый в своей
вкладке. Переключение между вкладками не теряет данные (слои, выделение, история, viewport).

**Архитектурное изменение (ФУНДАМЕНТАЛЬНО):**

Сейчас App.tsx хранит состояние одного документа:
```ts
const [layers, setLayers] = useState<Layer[]>([]);
const [docSize, setDocSize] = useState({ w: 2000, h: 2000 });
const [activeSelection, setActiveSelection] = useState<ActiveSelection | null>(null);
const historyRef = useRef<HistoryManager>(...);
const [panX, panY, zoom, ...] = useState(...);
```

Нужно извлечь это в `Document` type:
```ts
interface DocumentState {
  id: string;
  name: string;
  layers: Layer[];
  docSize: { w: number; h: number };
  colorProfile: ColorProfile;  // ← 1.7/1.8
  dpi: number;
  activeSelection: ActiveSelection | null;
  history: HistoryManager;
  viewport: { panX: number; panY: number; zoom: number };
  selectedLayerId: string | null;
  dirty: boolean;  // unsaved changes
  filePath?: string;  // for save/open
}
```

App хранит массив документов + `activeDocId`:
```ts
const [documents, setDocuments] = useState<DocumentState[]>([]);
const [activeDocId, setActiveDocId] = useState<string | null>(null);
```

Все `layers`, `docSize`, etc. в коде заменяются на `activeDocument.layers`, etc.

**UI: Tab strip (Photoshop-style):**
- Горизонтальная полоса вкладок над canvas
- Каждая вкладка: имя документа + ✕ (close)
- Активная вкладка подсвечена
- Drag-to-reorder (опционально, позже)
- Double-click на вкладку → rename
- Middle-click → close (как в браузерах)
- Unsaved changes → ● перед именем

**Hotkeys:**
- `Ctrl+Tab` / `Ctrl+Shift+Tab` — следующая/предыдущая вкладка
- `Ctrl+W` — закрыть вкладку (с подтверждением если dirty)

**Сложность:** Высокая. Затрагивает ВСЁ приложение — каждый `setLayers`, `setDocSize`,
etc. нужно проксировать через active document. Но это разовая работа, после которой
все остальные фичи (Undo/Redo, экспорт, и т.д.) работают per-document естественно.

**Файлы:**
- `src/types.ts` — `DocumentState`, `ColorProfile` type
- `src/App.tsx` — major refactor: extract document state, add tab strip
- `src/document-store.ts` (новый) — helper для multi-doc state management
- `src/components/TabStrip.tsx` (новый) — UI вкладок

---

### 🔴 1.7 New Document dialog (как в Photoshop)

**Цель:** При File → New (или старте) показывается диалог с параметрами:
- **Name:** имя документа (default "Untitled-N")
- **Width / Height:** в px (с переключателем единиц: px / cm / mm / in)
- **Resolution:** DPI (default 300)
- **Color Profile:**
  - `Grayscale 8-bit` (default для screentone/manga)
  - `RGB 8-bit` (для webtoon/color)
  - (future: `CMYK 8-bit` — заглушка, WebToonTools)
- **Background:** White / Transparent / (future: custom color)
- **Preset:** A4 / B5 / Manga page / Webtoon strip / Custom

**Поведение:**
- `OK` → создаёт новый документ в **новой вкладке** (не уничтожает существующий)
- `Cancel` → ничего не делает
- Preset выбирается → автоматически заполняет width/height/resolution
- Запоминает последние использованные настройки (localStorage)

**Preset list:**
- **A4 Print** — 2480×3508 px @ 300 DPI (210×297 mm)
- **B5 Manga** — 2079×2953 px @ 300 DPI (176×250 mm) — стандартная manga page
- **A4 Manga** — 2480×3508 px @ 300 DPI
- **Webtoon Strip** — 800×12000 px @ 72 DPI — вертикальная полоса
- **Square 1000** — 1000×1000 px @ 72 DPI
- **Custom** — пользователь вводит

**UI layout (Photoshop-style):**
```
┌─ New Document ─────────────────────────┐
│ Name: [Untitled-1            ]         │
│                                        │
│ Preset: [B5 Manga          ▼]         │
│                                        │
│ Width:  [2079] px [▼]   Height: [2953] px [▼] │
│ Resolution: [300] pixels/inch          │
│                                        │
│ Color Profile:                         │
│   ○ Grayscale 8-bit  (screentone)      │
│   ○ RGB 8-bit        (color/webtoon)   │
│   ○ CMYK 8-bit       (future — disabled)│
│                                        │
│ Background:                            │
│   ○ White    ○ Transparent             │
│                                        │
│        [Cancel]  [Create]              │
└────────────────────────────────────────┘
```

**Сложность:** Средняя. Dialog UI + state + создание документа.

---

### 🔴 1.8 Edit menu: изменение color profile

**Цель:** В Edit меню (или Properties panel) — возможность изменить color profile
существующего документа.

**Опции:**
- `Image → Mode → Grayscale 8-bit`
- `Image → Mode → RGB 8-bit`
- (future: `Image → Mode → CMYK 8-bit`)

**Поведение:**
- Конвертация существующих слоёв:
  - RGB → Grayscale: luminance formula `Y = 0.299R + 0.587G + 0.114B`
  - Grayscale → RGB: replicate Y to R=G=B=Y
- Screentone layers: при grayscale — black on transparent; при RGB — использует `params.color`
- Warning: "This will convert all layers. Continue?"
- Push в history (undoable)

**Сложность:** Низкая. Меню + конвертация + warning dialog.

---

### Color Profile в data model (forward-compat)

```ts
type ColorProfile = 'gray8' | 'rgb8' | 'cmyk8';  // cmyk8 — stub

interface DocumentState {
  // ...
  colorProfile: ColorProfile;
}
```

**Влияние на рендер:**
- Внутри canvas всегда RGBA8 (canvas limitation)
- `colorProfile` влияет на:
  - Screentone generation (gray = black dots, rgb = colored dots)
  - Export (gray → 1-bit/8-bit gray TIFF/PNG, rgb → RGB PNG)
  - Display hint в status bar ("Grayscale" / "RGB")
  - Future: CMYK → 4-channel composite

**Forward-compat для WebToonTools (CMYK):**
- `cmyk8` type зарезервирован, но UI disable
- Renderer throws "not implemented in GenTik stage" если выбран (защита от случайного)
- WebToonTools подменит renderer

---

## 4. КЛЮЧЕВЫЕ АРХИТЕКТУРНЫЕ РЕШЕНИЯ

### Transform tool state machine (PRESERVE-PERSPECTIVE)
```
ToolId = 'move' | 'scale' | 'rotate' | 'skew' | 'perspective' | selection tools

При corners ≠ null (perspective mode):
  - move:   translate 4 corners
  - scale:  scale 4 corners from anchor
  - rotate: rotate 4 corners around layer center
  - skew:   shear 4 corners (X-shear for mt/mb, Y-shear for ml/mr)
  - perspective: drag individual corner (existing behavior)

При corners === null (affine mode):
  - existing behavior (composeLayerMatrix + affine math)
```

**Handle positions при corners ≠ null:**
- tl/tr/br/bl = perspective corners (exact visual match)
- ml/mr/mt/mb = edge midpoints of perspective quad
- mtr = 30px выше top-edge midpoint по нормали от centroid
- body = pointInQuad test

### Mask rendering pipeline (два режима)

**"By object shape" (default, layer-local mask):**
```
Layer → renderLayerContent → offscreen
     → applyPaintedMask (mask in layer-local space) → masked offscreen
     → composite (perspective or affine) → destination
```
Mask применяется ДО perspective. Видимая область = selection, деформированный perspective.

**"By canvas shape" (canvas-space mask):**
```
Layer → renderLayerContent → offscreen (NO layer-local mask)
     → composite (perspective or affine) with destCtx.clip(canvasSpacePolygon)
     → destination (clipped to canvas-space polygon)
```
Mask применяется ПОСЛЕ perspective как clip. Видимая область = exact selection outline.
WebGL fallback to Canvas2D (clip не реализован в WebGL path).

---

## 5. ФАЙЛОВАЯ КАРТА (неактуальная)

```
src/
├── App.tsx                          4230 строк — главный UI
│   ├── handleToolChange (3474)      NO bake — preserves perspective ✓
│   ├── handleApplySelectionAsMask (3122)  mode: 'object' | 'canvas' ✓
│   ├── handleApplySelectionAsMaskWithModal  wrapper с модалкой ✓
│   ├── handleMaskModePick            обработчик выбора в модалке ✓
│   └── Modal JSX (3963)             "Mask from Selection — mode"
├── transform-overlay-canvas.tsx     2520 строк — Canvas overlay
│   ├── cornerHandlePositions (374)  corner-based handle positions ✓
│   ├── getHandlePos (424)           helper: corner-aware position ✓
│   ├── computeMove (1467)           corners branch: translate 4 corners ✓
│   ├── computeScale (1507)          corners branch: scale 4 corners ✓
│   ├── computeRotate (1849)         corners branch: rotate 4 corners ✓
│   ├── computeSkewedTransform (1853) corners branch: shear 4 corners ✓
│   ├── RAF render (584)             perspective quad + corner-based handles ✓
│   └── hit-test (1039, 1428)        corner-based с hidden-handle filter ✓
├── composite.ts                     1390 строк — Canvas2D composite
│   └── compositeSingleLayer (685)   canvasSpacePolygon clip ✓
├── webgl/composite-gl.ts            WebGL2 composite
│   └── compositeLayersWithFallback (450)  fallback to Canvas2D for canvasSpaceMask ✓
├── types.ts                         740 строк — контракты
│   └── LayerMask (232)              canvasSpacePolygon?: Vec2[] ✓
├── ora-format.ts                    1110 строк — .ora save/load
│   ├── encodeMaskAttr (344)         canvasSpacePolygon serialization ✓
│   └── decode (942)                 canvasSpacePolygon restore ✓
└── homography.ts                    401 строка — perspective math (НЕ ТРОГАТЬ)
```

---

## 6. ИСТОРИЯ ИЗМЕНЕНИЙ ПЛАНА

| Дата | Изменение |
|------|-----------|
| 2026-06-28 | BUG-1 + BUG-2 fixed (previous iteration) |
| 2026-06-28 | **PRESERVE-PERSPECTIVE (часть a)**: perspective сохраняется при Rotate/Scale/Skew/Move |
| 2026-06-28 | **PRESERVE-PERSPECTIVE (часть b)**: Mask from Sel модалка "by canvas / by object shape" |
| 2026-06-28 | .ora round-trip для canvasSpacePolygon |
| 2026-06-29 | **Transparent Layers**: новый LayerType='transparent', замена Solid в New Layer dropdown, переформулировка Background в NewDocumentDialog |
| 2026-06-29 | **BUG-C задокументирован**: документ уезжает влево-вверх при File → New (handleCreateNewDocument использует pan=0 вместо handleFitView) |
| 2026-06-29 | **BUG-C ИСПРАВЛЕН**: вынесена pure-функция `computeFitView`, использована в `handleCreateNewDocument` и `closeDocument` |
| 2026-06-29 | **Связка Rulers + Scroll Bar**: принято решение делать вместе (затрагивают общий layout canvas-контейнера) |
| 2026-06-29 | **BUG-прозрачность (частичный фикс)**: удалены дубликаты ppW/ppH в DestPingPong, удалён дублирующий блок uniform setup, добавлено диагностическое логирование |
| 2026-06-29 | **Rulers + Scroll Bar v2.4 СДЕЛАНО**: курсор-индикатор на линейке, единицы px/mm/in, ноль-маркер, CanvasScrollbar (custom, drag), клавиатурный скролл. Проверено через agent-browser. |
| 2026-06-29 | **v2.5: Photoshop-style scrollbar rewrite**: всегда видны, drag-vs-click disambiguation (3px threshold), wheel support (60px/notch), hover styles. Убрана auto-hide логика. |
| 2026-06-29 | **v2.5: Zoom tool СДЕЛАНО**: новый ToolId='zoom', Photoshop-style (click=zoom in 1.5x, Alt+click=zoom out, drag=marquee zoom to fit). Hotkey Z. Marquee overlay с blue/red tint. Проверено через agent-browser. |
| 2026-06-29 | **v2.5.1: BUG FIXES** (по записи пользователя): 1) Вертикальная линейка пустая из-за flex:1 в block parent — parent изменён на flex column. 2) Zoom tool не работал — TransformOverlayCanvas перехватывал mouse events; теперь pointerEvents='none' при zoom/none. 3) Transform handles вылезали при Zoom tool — добавлен early return в RAF. 4) Scrollbars инвертированы относительно Photoshop — инвертированы thumbPos, drag delta, wheel, page-jump. |
| 2026-06-29 | **v2.6: UNDO/REDO для SELECTION + физические кнопки**: 1) DocumentSnapshot расширен полем activeSelection — undo/redo восстанавливает marching ants. 2) pushHistory переписан: теперь вызывается ПОСЛЕ mutation с НОВЫМ state (раньше ДО со старым — redo был сломан). 3) Все layer handlers (Add/Delete/Duplicate/MoveUp/MoveDown/ApplyPreset/ImportPNG) обновлены. 4) handleSelectionCommit: undoable selections с labels (Selection/Add/Subtract/Intersect). 5) Escape clear selection — pushHistory 'Clear Selection'. 6) Физические кнопки ↶ ↷ в toolbar после меню. Проверено через agent-browser: undo/redo/hotkeys всё работает. |
| 2026-06-29 | **v2.7: WebGL edge cases (context loss)**: 1) Убран `{ once: true }` с webglcontextlost — постоянная подписка. 2) Добавлен webglcontextrestored handler — помечает state.lost=true для rebuild. 3) compositeLayersWithFallback: при state.lost=true → destroyGLState + delete cache + createGLState (fresh). 4) destroyGLState: removeEventListener для обоих handlers. 5) HiDPI и subpixel positioning пропущены (опциональные, текущее поведение приемлемо). |
| 2026-06-29 | **Bake Transform (будущая задача)** — добавлен в план: re-tessellation скринтона после scale. Идея: кнопка "Bake Transform" пересчитывает паттерн с учётом нового размера layer (dotSize*scale, spacing*scale), фиксирует как raster, сбрасывает transform в identity. Стоимость: ~30-50ms на 2000×2000. Не каждый кадр, а по кнопке. Открытые вопросы: (1) что масштабировать — dotSize, spacing, или оба; (2) кнопка в Properties или Layer panel; (3) сохранять ли original params для re-edit. |
| 2026-06-29 | **Bake Transform — ответы пользователя**: 1) Вариант (a) — dotSize остаётся, spacing масштабируется (проще, не лезть в генератор). Доработка генератора — пост-задача. 2) Кнопка на панели настроек скринтонов, рядом с simple/advanced toggle. 3) Сначала запекаемый совсем (скрывать params после bake), потом возможно re-edit вариант (зависит от сложности). Реализация — после текущего плана. |
| 2026-06-29 | **Редизайн UI (будущая задача)** — добавить в план после всех пунктов: общий дизайн, упорядочить значки, место вкладок, дополнительные инструменты (линейка для измерения расстояния точка-точка + выравнивание слоя по горизонту как в Photoshop, и прочее). Будет обсуждаться с пользователем ближе к последним фиксам. |
| 2026-06-29 | **v2.8: Skew по Krita**: Shift+drag на edge handle (mt/mb/ml/mr) в Move/Scale/Rotate tool → skew-x/skew-y вместо стандартного action. Skew tool без изменений. Поведение "одна сторона остаётся, противоположная смещается" уже работало. TOOL_HINTS обновлены. Проверено через agent-browser. |
| 2026-06-29 | **v2.9: Forward-compat хуки**: LayerType += 'text'\|'vector' (stubs, no-op render). Layer += meta (plugin metadata bag), colorSpace (sRGB/Linear/Gray8/CMYK8). ScreentoneParams += frequency (LPI). TextLayerData + VectorLayerData + VectorShape interfaces. PluginRegistry + FontRegistry interfaces с InMemory implementations + singletons. createTextLayer/createVectorLayer factories. composite.ts + WebGL + ora-format.ts — full serialization round-trip для text/vector/colorSpace/meta. App.tsx — LAYER_TYPE_ICONS (text='T', vector='◯'), Properties panel stubs. Все 9 задач плана выполнены. |

---

## 7. ПРИНЦИПЫ РАБОТЫ

1. **Перед кодом — план; перед планом — анализ**
2. **Хирургия, не трансплантация** — минимальные изменения
3. **Каждый фикс — верифицировать** в браузере через agent-browser
4. **Если фикс не работает — остановись и диагнозируй**

---

## 8. ПЛАН НА БУДУЩЕЕ (из Q1)

- **Вариант B** (из Q1): affine применяется в layer-local space, perspective остаётся
  как матрица. Transform = `perspective ∘ affine`. Нужна композиция: каждый раз при
  drag affine обновляется, corners пересчитываются через `applyHomography(H_perspective,
  affine_corners)`. Более чистая математика, но сложнее реализации. Попробовать после
  стабилизации текущего подхода.

---

## 9. АКТУАЛЬНЫЙ ПОРЯДОК РАБОТ (замена раздела 0)

```
1. [✅ сделано] BUG-C: центрирование нового документа
             — computeFitView helper + handleCreateNewDocument + closeDocument

2. [✅ сделано] BUG-прозрачность (частично): cleanup duplicate ppW/ppH в DestPingPong
             + удалён дублирующий блок uniform setup + диагностическое логирование

3. [✅ сделано] Rulers + Scroll Bar (v2.4)
             — Курсор-индикатор на линейке (синяя линия + label)
             — Единицы px/mm/in с RulerUnitSelector в углу
             — Ноль-маркер (bold accent tick)
             — CanvasScrollbar (custom, drag thumb, auto-hide)
             — Клавиатурный скролл: Arrows/PgUp/PgDn/Home/End

4. [1-2 дня] 1.3+1.4 Undo/Redo для selection + физические кнопки

5. [0.5 дня] 2.4 WebGL edge cases (context loss handlerы)

6. [0.5 дня] 1.2 Skew по образцу Krita

7. [1 день]  7. Forward-compat хуки (stubs + meta + plugin registry)

8. [дальше]  1.9 Bucket tool + Stage 2-5: tile system, viewport culling, commit cache, tone
```

**Прогресс (2026-06-29):**
- ✅ BUG-C: 10 минут работы, проверено через agent-browser
- ✅ BUG-прозрачность: cleanup помог, периодические WebGL fallback warnings остались (нужно следить)
- ✅ Rulers + Scroll Bar: проверено через agent-browser — линейки, курсор-индикатор, mm-режим, scrollbars, drag thumb, PageDown — всё работает
- ⏭️ Дальше: Undo/Redo для selection + физические кнопки

---

## 10. Планы по форматам изображений (JPG, AVIF, TIFF)
- **JPG / AVIF / WebP / PNG**: Полностью поддерживаются браузером из коробки. Добавление слоев работает через `<input accept="image/*">`, все эти форматы автоматически распознаются и декодируются.
- **TIFF (.tif / .tiff)**: Не поддерживается веб-браузерами нативно. На будущее запланирована интеграция декодера (например, библиотеки `tiff.js` или `utif.js`), которая при выборе TIFF-файла будет преобразовывать его ImageData в плоский холст перед передачей в WebGL/Canvas2D слой.

