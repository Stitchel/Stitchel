(function() {
  const PALETTES = window.STITCHEL_PALETTES;
  const DMC = window.STITCHEL_DMC;

  let customPalettes = {};
  try {
    const saved = localStorage.getItem('pixelStudio_customPalettes');
    if (saved) customPalettes = JSON.parse(saved);
  } catch(e) {}

  let activePaletteKey = 'default';
  let activePaletteRgbCache = null;
  let activePaletteRgbCacheKey = null;

  function getActivePalette() {
    if (PALETTES[activePaletteKey]) return PALETTES[activePaletteKey];
    if (customPalettes[activePaletteKey]) return customPalettes[activePaletteKey];
    activePaletteKey = 'default';
    return PALETTES.default;
  }

  function invalidatePaletteCache() {
    activePaletteRgbCache = null;
    activePaletteRgbCacheKey = null;
  }

  function saveCustomPalettes() {
    try { localStorage.setItem('pixelStudio_customPalettes', JSON.stringify(customPalettes)); } catch(e) {}
    invalidatePaletteCache();
  }



  function dmcLookup(input) {
    const v = input.trim();
    if (DMC[v]) return { hex: DMC[v], label: v };
    const upper = v.toUpperCase();
    if (DMC[upper]) return { hex: DMC[upper], label: upper };
    const titled = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
    if (DMC[titled]) return { hex: DMC[titled], label: titled };
    const lower = v.toLowerCase();
    for (const k in DMC) {
      if (k.toLowerCase() === lower) return { hex: DMC[k], label: k };
    }
    return null;
  }

  // Auto-migrate saved custom palettes to corrected DMC hex values
  (function() {
    let changed = false;
    for (const key in customPalettes) {
      const pal = customPalettes[key];
      if (!pal.labels) continue;
      for (let i = 0; i < pal.labels.length; i++) {
        if (!pal.labels[i]) continue;
        const result = dmcLookup(pal.labels[i]);
        if (result && result.hex.toLowerCase() !== pal.colors[i]) {
          pal.colors[i] = result.hex.toLowerCase();
          changed = true;
        }
      }
    }
    if (changed) saveCustomPalettes();
  })();

  let gridW = 32, gridH = 32;
  let pixels = [];
  let paletteSourcePixels = null;
  let paletteRemapInProgress = false;
  let currentColor = '#2C2416';
  let currentTool = 'pencil';
  let brushSize = 1;
  let showGrid = true;
  let mirrorX = false;
  let zoom = 1;
  let panX = 0, panY = 0;
  let isPanning = false;
  let panStart = null;
  let isDrawing = false;
  let lastCell = null;
  let undoStack = [];
  let redoStack = [];
  let shapeStart = null;
  let previewPixels = null;
  let hoverCell = null;
  let spaceHeld = false;
  let doneColors = new Set();
  const MAX_CANVAS_DIM = 16384;

  const canvas = document.getElementById('pixelCanvas');
  const ctx = canvas.getContext('2d');
  const canvasArea = document.getElementById('canvasArea');
  const canvasWrapper = document.getElementById('canvasWrapper');
  const coordsBar = document.getElementById('coordsBar');

  // Offscreen buffer holding the static pixel layer. Rebuilt only when pixels
  // change, so per-frame draws blit one image instead of iterating every cell.
  const pixelLayer = document.createElement('canvas');
  const pixelCtx = pixelLayer.getContext('2d');
  let pixelsDirty = true;

  let drawRaf = 0;
  function scheduleDraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      draw();
    });
  }

  function initPixels() {
    pixels = [];
    for (let y = 0; y < gridH; y++) {
      pixels[y] = [];
      for (let x = 0; x < gridW; x++) {
        pixels[y][x] = null;
      }
    }
    pixelsDirty = true;
  }

  function getFitScale() {
    const area = canvasArea.getBoundingClientRect();
    const maxW = Math.max(1, area.width - 40);
    const maxH = Math.max(1, area.height - 80);
    return Math.min(maxW / gridW, maxH / gridH);
  }

  function getCanvasScale() {
    return Math.max(0.01, getFitScale() * zoom);
  }

  function getMaxVisibleZoom() {
    const targetCellSize = 32;
    return Math.max(8, targetCellSize / getFitScale());
  }

  function getRenderScale() {
    const visibleScale = getCanvasScale();
    const dpr = window.devicePixelRatio || 1;
    const maxByWidth = MAX_CANVAS_DIM / (gridW * dpr);
    const maxByHeight = MAX_CANVAS_DIM / (gridH * dpr);
    return Math.max(0.01, Math.min(visibleScale, maxByWidth, maxByHeight));
  }

  function clampPan() {
    const area = canvasArea.getBoundingClientRect();
    const canvasWidth = gridW * getCanvasScale();
    const canvasHeight = gridH * getCanvasScale();
    const maxPanX = Math.max(0, (canvasWidth - area.width) / 2);
    const maxPanY = Math.max(0, (canvasHeight - area.height) / 2);
    panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
    panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
  }

  function updateZoomLabel() {
    document.getElementById('zoomLabel').textContent = Math.round(zoom * 100) + '%';
  }

  function resizeCanvas() {
    zoom = Math.min(zoom, getMaxVisibleZoom());
    clampPan();
    const displayScale = getCanvasScale();
    const renderScale = getRenderScale();
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = (gridW * displayScale) + 'px';
    canvas.style.height = (gridH * displayScale) + 'px';
    canvas.width = Math.max(1, Math.round(gridW * renderScale * dpr));
    canvas.height = Math.max(1, Math.round(gridH * renderScale * dpr));
    pixelsDirty = true;
    draw();
    applyPan();
  }

  function applyPan() {
    canvasWrapper.style.transform = 'translate(-50%, -50%) translate(' + panX + 'px, ' + panY + 'px)';
  }

  function handleCanvasMove(e) {
    const cell = getCell(e);
    coordsBar.textContent = `${Math.max(0, Math.min(cell.x, gridW-1))}, ${Math.max(0, Math.min(cell.y, gridH-1))}`;
    hoverCell = cell.x >= 0 && cell.x < gridW && cell.y >= 0 && cell.y < gridH ? cell : null;

    if (isPanning && panStart) {
      panX = panStart.px + (e.clientX - panStart.x);
      panY = panStart.py + (e.clientY - panStart.y);
      applyPan();
      return;
    }

    if (!isDrawing) {
      scheduleDraw();
      return;
    }

    if (currentTool === 'pencil' || currentTool === 'eraser') {
      const color = currentTool === 'eraser' ? null : currentColor;
      if (lastCell) {
        const pts = interpolate(lastCell.x, lastCell.y, cell.x, cell.y);
        for (const [px, py] of pts) {
          applyBrush(px, py, color);
        }
      } else {
        applyBrush(cell.x, cell.y, color);
      }
      lastCell = cell;
      scheduleDraw();
    } else if ((currentTool === 'line' || currentTool === 'rect') && shapeStart) {
      if (currentTool === 'line') {
        previewPixels = plotLine(shapeStart.x, shapeStart.y, cell.x, cell.y);
      } else {
        previewPixels = plotRect(shapeStart.x, shapeStart.y, cell.x, cell.y);
      }
      scheduleDraw();
    }
  }

  function renderPixelLayer(w, h, scaleX, scaleY, scale) {
    if (pixelLayer.width !== w || pixelLayer.height !== h) {
      pixelLayer.width = w;
      pixelLayer.height = h;
    }
    pixelCtx.imageSmoothingEnabled = false;
    pixelCtx.setTransform(1, 0, 0, 1, 0, 0);
    pixelCtx.clearRect(0, 0, w, h);
    pixelCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    pixelCtx.fillStyle = '#FFFFFF';
    pixelCtx.fillRect(0, 0, gridW, gridH);

    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (pixels[y][x]) {
          pixelCtx.fillStyle = pixels[y][x];
          pixelCtx.fillRect(x, y, 1, 1);
          if (doneColors.has(pixels[y][x])) {
            pixelCtx.fillStyle = 'rgba(255,255,255,0.25)';
            pixelCtx.fillRect(x, y, 1, 1);
            if (scale >= 8) {
              pixelCtx.strokeStyle = 'rgba(0,0,0,0.2)';
              pixelCtx.lineWidth = 1;
              pixelCtx.beginPath();
              pixelCtx.moveTo(x, y);
              pixelCtx.lineTo(x + 1, y + 1);
              pixelCtx.stroke();
            }
          }
        }
      }
    }
    pixelsDirty = false;
  }

  function draw() {
    const scale = getCanvasScale();
    const w = canvas.width;
    const h = canvas.height;
    const scaleX = w / gridW;
    const scaleY = h / gridH;
    const cellScale = Math.min(scaleX, scaleY);

    // The static pixel layer is cached; only rebuild it when pixels change.
    if (pixelsDirty || pixelLayer.width !== w || pixelLayer.height !== h) {
      renderPixelLayer(w, h, scaleX, scaleY, scale);
    }

    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(pixelLayer, 0, 0);
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    // Preview (for shapes)
    if (previewPixels) {
      ctx.globalAlpha = 0.5;
      for (const [px, py] of previewPixels) {
        if (px >= 0 && px < gridW && py >= 0 && py < gridH) {
          ctx.fillStyle = currentTool === 'eraser' ? '#FF000044' : currentColor;
          ctx.fillRect(px, py, 1, 1);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Light, pixel-aligned preview for the pencil and eraser brushes
    if (hoverCell && !spaceHeld && (currentTool === 'pencil' || currentTool === 'eraser')) {
      const footprint = getBrushFootprint(hoverCell.x, hoverCell.y);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = currentTool === 'eraser' ? '#E85D3A' : currentColor;
      for (const [px, py] of footprint) {
        ctx.fillRect(px, py, 1, 1);
      }
      ctx.globalAlpha = 1;
    }

    // Grid
    if (showGrid) {
      const strokeGrid = (step, color, widthFactor) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = widthFactor / Math.max(scaleX, scaleY);
        for (let x = 0; x <= gridW; x += step) {
          ctx.beginPath();
          ctx.moveTo(x + 0.5 / scaleX, 0);
          ctx.lineTo(x + 0.5 / scaleX, gridH);
          ctx.stroke();
        }
        for (let y = 0; y <= gridH; y += step) {
          ctx.beginPath();
          ctx.moveTo(0, y + 0.5 / scaleY);
          ctx.lineTo(gridW, y + 0.5 / scaleY);
          ctx.stroke();
        }
      };

      if (cellScale >= 8) {
        strokeGrid(1, 'rgba(0,0,0,0.08)', 1);
      }
      if (cellScale >= 1.5) {
        strokeGrid(10, 'rgba(0,0,0,0.16)', 1.25);
      }
      if (gridW >= 100 || gridH >= 100) {
        strokeGrid(100, 'rgba(0,0,0,0.28)', 1.75);
      }
    }
  }

  function saveState() {
    if (!paletteRemapInProgress) paletteSourcePixels = null;
    undoStack.push({
      pixels: pixels.map(row => [...row]),
      gridW,
      gridH
    });
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
  }

  function captureState() {
    return { pixels: pixels.map(row => [...row]), gridW, gridH };
  }

  function restoreState(state) {
    pixels = state.pixels.map(row => [...row]);
    gridW = state.gridW;
    gridH = state.gridH;
    hoverCell = null;
    resizeCanvas();
    buildStitchTracker();
  }

  function undo() {
    if (undoStack.length === 0) return;
    paletteSourcePixels = null;
    redoStack.push(captureState());
    restoreState(undoStack.pop());
  }

  function redo() {
    if (redoStack.length === 0) return;
    paletteSourcePixels = null;
    undoStack.push(captureState());
    restoreState(redoStack.pop());
  }

  function ensurePixelCapacity(width, height) {
    const currentWidth = pixels.reduce((max, row) => Math.max(max, row.length), 0);
    while (pixels.length < height) {
      pixels.push(Array(Math.max(width, currentWidth)).fill(null));
    }
    for (const row of pixels) {
      while (row.length < width) row.push(null);
    }
  }

  function getCell(e) {
    const rect = canvas.getBoundingClientRect();
    const cellSizeX = rect.width / gridW;
    const cellSizeY = rect.height / gridH;
    const x = Math.floor((e.clientX - rect.left) / cellSizeX);
    const y = Math.floor((e.clientY - rect.top) / cellSizeY);
    return { x, y };
  }

  function setPixel(x, y, color) {
    if (x < 0 || x >= gridW || y < 0 || y >= gridH) return;
    pixels[y][x] = color;
    if (mirrorX) {
      const mx = gridW - 1 - x;
      if (mx >= 0 && mx < gridW) pixels[y][mx] = color;
    }
    pixelsDirty = true;
  }

  function applyBrush(cx, cy, color) {
    const half = Math.floor(brushSize / 2);
    for (let dy = 0; dy < brushSize; dy++) {
      for (let dx = 0; dx < brushSize; dx++) {
        setPixel(cx - half + dx, cy - half + dy, color);
      }
    }
  }

  function getBrushFootprint(cx, cy) {
    const cells = [];
    const seen = new Set();
    const half = Math.floor(brushSize / 2);
    const add = (x, y) => {
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) return;
      const key = x + ',' + y;
      if (!seen.has(key)) {
        seen.add(key);
        cells.push([x, y]);
      }
    };
    for (let dy = 0; dy < brushSize; dy++) {
      for (let dx = 0; dx < brushSize; dx++) {
        const x = cx - half + dx;
        const y = cy - half + dy;
        add(x, y);
        if (mirrorX) add(gridW - 1 - x, y);
      }
    }
    return cells;
  }

  function plotLine(x0, y0, x1, y1) {
    const pts = [];
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      pts.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return pts;
  }

  function plotRect(x0, y0, x1, y1) {
    const pts = [];
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    for (let x = minX; x <= maxX; x++) { pts.push([x, minY]); pts.push([x, maxY]); }
    for (let y = minY + 1; y < maxY; y++) { pts.push([minX, y]); pts.push([maxX, y]); }
    return pts;
  }

  function floodFill(sx, sy, newColor) {
    if (sx < 0 || sx >= gridW || sy < 0 || sy >= gridH) return;
    const target = pixels[sy][sx];
    if (target === newColor) return;
    const stack = [[sx, sy]];
    const visited = new Set();
    while (stack.length) {
      const [x, y] = stack.pop();
      const key = x + ',' + y;
      if (visited.has(key)) continue;
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
      if (pixels[y][x] !== target) continue;
      visited.add(key);
      pixels[y][x] = newColor;
      if (mirrorX) {
        const mx = gridW - 1 - x;
        if (mx >= 0 && mx < gridW && pixels[y][mx] === target) {
          stack.push([mx, y]);
        }
      }
      stack.push([x-1,y],[x+1,y],[x,y-1],[x,y+1]);
    }
    pixelsDirty = true;
  }

  function interpolate(x0, y0, x1, y1) {
    return plotLine(x0, y0, x1, y1);
  }

  // Canvas mouse events
  canvas.addEventListener('mousedown', (e) => {
    if (spaceHeld || currentTool === 'move') {
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      canvas.style.cursor = 'grabbing';
      return;
    }

    const cell = getCell(e);
    isDrawing = true;
    lastCell = cell;

    if (currentTool === 'pencil') {
      saveState();
      applyBrush(cell.x, cell.y, currentColor);
      scheduleDraw();
    } else if (currentTool === 'eraser') {
      saveState();
      applyBrush(cell.x, cell.y, null);
      scheduleDraw();
    } else if (currentTool === 'fill') {
      saveState();
      floodFill(cell.x, cell.y, currentColor);
      scheduleDraw();
      isDrawing = false;
    } else if (currentTool === 'eyedropper') {
      if (cell.x >= 0 && cell.x < gridW && cell.y >= 0 && cell.y < gridH && pixels[cell.y][cell.x]) {
        setColor(pixels[cell.y][cell.x]);
      }
      isDrawing = false;
    } else if (currentTool === 'line' || currentTool === 'rect') {
      saveState();
      shapeStart = cell;
    }
  });

  canvas.addEventListener('mousemove', handleCanvasMove);
  document.addEventListener('mousemove', (e) => {
    if (isPanning && panStart) handleCanvasMove(e);
  });

  function endDraw(e) {
    if (isPanning) {
      isPanning = false;
      panStart = null;
      canvas.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
      return;
    }

    if (!isDrawing) return;

    if ((currentTool === 'line' || currentTool === 'rect') && shapeStart && previewPixels) {
      const color = currentColor;
      for (const [px, py] of previewPixels) {
        setPixel(px, py, color);
      }
      previewPixels = null;
      shapeStart = null;
      scheduleDraw();
    }

    isDrawing = false;
    lastCell = null;
  }

  canvas.addEventListener('mouseup', endDraw);
  document.addEventListener('mouseup', endDraw);
  canvas.addEventListener('mouseleave', (e) => {
    endDraw(e);
    hoverCell = null;
    scheduleDraw();
  });

  // Zoom with scroll
  canvasArea.addEventListener('wheel', (e) => {
    e.preventDefault();
    const maxZoom = getMaxVisibleZoom();
    if (e.deltaY < 0) {
      zoom = Math.min(maxZoom, zoom * 1.15);
    } else {
      zoom = Math.max(0.25, zoom / 1.15);
    }
    updateZoomLabel();
    clampPan();
    resizeCanvas();
  }, { passive: false });

  // Toolbar
  function syncBrushSizeHighlight() {
    document.querySelectorAll('.brush-size-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.size) === brushSize);
    });
  }

  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
      syncBrushSizeHighlight();
      canvas.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
      draw();
    });
  });

  // Brush sizes
  document.querySelectorAll('.brush-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      brushSize = parseInt(btn.dataset.size);
      currentTool = btn.dataset.brushTool;
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      const toolBtn = document.querySelector(`[data-tool="${currentTool}"]`);
      if (toolBtn) toolBtn.classList.add('active');
      syncBrushSizeHighlight();
      canvas.style.cursor = 'crosshair';
      draw();
    });
  });

  // Color
  function setColor(c) {
    currentColor = c;
    document.getElementById('colorPreviewFg').style.background = c;
    document.getElementById('colorHex').value = c;
    document.getElementById('colorInput').value = c;
    document.querySelectorAll('.palette-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === c);
    });
  }

  document.getElementById('colorInput').addEventListener('input', (e) => setColor(e.target.value));
  document.getElementById('colorHex').addEventListener('change', (e) => {
    const v = e.target.value;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(v);
  });

  // Palette rendering
  const paletteGrid = document.getElementById('paletteGrid');
  const paletteSelect = document.getElementById('paletteSelect');
  const delPaletteBtn = document.getElementById('delPaletteBtn');
  const editPaletteBtn = document.getElementById('editPaletteBtn');

  function rebuildPaletteSelect() {
    paletteSelect.innerHTML = '';
    for (const [key, p] of Object.entries(PALETTES)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = p.name + ' (' + p.colors.length + ')';
      paletteSelect.appendChild(opt);
    }
    for (const [key, p] of Object.entries(customPalettes)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = p.name + ' (' + p.colors.length + ')';
      paletteSelect.appendChild(opt);
    }
    const addCustomOpt = document.createElement('option');
    addCustomOpt.value = '__add_custom__';
    addCustomOpt.textContent = 'Add custom palette…';
    paletteSelect.appendChild(addCustomOpt);
    paletteSelect.value = activePaletteKey;
    const isCustom = !!customPalettes[activePaletteKey];
    delPaletteBtn.style.display = isCustom ? '' : 'none';
    editPaletteBtn.style.display = isCustom ? '' : 'none';
  }

  function renderPalette() {
    paletteGrid.innerHTML = '';
    const pal = getActivePalette();
    pal.colors.forEach((c, i) => {
      const swatch = document.createElement('div');
      swatch.className = 'palette-swatch';
      swatch.style.background = c;
      swatch.dataset.color = c;
      if (pal.labels && pal.labels[i]) {
        const label = document.createElement('span');
        label.className = 'swatch-label';
        label.textContent = pal.labels[i];
        swatch.appendChild(label);
      }
      swatch.addEventListener('click', () => setColor(c));
      paletteGrid.appendChild(swatch);
    });
  }

  function remapArtworkToActivePalette() {
    const hasArtwork = pixels.some(row => row.some(Boolean));
    if (!hasArtwork) {
      paletteSourcePixels = null;
      return;
    }

    if (!paletteSourcePixels) {
      paletteSourcePixels = pixels.map(row => [...row]);
    }
    paletteRemapInProgress = true;
    saveState();
    paletteRemapInProgress = false;
    const colorMap = new Map();
    pixels = paletteSourcePixels.map(sourceRow => {
      const mappedRow = [...sourceRow];
      for (let x = 0; x < sourceRow.length; x++) {
        const color = sourceRow[x];
        if (!color) continue;
        if (!colorMap.has(color)) {
          const [r, g, b] = hexToRgb(color);
          colorMap.set(color, closestPalette(r, g, b));
        }
        mappedRow[x] = colorMap.get(color);
      }
      return mappedRow;
    });
    doneColors.clear();
    pixelsDirty = true;
    draw();
    buildStitchTracker();
  }

  paletteSelect.addEventListener('change', () => {
    if (paletteSelect.value === '__add_custom__') {
      paletteSelect.value = activePaletteKey;
      openNewCustomPalette();
      return;
    }
    activePaletteKey = paletteSelect.value;
    remapArtworkToActivePalette();
    const isCustom = !!customPalettes[activePaletteKey];
    delPaletteBtn.style.display = isCustom ? '' : 'none';
    editPaletteBtn.style.display = isCustom ? '' : 'none';
    renderPalette();
    const [r, g, b] = hexToRgb(currentColor);
    setColor(closestPalette(r, g, b));
  });

  rebuildPaletteSelect();
  renderPalette();

  // Custom palette editor
  const paletteOverlay = document.getElementById('paletteOverlay');
  let editingColors = [];
  let editingLabels = [];
  let editingKey = null;
  const dmcInput = document.getElementById('dmcNumberInput');
  const dmcPreview = document.getElementById('dmcPreviewSwatch');
  const colorModeSelect = document.getElementById('colorMode');
  const dmcInputRow = document.getElementById('dmcInputRow');
  const hexInputRow = document.getElementById('hexInputRow');
  const paletteModalTitle = document.getElementById('paletteModalTitle');

  colorModeSelect.addEventListener('change', () => {
    const isDmc = colorModeSelect.value === 'dmc';
    dmcInputRow.style.display = isDmc ? '' : 'none';
    hexInputRow.style.display = isDmc ? 'none' : '';
  });

  dmcInput.addEventListener('input', () => {
    const result = dmcLookup(dmcInput.value);
    dmcPreview.style.background = result ? result.hex : '#ccc';
  });

  dmcInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('addDmcBtn').click(); }
  });

  function renderCustomSwatches() {
    const container = document.getElementById('customSwatches');
    container.innerHTML = '';
    if (editingColors.length === 0) {
      const isDmc = colorModeSelect.value === 'dmc';
      container.innerHTML = '<span class="custom-empty-msg">' + (isDmc ? 'Add DMC numbers to build your palette' : 'Click Add to build your palette') + '</span>';
      return;
    }
    editingColors.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'custom-swatch-item';

      const sw = document.createElement('div');
      sw.className = 'custom-swatch';
      sw.style.background = c;
      sw.title = editingLabels[i] ? editingLabels[i] + ' ' + c : c;
      if (editingLabels[i]) {
        const lbl = document.createElement('span');
        lbl.className = 'custom-swatch-label';
        lbl.textContent = editingLabels[i];
        item.appendChild(sw);
        item.appendChild(lbl);
      } else {
        item.appendChild(sw);
      }
      sw.addEventListener('click', () => {
        editingColors.splice(i, 1);
        editingLabels.splice(i, 1);
        renderCustomSwatches();
      });
      container.appendChild(item);
    });
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  function openNewCustomPalette() {
    editingColors = [];
    editingLabels = [];
    editingKey = null;
    paletteModalTitle.textContent = 'Own palette';
    document.getElementById('customPaletteName').value = '';
    document.getElementById('customColorPicker').value = '#E85D3A';
    document.getElementById('customColorHex').value = '#E85D3A';
    dmcInput.value = '';
    dmcPreview.style.background = '#ccc';
    colorModeSelect.value = 'dmc';
    dmcInputRow.style.display = '';
    hexInputRow.style.display = 'none';
    renderCustomSwatches();
    paletteOverlay.classList.add('visible');
    requestAnimationFrame(() => {
      document.getElementById('customSwatches').scrollTop = document.getElementById('customSwatches').scrollHeight;
    });
  }

  document.getElementById('addPaletteBtn').addEventListener('click', openNewCustomPalette);

  editPaletteBtn.addEventListener('click', () => {
    const pal = customPalettes[activePaletteKey];
    if (!pal) return;
    editingKey = activePaletteKey;
    editingColors = [...pal.colors];
    editingLabels = pal.labels ? [...pal.labels] : pal.colors.map(() => null);
    paletteModalTitle.textContent = 'Edit: own palette';
    document.getElementById('customPaletteName').value = pal.name;
    document.getElementById('customColorPicker').value = '#E85D3A';
    document.getElementById('customColorHex').value = '#E85D3A';
    dmcInput.value = '';
    dmcPreview.style.background = '#ccc';
    const hasDmc = editingLabels.some(l => l);
    colorModeSelect.value = hasDmc ? 'dmc' : 'hex';
    dmcInputRow.style.display = hasDmc ? '' : 'none';
    hexInputRow.style.display = hasDmc ? 'none' : '';
    renderCustomSwatches();
    paletteOverlay.classList.add('visible');
    requestAnimationFrame(() => {
      document.getElementById('customSwatches').scrollTop = document.getElementById('customSwatches').scrollHeight;
    });
  });

  document.getElementById('customColorPicker').addEventListener('input', (e) => {
    document.getElementById('customColorHex').value = e.target.value;
  });
  document.getElementById('customColorHex').addEventListener('change', (e) => {
    if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
      document.getElementById('customColorPicker').value = e.target.value;
    }
  });

  document.getElementById('addDmcBtn').addEventListener('click', () => {
    const result = dmcLookup(dmcInput.value);
    if (!result) { dmcInput.style.borderColor = '#c0392b'; setTimeout(() => dmcInput.style.borderColor = '', 1000); return; }
    if (!editingColors.includes(result.hex.toLowerCase())) {
      editingColors.push(result.hex.toLowerCase());
      editingLabels.push(result.label);
      renderCustomSwatches();
      requestAnimationFrame(() => {
        document.getElementById('customSwatches').scrollTop = document.getElementById('customSwatches').scrollHeight;
      });
    }
    dmcInput.value = '';
    dmcPreview.style.background = '#ccc';
    dmcInput.focus();
  });

  document.getElementById('addColorBtn').addEventListener('click', () => {
    const hex = document.getElementById('customColorHex').value;
    if (/^#[0-9a-fA-F]{6}$/.test(hex) && !editingColors.includes(hex.toLowerCase())) {
      editingColors.push(hex.toLowerCase());
      editingLabels.push(null);
      renderCustomSwatches();
      requestAnimationFrame(() => {
        document.getElementById('customSwatches').scrollTop = document.getElementById('customSwatches').scrollHeight;
      });
    }
  });

  document.getElementById('paletteCancel').addEventListener('click', () => {
    paletteOverlay.classList.remove('visible');
  });

  document.getElementById('paletteSave').addEventListener('click', () => {
    const name = document.getElementById('customPaletteName').value.trim();
    if (!name) { document.getElementById('customPaletteName').focus(); return; }
    if (editingColors.length < 2) return;

    const key = editingKey || ('custom_' + Date.now());
    customPalettes[key] = {
      name: name,
      colors: [...editingColors],
      labels: editingLabels.some(l => l) ? [...editingLabels] : null,
    };
    saveCustomPalettes();
    activePaletteKey = key;
    remapArtworkToActivePalette();
    editingKey = null;
    rebuildPaletteSelect();
    renderPalette();
    const [r, g, b] = hexToRgb(currentColor);
    setColor(closestPalette(r, g, b));
    paletteOverlay.classList.remove('visible');
  });

  delPaletteBtn.addEventListener('click', () => {
    if (!customPalettes[activePaletteKey]) return;
    delete customPalettes[activePaletteKey];
    saveCustomPalettes();
    activePaletteKey = 'default';
    remapArtworkToActivePalette();
    rebuildPaletteSelect();
    renderPalette();
    const [r, g, b] = hexToRgb(currentColor);
    setColor(closestPalette(r, g, b));
  });

  // Grid toggle
  const gridToggle = document.getElementById('gridToggle');
  gridToggle.addEventListener('click', () => {
    showGrid = !showGrid;
    gridToggle.classList.toggle('on', showGrid);
    draw();
  });

  // Mirror toggle
  const mirrorToggle = document.getElementById('mirrorToggle');
  if (mirrorToggle) {
    mirrorToggle.addEventListener('click', () => {
      mirrorX = !mirrorX;
      mirrorToggle.classList.toggle('on', mirrorX);
    });
  }

  // Stitch tracker
  function buildStitchTracker() {
    const colorCounts = {};
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const c = pixels[y][x];
        if (c) colorCounts[c] = (colorCounts[c] || 0) + 1;
      }
    }
    const panel = document.getElementById('stitchPanel');
    const tracker = document.getElementById('stitchTracker');
    const colors = Object.keys(colorCounts);
    if (colors.length === 0) { panel.style.display = 'none'; return; }
    panel.style.display = '';

    const entries = Object.entries(colorCounts).map(([hex, count]) => ({
      hex, count, dmc: reverseDmcLookup(hex)
    })).sort((a, b) => a.dmc.localeCompare(b.dmc, undefined, {numeric: true}));

    tracker.innerHTML = '';
    entries.forEach(({hex, count, dmc}) => {
      const row = document.createElement('div');
      row.className = 'stitch-row' + (doneColors.has(hex) ? ' done' : '');
      row.dataset.c = hex;
      row.innerHTML = '<div class="stitch-check">' + (doneColors.has(hex) ? '✓' : '') + '</div>'
        + '<div class="stitch-swatch" style="background:' + hex + '"></div>'
        + '<span>' + dmc + '</span>'
        + '<span class="stitch-count">' + count + '</span>';
      row.addEventListener('click', () => {
        if (doneColors.has(hex)) {
          doneColors.delete(hex);
          row.classList.remove('done');
          row.querySelector('.stitch-check').textContent = '';
        } else {
          doneColors.add(hex);
          row.classList.add('done');
          row.querySelector('.stitch-check').textContent = '✓';
        }
        updateStitchProgress();
        pixelsDirty = true;
        draw();
      });
      tracker.appendChild(row);
    });
    updateStitchProgress();
  }

  function updateStitchProgress() {
    const tracker = document.getElementById('stitchTracker');
    const total = tracker.querySelectorAll('.stitch-row').length;
    const done = tracker.querySelectorAll('.stitch-row.done').length;
    document.getElementById('stitchProgress').textContent = done + '/' + total;
  }

  // Zoom buttons
  document.getElementById('zoomIn').addEventListener('click', () => {
    zoom = Math.min(getMaxVisibleZoom(), zoom * 1.25);
    updateZoomLabel();
    clampPan();
    resizeCanvas();
  });
  document.getElementById('zoomOut').addEventListener('click', () => {
    zoom = Math.max(0.25, zoom / 1.25);
    updateZoomLabel();
    clampPan();
    resizeCanvas();
  });
  document.getElementById('zoomFit').addEventListener('click', () => {
    zoom = 1;
    updateZoomLabel();
    panX = 0;
    panY = 0;
    resizeCanvas();
  });

  // Undo / Redo
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('redoBtn').addEventListener('click', redo);

  // Clear
  document.getElementById('clearBtn').addEventListener('click', () => {
    saveState();
    initPixels();
    doneColors.clear();
    draw();
    buildStitchTracker();
  });

  // Export
  document.getElementById('exportBtn').addEventListener('click', () => {
    const scale = Math.max(1, Math.floor(512 / gridW));
    const expCanvas = document.createElement('canvas');
    expCanvas.width = gridW * scale;
    expCanvas.height = gridH * scale;
    const ectx = expCanvas.getContext('2d');
    ectx.imageSmoothingEnabled = false;

    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (pixels[y][x]) {
          ectx.fillStyle = pixels[y][x];
          ectx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }

    const link = document.createElement('a');
    link.download = 'pixel-art.png';
    link.href = expCanvas.toDataURL('image/png');
    link.click();
  });

  function reverseDmcLookup(hex) {
    if (!hex) return '';
    const h = hex.toLowerCase();
    const exactMap = getReverseDmcLookupMap();
    if (exactMap.has(h)) return exactMap.get(h);
    const rgb = hexToRgb(hex);
    let best = '', bestDist = Infinity;
    for (const [num, val] of Object.entries(DMC)) {
      const pr = hexToRgb(val);
      const d = (rgb[0]-pr[0])**2 + (rgb[1]-pr[1])**2 + (rgb[2]-pr[2])**2;
      if (d < bestDist) { bestDist = d; best = num; }
    }
    exactMap.set(h, best);
    return best;
  }

  let reverseDmcLookupMap = null;
  function getReverseDmcLookupMap() {
    if (reverseDmcLookupMap) return reverseDmcLookupMap;
    reverseDmcLookupMap = new Map();
    for (const [num, val] of Object.entries(DMC)) {
      reverseDmcLookupMap.set(val.toLowerCase(), num);
    }
    return reverseDmcLookupMap;
  }

  function luminance(hex) {
    const [r,g,b] = hexToRgb(hex);
    return 0.299*r + 0.587*g + 0.114*b;
  }

  function guideLineShadows(x, y) {
    return '';
  }

  function printGuideLineShadows(x, y) {
    const shadows = [];
    const guideColor = 'rgba(168, 154, 126, 1)';
    if ((x + 1) % 10 === 0) shadows.push('border-right:3px solid ' + guideColor);
    if ((y + 1) % 10 === 0) shadows.push('border-bottom:3px solid ' + guideColor);
    return shadows.join('');
  }

  document.getElementById('exportPatternBtn').addEventListener('click', () => {
    const reverseMap = getReverseDmcLookupMap();
    const usedColors = {};
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const c = pixels[y][x];
        if (c && !usedColors[c]) {
          usedColors[c] = reverseMap.get(c.toLowerCase()) || reverseDmcLookup(c);
        }
      }
    }

    const sorted = Object.entries(usedColors).sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
    const cellPx = 24;
    const axisPx = cellPx;
    const previewCellPx = cellPx;
    const previewW = gridW * previewCellPx;
    const previewH = gridH * previewCellPx;
    const topAxisCells = Array.from({ length: gridW }, (_, x) => '<td class="screen-ax screen-ax-col" style="width:' + previewCellPx + 'px;min-width:' + previewCellPx + 'px;max-width:' + previewCellPx + 'px;height:' + axisPx + 'px;min-height:' + axisPx + 'px;max-height:' + axisPx + 'px">' + (x + 1) + '</td>').join('');
    const leftAxisRows = Array.from({ length: gridH }, (_, y) => '<tr><td class="screen-ax screen-ax-row" style="width:' + axisPx + 'px;min-width:' + axisPx + 'px;max-width:' + axisPx + 'px;height:' + previewCellPx + 'px;min-height:' + previewCellPx + 'px;max-height:' + previewCellPx + 'px">' + (y + 1) + '</td></tr>').join('');
    const printData = {
      gridW,
      gridH,
      cellPx,
      axisPx,
      previewCellPx,
      previewW,
      previewH,
      pixels,
      usedColors,
      sorted
    };

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Cross-Stitch Pattern</title>
<style>
html,body{height:100%;overflow:hidden}
*{box-sizing:border-box}
body{margin:0;font-family:"SF Mono","Consolas",monospace;color:#2C2416;background:#F5F0E8}
.view-bar{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #D4CDB8;background:#FFFDF7}
.view-bar h2{font-size:14px;margin:0}
.view-bar .info{font-size:10px;color:#666;margin:0}
.view-bar button{padding:6px 14px;border:1px solid #ccc;border-radius:5px;background:#fff;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer}
.view-bar button:hover{background:#f0f0f0}
.view-bar .print-btn{background:#3b5dc9;color:#fff;border-color:#3b5dc9}
.view-bar .print-btn:hover{background:#2d4ea5}
.view-layout{display:flex;height:calc(100vh - 52px)}
.legend-panel{width:200px;border-left:1px solid #D4CDB8;display:flex;flex-direction:column;overflow:hidden;padding:16px 12px;flex-shrink:0;background:#FFFDF7;min-height:0}
.legend-panel h2{font-size:14px;margin:0 0 14px;color:#2C2416;flex-shrink:0}
.legend-panel h3{font-size:11px;margin:0 0 12px;color:#8A7E6B;text-transform:uppercase;letter-spacing:1px;flex-shrink:0;padding-bottom:10px;border-bottom:1px solid rgba(212,205,184,0.75)}
#legendItems{overflow-y:auto;min-height:0;flex:1;padding-top:10px}
.leg-item{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;cursor:pointer;padding:6px;border-radius:6px;transition:background 0.15s;user-select:none;color:#2C2416}
.leg-item:hover{background:#F5F0E8}
.leg-item.active{background:#FFF0EC;outline:2px solid #E85D3A;outline-offset:-1px}
.leg-item.done{opacity:0.45;text-decoration:line-through}
.leg-item.done .leg-check{background:#E85D3A;border-color:#D04A28}
.leg-item.done .leg-check::after{content:"✓";color:#fff;font-size:12px}
.leg-check{width:18px;height:18px;border-radius:4px;border:2px solid #D4CDB8;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all 0.15s}
.leg-swatch{width:22px;height:22px;border-radius:5px;border:1px solid #D4CDB8;flex-shrink:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
.grid-shell{position:relative;flex:1;min-width:0;min-height:0;background:#F5F0E8;overflow:hidden}
.grid-viewport{position:absolute;inset:0;overflow:auto;background:#F5F0E8;scrollbar-gutter:stable both-edges}
.grid-sizer{width:${previewW}px;height:${previewH}px}
.grid-canvas{position:absolute;top:${axisPx}px;left:${axisPx}px;right:0;bottom:0;display:block;pointer-events:none;background:#fff;z-index:1}
.grid-corner{position:absolute;top:0;left:0;width:${axisPx}px;height:${axisPx}px;background:#f0f0f0;z-index:40;border-right:1px solid #ccc;border-bottom:1px solid #ccc;pointer-events:none}
.grid-top-axis{position:absolute;top:0;left:${axisPx}px;right:0;height:${axisPx}px;overflow:hidden;background:#f0f0f0;z-index:39;border-bottom:1px solid #ccc;pointer-events:none}
.grid-left-axis{position:absolute;top:${axisPx}px;left:0;bottom:0;width:${axisPx}px;overflow:hidden;background:#f0f0f0;z-index:38;border-right:1px solid #ccc;pointer-events:none}
.grid-top-axis-inner,.grid-left-axis-inner{position:relative;overflow:visible;will-change:transform}
.screen-ax{background:#f0f0f0 !important;background-image:none !important;color:#888;font-size:7px;font-weight:600;border:1px solid #ccc;position:relative;z-index:3;background-clip:padding-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
.screen-ax-col{border-bottom:1px solid #ccc}
.screen-ax-row{border-right:1px solid #ccc}
.screen-ax-corner{border-right:1px solid #ccc;border-bottom:1px solid #ccc}
.grid-table-wrap{position:relative;display:inline-block;background:#fff;box-shadow:0 4px 20px rgba(44,36,22,0.12)}
.grid-guides,.axis-guides-x,.axis-guides-y{position:absolute;inset:0;pointer-events:none;z-index:1}
.grid-guides{background-image:repeating-linear-gradient(to right, transparent 0, transparent ${(cellPx * 10) - 3}px, rgba(168,154,126,1) ${(cellPx * 10) - 3}px, rgba(168,154,126,1) ${cellPx * 10}px),repeating-linear-gradient(to bottom, transparent 0, transparent ${(cellPx * 10) - 3}px, rgba(168,154,126,1) ${(cellPx * 10) - 3}px, rgba(168,154,126,1) ${cellPx * 10}px)}
table{border-collapse:collapse;table-layout:fixed;background:#fff}
td{width:${cellPx}px;min-width:${cellPx}px;max-width:${cellPx}px;height:${cellPx}px;min-height:${cellPx}px;max-height:${cellPx}px;text-align:center;vertical-align:middle;font-size:8px;font-weight:700;border:1px solid #bbb;line-height:1;padding:0;overflow:hidden;white-space:nowrap;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
.ax{background:#f0f0f0 !important;background-image:none !important;color:#888;font-size:7px;font-weight:600;border:1px solid #ccc;position:relative;z-index:3;background-clip:padding-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
.ax-col{border-bottom:1px solid #ccc}
.ax-row{border-right:1px solid #ccc}
.ax-corner{border-right:1px solid #ccc;border-bottom:1px solid #ccc}
.print-sections{display:none}
.section{margin-bottom:16px}
.section-title{font-size:10px;font-weight:700;color:#888;margin-bottom:4px}
.print-svg{display:block;max-width:100%;height:auto}
.print-legend{display:none}
@media print{
html,body{height:auto!important;overflow:visible!important}
.view-bar,.view-layout{display:none!important}
.print-sections{display:block!important}
.print-legend{display:block!important;page-break-before:always;padding:16px}
.section{break-inside:avoid;page-break-inside:avoid;break-after:page;page-break-after:always}
.section:last-of-type{break-after:auto;page-break-after:auto}
body{padding:10px}
table{break-inside:avoid;page-break-inside:avoid}
td,.ax,.leg-swatch{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}
}
</style></head><body>
<div class="view-bar">
  <div><h2>Cross-Stitch Pattern</h2><div class="info">${gridW} &times; ${gridH} stitches &middot; ${sorted.length} colors</div></div>
</div>
<div class="view-layout">
  <div class="grid-shell">
    <canvas class="grid-canvas" id="patternCanvas"></canvas>
    <div class="grid-viewport" id="gridViewport">
      <div class="grid-sizer" id="gridSizer"></div>
    </div>
    <div class="grid-corner"></div>
    <div class="grid-top-axis"><div class="grid-top-axis-inner" id="gridTopAxis"><div class="axis-guides-x"></div><table><tr>${topAxisCells}</tr></table></div></div>
    <div class="grid-left-axis"><div class="grid-left-axis-inner" id="gridLeftAxis"><div class="axis-guides-y"></div><table>${leftAxisRows}</table></div></div>  </div>
  <div class="legend-panel" id="legendPanel">
    <h2>Progress Tracker</h2>
    <h3>Colors <span id="doneCount">0</span>/${sorted.length}</h3>
    <div id="legendItems"></div>
  </div>
</div>
<div class="print-sections" id="printSections"></div>
<script>
(function() {
  var data = null;
  var patternCanvas = null;
  var gridViewport = null;
  var gridSizer = null;
  var gridTopAxis = null;
  var gridLeftAxis = null;
  var legendPanel = null;
  var legendItems = null;
  var doneCount = null;
  var printSections = null;
  var ctx = null;
  var activeColor = null;
  var doneColors = new Set();
  var drawRaf = 0;
  var printBuilt = false;
  var resizeObserver = null;

  function hexToRgb(hex) {
    var value = hex.replace('#', '');
    if (value.length === 3) {
      value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
    }
    var num = parseInt(value, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  function luminance(hex) {
    var rgb = hexToRgb(hex);
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  }

  function expandHex(hex) {
    var value = String(hex || '').trim();
    if (value.charAt(0) !== '#') return value;
    if (value.length === 4) {
      return '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    }
    return value;
  }

  function svgText(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function guideLineStyle(x, y) {
    var shadows = [];
    var guideColor = 'rgba(168, 154, 126, 1)';
    if ((x + 1) % 10 === 0) shadows.push('border-right:3px solid ' + guideColor);
    if ((y + 1) % 10 === 0) shadows.push('border-bottom:3px solid ' + guideColor);
    return shadows.join('');
  }

  function setCanvasSize() {
    if (!patternCanvas || !gridViewport) return;
    var dpr = window.devicePixelRatio || 1;
    var maxCanvasPx = 8192;
    var width = Math.max(1, gridViewport.clientWidth - data.axisPx);
    var height = Math.max(1, gridViewport.clientHeight - data.axisPx);
    width = Math.min(width, Math.floor(maxCanvasPx / dpr));
    height = Math.min(height, Math.floor(maxCanvasPx / dpr));
    patternCanvas.width = Math.max(1, Math.round(width * dpr));
    patternCanvas.height = Math.max(1, Math.round(height * dpr));
    patternCanvas.style.width = width + 'px';
    patternCanvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  function scheduleDraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(function() {
      drawRaf = 0;
      draw();
    });
  }

  function draw() {
    if (!data || !ctx || !gridViewport) return;

    var cellPx = data.previewCellPx;
    var gridW = data.gridW;
    var gridH = data.gridH;
    var pixels = data.pixels;
    var dpr = window.devicePixelRatio || 1;
    var canvasW = patternCanvas.clientWidth;
    var canvasH = patternCanvas.clientHeight;
    var scrollLeft = gridViewport.scrollLeft;
    var scrollTop = gridViewport.scrollTop;
    var visibleRight = Math.max(0, scrollLeft + canvasW);
    var visibleBottom = Math.max(0, scrollTop + canvasH);


    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasW, canvasH);

    ctx.font = '700 8px "SF Mono","Consolas",monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    var firstCol = Math.max(0, Math.floor(scrollLeft / cellPx));
    var lastCol = Math.min(gridW - 1, Math.ceil(visibleRight / cellPx));
    var firstRow = Math.max(0, Math.floor(scrollTop / cellPx));
    var lastRow = Math.min(gridH - 1, Math.ceil(visibleBottom / cellPx));

    for (var y = firstRow; y <= lastRow; y++) {
      var rawY = y * cellPx - scrollTop;
      var cellY = Math.round(rawY * dpr) / dpr;
      for (var x = firstCol; x <= lastCol; x++) {
        var color = pixels[y][x];
        var rawX = x * cellPx - scrollLeft;
        var cellX = Math.round(rawX * dpr) / dpr;
        var alpha = (activeColor && color && color !== activeColor && !doneColors.has(color)) ? 0.12 : 1;
        if (color) {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = color;
          ctx.fillRect(cellX, cellY, cellPx, cellPx);
          ctx.strokeStyle = 'rgba(187, 187, 187, ' + alpha + ')';
          ctx.strokeRect(cellX + 0.5, cellY + 0.5, cellPx - 1, cellPx - 1);
          ctx.globalAlpha = 1;
          var text = data.usedColors[color] || '';
          if (text && cellPx >= 12 && !doneColors.has(color)) {
            ctx.fillStyle = luminance(color) > 140 ? 'rgba(0,0,0,' + alpha + ')' : 'rgba(255,255,255,' + alpha + ')';
            ctx.fillText(text, cellX + cellPx / 2, cellY + cellPx / 2);
          }
        } else {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(cellX, cellY, cellPx, cellPx);
          ctx.strokeStyle = 'rgba(187, 187, 187, 1)';
          ctx.strokeRect(cellX + 0.5, cellY + 0.5, cellPx - 1, cellPx - 1);
        }
      }
    }

    ctx.strokeStyle = 'rgba(168, 154, 126, 1)';
    ctx.lineWidth = 3;
    for (var gx = ((firstCol / 10) | 0) * 10 + 9; gx < gridW && gx <= lastCol + 10; gx += 10) {
      var guideX = Math.round((((gx + 1) * cellPx) - scrollLeft) * dpr) / dpr;
      ctx.beginPath();
      ctx.moveTo(guideX, 0);
      ctx.lineTo(guideX, canvasH);
      ctx.stroke();
    }
    for (var gy = ((firstRow / 10) | 0) * 10 + 9; gy < gridH && gy <= lastRow + 10; gy += 10) {
      var guideY = Math.round((((gy + 1) * cellPx) - scrollTop) * dpr) / dpr;
      ctx.beginPath();
      ctx.moveTo(0, guideY);
      ctx.lineTo(canvasW, guideY);
      ctx.stroke();
    }
  }

  function updateDoneCount() {
    if (doneCount) doneCount.textContent = String(doneColors.size);
  }

  function setActive(hex) {
    activeColor = activeColor === hex ? null : hex;
    var items = legendItems.querySelectorAll('.leg-item');
    items.forEach(function(item) {
      item.classList.toggle('active', !!activeColor && item.dataset.c === activeColor);
    });
    scheduleDraw();
  }

  function toggleDone(hex, item) {
    if (doneColors.has(hex)) {
      doneColors.delete(hex);
      item.classList.remove('done');
    } else {
      doneColors.add(hex);
      item.classList.add('done');
    }
    updateDoneCount();
    scheduleDraw();
  }

  function buildLegend() {
    if (!legendItems || !data) return;
    var frag = document.createDocumentFragment();
    data.sorted.forEach(function(entry) {
      var hex = entry[0];
      var dmc = entry[1];
      var row = document.createElement('div');
      row.className = 'leg-item';
      row.dataset.c = hex;
      row.innerHTML = '<div class="leg-check"></div><div class="leg-swatch" style="background:' + hex + '"></div><span class="leg-label">' + dmc + '</span>';
      row.addEventListener('click', function(e) {
        var isCheck = !!e.target.closest('.leg-check');
        if (isCheck) {
          toggleDone(hex, row);
          return;
        }
        setActive(hex);
      });
      frag.appendChild(row);
    });
    legendItems.innerHTML = '';
    legendItems.appendChild(frag);
    updateDoneCount();
  }

  function buildPrintSections() {
    if (!data || !printSections) return;
    printSections.innerHTML = '';

    var gridW = data.gridW;
    var gridH = data.gridH;
    var pixels = data.pixels;
    var usedColors = data.usedColors;
    var sorted = data.sorted;
    var cellPx = data.cellPx;
    var axisPx = data.axisPx;
    var colsPerPage = Math.min(gridW, Math.floor(680 / cellPx));
    var rowsPerPage = Math.min(gridH, Math.floor(900 / cellPx));
    var html = '';

    html += '<h2 style="font-size:13px;margin:0 0 4px">Cross-Stitch Pattern</h2>';
    html += '<div style="font-size:10px;color:#666;margin-bottom:10px">' + gridW + ' &times; ' + gridH + ' stitches &middot; ' + sorted.length + ' colors</div>';

    var pageNum = 0;
    for (var startY = 0; startY < gridH; startY += rowsPerPage) {
      for (var startX = 0; startX < gridW; startX += colsPerPage) {
        pageNum++;
        var endX = Math.min(startX + colsPerPage, gridW);
        var endY = Math.min(startY + rowsPerPage, gridH);
        var sectionCols = endX - startX;
        var sectionRows = endY - startY;
        var svgW = axisPx + sectionCols * cellPx;
        var svgH = axisPx + sectionRows * cellPx;
        var sectionBreak = pageNum === 1 ? '' : 'break-before:page;page-break-before:always;';
        html += '<div class="section" style="display:block;break-inside:avoid;page-break-inside:avoid;' + sectionBreak + '">';
        html += '<div class="section-title">Section ' + pageNum + ': Col ' + (startX + 1) + '–' + endX + ', Row ' + (startY + 1) + '–' + endY + '</div>';
        html += '<svg class="print-svg" xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '" shape-rendering="crispEdges">';
        html += '<rect x="0" y="0" width="' + svgW + '" height="' + svgH + '" fill="#ffffff"/>';
        html += '<rect x="0" y="0" width="' + axisPx + '" height="' + axisPx + '" fill="#f0f0f0" stroke="#ccc" stroke-width="1"/>';
        for (var x = startX; x < endX; x++) {
          var ox = axisPx + (x - startX) * cellPx;
          var topStrokeWidth = ((x + 1) % 10 === 0) ? 1.5 : 1;
          html += '<rect x="' + ox + '" y="0" width="' + cellPx + '" height="' + axisPx + '" fill="#f0f0f0" stroke="#ccc" stroke-width="' + topStrokeWidth + '"/>';
          html += '<text x="' + (ox + cellPx / 2) + '" y="' + (axisPx / 2 + 2) + '" text-anchor="middle" font-family="SF Mono,Consolas,monospace" font-size="8" font-weight="600" fill="#888">' + svgText(x + 1) + '</text>';
        }
        for (var y = startY; y < endY; y++) {
          var oy = axisPx + (y - startY) * cellPx;
          var leftStrokeWidth = ((y + 1) % 10 === 0) ? 1.5 : 1;
          html += '<rect x="0" y="' + oy + '" width="' + axisPx + '" height="' + cellPx + '" fill="#f0f0f0" stroke="#ccc" stroke-width="' + leftStrokeWidth + '"/>';
          html += '<text x="' + (axisPx / 2) + '" y="' + (oy + cellPx / 2 + 2) + '" text-anchor="middle" font-family="SF Mono,Consolas,monospace" font-size="8" font-weight="600" fill="#888">' + svgText(y + 1) + '</text>';
          for (var x2 = startX; x2 < endX; x2++) {
            var c = pixels[y][x2];
            var ox2 = axisPx + (x2 - startX) * cellPx;
            var strokeWidth = (((x2 + 1) % 10 === 0) || ((y + 1) % 10 === 0)) ? 1.5 : 1;
            if (c) {
              var dm = usedColors[c] || '';
              var tc = luminance(c) > 140 ? '#000' : '#fff';
              html += '<rect x="' + ox2 + '" y="' + oy + '" width="' + cellPx + '" height="' + cellPx + '" fill="' + expandHex(c) + '" stroke="#bbb" stroke-width="' + strokeWidth + '"/>';
              if (cellPx >= 12) {
                html += '<text x="' + (ox2 + cellPx / 2) + '" y="' + (oy + cellPx / 2 + 2) + '" text-anchor="middle" font-family="SF Mono,Consolas,monospace" font-size="8" font-weight="700" fill="' + tc + '">' + svgText(dm) + '</text>';
              }
            } else {
              html += '<rect x="' + ox2 + '" y="' + oy + '" width="' + cellPx + '" height="' + cellPx + '" fill="#ffffff" stroke="#bbb" stroke-width="' + strokeWidth + '"/>';
            }
          }
        }
        html += '</svg></div>';
      }
    }

    html += '<div class="print-legend"><h3 style="font-size:13px;margin:0 0 10px">Color Key (' + sorted.length + ' colors)</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px">';
    for (var i = 0; i < sorted.length; i++) {
      var hex = sorted[i][0];
      var dmc = sorted[i][1];
      html += '<div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600"><svg class="leg-swatch" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22" shape-rendering="crispEdges"><rect x="0" y="0" width="22" height="22" fill="' + expandHex(hex) + '" stroke="#D4CDB8" stroke-width="1"/></svg>' + dmc + '</div>';
    }
    html += '</div></div>';

    printSections.innerHTML = html;
  }

  function printPattern() {
    buildPrintSections();
    window.print();
  }

  function initPatternView() {
    data = window.__patternData;
    if (!data) return;

    patternCanvas = document.getElementById('patternCanvas');
    gridViewport = document.getElementById('gridViewport');
    gridSizer = document.getElementById('gridSizer');
    gridTopAxis = document.getElementById('gridTopAxis');
    gridLeftAxis = document.getElementById('gridLeftAxis');
    legendPanel = document.getElementById('legendPanel');
    legendItems = document.getElementById('legendItems');
    doneCount = document.getElementById('doneCount');
    printSections = document.getElementById('printSections');
    ctx = patternCanvas.getContext('2d');

    if (gridSizer) {
      gridSizer.style.width = data.previewW + 'px';
      gridSizer.style.height = data.previewH + 'px';
    }

    buildLegend();
    setCanvasSize();
    scheduleDraw();

    window.addEventListener('resize', function() {
      setCanvasSize();
      scheduleDraw();
    });

    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(function() {
        setCanvasSize();
        scheduleDraw();
      });
      resizeObserver.observe(gridViewport);
    }

    function syncGridAxes() {
      if (gridTopAxis) gridTopAxis.style.transform = 'translateX(' + (-gridViewport.scrollLeft) + 'px)';
      if (gridLeftAxis) gridLeftAxis.style.transform = 'translateY(' + (-gridViewport.scrollTop) + 'px)';
    }

    gridViewport.addEventListener('scroll', function() {
      syncGridAxes();
      scheduleDraw();
    }, { passive: true });
    syncGridAxes();

    window.addEventListener('beforeprint', buildPrintSections);
  }

  window.initPatternView = initPatternView;
  window.printPattern = printPattern;
})();
</script>
</body></html>`;

    const oldFrame = document.getElementById('patternFrame');
    if (oldFrame) oldFrame.remove();
    const frame = document.createElement('iframe');
    frame.id = 'patternFrame';
    frame.className = 'pattern-frame';
    frame.title = 'Cross-Stitch Pattern';
    frame.srcdoc = html;
    frame.addEventListener('load', () => {
      if (frame.contentWindow) {
        frame.contentWindow.__patternData = printData;
        if (typeof frame.contentWindow.initPatternView === 'function') {
          frame.contentWindow.initPatternView();
        }
      }
    });
    document.querySelector('.main-layout').appendChild(frame);
    document.body.classList.add('pattern-mode');
  });

  document.getElementById('exitPatternBtn').addEventListener('click', () => {
    document.body.classList.remove('pattern-mode');
    const frame = document.getElementById('patternFrame');
    if (frame) frame.remove();
    resizeCanvas();
  });

  document.getElementById('savePatternBtn').addEventListener('click', () => {
    const frame = document.getElementById('patternFrame');
    if (frame && frame.contentWindow && typeof frame.contentWindow.printPattern === 'function') {
      frame.contentWindow.printPattern();
    } else if (frame && frame.contentWindow) {
      frame.contentWindow.print();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;

    if (e.code === 'Space' && !spaceHeld) {
      spaceHeld = true;
      canvas.style.cursor = 'grab';
      draw();
      e.preventDefault();
    }

    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.metaKey || e.ctrlKey) && key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
    if ((e.metaKey || e.ctrlKey) && key === 'y') { e.preventDefault(); redo(); }

    if (e.metaKey || e.ctrlKey) return;

    const toolMap = { b: 'pencil', e: 'eraser', g: 'fill', i: 'eyedropper', l: 'line', r: 'rect' };
    if (toolMap[key]) {
      currentTool = toolMap[key];
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      const btn = document.querySelector(`[data-tool="${currentTool}"]`);
      if (btn) btn.classList.add('active');
      syncBrushSizeHighlight();
      canvas.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
      draw();
    }

    if (key >= '1' && key <= '4') {
      brushSize = parseInt(key);
      syncBrushSizeHighlight();
      draw();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceHeld = false;
      canvas.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
      draw();
    }
  });

  // Image import
  let importedImage = null;
  let snapToPalette = true;
  let keepRatio = false;
  let importPreviewRaf = null;

  const importOverlay = document.getElementById('importOverlay');
  const importPreview = document.getElementById('importPreview');
  const importPreviewCtx = importPreview.getContext('2d');
  const snapToggle = document.getElementById('snapToggle');
  const importSizeSelect = document.getElementById('importSize');
  const importSizeInput = document.getElementById('importSizeValue');
  const importSizeCount = document.getElementById('importSizeCount');
  const IMPORT_PREVIEW_TARGET_EDGE = 240;
  const IMPORT_PREVIEW_MAX_W = 360;
  const IMPORT_PREVIEW_MAX_H = 280;

  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
  }

  function clampImportSize(value) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return 16;
    return Math.min(600, Math.max(16, parsed));
  }

  function colorDistance(r1, g1, b1, r2, g2, b2) {
    return (r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2;
  }

  function closestPalette(r, g, b) {
    const pal = getActivePalette();
    if (!activePaletteRgbCache || activePaletteRgbCacheKey !== activePaletteKey || activePaletteRgbCache.length !== pal.colors.length) {
      activePaletteRgbCache = pal.colors.map(hex => ({ hex, rgb: hexToRgb(hex) }));
      activePaletteRgbCacheKey = activePaletteKey;
    }
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < activePaletteRgbCache.length; i++) {
      const prgb = activePaletteRgbCache[i].rgb;
      const d = colorDistance(r, g, b, prgb[0], prgb[1], prgb[2]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return activePaletteRgbCache[best].hex;
  }

  function getImportDims(maxEdge) {
    if (!importedImage || !keepRatio) return { w: maxEdge, h: maxEdge };
    const img = importedImage;
    const aspect = img.width / img.height;
    let w, h;
    if (aspect >= 1) {
      w = maxEdge;
      h = Math.max(1, Math.round(maxEdge / aspect));
    } else {
      h = maxEdge;
      w = Math.max(1, Math.round(maxEdge * aspect));
    }
    return { w, h };
  }

  function fitToTargetEdge(w, h, targetEdge, maxW, maxH) {
    const edge = Math.max(w, h);
    const scale = Math.min(targetEdge / edge, maxW / w, maxH / h);
    return {
      w: Math.max(1, Math.round(w * scale)),
      h: Math.max(1, Math.round(h * scale))
    };
  }

  function scheduleImportPreviewUpdate() {
    if (!importedImage) return;
    if (importPreviewRaf) return;
    importPreviewRaf = requestAnimationFrame(() => {
      importPreviewRaf = null;
      updateImportPreview();
    });
  }

  function drawImportedImage(ctx, img, dims) {
    if (keepRatio) {
      ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, dims.w, dims.h);
      return;
    }

    const aspect = img.width / img.height;
    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    if (aspect > 1) { sx = (img.width - img.height) / 2; sw = img.height; }
    else if (aspect < 1) { sy = (img.height - img.width) / 2; sh = img.width; }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dims.w, dims.h);
  }

  function updateImportPreview() {
    if (!importedImage) return;
    const maxEdge = clampImportSize(importSizeSelect.value);
    importSizeSelect.value = String(maxEdge);
    importSizeInput.value = String(maxEdge);
    const dims = getImportDims(maxEdge);
    importPreview.width = dims.w;
    importPreview.height = dims.h;
    importPreviewCtx.imageSmoothingEnabled = true;
    importPreviewCtx.imageSmoothingQuality = 'medium';

    drawImportedImage(importPreviewCtx, importedImage, dims);

    if (snapToPalette) {
      const imgData = importPreviewCtx.getImageData(0, 0, dims.w, dims.h);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const [cr, cg, cb] = hexToRgb(closestPalette(d[i], d[i+1], d[i+2]));
        d[i] = cr; d[i+1] = cg; d[i+2] = cb;
      }
      importPreviewCtx.putImageData(imgData, 0, 0);
    }

    const previewDims = fitToTargetEdge(dims.w, dims.h, IMPORT_PREVIEW_TARGET_EDGE, IMPORT_PREVIEW_MAX_W, IMPORT_PREVIEW_MAX_H);
    importPreview.style.width = previewDims.w + 'px';
    importPreview.style.height = previewDims.h + 'px';
    importSizeCount.textContent = keepRatio ? (dims.w + ' × ' + dims.h) : (maxEdge + ' × ' + maxEdge);
  }

  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });

  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    function onImageReady(img) {
      importedImage = img;
      const longest = Math.max(gridW, gridH);
      const initialSize = clampImportSize(longest);
      importSizeSelect.value = String(initialSize);
      importSizeInput.value = String(initialSize);
      scheduleImportPreviewUpdate();
      importOverlay.classList.add('visible');
    }

    function showImportError() {
      alert('Could not load this image format. Try converting to PNG or JPG first.');
    }

    createImageBitmap(file).then(bitmap => {
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext('2d').drawImage(bitmap, 0, 0);
      const img = new Image();
      img.onload = () => onImageReady(img);
      img.onerror = showImportError;
      img.src = c.toDataURL();
    }).catch(() => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        onImageReady(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        showImportError();
      };
      img.src = url;
    });

    e.target.value = '';
  });

  snapToggle.addEventListener('click', () => {
    snapToPalette = !snapToPalette;
    snapToggle.classList.toggle('on', snapToPalette);
    scheduleImportPreviewUpdate();
  });

  const ratioToggle = document.getElementById('ratioToggle');
  ratioToggle.addEventListener('click', () => {
    keepRatio = !keepRatio;
    ratioToggle.classList.toggle('on', keepRatio);
    scheduleImportPreviewUpdate();
  });

  importSizeSelect.addEventListener('input', () => {
    importSizeInput.value = importSizeSelect.value;
    scheduleImportPreviewUpdate();
  });
  importSizeInput.addEventListener('input', () => {
    if (importSizeInput.value.trim() === '') return;
    const value = clampImportSize(importSizeInput.value);
    importSizeSelect.value = String(value);
    scheduleImportPreviewUpdate();
  });
  importSizeInput.addEventListener('change', () => {
    const value = clampImportSize(importSizeInput.value);
    importSizeInput.value = String(value);
    importSizeSelect.value = String(value);
    scheduleImportPreviewUpdate();
  });

  document.getElementById('importCancel').addEventListener('click', () => {
    if (importPreviewRaf) {
      cancelAnimationFrame(importPreviewRaf);
      importPreviewRaf = null;
    }
    importOverlay.classList.remove('visible');
    importedImage = null;
  });

  document.getElementById('importConfirm').addEventListener('click', () => {
    if (!importedImage) return;
    const maxEdge = clampImportSize(importSizeSelect.value);
    const dims = getImportDims(maxEdge);

    saveState();

    gridW = dims.w;
    gridH = dims.h;
    initPixels();

    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = dims.w;
    tmpCanvas.height = dims.h;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.imageSmoothingEnabled = true;
    tmpCtx.imageSmoothingQuality = 'medium';

    drawImportedImage(tmpCtx, importedImage, dims);

    const imgData = tmpCtx.getImageData(0, 0, dims.w, dims.h);
    const d = imgData.data;

    for (let y = 0; y < dims.h; y++) {
      for (let x = 0; x < dims.w; x++) {
        const i = (y * dims.w + x) * 4;
        const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3];
        if (a < 128) {
          pixels[y][x] = null;
        } else if (snapToPalette) {
          pixels[y][x] = closestPalette(r, g, b);
        } else {
          pixels[y][x] = rgbToHex(r, g, b);
        }
      }
    }

    zoom = 1;
    updateZoomLabel();
    undoStack = [];
    redoStack = [];

    importOverlay.classList.remove('visible');
    importedImage = null;
    doneColors.clear();
    pixelsDirty = true;
    resizeCanvas();
    buildStitchTracker();
  });

  // Init
  initPixels();
  previewPixels = null;
  doneColors.clear();
  undoStack = [];
  redoStack = [];
  setColor('#2C2416');
  resizeCanvas();
  buildStitchTracker();

  window.addEventListener('resize', resizeCanvas);

  new ResizeObserver(() => resizeCanvas()).observe(canvasArea);
})();
