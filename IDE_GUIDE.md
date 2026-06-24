# IDE GUIDE — GenToniK v2 для тестировщиков

> **Цель:** за 15 минут запустить проект в IDE, понять структуру, проверить
> ключевые фичи. Без воды, без "теории архитектуры".

---

## 0. Что это вообще такое

**GenToniK** — редактор screentone (сеток точек, штриховки, градиентов
для манги и комиксов). Версия 2 — многослойная, с mask editor, undo/redo,
Photoshop round-trip через PNG, free transform с перспективой.

**Лицензия:** GPLv3 — можно использовать, модифицировать, распространять,
но производные работы тоже под GPLv3.
**Автор кода:** GLM 5.1 (Z.ai), собрано в **Antigravity IDE**.

---

## 1. Требования к окружению

| Компонент | Версия | Зачем |
|-----------|--------|-------|
| Node.js | 18+ | Vite dev-сервер |
| npm | 9+ | Установка зависимостей |
| Antigravity IDE / VSCode / любой | последняя | Редактирование TypeScript |
| Tauri CLI (опц.) | 2.x | Сборка .exe (необязательно для теста) |
| Браузер | Chrome 100+ / Firefox 100+ / Safari 16+ | Dev-сервер |

**ОС:** Windows 10+, macOS 12+, или Linux (Ubuntu 22.04+).
Tauri .exe-сборка требует Windows SDK / Xcode / webkit2gtk соответственно.

---

## 2. Установка за 5 шагов

### Шаг 1. Скопировать файлы

Скопируй **все** файлы из `/home/z/my-project/download/` в `src/` твоего
Tauri+React+Vite проекта. Структура:

```
твой-проект/
├── src/
│   ├── types.ts              ← скопировать
│   ├── roundness.ts          ←
│   ├── engine.ts             ←
│   ├── composite.ts          ←
│   ├── units.ts              ←
│   ├── preset-store.ts       ←
│   ├── ora-format.ts         ←
│   ├── history.ts            ←
│   ├── mask-editor.tsx       ←
│   ├── debug-tools.tsx       ←
│   ├── ps-bridge.ts          ←
│   ├── homography.ts         ←
│   ├── transform-panel.tsx   ←
│   ├── App.tsx               ← старый v1, ЗАМЕНИТЬ на новый (см. BUILD_INSTRUCTIONS.md)
│   ├── main.tsx              ← из заготовки /upload/, не трогать
│   └── index.css             ← из заготовки /upload/, опц. дополнить
├── index.html                ← из заготовки /upload/
├── package.json              ← из заготовки /upload/, дополнить
├── tsconfig.json             ← из заготовки /upload/
└── vite.config.ts            ← из заготовки /upload/
```

Заготовка проекта лежит в `/home/z/my-project/upload/`.

### Шаг 2. Установить зависимости

```bash
npm install jszip
npm install @tauri-apps/api   # опц., для native file dialogs
```

`jszip` — обязательно (для .ora save/load).
`@tauri-apps/api` — опционально. Без него ps-bridge откатывается на
browser file picker + download. Нормально для теста в браузере.

### Шаг 3. Открыть в Antigravity IDE

```bash
cd твой-проект
# Открыть папку в Antigravity IDE через File → Open Folder
```

Antigravity автоматически подхватит `tsconfig.json` (strict mode включён).
Должны видеть TypeScript-типы без красных подчёркиваний.

### Шаг 4. Запустить dev-сервер

```bash
npm run dev
```

Vite выдаст URL (обычно `http://localhost:5173`). Открыть в браузере.

### Шаг 5. Проверить что живо

- Холст рисуется (даже со старым App.tsx — там single-layer v1).
- Debug panel открывается по **Ctrl+`** (backtick) — должен показать логи.
- В devtools console: `window.__gentonikDebug` — должен вернуть объект логгера.

Если всё ок — переходи к разделу 4 (тестирование фич).

---

## 3. Структура кода — что за что отвечает

```
types.ts            Контракты данных (Layer, Preset, Transform, Mask)
                    → ИЗМЕНЯТЬ ОСТОРОЖНО, всё от него зависит

roundness.ts        Алгоритм скругления углов (чистая функция)
                    → Можно править свободно, изолирован

engine.ts           Рендер screentone (12 паттернов)
                    → Главный алгоритмический модуль

composite.ts        Многослойная композиция + трансформы
                    → Активно расширялся в v2.1 (skew) и v2.2 (perspective)

units.ts            px ↔ mm ↔ in ↔ lpi
                    → Маленький, трогать редко

preset-store.ts     CRUD пресетов + localStorage
                    → Самодостаточный, изолированный

ora-format.ts       Save/load .ora (OpenRaster) через JSZip
                    → Содержит gentonik:* extension attrs

history.ts          Undo/redo менеджер (snapshot-based)
                    → Framework-agnostic, не зависит от React

mask-editor.tsx     UI painted masks (6 инструментов)
                    → React, инлайн-стили, без CSS-файла

