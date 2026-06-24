# PATCH NOTES — GenToniK Screentone Generator v2

> **Кратко для тестировщиков:** что было сделано, что нового в каждой версии,
> какие файлы затронуты. Подробности — в `IDE_GUIDE.md` и `BUILD_INSTRUCTIONS.md`.

**Проект:** GenToniK Screentone Generator — многослойный растровый редактор
для screentone (сеток точек, штриховки, градиентов для манги/комиксов).

**Лицензия:** GNU GPLv3 (см. `LICENSE`).
**Автор кода:** GLM 5.1 (Z.ai), собрано в Antigravity IDE.

---

## v2.2.0 — Free Transform 4-corner (гомография)

**Главная фича:** инструмент **Free Transform (F)** — пользователь перетаскивает
4 угла слоя в произвольные позиции, слой рендерится через перспективную проекцию
(гомографию), а не через affine-трансформ.

### Что нового

- **Новый модуль `homography.ts`** (401 строка) — чистая математика:
  - `computeHomography(src4, dst4) → Mat3` — решение 8×8 системы методом
    Гаусса с partial pivot, h33=1 normalization.
  - `applyHomography(H, p) → Vec2` — прямое преобразование точки.
  - `invertHomography(H) → Mat3` — обратная матрица через adjugate/det.
  - `affineFromTriangle(src3, dst3) → [a,b,c,d,e,f]` — аффинная матрица
    для пары треугольников (для patch-рендера).
  - `pointInQuad(p, quad4) → boolean` — cross-product тест.
- **`types.ts`** — добавлено поле `corners?: [Vec2, Vec2, Vec2, Vec2] | null`
  в `LayerTransform`. Если `corners` задан — рендер идёт через перспективу,
  affine-поля (`x/y/scale/rotation/skew`) игнорируются. Если `null` — обычный
  affine-режим. Поле сохраняется в .ora (attrs `gentonik:corner-tl/tr/br/bl`).
- **`composite.ts`** — новая функция `drawImageWithPerspective()`:
  - Триангулирует исходный прямоугольник слоя на 8×8 = 128 треугольников.
  - Для каждого треугольника считает целевые вершины через гомографию,
    потом аффинную матрицу между source-triangle и dst-triangle.
  - Рисует каждый треугольник через `ctx.setTransform + clip + drawImage`.
  - Branch в `drawLayer()`: если `corners` задан — perspective path,
    иначе старый affine path.
  - Bounds/hit-test в `getLayerCanvasBounds()` и `isPointInLayer()` обновлены
    чтобы учитывать 4 угла.
- **`transform-panel.tsx`** — добавлена кнопка **Free (F)** в панели
  трансформаций (рядом с Move/Rotate/Scale):
  - 4 corner-handle в режиме Free (drag меняет соответствующий угол).
  - Кнопка **Reset Perspective** — сбрасывает `corners` в `null`, возвращает
    affine-режим.
  - При первом входе в Free Transform corners инициализируются из текущего
    affine-bounding-box (TL/TR/BR/BL), чтобы user видел начальный прямоугольник.

### Как тестировать

1. Создать слой, выбрать его.
2. Нажать **F** (или кликнуть кнопку Free в Transform panel).
3. Видны 4 угловых handle.
4. Перетащить любой угол — слой деформируется перспективно.
5. Перетащить остальные углы — quad становится трапецией/произвольным
   четырёхугольником.
6. Нажать **Reset Perspective** — уголы возвращаются в прямоугольник,
   affine-поля восстанавливаются.
7. Сохранить .ora, открыть заново — corners должны восстановиться.
8. Проверить undo/redo: каждый drag угла = один undo-шаг.

### Ограничения

- 8×8 subdivisions = 128 треугольников. На очень больших слоях (4000×4000+)
  возможны тормоза. Если будет проблема — уменьшить subdivisions до 4 в
  `composite.ts:drawImageWithPerspective()` (последний аргумент).
- Self-intersecting quad (например, TL и BR поменяны местами) рендерится
  некорректно. В v2.3 добавим валидацию.
- Hit-test в perspective-режиме использует point-in-quad, что корректно для
  выпуклых quad. Для вогнутых может давать ложные срабатывания.

---

## v2.1.0 — Skew + Selection инструменты

### 1. Skew (наклон слоя)

`LayerTransform` расширен полями `skewX`/`skewY` (градусы, диапазон ±89°).

- **`types.ts`** — добавлены поля, обновлён `DEFAULT_TRANSFORM`.
- **`composite.ts`** — skew применяется в pipeline после rotate, до scale.
  Hit-test и bounds тоже учитывают skew (через обратную 2×2 матрицу).
- **`ora-format.ts`** — сериализация через `gentonik:skew-x`/`gentonik:skew-y`
  attrs. Backward-compatible: старые .ora грузятся с skew=0.
- **App.tsx** — нужно добавить 2 слайдера Skew X / Skew Y в Transform panel.

### 2. Selection инструменты в MaskEditor

`MaskTool` расширен с 2 до 6 значений:
`brush | eraser | lasso | polygonal-lasso | rect-marquee | ellipse-marquee`.

- **Freehand Lasso** — drag мышью = произвольный контур → fill на mouseup.
- **Polygonal Lasso** — клики добавляют вершины; double-click / Enter
  закрывает; Escape отменяет. Rubber-band preview к курсору.
- **Rect Marquee** — drag = прямоугольник → fill.
- **Ellipse Marquee** — drag = эллипс → fill.
- **Alt-модификатор** (для всех selection): subtract из mask через
  `destination-out`. Для вырезания дырок.
