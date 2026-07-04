# История борьбы с вылетом WebGL / WebGL Context Loss Saga History

## Действующие лица / Cast of Characters
- **Kimi (AI):** Изначальный автор WebGL-очистки. / Author of the initial WebGL cleanup logic.
- **Claude 3.5 Sonnet (AI):** Обнаружил гонку в React Ref. / Identified the React Ref race condition.
- **Google Gemini (AI):** Выявил лимиты контекстов, бесконечный цикл рекреации и блокировку Canvas2D. / Discovered context limits, the infinite recreation loop, and Canvas2D lockout.
- **GLM-5.2 (AI):** Внедрил persistent canvas, автомат состояний, onWebGLFallback и Viewport Culling. / Implemented persistent canvas, state machine, fallback callback, and Viewport Culling.

---

## 🇷🇺 Русская версия

### Хронология событий (Июль 2026)

#### 📂 03.07.2026, ~22:00
- **Проблема:** WebGL падал на всех вкладках при переключении документов.
- **Анализ Claude:** Обнаружена гонка в React Ref: unmount-очистка читала `canvasRef.current` слишком поздно, когда React уже переключил ссылку на новый холст. Очистка гасила контекст нового холста.
- **Решение Claude:** Захватывать холст в локальную переменную при монтировании эффекта.

#### 📂 04.07.2026, ~08:50
- **Проблема:** Падения WebGL продолжались. Выдавалась ошибка `FATAL: WebGL composite failed AND canvas2D fallback unavailable`.
- **Анализ Gemini:**
  1. Размонтирование холста на каждый tab-switch (`key={activeDocId}`) исчерпывало лимит WebGL-контекстов браузера (8-16) из-за медленного GC.
  2. Новые контексты создавались уже потерянными, вызывая бесконечный цикл пересоздания на каждом кадре `requestAnimationFrame`.
  3. Canvas2D-фоллбек блокировался спецификацией HTML5 (нельзя получить 2D-контекст на холсте, где запрашивался WebGL).
- **Решение Gemini:** Отказ от `key`. Использование единого постоянного холста с очисткой FBO при переключении. Пересоздание холста (смена `canvasKey`) только при фатальном сбое.

#### 📂 04.07.2026, ~11:00
- **Разработка GLM-5.2:** Создан патч v2.18 (persistent canvas, автомат состояний, `onWebGLFallback` и оптимизация Viewport Culling — пропуск рендеринга скрытых слоев).
- **Верификация Gemini:** Сбои WebGL устранены. Система работает стабильно на больших документах. Сверхбольшие документы (например, 12 000 × 17 000 px) не открываются из-за ограничений браузера на выделение памяти под холст ещё до инициализации WebGL. Код успешно залит в Git и отправлен на GitHub.

---

## 🇺🇸 English Version

### Chronology of Events (July 2026)

#### 📂 July 3, 2026, ~22:00
- **Issue:** WebGL crashed on all tabs when switching documents.
- **Claude Analysis:** Detected a race condition in the React Ref: the unmount cleanup effect read `canvasRef.current` too late, after React had already updated the ref to the new tab's canvas. The cleanup destroyed the new canvas context.
- **Claude Solution:** Capture the canvas DOM node in a local variable during mount.

#### 📂 July 4, 2026, ~08:50
- **Issue:** WebGL crashes persisted. Browser logged `FATAL: WebGL composite failed AND canvas2D fallback unavailable`.
- **Gemini Analysis:**
  1. Re-creating the canvas on tab-switch (`key={activeDocId}`) exhausted the browser's WebGL context limit (8-16) due to slow async GC.
  2. New contexts were created in an already-lost state, triggering an infinite loop of context recreation on every `requestAnimationFrame`.
  3. Canvas2D fallback was blocked by the HTML5 spec (cannot query 2D context on a canvas where WebGL was already requested).
- **Gemini Solution:** Persistent canvas (no `key`). Clear FBOs to transparent on tab switch. Recreate the canvas (increment `canvasKey`) only on fatal WebGL loss.

#### 📂 July 4, 2026, ~11:00
- **GLM-5.2 Implementation:** Created the v2.18 patch (persistent canvas, state machine, `onWebGLFallback`, and Viewport Culling — skipping rendering of off-screen layers).
- **Gemini Verification:** WebGL crashes resolved. System works stably on large documents. Extra-large documents (e.g. 12,000 × 17,000 px) do not open due to browser-level memory allocation limits for canvas nodes before WebGL even initializes. Code pushed to GitHub.