debug-tools.tsx     Логгер + <DebugPanel> overlay
                    → Mount один раз рядом с корнем

ps-bridge.ts        Photoshop round-trip через PNG
                    → Tauri dynamic import, browser fallback

homography.ts       Математика 4-point perspective (НОВЫЙ v2.2)
                    → Чистая функция, без副作用

transform-panel.tsx UI Move/Rotate/Scale/Skew/Free Transform
                    → Активно расширялся в v2.1 (skew) и v2.2 (corners)

App.tsx             Главный компонент (СТАРЫЙ v1, ЗАМЕНИТЬ)
                    → См. BUILD_INSTRUCTIONS.md
```

---

## 4. Тестирование фич — чек-листы

### 4.1. Базовый рендер (v2.0)

- [ ] Холст рисуется при запуске
- [ ] Кнопка добавления screentone-слоя работает
- [ ] Применение built-in пресета меняет паттерн
- [ ] Слайдер Opacity работает (0 = невидимый, 100 = непрозрачный)
- [ ] Blend mode меняется (попробовать Multiply, Screen, Overlay)
- [ ] Слой можно удалить
- [ ] Undo (Ctrl+Z) отменяет последнее действие
- [ ] Redo (Ctrl+Shift+Z или Ctrl+Y) восстанавливает

### 4.2. .ora save/load (v2.0)

- [ ] Save → создаётся .ora файл
- [ ] Распаковать .ora (это ZIP) → внутри `mergedimage.png`,
      `stack.xml`, `Thumbnail.png`
- [ ] Открыть .ora в GIMP/Krita → слои видны
- [ ] Load .ora в GenToniK → слои восстанавливаются с параметрами
- [ ] Old .ora (без gentonik:skew-*) грузится без ошибок (skew=0)

### 4.3. Mask Editor (v2.0 + v2.1)

- [ ] Клик "Edit Mask" на слое → открывается mask editor
- [ ] Brush рисует маску (мягкие края при hardness < 1)
- [ ] Eraser стирает
- [ ] **Freehand Lasso:** drag = контур, mouseup = fill
- [ ] **Polygonal Lasso:** клики добавляют точки, double-click закрывает
- [ ] **Rect Marquee:** drag = прямоугольник
- [ ] **Ellipse Marquee:** drag = эллипс
- [ ] Alt+drag в любом selection = subtract (дырка в маске)
- [ ] Escape в polygonal = отмена
- [ ] Opacity слайдер применяется к fill
- [ ] "Done" закрывает editor, маска сохранена
- [ ] Каждый stroke = один undo-шаг (не больше)

### 4.4. Skew (v2.1)

- [ ] В Transform panel есть слайдеры Skew X / Skew Y
- [ ] Skew X наклоняет слой по горизонтали
- [ ] Skew Y наклоняет по вертикали
- [ ] Значение -89° и +89° работают без NaN
- [ ] Skew + Rotation комбинируются корректно
- [ ] Save .ora → skew сохранён (gentonik:skew-x attr в stack.xml)
- [ ] Load .ora → skew восстанавливается
- [ ] Hit-test работает с skew (клик по наклонённому слою выделяет его)

### 4.5. Free Transform / Perspective (v2.2) — ГЛАВНОЕ НОВОВВЕДЕНИЕ

- [ ] В Transform panel есть кнопка **Free** (горячая клавиша **F**)
- [ ] При активации Free появляются 4 corner handle (TL/TR/BR/BL)
- [ ] Drag одного handle → соответствующий угол двигается, слой
      деформируется перспективно
- [ ] Drag всех 4 углов → quad становится трапецией
- [ ] Слой рендерится через триангуляцию (8×8 = 128 треугольников),
      видна корректная перспектива (не affine)
- [ ] **Reset Perspective** кнопка сбрасывает corners в null
- [ ] После Reset — обычный affine-режим, x/y/scale/rotation/skew работают
- [ ] Undo (Ctrl+Z) отменяет последний drag угла
- [ ] Redo восстанавливает
- [ ] Save .ora → corners сохранены (gentonik:corner-tl/tr/br/bl attrs)
- [ ] Load .ora → corners восстанавливаются
- [ ] Hit-test в perspective-режиме корректен (клик внутри quad выделяет слой)

**Что проверять внимательно:**
- Качество перспективы на больших слоях (3000×3000+). Если тормозит —
  уменьшить subdivisions в `composite.ts:drawImageWithPerspective()` с 8 до 4.
- Self-intersecting quad (TL и BR поменяны местами) — рендерится
  некорректно, валидации пока нет.

### 4.6. Photoshop Bridge (v2.0)

- [ ] Import PNG (drag-drop или file picker) → создаётся image layer
- [ ] Import из Photoshop (с .gentonik.json sidecar) → метаданные
      подхватываются
- [ ] Export PNG → файл создаётся
- [ ] В Tauri: native save dialog открывается
- [ ] В browser: файл скачивается через download
- [ ] Export to clipboard (если поддерживается) → можно вставить в PS
- [ ] Bridge session state отображается (idle/importing/editing/exporting)

### 4.7. Debug Tools (v2.0)

- [ ] **Ctrl+`** открывает/закрывает debug panel
- [ ] Panel показывает логи в реальном времени
- [ ] Фильтр по level (error/warn/info/debug/trace) работает
- [ ] Фильтр по category (10 категорий) работает
- [ ] Клик по записи → detail pane с data, stack, duration
- [ ] Export → скачивается JSON со всеми логами
- [ ] Clear → очищает буфер
- [ ] В devtools: `window.__gentonikDebug.getSnapshot()` работает
- [ ] Thumbnail canvas capture видно (если есть dumpCanvas вызовы)

