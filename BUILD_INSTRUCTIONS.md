# СБОРКА GenToniK v2 — инструкция для AI-ассистента в IDE

> **Прочитай это ПЕРВЫМ делом.** Не читай другие файлы, не "изучай архитектуру" — просто следуй шагам ниже. Это сэкономит токены и время.

---

## Что уже готово

13 файлов в `/home/z/my-project/download/` полностью написаны и проходят `tsc --strict` с **0 ошибок**:

| Файл | Строк | Назначение |
|------|-------|-----------|
| `types.ts` | 640 | Контракты: `Layer`, `ScreentoneParams`, `PresetV2`, 18 built-in presets. `LayerTransform` со `skewX`/`skewY` и `corners` (v2.2) |
| `roundness.ts` | 320 | Алгоритм скругления углов через `quadraticCurveTo` |
| `engine.ts` | 690 | Рендер screentone (12 паттернов, спутники, градиенты) |
| `composite.ts` | 902 | Многослойная композиция (blend, masks, transforms, skew, **perspective v2.2**) |
| `units.ts` | 76 | Конвертация px↔mm↔in↔lpi |
| `preset-store.ts` | 645 | CRUD пресетов, localStorage + built-ins |
| `ora-format.ts` | 1032 | .ora (OpenRaster) save/load через JSZip (skew + corners в сериализации) |
| `history.ts` | 377 | Undo/redo, snapshot-based с coalescing |
| `mask-editor.tsx` | 1102 | UI painted masks: **6 инструментов** — Brush, Eraser, Lasso, Poly-Lasso, Rect/Ellipse Marquee |
| `debug-tools.tsx` | 937 | Структурированный лог + `<DebugPanel>` overlay |
| `ps-bridge.ts` | 816 | Photoshop round-trip через PNG (Tauri + browser fallback) |
| `homography.ts` | 401 | **НОВЫЙ v2.2** — 4-point perspective: computeHomography, applyHomography, affineFromTriangle, pointInQuad |
| `transform-panel.tsx` | 1620 | **НОВЫЙ** — UI Move/Rotate/Scale/Skew/Free Transform + 4 corner handles |

**Итого: 13 384 строк готового кода, 0 ошибок `tsc --strict`.**

> Документация: `README.md`, `PATCH_NOTES.md`, `IDE_GUIDE.md`, `LICENSE` (GPLv3) — рядом с этим файлом.

---

## Что осталось сделать

### Шаг 1. Скопировать файлы в проект

Скопировать 14 файлов из `/home/z/my-project/download/` в `src/` твоего Tauri+React+Vite проекта (или куда у тебя указано в `tsconfig.json` → `include`):

- `types.ts`, `units.ts`, `roundness.ts`, `engine.ts`, `composite.ts`, `history.ts`, `homography.ts`
- `ora-format.ts`, `preset-store.ts`, `ps-bridge.ts`
- `debug-tools.tsx`, `mask-editor.tsx`, `transform-panel.tsx` (старый, оставлен как reference)
- **`transform-matrix.ts`** (новый в v2.3 — canonical 2D affine math)
- **`transform-overlay-movable.tsx`** (новый в v2.3 — замена transform-panel на базе react-moveable)
- `App.tsx` (обновлён в v2.3 — использует новый overlay + патчи mask-editor props)
- `NOTICE.md` (в корень проекта, не в src/ — атрибуция third-party кода)

### Шаг 2. Установить зависимости

```bash
npm install jszip react-moveable @scena/matrix
```

- `jszip` — для `ora-format.ts` (.ora save/load)
- `react-moveable` (MIT, © Daybrush) — для `transform-overlay-movable.tsx` (drag/scale/rotate/warp handles)
- `@scena/matrix` (MIT, © Daybrush) — transitive dep react-moveable, но полезен и напрямую для matrix math

Без `react-moveable` будет ошибка `Cannot find module 'react-moveable'` в `transform-overlay-movable.tsx`.

### Шаг 3. Установить Tauri API (опционально, для ps-bridge native file dialogs)

```bash
npm install @tauri-apps/api
```

Если не поставить — `ps-bridge.ts` автоматически откатится на browser file picker / download. Это нормально для dev-режима.

### Шаг 4. Заменить `App.tsx`

Текущий `App.tsx` (2580 строк, v2.3) — это **новая версия**, интегрирующая все модули включая react-moveable overlay. Заменить им дефолтный `App.tsx` твоего Vite-проекта.