- Opacity из BrushSettings применяется к fill. Hardness/Size игнорируются.
- Live preview: синий пунктир (#5ac8fa) на overlay canvas.

### Как тестировать

- **Skew:** выбрать слой, сдвинуть слайдер Skew X. Слой наклоняется.
  Сохранить .ora, открыть — наклон сохранён.
- **Selection:** открыть Mask Editor (Edit Mask на слое). Выбрать Lasso.
  Нарисовать контур, отпустить — область залилась в mask. Alt+drag = вырезание.

---

## v2.0.0 — Multi-layer refactor (база)

Полная переработка архитектуры: single-layer v1 → multi-layer v2.
11 модулей, ~7322 строки TypeScript, проходит `tsc --strict` с 0 ошибок.

### Модули

| Файл | Строк | Назначение |
|------|-------|-----------|
| `types.ts` | 640 | Контракты: `Layer`, `ScreentoneParams`, `PresetV2`, 18 built-in presets, `LayerTransform` (со skew и corners) |
| `roundness.ts` | 320 | Алгоритм скругления углов через `quadraticCurveTo` |
| `engine.ts` | 690 | Рендер screentone (12 паттернов, спутники, градиенты) |
| `composite.ts` | 902 | Многослойная композиция (blend modes, masks, transforms, skew, perspective) |
| `units.ts` | 76 | Конвертация px↔mm↔in↔lpi |
| `preset-store.ts` | 645 | CRUD пресетов, localStorage + 18 built-ins |
| `ora-format.ts` | 1032 | .ora (OpenRaster) save/load через JSZip |
| `history.ts` | 377 | Undo/redo, snapshot-based с coalescing |
| `mask-editor.tsx` | 1102 | UI painted masks: 6 инструментов |
| `debug-tools.tsx` | 937 | Структурированный лог + `<DebugPanel>` overlay (Ctrl+`) |
| `ps-bridge.ts` | 816 | Photoshop round-trip через PNG (Tauri + browser fallback) |
| `homography.ts` | 401 | **Новый в v2.2** — 4-point perspective |
| `transform-panel.tsx` | 1620 | UI трансформаций: Move/Rotate/Scale/Skew/Free + corner handles |
| `App.tsx` | 2228 | Старый v1, нужно заменить на новый multi-layer UI |

**Итого:** ~14 388 строк (включая старый App.tsx, который будет заменён).

### Ключевые архитектурные решения

1. **Multi-layer с blend modes** — 18 режимов (Normal, Multiply, Screen,
   Overlay, Color Dodge, ...). Полный список в `BLEND_MODES` (`types.ts`).
2. **Painted masks + shape masks** — discriminated union. Painted masks
   хранятся как `Uint8Array` alpha-канала.
3. **History = snapshot-based**, не command-pattern. Coalescing явный
   (слайдеры сливают шаги), 100 снимков в стеке.
4. **ORA format** — стандарт OpenRaster, читается GIMP/Krita. Доп. attrs
   `gentonik:*` для screentone-параметров, skew, corners.
5. **PS Bridge** — PNG round-trip без PSD-парсинга. Tauri native dialogs
   если доступно, иначе browser file picker + download.
6. **Debug logger** — ring buffer 500 записей, 10 категорий, экспорт JSON
   для баг-репортов. Thumbnail-захват canvas.

---

## v1.x — предыстория (single-layer)

Первоначальная версия GenToniK: один screentone-слой, без masks, без
history, без .ora, без PS bridge. Файлы `types.ts`, `engine.ts`,
`App.tsx` в `/home/z/my-project/upload/` — это v1. Полностью заменены в v2.

---

## Файловая карта

```
/home/z/my-project/download/
├── LICENSE                    GPLv3 (новый в v2.2-doc)
├── README.md                  Краткое описание + атрибуция
├── PATCH_NOTES.md             ← этот файл
├── IDE_GUIDE.md               Гайд для тестировщиков в IDE
├── BUILD_INSTRUCTIONS.md      Сборка .exe, чек-листы
├── types.ts                   Контракты
├── roundness.ts               Сkrugление
├── engine.ts                  Screentone рендер
├── composite.ts               Композиция слоёв
├── units.ts                   Единицы измерения
├── preset-store.ts            Пресеты
├── ora-format.ts              .ora save/load
├── history.ts                 Undo/redo
├── mask-editor.tsx            Mask editor UI
├── debug-tools.tsx            Debug panel
├── ps-bridge.ts               Photoshop bridge
├── homography.ts              Perspective math (новый в v2.2)
├── transform-panel.tsx        Transform UI (расширен в v2.1 + v2.2)
└── App.tsx                    Старый v1, ЗАМЕНИТЬ
```

---

## Что НЕ сделано (известные ограничения)

- **App.tsx не заменён.** Старый v1 (2228 строк) — single-layer. Новый
  multi-layer UI должен написать разработчик, следуя `BUILD_INSTRUCTIONS.md`.
- **.exe не собран.** Dev-сборка работает, но Tauri-build для Windows/macOS/Linux
  ещё не запускался.
- **Тесты отсутствуют.** Вся проверка — `tsc --strict` + ручное тестирование
  в dev-сервере.
- **Self-intersecting perspective quad** — нет валидации (см. v2.2 ограничения).

---

## Контакты

- Код сгенерирован: **GLM 5.1** (Z.ai)
- IDE: **Antigravity IDE**
- Лицензия: **GNU GPLv3** — свободное использование, модификация,
  распространение с условием сохранения лицензии и публикации исходников
  при распространении бинарников.

Полная история работы — в `/home/z/my-project/worklog.md`.
