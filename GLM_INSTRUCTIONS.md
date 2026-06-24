# Инструкции для GLM: Исправления и Оптимизации GenToniK

Этот файл содержит описание ранее решённых критических проблем, которые необходимо сохранить, а также подробный список текущих багов и руководство по их исправлению. Передайте эти инструкции GLM для выполнения фазы стабилизации и полировки.

---

## 1. Что было исправлено ранее (НЕ ломать!)

### 1.1. Ошибка импорта Tauri API в Vite
* **Где находится**: [`src/ps-bridge.ts:L16-L20`](file:///f:/Downloads/react-screentone-editor-implementation/src/ps-bridge.ts#L16-L20)
* **Проблема**: При статической сборке Vite пытался разрешить импорт `"@tauri-apps/api/dialog"`. В средах без Tauri (например, в Photoshop UXP или обычном браузере) этот импорт приводил к ошибке сборки (`Failed to resolve import...`).
* **Как исправлено**: Импорт сделан динамическим с использованием специальной директивы компилятора Vite `/* @vite-ignore */`:
  ```typescript
  return await import(
    /* @vite-ignore */
    "@tauri-apps/api/dialog"
  );
  ```
  **Важно**: Ни в коем случае не удаляйте комментарий `/* @vite-ignore */` при любых изменениях в мосте `ps-bridge.ts`.

### 1.2. Ошибки синхронизации Undo/Redo при трансформации слоев
* **Где находится**: [`src/App.tsx:L2586-L2645`](file:///f:/Downloads/react-screentone-editor-implementation/src/App.tsx#L2586-L2645) (обработчики `handleTransformLive` и `handleTransformCommit`)
* **Проблема 1 (Stale snapshot)**: Запись снапшота истории через `setTimeout(0)` после `setLayers` сохраняла старое состояние, так как обновление стейта в React асинхронно.
* **Проблема 2 (Отсутствие pre-drag состояния)**: Интерфейс не имел события начала перетаскивания. К моменту коммита трансформация уже многократно менялась, и состояние слоев *до начала* перемещения было безвозвратно утеряно.
* **Как исправлено (Паттерн первого изменения)**:
  Внедрен `preDragLayersRef` внутри `App.tsx`. При первом же вызове `handleTransformLive` (когда реф равен `null`) состояние слоев до мутации сохраняется и сразу же пушится в историю:
  ```typescript
  if (preDragLayersRef.current === null) {
    preDragLayersRef.current = layers; // сохраняем начальное состояние
    historyRef.current?.push(
      makeSnapshot(layers, docSize, selectedLayerId, 'Transform')
    );
  }
  ```
  В обработчике `handleTransformCommit` реф просто сбрасывается обратно в `null` (`preDragLayersRef.current = null`). Это гарантирует ровно один шаг Undo на один полноценный драг мышью.

---

## 2. Текущие проблемы и как их исправить

### 2.1. Баг: Рамка трансформации прыгает и дёргается при вращении/масштабировании
* **Где находится**: [`src/transform-overlay-movable.tsx`](file:///f:/Downloads/react-screentone-editor-implementation/src/transform-overlay-movable.tsx) (обработчики `handleScale`, `handleRotate`, `handleWarp`).
* **Почему происходит**: 
  CSS-свойство невидимого ghost-контейнера привязано к `transformOrigin: '0 0'` (левый верхний угол). `react-moveable` рассчитывает компенсирующий сдвиг `e.drag.beforeTranslate` относительно этой точки. Однако рендер холста в [`src/transform-matrix.ts:L154`](file:///f:/Downloads/react-screentone-editor-implementation/src/transform-matrix.ts#L154) (`composeLayerMatrix`) производит вращение и масштабирование относительно геометрического **центра** слоя `(-w/2, -h/2)`. Прибавка `beforeTranslate` напрямую к `transform.x/y` создает математический сдвиг, приводящий к прыжкам и улету рамок.
* **Как исправить (Проекция центра через матрицу)**:
  Вместо использования сырого `beforeTranslate` вычисляйте новое положение центра слоя на холсте прямо из экранной матрицы `e.matrix`, которую генерирует Moveable:
  
  1. Выделите 2D-часть из 3D-матрицы `e.matrix` (размера 16) и переведите её в координаты холста (разделив на зум и вычтя pan):
     ```typescript
     const { zoom, panX, panY } = view;
     const a = e.matrix[0] / zoom;
     const b = e.matrix[1] / zoom;
     const c = e.matrix[4] / zoom;
     const d = e.matrix[5] / zoom;
     const tx = (e.matrix[12] - panX) / zoom;
     const ty = (e.matrix[13] - panY) / zoom;
     ```
  2. Спроецируйте локальный центр слоя `(w/2, h/2)` через эту новую матрицу:
     ```typescript
     const w = activeLayerNaturalSize.w;
     const h = activeLayerNaturalSize.h;
     const centerX = a * (w / 2) + c * (h / 2) + tx;
     const centerY = b * (w / 2) + d * (h / 2) + ty;
     ```
  3. Получите новые значения координат центра слоя на холсте:
     ```typescript
     const newX = centerX - docSize.w / 2;
     const newY = centerY - docSize.h / 2;
     ```
  4. Примените эту математику в обработчиках:
     * В `handleScale`: обновите `scaleX`/`scaleY` через `e.scale`, а `x`/`y` установите в `newX`/`newY`.
     * В `handleRotate`: обновите `rotation` через `e.beforeRotation`, а `x`/`y` установите в `newX`/`newY`.
     * В `handleWarp` (для инструмента Skew): обновите углы сдвига, а `x`/`y` установите в `newX`/`newY` (это решит проблему уплывания слоя при сдвиге).

---

### 2.2. Производительность: Сильные тормоза при использовании Лассо (Lasso Lag)
* **Где находится**: [`src/transform-overlay-movable.tsx`](file:///f:/Downloads/react-screentone-editor-implementation/src/transform-overlay-movable.tsx) (события выделения и растеризация)
* **Почему происходит**:
  1. На каждое движение мыши вызывается `setLassoPreview([...points])`, что запускает тяжелый цикл рендеринга React и сверку Virtual DOM для всего оверлея.
  2. Очистка Canvas (`ctx.clearRect`) на каждый кадр происходит по всей площади документа (например, $2000 \times 2000$ пикселей).
  3. Алгоритм сканирующей строки `rasterizePolygon` написан на чистом JS. При большом количестве точек лассо он намертво вешает поток.
* **Как исправить**:
  1. **Убрать React из процесса ведения линии**: Накапливайте точки лассо в неподконтрольном React массиве (внутри `selectionDragRef.current` или `useRef`).
  2. **Прямой рендер**: В обработчике `onSelectionPointerMove` получайте контекст оверлейного холста и рисуйте линию превью напрямую через `ctx.lineTo() / ctx.stroke()` без изменения стейта React.
  3. **Нативная растеризация**: Замените JS-алгоритм в `rasterizePolygon` на нативный Canvas. Создайте временный оффскрин-холст размером с AABB полигона, нарисуйте на нём путь и залейте белым цветом:
     ```typescript
     const tempCanvas = document.createElement('canvas');
     tempCanvas.width = width;
     tempCanvas.height = height;
     const tempCtx = tempCanvas.getContext('2d')!;
     tempCtx.translate(-offsetX, -offsetY);
     tempCtx.beginPath();
     tempCtx.moveTo(points[0].x, points[0].y);
     for (let i = 1; i < points.length; i++) {
       tempCtx.lineTo(points[i].x, points[i].y);
     }
     tempCtx.closePath();
     tempCtx.fillStyle = 'white';
     tempCtx.fill();
     ```
     Затем скопируйте альфа-канал из `tempCtx.getImageData(0, 0, width, height).data` в результирующий `Uint8Array` маски. Это снизит время растеризации с 500мс до 1мс.

---

### 2.3. Производительность: Лаги при деформации перспективы (Free Transform)
* **Где находится**: [`src/composite.ts:L416-L489`](file:///f:/Downloads/react-screentone-editor-implementation/src/composite.ts#L416-L489) (`drawImageWithPerspective` и вызов в `compositeSingleLayer`)
* **Почему происходит**:
  Для имитации 3D-перспективы Canvas2D рендерит слой по треугольникам с использованием маски отсечения (`clip()`), которая сильно нагружает CPU. Сетка $8 \times 8$ (128 треугольников) пережимает и рендерит 2000-пиксельный холст 128 раз на каждый кадр движения мыши.
* **Как исправить (Адаптивная сетка)**:
  Внедрите динамический параметр `subdivisions` при рендере:
  * Во время активного движения (drag) используйте сетку `2` или `4` (от 8 до 32 треугольников). Это даст мгновенный отклик и плавное скольжение мыши.
  * На событии отпускания мыши (commit) и при экспорте используйте качественную сетку `8` или `16`.

---

### 2.4. Недостатки интерфейса (UI UX по аудиту)
Для соответствия последним рекомендациям дизайна необходимо исправить следующие моменты:

1. **Вкладки для Слоев и Пресетов**:
   Вместо вертикального стека в левой панели (`Layers` 40% и `Presets` 60% высоты) сделайте переключение вкладок (Tabs): `[ Слои ]` и `[ Пресеты ]`. Это позволит освободить максимум высоты для длинных списков слоев и удобной работы с браузером пресетов.
2. **Объединение Spacing X/Y**:
   В [ParamEditorSimple](file:///f:/Downloads/react-screentone-editor-implementation/src/App.tsx#L483) замените раздельные числовые поля `Spacing X` и `Spacing Y` на единое поле `Spacing` с кнопкой-замочком (цепью) рядом с ним. Если замок закрыт (по умолчанию), изменение Spacing меняет обе оси синхронно.
3. **Выпадающее меню в Top Bar**:
   Перегруппируйте кнопки в `Toolbar` из одной плоской линии в меню с классическим выпадающим поведением (File, Edit, View), чтобы разгрузить заголовок и дать приложению более строгий настольный вид.
4. **Вынос цвета фона (Background)**:
   Поскольку цвет фона холста относится к документу или слою-заливке, уберите поле `Background` из параметров скринтона в `ParamEditorSimple`. Настройки фона должны находиться либо в свойствах документа, либо управляться отдельным Solid-слоем.
