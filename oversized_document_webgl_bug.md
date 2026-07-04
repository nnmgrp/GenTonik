# Анализ бага WebGL-рендеринга сверхбольших документов (12 000 × 17 000 px)

В проекте GenToniK есть скрытая логическая ошибка в WebGL-конвейере, которая ломает рендеринг при создании или импорте документов большого формата (например, 12 000 × 17 000 px), даже если видеокарта пользователя поддерживает даунсэмплинг холста.

---

## 🔍 Симптомы бага
1. При попытке создать документ формата 12 000 × 17 000 px интерфейс начинает жутко лагать (1 FPS) либо вкладка браузера аварийно закрывается с ошибкой Out-Of-Memory (OOM).
2. В логах консоли отсутствуют критические ошибки WebGL, но происходит автоматическое переключение на процессорный рендеринг Canvas2D.
3. Рендеринг Canvas2D на холсте размером 12k × 17k требует ~816 МБ оперативной памяти только под один кадровый буфер, что приводит к мгновенной перегрузке браузера.

---

## 🛠️ Математический диагноз и корневая причина (Root Cause)

В движке GenToniK заложена концепция **On-canvas downsampling** для предпросмотра:
- Если логический размер документа `(w, h)` превышает максимальный размер текстуры видеокарты (`state.caps.maxTextureSize`, обычно 16 384 или 8 192 px), рассчитывается коэффициент сжатия `state.renderScale`.
- Буферы финального вывода (Ping-Pong FBO) выделяются в сжатом физическом разрешении (`state.renderW` и `state.renderH`). Для документа 12k × 17k на GPU с лимитом 16k это даёт размер **11 565 × 16 384**.

### В чём заключается баг:
В файле `src/webgl/composite-gl.ts` внутри послойного рендеринга `compositeSingleLayerGL` размер кадрового буфера конкретного слоя (`layerFBO`) запрашивается в **оригинальном, несжатом разрешении**:
```typescript
// Line 341 inside src/webgl/composite-gl.ts:
const layerFBO = acquireLayerFBO(state, renderW, renderH);
```
Для фонового сплошного слоя (Solid Background) или любого слоя размером с документ, `renderW` и `renderH` равны исходным 12 000 и 17 000 px.

Далее в файле `src/webgl/gl-resources.ts` срабатывает защитный барьер:
```typescript
// Line 92 inside src/webgl/gl-resources.ts:
if (w > state.caps.maxTextureSize || h > state.caps.maxTextureSize) return null;
```
Поскольку высота слоя `renderH` (17 000 px) превышает лимит `maxTextureSize` (16 384 px), функция `acquireLayerFBO` возвращает `null`. 
WebGL-композиция аварийно завершается на первом же слое, и приложение скатывается в тяжелый Canvas2D-режим на центральном процессоре, что вешает вкладку.

---

## 📋 Инструкция по исправлению для ИИ (KIMI / Claude / GLM)

Для устранения бага необходимо масштабировать размеры выделяемых под слои FBO на коэффициент `state.renderScale` внутри цикла отрисовки WebGL:

1. Открыть файл `src/webgl/composite-gl.ts` и перейти к функции `compositeSingleLayerGL`.
2. Найти строку выделения памяти под FBO слоя:
   ```typescript
   const layerFBO = acquireLayerFBO(state, renderW, renderH);
   ```
3. Заменить её на масштабированную версию:
   ```typescript
   // Фикс рендеринга 12k+ документов: сжимаем FBO слоя на renderScale
   const layerRenderW = Math.max(1, Math.floor(renderW * state.renderScale));
   const layerRenderH = Math.max(1, Math.floor(renderH * state.renderScale));
   
   const layerFBO = acquireLayerFBO(state, layerRenderW, layerRenderH);
   ```
4. В той же функции обновить передаваемые размеры в функции контента и маски:
   ```typescript
   // Было:
   if (!renderLayerContentGL(state, layer, renderW, renderH, compositeCtx.imageCache)) { ... }
   if (layer.mask) {
     if (!applyMaskGL(state, layerFBO, layer.mask)) { ... }
   }

   // Должно быть:
   if (!renderLayerContentGL(state, layer, layerRenderW, layerRenderH, compositeCtx.imageCache)) { ... }
   if (layer.mask) {
     if (!applyMaskGL(state, layerFBO, layer.mask)) { ... }
   }
   ```
5. После этого изменения слои будут выделяться в пределах лимита GPU (например, фоновый слой сожмется до 11 565 × 16 384), рендеринг останется внутри WebGL и будет работать плавно на 60 FPS.