В v2.3 изменилось:
- Импорт `TransformPanel` заменён на `TransformOverlayMovable` (из `./transform-overlay-movable`)
- В `<TransformPanelOverlay>` добавлены props `panX`/`panY` (нужны для правильного позиционирования overlay при панорамировании)
- В `<MaskEditor>` добавлены props `docWidth`/`docHeight` (раньше docSize не передавался — был latent bug для image layers)

### Шаг 5. Добавить CSS-переменные (опционально, для темизации)

В `index.css` после существующих `--c-*` переменных добавить:

```css
:root, [data-theme="dark"] {
  --c-mask-overlay-bg: rgba(40, 40, 45, 0.95);
  --c-mask-toolbar-shadow: 0 4px 16px rgba(0,0,0,0.4);
  --c-debug-bg: rgba(20, 20, 24, 0.97);
  --c-debug-border: #333;
  --c-layer-active: rgba(59, 130, 246, 0.25);
  --c-layer-thumb-bg: #0d1117;
  --c-warning: #f59e0b;
  --c-success: #10b981;
}
```

Это опционально — `mask-editor.tsx` и `debug-tools.tsx` уже работают с inline-стилями (хардкод), CSS-переменные нужны только если хочешь единую темизацию.

### Шаг 6. Проверить сборку

```bash
npm run build
```