---

## 5. Горячие клавиши

| Клавиша | Действие |
|---------|----------|
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` или `Ctrl+Y` | Redo |
| `Ctrl+\`` (backtick) | Toggle Debug Panel |
| `V` | Move tool (в Transform panel) |
| `R` | Rotate tool |
| `S` | Scale tool |
| `K` | Skew tool (v2.1) |
| `F` | **Free Transform** (v2.2) |
| `Esc` | Отмена polygonal lasso / закрытие диалогов |
| `Enter` | Закрыть polygonal lasso |
| `Alt+drag` | В selection инструментах = subtract |
| `Double-click` | Закрыть polygonal lasso |

---

## 6. Сборка .exe (Tauri)

### 6.1. Подготовка

```bash
npm install -D @tauri-apps/cli
npm run tauri init    # если ещё не инициализирован
```

В `tauri.conf.json` добавить capabilities (для ps-bridge):

```json
{
  "app": {
    "security": {
      "capabilities": [
        "fs:allow-read-file",
        "fs:allow-write-file",
        "dialog:allow-open",
        "dialog:allow-save"
      ]
    }
  }
}
```

### 6.2. Сборка

```bash
npm run tauri build
```

Результат:
- **Windows:** `src-tauri/target/release/bundle/nsis/*.exe`
- **macOS:** `src-tauri/target/release/bundle/dmg/*.dmg`
- **Linux:** `src-tauri/target/release/bundle/deb/*.deb` или `.AppImage`

### 6.3. Что проверять в .exe

- [ ] Запускается без консольных ошибок
- [ ] File dialogs нативные (не browser)
- [ ] Save .ora работает
- [ ] Import/Export PNG работает
- [ ] Clipboard export работает (если разрешён в capabilities)

---

## 7. Если что-то не работает

### 7.1. TypeScript ошибки

```bash
npx tsc --noEmit --strict
```

Должно быть **0 ошибок** для всех модулей кроме App.tsx (он будет заменён).

Частые проблемы:
- `Cannot find module 'jszip'` → `npm install jszip`
- `Cannot find module '@tauri-apps/api/dialog'` → опц., dynamic import
- `JSX namespace not found` → добавить `import { type JSX } from 'react'`

### 7.2. Runtime ошибки

1. Открыть **Debug Panel** (Ctrl+`).
2. Фильтр по category:
   - `composite` — рендеринг
   - `mask` — mask editor
   - `ora` — .ora save/load
   - `bridge` — Photoshop round-trip
   - `system` — необработанные ошибки
3. Нажать **Export** → скачать JSON.
4. Приложить JSON к баг-репорту.

### 7.3. Тормоза рендера

- Проверить количество слоёв (10+ — уже заметно)
- Проверить размер документа (4000×4000+ — медленно)
- Perspective на больших слоях: уменьшить subdivisions в composite.ts
- Debug Panel → посмотреть `time/timeEnd` записи (категория `composite`)

### 7.4. Undo работает странно

- Слайдеры должны coalesce (один шаг на drag). Если каждый tick = шаг —
  проверь что в App.tsx вызывается `history.push(snapshot, { coalesce: true })`.
- Brush strokes — каждый stroke = один шаг, без coalescing. Это правильно.
- История ограничена 100 снимками (старые удаляются FIFO).

---

## 8. Что НЕ тестировать (не сделано)

- App.tsx ещё старый v1 (single-layer). Полноценный multi-layer UI должен
  написать разработчик, следуя `BUILD_INSTRUCTIONS.md`.
- Self-intersecting perspective quad — валидации нет, рендер будет некорректным.
- Юнит-тесты отсутствуют. Вся проверка — ручная.
- Mobile/touch — не поддерживается (desktop-only).

---

## 9. Контакты и атрибуция

- **Код:** GLM 5.1 (Z.ai)
- **IDE:** Antigravity IDE
- **Лицензия:** GNU GPLv3 (см. `LICENSE`)

Полная история разработки — в `worklog.md` (в корне проекта).
Патч-ноты по версиям — в `PATCH_NOTES.md`.
Инструкция по сборке — в `BUILD_INSTRUCTIONS.md`.

При баг-репорте приложи:
1. Версию (v2.2.0)
2. ОС + браузер (или Tauri)
3. Export JSON из Debug Panel
4. Шаги воспроизведения
5. Скриншот (если визуальный баг)
