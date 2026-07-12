(function() {
  const PALETTES = window.STITCHEL_PALETTES;
  const DMC = window.STITCHEL_DMC;

  let customPalettes = {};
  try {
    const saved = localStorage.getItem('pixelStudio_customPalettes');
    if (saved) customPalettes = JSON.parse(saved);
  } catch(e) {}

  let activePaletteKey = 'default';

  function getActivePalette() {
    if (PALETTES[activePaletteKey]) return PALETTES[activePaletteKey];
    if (customPalettes[activePaletteKey]) return customPalettes[activePaletteKey];
    activePaletteKey = 'default';
    return PALETTES.default;
  }

  function saveCustomPalettes() {
    try { localStorage.setItem('pixelStudio_customPalettes', JSON.stringify(customPalettes)); } catch(e) {}
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

  const canvas = document.getElementById('pixelCanvas');
  const ctx = canvas.getContext('2d');
  const canvasArea = document.getElementById('canvasArea');
  const canvasWrapper = document.getElementById('canvasWrapper');
  const coordsBar = document.getElementById('coordsBar');

  function initPixels() {
    pixels = [];
    for (let y = 0; y < gridH; y++) {
      pixels[y] = [];
      for (let x = 0; x < gridW; x++) {
        pixels[y][x] = null;
      }
    }
  }

  function getCellSize() {
    const area = canvasArea.getBoundingClientRect();
    const maxW = (area.width - 40);
    const maxH = (area.height - 80);
    const base = Math.min(maxW / gridW, maxH / gridH);
    return Math.max(2, Math.floor(base * zoom));
  }

  function resizeCanvas() {
    const cellSize = getCellSize();
    const w = gridW * cellSize;
    const h = gridH * cellSize;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    draw();
  }

  function draw() {
    const cellSize = getCellSize();
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    // Pixels
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (pixels[y][x]) {
          ctx.fillStyle = pixels[y][x];
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
          if (doneColors.has(pixels[y][x])) {
            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
            if (cellSize >= 8) {
              ctx.strokeStyle = 'rgba(0,0,0,0.2)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(x * cellSize, y * cellSize);
              ctx.lineTo((x+1) * cellSize, (y+1) * cellSize);
              ctx.stroke();
            }
          }
        }
      }
    }

    // Preview (for shapes)
    if (previewPixels) {
      ctx.globalAlpha = 0.5;
      for (const [px, py] of previewPixels) {
        if (px >= 0 && px < gridW && py >= 0 && py < gridH) {
          ctx.fillStyle = currentTool === 'eraser' ? '#FF000044' : currentColor;
          ctx.fillRect(px * cellSize, py * cellSize, cellSize, cellSize);
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
        ctx.fillRect(px * cellSize, py * cellSize, cellSize, cellSize);
      }
      ctx.globalAlpha = 1;
    }

    // Grid
    if (showGrid && cellSize >= 4) {
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= gridW; x++) {
        ctx.beginPath();
        ctx.moveTo(x * cellSize + 0.5, 0);
        ctx.lineTo(x * cellSize + 0.5, h);
        ctx.stroke();
      }
      for (let y = 0; y <= gridH; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * cellSize + 0.5);
        ctx.lineTo(w, y * cellSize + 0.5);
        ctx.stroke();
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
    gridSlider.value = Math.max(gridW, gridH);
    gridSizeLabel.textContent = gridW + ' × ' + gridH;
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
    const cellSize = getCellSize();
    const x = Math.floor((e.clientX - rect.left) / cellSize);
    const y = Math.floor((e.clientY - rect.top) / cellSize);
    return { x, y };
  }

  function setPixel(x, y, color) {
    if (x < 0 || x >= gridW || y < 0 || y >= gridH) return;
    pixels[y][x] = color;
    if (mirrorX) {
      const mx = gridW - 1 - x;
      if (mx >= 0 && mx < gridW) pixels[y][mx] = color;
    }
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
      draw();
    } else if (currentTool === 'eraser') {
      saveState();
      applyBrush(cell.x, cell.y, null);
      draw();
    } else if (currentTool === 'fill') {
      saveState();
      floodFill(cell.x, cell.y, currentColor);
      draw();
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

  canvas.addEventListener('mousemove', (e) => {
    const cell = getCell(e);
    coordsBar.textContent = `${Math.max(0, Math.min(cell.x, gridW-1))}, ${Math.max(0, Math.min(cell.y, gridH-1))}`;
    hoverCell = cell.x >= 0 && cell.x < gridW && cell.y >= 0 && cell.y < gridH ? cell : null;

    if (isPanning && panStart) {
      return;
    }

    if (!isDrawing) {
      draw();
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
      draw();
    } else if ((currentTool === 'line' || currentTool === 'rect') && shapeStart) {
      if (currentTool === 'line') {
        previewPixels = plotLine(shapeStart.x, shapeStart.y, cell.x, cell.y);
      } else {
        previewPixels = plotRect(shapeStart.x, shapeStart.y, cell.x, cell.y);
      }
      draw();
    }
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
      draw();
    }

    isDrawing = false;
    lastCell = null;
  }

  canvas.addEventListener('mouseup', endDraw);
  canvas.addEventListener('mouseleave', (e) => {
    endDraw(e);
    hoverCell = null;
    draw();
  });

  // Zoom with scroll
  canvasArea.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      zoom = Math.min(8, zoom * 1.15);
    } else {
      zoom = Math.max(0.25, zoom / 1.15);
    }
    document.getElementById('zoomLabel').textContent = Math.round(zoom * 100) + '%';
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

  // Grid slider
  const gridSlider = document.getElementById('gridSlider');
  const gridSizeLabel = document.getElementById('gridSizeLabel');
  gridSlider.addEventListener('input', () => {
    const newSize = parseInt(gridSlider.value);
    gridSizeLabel.textContent = newSize + ' × ' + newSize;
  });
  gridSlider.addEventListener('change', () => {
    const newSize = parseInt(gridSlider.value);
    if (newSize === gridW && newSize === gridH) return;
    saveState();
    ensurePixelCapacity(newSize, newSize);
    gridW = newSize;
    gridH = newSize;
    zoom = 1;
    document.getElementById('zoomLabel').textContent = '100%';
    hoverCell = null;
    resizeCanvas();
    buildStitchTracker();
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
  mirrorToggle.addEventListener('click', () => {
    mirrorX = !mirrorX;
    mirrorToggle.classList.toggle('on', mirrorX);
  });

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
    zoom = Math.min(8, zoom * 1.25);
    document.getElementById('zoomLabel').textContent = Math.round(zoom * 100) + '%';
    resizeCanvas();
  });
  document.getElementById('zoomOut').addEventListener('click', () => {
    zoom = Math.max(0.25, zoom / 1.25);
    document.getElementById('zoomLabel').textContent = Math.round(zoom * 100) + '%';
    resizeCanvas();
  });
  document.getElementById('zoomFit').addEventListener('click', () => {
    zoom = 1;
    document.getElementById('zoomLabel').textContent = '100%';
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
    for (const [num, val] of Object.entries(DMC)) {
      if (val.toLowerCase() === h) return num;
    }
    const rgb = hexToRgb(hex);
    let best = '', bestDist = Infinity;
    for (const [num, val] of Object.entries(DMC)) {
      const pr = hexToRgb(val);
      const d = (rgb[0]-pr[0])**2 + (rgb[1]-pr[1])**2 + (rgb[2]-pr[2])**2;
      if (d < bestDist) { bestDist = d; best = num; }
    }
    return best;
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
    const usedColors = {};
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const c = pixels[y][x];
        if (c && !usedColors[c]) {
          usedColors[c] = reverseDmcLookup(c);
        }
      }
    }

    const cellPx = 24;
    const fontSize = 8;
    const colsPerPage = Math.min(gridW, Math.floor(680 / cellPx));
    const rowsPerPage = Math.min(gridH, Math.floor(900 / cellPx));

    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
    html += '<title>Cross-Stitch Pattern</title>';
    html += '<style>';
    html += '*{box-sizing:border-box}';
    html += 'body{margin:0;font-family:"SF Mono","Consolas",monospace;color:#2C2416;background:#F5F0E8}';

    html += '.view-bar{display:none}';
    html += '.view-bar h2{font-size:14px;margin:0}';
    html += '.view-bar .info{font-size:10px;color:#666;margin:0}';
    html += '.view-bar button{padding:6px 14px;border:1px solid #ccc;border-radius:5px;background:#fff;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer}';
    html += '.view-bar button:hover{background:#f0f0f0}';
    html += '.view-bar .print-btn{background:#3b5dc9;color:#fff;border-color:#3b5dc9}';
    html += '.view-bar .print-btn:hover{background:#2d4ea5}';

    html += '.view-layout{display:flex;height:100vh}';
    html += '.grid-scroll{flex:1;overflow:auto;padding:20px;background:#F5F0E8;position:relative}';
    html += '.legend-panel{width:200px;border-left:1px solid #D4CDB8;overflow-y:auto;padding:16px 12px;flex-shrink:0;background:#FFFDF7}';
    html += '.legend-panel h2{font-size:14px;margin:0 0 14px;color:#2C2416}';
    html += '.legend-panel h3{font-size:11px;margin:0 0 10px;color:#8A7E6B;text-transform:uppercase;letter-spacing:1px}';
    html += '.leg-item{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;cursor:pointer;padding:6px;border-radius:6px;transition:background 0.15s;user-select:none;color:#2C2416}';
    html += '.leg-item:hover{background:#F5F0E8}';
    html += '.leg-item.active{background:#FFF0EC;outline:2px solid #E85D3A;outline-offset:-1px}';
    html += '.leg-item.done{opacity:0.45;text-decoration:line-through}';
    html += '.leg-item.done .leg-check{background:#E85D3A;border-color:#D04A28}';
    html += '.leg-item.done .leg-check::after{content:"✓";color:#fff;font-size:12px}';
    html += '.leg-check{width:18px;height:18px;border-radius:4px;border:2px solid #D4CDB8;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all 0.15s}';
    html += '.leg-swatch{width:22px;height:22px;border-radius:5px;border:1px solid #D4CDB8;flex-shrink:0;';
    html += '-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}';

    html += '.grid-shell{position:relative;flex:1;min-width:0;min-height:0;background:#F5F0E8}';
    html += '.grid-viewport{position:absolute;inset:0;overflow:auto;padding-top:'+cellPx+'px;padding-left:'+cellPx+'px;background:#F5F0E8}';
    html += '.grid-corner{position:absolute;top:0;left:0;width:'+cellPx+'px;height:'+cellPx+'px;background:#f0f0f0;z-index:30;border-right:1px solid #ccc;border-bottom:1px solid #ccc}';
    html += '.grid-top-axis{position:absolute;top:0;left:'+cellPx+'px;right:0;height:'+cellPx+'px;overflow:hidden;background:#f0f0f0;z-index:29;border-bottom:1px solid #ccc}';
    html += '.grid-left-axis{position:absolute;top:'+cellPx+'px;left:0;bottom:0;width:'+cellPx+'px;overflow:hidden;background:#f0f0f0;z-index:28;border-right:1px solid #ccc}';
    html += '.grid-top-axis-inner,.grid-left-axis-inner{will-change:transform;position:relative}';
    html += '.grid-table-wrap{position:relative;display:inline-block;background:#fff;box-shadow:0 4px 20px rgba(44,36,22,0.12)}';
    html += '.grid-body-wrap{position:relative;display:inline-block;background:#fff;box-shadow:0 4px 20px rgba(44,36,22,0.12)}';
    html += '.grid-guides,.axis-guides-x,.axis-guides-y{position:absolute;inset:0;pointer-events:none;z-index:1}';
    html += '.grid-guides{background-image:repeating-linear-gradient(to right, transparent 0, transparent '+(cellPx * 10 - 3)+'px, rgba(168,154,126,1) '+(cellPx * 10 - 3)+'px, rgba(168,154,126,1) '+(cellPx * 10)+'px),repeating-linear-gradient(to bottom, transparent 0, transparent '+(cellPx * 10 - 3)+'px, rgba(168,154,126,1) '+(cellPx * 10 - 3)+'px, rgba(168,154,126,1) '+(cellPx * 10)+'px)}';
    html += '.axis-guides-x{background-image:repeating-linear-gradient(to right, transparent 0, transparent '+(cellPx * 10 - 3)+'px, rgba(168,154,126,1) '+(cellPx * 10 - 3)+'px, rgba(168,154,126,1) '+(cellPx * 10)+'px)}';
    html += '.axis-guides-y{background-image:repeating-linear-gradient(to bottom, transparent 0, transparent '+(cellPx * 10 - 3)+'px, rgba(168,154,126,1) '+(cellPx * 10 - 3)+'px, rgba(168,154,126,1) '+(cellPx * 10)+'px)}';
    html += 'table{border-collapse:collapse;table-layout:fixed;background:#fff}';
    html += 'td{width:'+cellPx+'px;min-width:'+cellPx+'px;max-width:'+cellPx+'px;height:'+cellPx+'px;min-height:'+cellPx+'px;max-height:'+cellPx+'px;';
    html += 'text-align:center;vertical-align:middle;font-size:'+fontSize+'px;font-weight:700;border:1px solid #bbb;line-height:1;padding:0;overflow:hidden;white-space:nowrap;';
    html += '-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}';
    html += '.ax{background:#f0f0f0 !important;background-image:none !important;color:#888;font-size:'+(fontSize-1)+'px;font-weight:600;border:1px solid #ccc;position:relative;z-index:3;background-clip:padding-box;';
    html += '-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}';
    html += '.ax-col{border-bottom:1px solid #ccc}';
    html += '.ax-row{border-right:1px solid #ccc}';
    html += '.ax-corner{border-right:1px solid #ccc;border-bottom:1px solid #ccc}';

    html += '.print-sections{display:none}';
    html += '.section{margin-bottom:16px}';
    html += '.section-title{font-size:10px;font-weight:700;color:#888;margin-bottom:4px}';
    html += '.print-legend{display:none}';

    html += '@media print{';
    html += '.view-bar,.view-layout{display:none!important}';
    html += '.print-sections{display:block!important}';
    html += '.print-legend{display:block!important;page-break-before:always;padding:16px}';
    html += '.section{page-break-inside:avoid}';
    html += 'body{padding:10px}';
    html += 'td,.ax,.leg-swatch{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}}';
    html += '</style></head><body>';

    // Top bar
    html += '<div class="view-bar">';
    html += '<div><h2>Cross-Stitch Pattern</h2>';
    html += '<div class="info">'+gridW+' &times; '+gridH+' stitches &middot; '+Object.keys(usedColors).length+' colors</div></div>';
    html += '<button class="print-btn" onclick="window.print()">Save as PDF</button>';
    html += '</div>';

    // Screen view: full grid + legend sidebar
    html += '<div class="view-layout">';
    html += '<div class="grid-shell">';
    html += '<div class="grid-viewport" id="gridViewport">';
    html += '<div class="grid-body-wrap"><div class="grid-guides"></div><table>';
    for (let y = 0; y < gridH; y++) {
      html += '<tr>';
      for (let x = 0; x < gridW; x++) {
        const c = pixels[y][x];
        const bdr = '';
        if (c) {
          const dmc = usedColors[c] || '';
          const textColor = luminance(c) > 140 ? '#000' : '#fff';
          html += '<td data-c="'+c+'" style="background:'+c+';color:'+textColor+';'+bdr+'">'+dmc+'</td>';
        } else {
          html += '<td style="'+bdr+'"></td>';
        }
      }
      html += '</tr>';
    }
    html += '</table></div></div>';
    html += '<div class="grid-corner"></div>';
    html += '<div class="grid-top-axis"><div class="grid-top-axis-inner" id="gridTopAxis"><div class="axis-guides-x"></div><table><tr>';
    for (let x = 0; x < gridW; x++) {
      const hbdr = '';
      html += '<td class="ax ax-col" style="'+hbdr+'">'+(x+1)+'</td>';
    }
    html += '</tr></table></div></div>';
    html += '<div class="grid-left-axis"><div class="grid-left-axis-inner" id="gridLeftAxis"><div class="axis-guides-y"></div><table>';
    for (let y = 0; y < gridH; y++) {
      const rowStyle = '';
      html += '<tr><td class="ax ax-row" style="'+rowStyle+'">'+(y+1)+'</td></tr>';
    }
    html += '</table></div></div>';
    html += '</div>';

    // Legend sidebar
    html += '<div class="legend-panel">';
    html += '<h2>Progress Tracker</h2>';
    html += '<h3>Colors <span id="doneCount">0</span>/'+Object.keys(usedColors).length+'</h3>';
    const sorted = Object.entries(usedColors).sort((a,b) => a[1].localeCompare(b[1], undefined, {numeric:true}));
    for (const [hex, dmc] of sorted) {
      html += '<div class="leg-item" data-c="'+hex+'"><div class="leg-check"></div><div class="leg-swatch" style="background:'+hex+'"></div><span class="leg-label">'+dmc+'</span></div>';
    }
    html += '</div></div>';

    // Print-only: paginated sections
    html += '<div class="print-sections">';
    html += '<h2 style="font-size:13px;margin:0 0 4px">Cross-Stitch Pattern</h2>';
    html += '<div style="font-size:10px;color:#666;margin-bottom:10px">'+gridW+' &times; '+gridH+' stitches &middot; '+Object.keys(usedColors).length+' colors</div>';

    let pageNum = 0;
    for (let startY = 0; startY < gridH; startY += rowsPerPage) {
      for (let startX = 0; startX < gridW; startX += colsPerPage) {
        pageNum++;
        const endX = Math.min(startX + colsPerPage, gridW);
        const endY = Math.min(startY + rowsPerPage, gridH);
        html += '<div class="section">';
        html += '<div class="section-title">Section '+pageNum+': Col '+(startX+1)+'–'+endX+', Row '+(startY+1)+'–'+endY+'</div>';
        html += '<div class="grid-table-wrap"><div class="grid-guides"></div><table><tr><td class="ax"></td>';
        for (let x = startX; x < endX; x++) {
          const hb = printGuideLineShadows(x, startY);
          html += '<td class="ax" style="'+hb+'">'+(x+1)+'</td>';
        }
        html += '</tr>';
        for (let y = startY; y < endY; y++) {
          const rt = printGuideLineShadows(startX, y);
          html += '<tr><td class="ax" style="'+rt+'">'+(y+1)+'</td>';
          for (let x = startX; x < endX; x++) {
            const c=pixels[y][x];
            const bd = printGuideLineShadows(x, y);
            if (c) {
              const dm=usedColors[c]||'';
              const tc=luminance(c)>140?'#000':'#fff';
              html+='<td style="background:'+c+';color:'+tc+';'+bd+'">'+dm+'</td>';
            } else html+='<td style="'+bd+'"></td>';
          }
          html += '</tr>';
        }
        html += '</table></div></div>';
      }
    }
    html += '</div>';

    // Print-only legend
    html += '<div class="print-legend"><h3 style="font-size:13px;margin:0 0 10px">Color Key ('+Object.keys(usedColors).length+' colors)</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px">';
    for (const [hex, dmc] of sorted) {
      html += '<div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600"><div class="leg-swatch" style="background:'+hex+'"></div>'+dmc+'</div>';
    }
    html += '</div></div>';

    // Highlight + done script
    html += '<script>';
    html += 'var doneColors={};';
    html += 'function updateDoneCount(){document.getElementById("doneCount").textContent=Object.keys(doneColors).length}';
    html += 'function applyDone(){';
    html += '  document.querySelectorAll("td[data-c]").forEach(function(td){';
    html += '    if(doneColors[td.dataset.c]){td.dataset.orig=td.dataset.orig||td.textContent;td.textContent="";td.style.filter="";td.style.opacity="1"}';
    html += '    else if(td.dataset.orig!==undefined){td.textContent=td.dataset.orig;td.style.filter="";td.style.opacity=""}';
    html += '  });';
    html += '}';
    html += 'var gridViewport=document.getElementById("gridViewport");';
    html += 'var gridTopAxis=document.getElementById("gridTopAxis");';
    html += 'var gridLeftAxis=document.getElementById("gridLeftAxis");';
    html += 'function syncGridAxes(){';
    html += '  if(!gridViewport)return;';
    html += '  if(gridTopAxis)gridTopAxis.style.transform="translateX("+(-gridViewport.scrollLeft)+"px)";';
    html += '  if(gridLeftAxis)gridLeftAxis.style.transform="translateY("+(-gridViewport.scrollTop)+"px)";';
    html += '}';
    html += 'if(gridViewport){gridViewport.addEventListener("scroll",syncGridAxes);syncGridAxes();}';
    html += 'document.querySelector(".legend-panel").addEventListener("click",function(e){';
    html += '  var item=e.target.closest(".leg-item");if(!item)return;';
    html += '  var c=item.dataset.c;';
    html += '  if(e.target.closest(".leg-check")){';
    html += '    if(doneColors[c]){delete doneColors[c];item.classList.remove("done")}';
    html += '    else{doneColors[c]=true;item.classList.add("done")}';
    html += '    updateDoneCount();applyDone();return;';
    html += '  }';
    html += '  var active=item.classList.contains("active");';
    html += '  document.querySelectorAll(".leg-item").forEach(function(el){el.classList.remove("active")});';
    html += '  var cells=document.querySelectorAll("td[data-c]");';
    html += '  if(active){';
    html += '    cells.forEach(function(td){td.style.opacity="1";td.style.outline="none";td.style.boxShadow="";td.style.zIndex="";td.style.position=""});';
    html += '  }else{';
    html += '    item.classList.add("active");';
    html += '    cells.forEach(function(td){';
    html += '      if(td.dataset.c===c){';
    html += '        td.style.opacity="1";td.style.outline="none";td.style.boxShadow="";td.style.zIndex="";td.style.position=""';
    html += '      }else{td.style.opacity=doneColors[td.dataset.c]?"1":"0.12";td.style.outline="none";td.style.boxShadow="";td.style.zIndex="";td.style.position=""}';
    html += '    });';
    html += '  }';
    html += '});';
    html += '<\/script>';

    html += '</body></html>';

    const oldFrame = document.getElementById('patternFrame');
    if (oldFrame) oldFrame.remove();
    const frame = document.createElement('iframe');
    frame.id = 'patternFrame';
    frame.className = 'pattern-frame';
    frame.title = 'Cross-Stitch Pattern';
    frame.srcdoc = html;
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
    if (frame && frame.contentWindow) frame.contentWindow.print();
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

  const importOverlay = document.getElementById('importOverlay');
  const importPreview = document.getElementById('importPreview');
  const importPreviewCtx = importPreview.getContext('2d');
  const snapToggle = document.getElementById('snapToggle');
  const importSizeSelect = document.getElementById('importSize');

  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
  }

  function colorDistance(a, b) {
    return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
  }

  function closestPalette(r, g, b) {
    const pal = getActivePalette();
    const colors = pal.colors;
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const pr = hexToRgb(colors[i]);
      const d = colorDistance([r, g, b], pr);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return colors[best];
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

  function updateImportPreview() {
    if (!importedImage) return;
    const maxEdge = parseInt(importSizeSelect.value);
    const dims = getImportDims(maxEdge);
    importPreview.width = dims.w;
    importPreview.height = dims.h;
    importPreviewCtx.imageSmoothingEnabled = true;
    importPreviewCtx.imageSmoothingQuality = 'medium';

    const img = importedImage;
    if (keepRatio) {
      importPreviewCtx.drawImage(img, 0, 0, img.width, img.height, 0, 0, dims.w, dims.h);
    } else {
      const aspect = img.width / img.height;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (aspect > 1) { sx = (img.width - img.height) / 2; sw = img.height; }
      else if (aspect < 1) { sy = (img.height - img.width) / 2; sh = img.width; }
      importPreviewCtx.drawImage(img, sx, sy, sw, sh, 0, 0, dims.w, dims.h);
    }

    if (snapToPalette) {
      const imgData = importPreviewCtx.getImageData(0, 0, dims.w, dims.h);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const [cr, cg, cb] = hexToRgb(closestPalette(d[i], d[i+1], d[i+2]));
        d[i] = cr; d[i+1] = cg; d[i+2] = cb;
      }
      importPreviewCtx.putImageData(imgData, 0, 0);
    }

    const scale = Math.min(200 / dims.w, 200 / dims.h);
    const displayW = Math.max(dims.w, Math.floor(dims.w * scale));
    const displayH = Math.max(dims.h, Math.floor(dims.h * scale));
    importPreview.style.width = displayW + 'px';
    importPreview.style.height = displayH + 'px';

    document.getElementById('importSizeLabel').textContent = keepRatio ? 'Longest edge (' + dims.w + '×' + dims.h + ')' : 'Canvas size';
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
      const opts = Array.from(importSizeSelect.options).map(o => parseInt(o.value));
      const best = opts.reduce((a, b) => Math.abs(b - longest) < Math.abs(a - longest) ? b : a);
      importSizeSelect.value = String(best);
      updateImportPreview();
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
    updateImportPreview();
  });

  const ratioToggle = document.getElementById('ratioToggle');
  ratioToggle.addEventListener('click', () => {
    keepRatio = !keepRatio;
    ratioToggle.classList.toggle('on', keepRatio);
    updateImportPreview();
  });

  importSizeSelect.addEventListener('change', updateImportPreview);

  document.getElementById('importCancel').addEventListener('click', () => {
    importOverlay.classList.remove('visible');
    importedImage = null;
  });

  document.getElementById('importConfirm').addEventListener('click', () => {
    if (!importedImage) return;
    const maxEdge = parseInt(importSizeSelect.value);
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

    const img = importedImage;
    if (keepRatio) {
      tmpCtx.drawImage(img, 0, 0, img.width, img.height, 0, 0, dims.w, dims.h);
    } else {
      const aspect = img.width / img.height;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (aspect > 1) { sx = (img.width - img.height) / 2; sw = img.height; }
      else if (aspect < 1) { sy = (img.height - img.width) / 2; sh = img.width; }
      tmpCtx.drawImage(img, sx, sy, sw, sh, 0, 0, dims.w, dims.h);
    }

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

    gridSlider.value = Math.max(dims.w, dims.h);
    gridSizeLabel.textContent = dims.w + ' × ' + dims.h;
    zoom = 1;
    document.getElementById('zoomLabel').textContent = '100%';
    undoStack = [];
    redoStack = [];

    importOverlay.classList.remove('visible');
    importedImage = null;
    doneColors.clear();
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