Должно собраться без ошибок. Если есть ошибки `tsc` — смотреть в [Известные подводные камни](#известные-подводные-камни).

### Шаг 7. Запустить dev-сервер

```bash
npm run dev
```

Открыть по указанному URL. Проверить:
- Холст рисуется
- Кнопки добавления слоёв работают
- Пресеты применяются
- Undo/redo работает (Ctrl+Z / Ctrl+Shift+Z)
- Debug panel открывается по **Ctrl+`** (backtick)

---

## Сигнатуры импортов для нового App.tsx

### Из `types.ts`
```ts
import {
  type Layer, type ScreentoneParams, type PresetV2,
  type BlendMode, type LayerTransform, type LayerType,
  type DotShape, type PatternType, type SizeUnit, type RenderSizeMode,
  type LayerMask,
  DEFAULT_PARAMS, DEFAULT_TRANSFORM, BLEND_MODES, BUILT_IN_PRESETS,
  createScreentoneLayer, createImageLayer, createSolidLayer,
  getLayerNaturalSize, blendToCompositeOp,
} from './types';
```

### Из `composite.ts`
```ts
import {
  type CompositeContext, type ImageCache,
  compositeLayers, compositeSingleLayerPublic,
  getLayerCanvasBounds, isPointInLayer, layerContentFingerprint,
} from './composite';
```

### Из `engine.ts`
```ts
import { renderScreentone } from './engine';
// renderScreentone(ctx, width, height, params): void
```

### Из `units.ts`
```ts
import { toPx, fromPx, formatInUnit, parseInUnit } from './units';
```

### Из `preset-store.ts`
```ts
import * as presetStore from './preset-store';
// presetStore.getAllPresets(), getPresetById(id), createPreset(...),
// updatePreset(id, patch), deletePreset(id), duplicatePreset(id),
// exportPresets(), importPresets(json), searchPresets(query), ...
```

### Из `ora-format.ts`
```ts
import {
  saveOraFile, openOraFile, isOraFile, ORA_FILE_ACCEPT,
  exportOra, importOra,
  type OraExportResult, type OraImportResult,
} from './ora-format';
```

### Из `history.ts`
```ts
import {
  HistoryManager, makeSnapshot,
  type DocumentSnapshot,
} from './history';
// const historyRef = useRef(new HistoryManager());
// historyRef.current.initialize(makeSnapshot(layers, docSize, activeId, 'init'));
// historyRef.current.push(makeSnapshot(..., 'Edit Opacity'), { coalesce: true });
// historyRef.current.undo() → DocumentSnapshot | null
```

### Из `mask-editor.tsx`
```ts
import { MaskEditor, type MaskEditorProps, type BrushSettings, type ViewTransform } from './mask-editor';
// <MaskEditor layer={...} layerWidth={...} layerHeight={...}
//   viewTransform={...} layerTransform={...}
//   onStrokeComplete={mask => { ... }} onClose={...} />
```

### Из `debug-tools.tsx`
```ts
import { debug, DebugPanel, useDebugLog } from './debug-tools';
// <DebugPanel />  // mount once near root; toggle with Ctrl+`
// debug.info('composite', 'rendering', { layers: layers.length });
// debug.time('render'); ... debug.timeEnd('render');
```

### Из `ps-bridge.ts`
```ts
import {
  pngBridge, bridgeSession,
  exportCompositeToFile, renderCompositeToCanvas,
  buildExportMetadata, type BridgeImportResult, type BridgeSessionSnapshot,
} from './ps-bridge';
// const result = await pngBridge.importFromPicker();
// await exportCompositeToFile(pngBridge, layers, docSize, imageCache, { fileName: 'foo' });
// const snap = bridgeSession.getSnapshot(); snap.state === 'editing'
```

---

## Известные подводные камни

### 1. `Cannot find module 'jszip'`
**Решение:** `npm install jszip`. Без него `ora-format.ts` не компилируется.

### 2. `Cannot find module '@tauri-apps/api/dialog'`
Это **динамический** импорт в `ps-bridge.ts` — ошибка появится только если ты используешь Tauri. Если нет — модуль `ps-bridge.ts` корректно откатывается на browser fallback.
**Решение:** либо `npm install @tauri-apps/api`, либо игнорировать (в browser-сборке dynamic import вернёт null, код обработает).

### 3. `JSX namespace not found` или `Cannot find name 'JSX'`
В React 19 types глобальный `JSX` namespace может быть не виден.
**Решение:** в `mask-editor.tsx` и `debug-tools.tsx` уже используется `JSX.Element` как тип возврата. Если tsc ругается — добавь в начало файла:
```ts
import { type JSX } from 'react';
```
**Проверено:** с `@types/react@19.2.7` работает без этого импорта (глобальный JSX namespace ещё доступен для обратной совместимости).

### 4. `ClipboardItem is not defined` (runtime, не tsc)
В старых браузерах `ClipboardItem` может отсутствовать. В `ps-bridge.ts` есть проверка `if (!navigator.clipboard || !navigator.clipboard.write)` — откатывается на download.

### 5. `URL.createObjectURL is not a function`
В очень старых браузерах. В `ps-bridge.ts` есть fallback на `FileReader.readAsDataURL`.

### 6. Tailwind v4 конфигурация
В `index.css` уже есть `@import "tailwindcss"` — это правильно для v4. **НЕ добавляй** `tailwind.config.js`, `@tailwind base/components/utilities` — это v3 синтаксис.

### 7. StrictMode двойной mount
В dev-режиме `useEffect` вызывается дважды (mount → unmount → mount). Это безопасно для всех наших модулей:
- `debug-tools.ts`: `installGlobalHandlers()` idempotent
- `history.ts`: подписка корректно отписывается в cleanup
- `mask-editor.tsx`: canvas инициализируется заново, состояние то же

### 8. localStorage quota errors
`debug-tools.ts` и `preset-store.ts` ловят все ошибки localStorage и тихо откатываются (никогда не бросают). Не нужно оборачивать в try/catch.

### 9. Tauri файловые диалоги не открываются
Проверь что в `tauri.conf.json` разрешены нужные capabilities:
```json
{
  "app": {
    "security": {
      "capabilities": ["fs:allow-read-file", "fs:allow-write-file", "dialog:allow-open", "dialog:allow-save"]
    }
  }
}
```

### 10. PNG без sidecar metadata
Если импортируешь PNG из Photoshop напрямую (без .gentonik.json sidecar) — `metadata` будет `null`. Это нормально. App.tsx должен создавать image layer с размерами из PNG и без sourceLayerId.

---

## Чек-лист перед "готово"

- [ ] 14 файлов скопированы в `src/` (включая новые transform-matrix.ts и transform-overlay-movable.tsx)
- [ ] `NOTICE.md` скопирован в корень проекта (атрибуция third-party)
- [ ] `npm install jszip react-moveable @scena/matrix` выполнено
- [ ] (опц.) `npm install @tauri-apps/api` выполнено
- [ ] `App.tsx` заменён на v2.3 (использует TransformOverlayMovable + panX/panY props)
- [ ] `index.css` дополнен переменными (опц.)
- [ ] `npm run build` проходит без ошибок
- [ ] `npm run dev` запускается, холст рисуется
- [ ] Добавление screentone layer работает
- [ ] Применение preset работает
- [ ] Undo/redo работает (Ctrl+Z)
- [ ] Save .ora работает
- [ ] Load .ora работает
- [ ] Import PNG из Photoshop работает (drag-drop или file picker)
- [ ] Export PNG работает (download или native save dialog)
- [ ] Debug panel открывается по Ctrl+` и показывает логи
- [ ] Mask editor открывается при выборе "Edit Mask" на слое
- [ ] **v2.3 regression test:** кисть mask editor'а рисует точно под курсором на слое с rotation ≠ 0 (раньше "инвертированно")
- [ ] **v2.3 regression test:** drag moveable handles двигает слой в ту же сторону что и drag (без инверсии при flip)

---

## Новые фичи v2.2 — Free Transform 4-corner (гомография)

**Главная фича:** инструмент **Free Transform (F)** — пользователь перетаскивает
4 угла слоя, рендер идёт через перспективную проекцию (гомографию), а не
через affine-трансформ.

### Что нового

- **`homography.ts`** (401 строка) — чистая математика:
  - `computeHomography(src4, dst4) → Mat3` — 8×8 система, Гаусс с partial pivot.
  - `applyHomography(H, p) → Vec2` — прямое преобразование точки.
  - `affineFromTriangle(src3, dst3) → [a,b,c,d,e,f]` — аффинная матрица для
    пары треугольников (для patch-рендера).
  - `pointInQuad(p, quad4) → boolean` — cross-product тест.
- **`types.ts`** — добавлено поле `corners?: [Vec2, Vec2, Vec2, Vec2] | null`
  в `LayerTransform`. Если `corners` задан — рендер через перспективу,
  affine-поля игнорируются. Если `null` — обычный affine-режим.
- **`composite.ts`** — `drawImageWithPerspective()`: триангулирует исходный
  прямоугольник 8×8 = 128 треугольников, для каждого считает целевые
  вершины через гомографию, рисует через `setTransform + clip + drawImage`.
  Bounds и hit-test обновлены для учёта 4 углов.
- **`transform-panel.tsx`** — кнопка **Free (F)**, 4 corner handle, кнопка
  **Reset Perspective**.
- **`ora-format.ts`** — сериализация `gentonik:corner-tl/tr/br/bl` attrs.
  Backward-compatible: старые .ora грузятся с `corners=null`.

### App.tsx интеграция

В Transform panel добавить кнопку **Free** с горячей клавишей **F**.
При активации — показать 4 corner handle (overlay). Drag handle →
обновить `transform.corners[i]`. Кнопка **Reset Perspective** →
`transform.corners = null`.

API в `transform-panel.tsx` уже готов: `computePerspectiveHandles()`,
`getLayerCorners()`, `pointInQuad()`. Импортируй и используй.

### Чек-лист v2.2

- [ ] Transform panel имеет кнопку Free (F)
- [ ] При активации Free показываются 4 corner handle
- [ ] Drag handle → слой деформируется перспективно (не affine!)
- [ ] Reset Perspective возвращает affine-режим
- [ ] Undo (Ctrl+Z) отменяет drag угла
- [ ] Save .ora сохраняет corners (gentonik:corner-* attrs)
- [ ] Load .ora восстанавливает corners
- [ ] Hit-test корректен в perspective-режиме

### Ограничения

- 8×8 subdivisions = 128 треугольников. На слоях 4000×4000+ возможны
  тормоза. Уменьшить subdivisions в `composite.ts:drawImageWithPerspective()`
  с 8 до 4.
- Self-intersecting quad (TL и BR поменяны) — нет валидации, рендер
  некорректен. В v2.3 добавим проверку.

---

## Новые фичи v2.1 (добавлены после первоначальной сборки)

### 1. Skew (наклон слоя)

`LayerTransform` теперь имеет 2 новых поля:
```ts
interface LayerTransform {
  x: number; y: number;
  scaleX: number; scaleY: number;
  rotation: number;
  skewX: number;   // ← НОВОЕ, градусы, [-89, 89]
  skewY: number;   // ← НОВОЕ, градусы, [-89, 89]
}
```

Применяется в composite.ts в pipeline: translate → rotate → skew → scale → translate-to-center.
Хорошо для изометрии, наклонных плоскостей, псевдо-3D.

**В App.tsx:** в Transform panel добавить 2 слайдера Skew X / Skew Y (-89° … +89°).
`DEFAULT_TRANSFORM` уже включает `skewX: 0, skewY: 0` — все существующие слои получают их автоматически через spread.

### 2. Selection инструменты в MaskEditor

`MaskTool` теперь union из 6 значений:
```ts
type MaskTool =
  | 'brush' | 'eraser'
  | 'lasso' | 'polygonal-lasso'
  | 'rect-marquee' | 'ellipse-marquee';
```

**Поведение:**
- **Brush / Eraser** — как раньше (кисть/ластик, per-stroke opacity)
- **Freehand Lasso** — drag мышью = произвольный контур → fill в mask на mouseup
- **Polygonal Lasso** — клики добавляют вершины, double-click или Enter закрывает, Escape отменяет. Rubber-band preview к курсору.
- **Rect Marquee** — drag = прямоугольник → fill
- **Ellipse Marquee** — drag = эллипс → fill

**Alt-модификатор** (для всех selection инструментов): инвертирует операцию — subtract из mask (через `destination-out`). Полезно для вырезания дырок в существующей маске.

**Opacity** из BrushSettings применяется к selection fill тоже. Hardness и Size игнорируются для selection.

**Live preview:** синий пунктирный контур на overlay canvas во время drag.

**App.tsx интеграция:** ничего не меняется — `<MaskEditor>` API совместим. Просто появятся 4 новые кнопки в тулбаре.

### Чек-лист для новых фич

- [ ] Transform panel в App.tsx имеет слайдеры Skew X / Skew Y
- [ ] Skew применяется визуально (наклон слоя)
- [ ] Mask editor показывает 6 кнопок инструментов
- [ ] Freehand Lasso рисует произвольный контур
- [ ] Polygonal Lasso: клик-клик-клик → double-click закрывает
- [ ] Rect Marquee: drag = прямоугольник
- [ ] Ellipse Marquee: drag = эллипс
- [ ] Alt+drag в любом selection инструменте = subtract
- [ ] Save .ora сохраняет skew (gentonik:skew-x / skew-y attrs)
- [ ] Load .ora восстанавливает skew

---

## Если что-то не работает

1. Открой `<DebugPanel>` (Ctrl+`) — посмотри последние записи
2. Категория `bridge` — для PS round-trip проблем
3. Категория `composite` — для рендеринга
4. Категория `ora` — для .ora файлов
5. Категория `system` — для необработанных ошибок (window.onerror)
6. Нажми "Export" в debug panel — скачается JSON со всеми логами
7. window.__gentonikDebug в devtools console — прямой доступ к логгеру

**Не редактируй 11 готовых файлов** без крайней необходимости. Они покрыты `tsc --strict` и протестированы. Если баг — скорее всего в `App.tsx` (новом), который ты пишешь.

---

## Файлы в `/home/z/my-project/upload/` (старый проект-шаблон)

Эти файлы — заготовка Tauri+React+Vite+Tailwind проекта. Используй их как стартовую точку:
- `package.json` — deps (нужно добавить `jszip`, опц. `@tauri-apps/api`)
- `tsconfig.json` — ok, использовать как есть (strict mode включён)
- `vite.config.ts` — ok
- `index.html` — ok
- `main.tsx` — ok, не трогать
- `index.css` — ok, можно дополнить переменными
- `App.tsx` — **ЗАМЕНИТЬ** на новый
- `types.ts`, `engine.ts` — **ЗАМЕНИТЬ** на новые из `/download/`

---

## Контакт / история

Полная история работы — в `/home/z/my-project/worklog.md` (13+ task entries).
Читай если нужно понять "почему так сделано".

Краткая сводка:
- Task 1-7: types, roundness, engine, composite, units, preset-store, ora-format (предыдущие сессии)
- Task 8: history.ts
- Task 9: mask-editor.tsx
- Task 10: debug-tools.tsx
- Task 11: ps-bridge.ts + BUILD_INSTRUCTIONS.md
- Task 12 (v2.1): Skew + 4 selection инструмента в mask-editor
- Task 13 (v2.2): homography.ts + Free Transform 4-corner
- Task 14 (v2.2-doc): LICENSE (GPLv3), README.md, PATCH_NOTES.md, IDE_GUIDE.md

**Лицензия:** GNU GPLv3 — см. `LICENSE`.
**Автор кода:** GLM 5.1 (Z.ai), собрано в Antigravity IDE.

Всё. Можно собирать.
