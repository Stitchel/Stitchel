(function() {
  const PALETTES = window.STITCHEL_PALETTES;
  const DMC = window.STITCHEL_DMC;
  const $ = (id) => document.getElementById(id);

  let customPalettes = {};
  try {
    const saved = localStorage.getItem('pixelStudio_customPalettes');
    if (saved) customPalettes = JSON.parse(saved);
  } catch (e) {}

  let activePaletteKey = 'default';
  let activePaletteRgbCache = null;
  let activePaletteRgbCacheKey = null;
  let gridW = 32;
  let gridH = 32;
  let pixels = [];
  let paletteSourcePixels = null;
  let paletteRemapInProgress = false;
  let currentColor = '#2C2416';
  let doneColors = new Set();
  let importedImage = null;
  let snapToPalette = true;
  let keepRatio = false;
  let importPreviewRaf = null;
  let patternFrameReady = false;
  let legendPanel = null;
  let editingColors = [];
  let editingLabels = [];
  let editingKey = null;

  const canvas = $('previewCanvas');
  const ctx = canvas.getContext('2d');
  const previewCard = $('previewCard');
  const emptyState = $('emptyState');
  const statusChip = $('statusChip');
  const patternMeta = $('patternMeta');
  const exportPatternBtn = $('exportPatternBtn');
  const exportBtn = $('exportBtn');
  const patternOverlay = $('patternOverlay');
  const patternFrame = $('patternFrame');
  const paletteOverlay = $('paletteOverlay');
  const importOverlay = $('importOverlay');
  const importPreview = $('importPreview');
  const importPreviewCtx = importPreview.getContext('2d');
  const snapToggle = $('snapToggle');
  const ratioToggle = $('ratioToggle');
  const importSizeSelect = $('importSize');
  const importSizeInput = $('importSizeValue');
  const importSizeCount = $('importSizeCount');
  const paletteGrid = $('paletteGrid');
  const paletteSelect = $('paletteSelect');
  const delPaletteBtn = $('delPaletteBtn');
  const editPaletteBtn = $('editPaletteBtn');
  const colorInput = $('colorInput');
  const colorHex = $('colorHex');
  const colorPreviewFg = $('colorPreviewFg');
  const importFile = $('importFile');
  const dmcInput = $('dmcNumberInput');
  const dmcPreview = $('dmcPreviewSwatch');
  const colorModeSelect = $('colorMode');
  const dmcInputRow = $('dmcInputRow');
  const hexInputRow = $('hexInputRow');
  const paletteModalTitle = $('paletteModalTitle');
  const customPaletteName = $('customPaletteName');
  const customColorPicker = $('customColorPicker');
  const customColorHex = $('customColorHex');
  const customSwatches = $('customSwatches');
  const stitchPanel = $('stitchPanel');
  const stitchTracker = $('stitchTracker');
  const stitchProgress = $('stitchProgress');

  function loadCustomPalettes() {
    try {
      const saved = localStorage.getItem('pixelStudio_customPalettes');
      if (saved) customPalettes = JSON.parse(saved) || {};
    } catch (e) {}
  }

  function saveCustomPalettes() {
    try { localStorage.setItem('pixelStudio_customPalettes', JSON.stringify(customPalettes)); } catch (e) {}
    invalidatePaletteCache();
  }

  function invalidatePaletteCache() {
    activePaletteRgbCache = null;
    activePaletteRgbCacheKey = null;
  }

  function getActivePalette() {
    if (PALETTES[activePaletteKey]) return PALETTES[activePaletteKey];
    if (customPalettes[activePaletteKey]) return customPalettes[activePaletteKey];
    activePaletteKey = 'default';
    return PALETTES.default;
  }

  function hasArtwork() {
    return pixels.some(row => row.some(Boolean));
  }

  function hexToRgb(hex) {
    let value = String(hex).trim().replace('#', '');
    if (value.length === 3) {
      value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
    }
    const num = parseInt(value, 16);
    if (Number.isNaN(num)) return [44, 36, 22];
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
  }

  function colorDistance(r1, g1, b1, r2, g2, b2) {
    return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
  }

  function dmcLookup(input) {
    const v = String(input || '').trim();
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

  function getReverseDmcLookupMap() {
    if (getReverseDmcLookupMap.map) return getReverseDmcLookupMap.map;
    const map = new Map();
    for (const [num, val] of Object.entries(DMC)) {
      map.set(String(val).toLowerCase(), num);
    }
    getReverseDmcLookupMap.map = map;
    return map;
  }

  function reverseDmcLookup(hex) {
    if (!hex) return '';
    const h = String(hex).toLowerCase();
    const exactMap = getReverseDmcLookupMap();
    if (exactMap.has(h)) return exactMap.get(h);
    const rgb = hexToRgb(hex);
    let best = '';
    let bestDist = Infinity;
    for (const [num, val] of Object.entries(DMC)) {
      const pr = hexToRgb(val);
      const d = colorDistance(rgb[0], rgb[1], rgb[2], pr[0], pr[1], pr[2]);
      if (d < bestDist) { bestDist = d; best = num; }
    }
    exactMap.set(h, best);
    return best;
  }

  function closestPalette(r, g, b) {
    const pal = getActivePalette();
    if (!activePaletteRgbCache || activePaletteRgbCacheKey !== activePaletteKey || activePaletteRgbCache.length !== pal.colors.length) {
      activePaletteRgbCache = pal.colors.map(hex => ({ hex, rgb: hexToRgb(hex) }));
      activePaletteRgbCacheKey = activePaletteKey;
    }
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < activePaletteRgbCache.length; i++) {
      const prgb = activePaletteRgbCache[i].rgb;
      const d = colorDistance(r, g, b, prgb[0], prgb[1], prgb[2]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return activePaletteRgbCache[best].hex;
  }

  function ensurePixelGrid(width, height) {
    pixels = [];
    for (let y = 0; y < height; y++) {
      pixels[y] = [];
      for (let x = 0; x < width; x++) pixels[y][x] = null;
    }
  }

  function syncButtons() {
    const ready = hasArtwork();
    exportPatternBtn.disabled = !ready;
    exportBtn.disabled = !ready;
    statusChip.textContent = ready ? `${gridW} × ${gridH} ready` : 'No artwork yet';
    emptyState.style.display = ready ? 'none' : 'flex';
    canvas.style.display = ready ? 'block' : 'none';
  }

  function updateColorSelection(c) {
    currentColor = c;
    if (colorPreviewFg) colorPreviewFg.style.background = c;
    if (colorHex) colorHex.value = c;
    if (colorInput) colorInput.value = c;
    document.querySelectorAll('.palette-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === c);
    });
  }

  function drawPreview() {
    if (!hasArtwork()) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const w = canvas.width;
    const h = canvas.height;
    const scaleX = w / gridW;
    const scaleY = h / gridH;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, gridW, gridH);
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (pixels[y][x]) {
          ctx.fillStyle = pixels[y][x];
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function resizePreview() {
    const rect = previewCard.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!hasArtwork()) {
      canvas.width = 1;
      canvas.height = 1;
      drawPreview();
      syncButtons();
      return;
    }
    const maxW = Math.max(1, rect.width - 24);
    const maxH = Math.max(1, rect.height - 24);
    const scale = Math.max(0.25, Math.min(maxW / gridW, maxH / gridH));
    const cssW = gridW * scale;
    const cssH = gridH * scale;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    drawPreview();
    syncButtons();
  }

  function scheduleResizePreview() {
    requestAnimationFrame(resizePreview);
  }

  function buildStitchTracker() {
    const colorCounts = {};
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const c = pixels[y][x];
        if (c) colorCounts[c] = (colorCounts[c] || 0) + 1;
      }
    }
    const colors = Object.keys(colorCounts);
    if (!colors.length) {
      stitchTracker.innerHTML = '<div class="tracker-empty">Import an image to see the stitch tracker.</div>';
      stitchProgress.textContent = '0/0';
      stitchPanel.style.display = '';
      return;
    }

    const entries = Object.entries(colorCounts)
      .map(([hex, count]) => ({ hex, count, dmc: reverseDmcLookup(hex) }))
      .sort((a, b) => a.dmc.localeCompare(b.dmc, undefined, { numeric: true }));

    stitchTracker.innerHTML = '';
    entries.forEach(({ hex, count, dmc }) => {
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
        drawPreview();
      });
      stitchTracker.appendChild(row);
    });
    updateStitchProgress();
    stitchPanel.style.display = '';
  }

  function updateStitchProgress() {
    const total = stitchTracker.querySelectorAll('.stitch-row').length;
    const done = stitchTracker.querySelectorAll('.stitch-row.done').length;
    stitchProgress.textContent = done + '/' + total;
  }

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
      swatch.addEventListener('click', () => updateColorSelection(c));
      paletteGrid.appendChild(swatch);
    });
    updateColorSelection(currentColor);
  }

  function remapArtworkToActivePalette() {
    if (!hasArtwork()) {
      paletteSourcePixels = null;
      buildStitchTracker();
      drawPreview();
      return;
    }

    if (!paletteSourcePixels) {
      paletteSourcePixels = pixels.map(row => [...row]);
    }
    const source = paletteSourcePixels;
    const mapped = source.map(sourceRow => {
      const row = [...sourceRow];
      for (let x = 0; x < sourceRow.length; x++) {
        const color = sourceRow[x];
        if (!color) continue;
        const [r, g, b] = hexToRgb(color);
        row[x] = closestPalette(r, g, b);
      }
      return row;
    });
    pixels = mapped;
    doneColors.clear();
    scheduleResizePreview();
    buildStitchTracker();
  }

  function setSheetVisible(el, visible) {
    el.classList.toggle('visible', visible);
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function renderCustomSwatches() {
    customSwatches.innerHTML = '';
    if (!editingColors.length) {
      const isDmc = colorModeSelect.value === 'dmc';
      customSwatches.innerHTML = '<span class="custom-empty-msg">' + (isDmc ? 'Add DMC numbers to build your palette' : 'Click Add to build your palette') + '</span>';
      return;
    }
    editingColors.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'custom-swatch-item';
      const sw = document.createElement('div');
      sw.className = 'custom-swatch';
      sw.style.background = c;
      sw.title = editingLabels[i] ? editingLabels[i] + ' ' + c : c;
      sw.addEventListener('click', () => {
        editingColors.splice(i, 1);
        editingLabels.splice(i, 1);
        renderCustomSwatches();
      });
      item.appendChild(sw);
      if (editingLabels[i]) {
        const lbl = document.createElement('span');
        lbl.className = 'custom-swatch-label';
        lbl.textContent = editingLabels[i];
        item.appendChild(lbl);
      }
      customSwatches.appendChild(item);
    });
  }

  function openNewCustomPalette() {
    editingColors = [];
    editingLabels = [];
    editingKey = null;
    paletteModalTitle.textContent = 'Own palette';
    customPaletteName.value = '';
    customColorPicker.value = '#E85D3A';
    customColorHex.value = '#E85D3A';
    dmcInput.value = '';
    dmcPreview.style.background = '#ccc';
    colorModeSelect.value = 'dmc';
    dmcInputRow.style.display = '';
    hexInputRow.style.display = 'none';
    renderCustomSwatches();
    setSheetVisible(paletteOverlay, true);
  }

  function openEditPalette() {
    const pal = customPalettes[activePaletteKey];
    if (!pal) return;
    editingKey = activePaletteKey;
    editingColors = [...pal.colors];
    editingLabels = pal.labels ? [...pal.labels] : pal.colors.map(() => null);
    paletteModalTitle.textContent = 'Edit: own palette';
    customPaletteName.value = pal.name;
    customColorPicker.value = '#E85D3A';
    customColorHex.value = '#E85D3A';
    dmcInput.value = '';
    dmcPreview.style.background = '#ccc';
    const hasDmc = editingLabels.some(Boolean);
    colorModeSelect.value = hasDmc ? 'dmc' : 'hex';
    dmcInputRow.style.display = hasDmc ? '' : 'none';
    hexInputRow.style.display = hasDmc ? 'none' : '';
    renderCustomSwatches();
    setSheetVisible(paletteOverlay, true);
  }

  function clampImportSize(value) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return 16;
    return Math.min(600, Math.max(16, parsed));
  }

  function getImportDims(maxEdge) {
    if (!importedImage || !keepRatio) return { w: maxEdge, h: maxEdge };
    const img = importedImage;
    const aspect = img.width / img.height;
    if (aspect >= 1) {
      return { w: maxEdge, h: Math.max(1, Math.round(maxEdge / aspect)) };
    }
    return { w: Math.max(1, Math.round(maxEdge * aspect)), h: maxEdge };
  }

  function fitToTargetEdge(w, h, targetEdge, maxW, maxH) {
    const edge = Math.max(w, h);
    const scale = Math.min(targetEdge / edge, maxW / w, maxH / h);
    return {
      w: Math.max(1, Math.round(w * scale)),
      h: Math.max(1, Math.round(h * scale))
    };
  }

  function drawImportedImage(ctx2d, img, dims) {
    if (keepRatio) {
      ctx2d.drawImage(img, 0, 0, img.width, img.height, 0, 0, dims.w, dims.h);
      return;
    }
    const aspect = img.width / img.height;
    let sx = 0;
    let sy = 0;
    let sw = img.width;
    let sh = img.height;
    if (aspect > 1) {
      sx = (img.width - img.height) / 2;
      sw = img.height;
    } else if (aspect < 1) {
      sy = (img.height - img.width) / 2;
      sh = img.width;
    }
    ctx2d.drawImage(img, sx, sy, sw, sh, 0, 0, dims.w, dims.h);
  }

  function scheduleImportPreviewUpdate() {
    if (!importedImage) return;
    if (importPreviewRaf) return;
    importPreviewRaf = requestAnimationFrame(() => {
      importPreviewRaf = null;
      updateImportPreview();
    });
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
        const [cr, cg, cb] = hexToRgb(closestPalette(d[i], d[i + 1], d[i + 2]));
        d[i] = cr;
        d[i + 1] = cg;
        d[i + 2] = cb;
      }
      importPreviewCtx.putImageData(imgData, 0, 0);
    }
    const rect = importOverlay.querySelector('.sheet').getBoundingClientRect();
    const previewDims = fitToTargetEdge(dims.w, dims.h, 240, Math.max(260, rect.width - 64), 280);
    importPreview.style.width = previewDims.w + 'px';
    importPreview.style.height = previewDims.h + 'px';
    importSizeCount.textContent = keepRatio ? (dims.w + ' × ' + dims.h) : (maxEdge + ' × ' + maxEdge);
  }

  function openImportSheet() {
    importFile.click();
  }

  function updatePatternMeta() {
    if (!patternMeta) return;
    const colorCount = stitchTracker.querySelectorAll('.stitch-row').length;
    patternMeta.textContent = gridW + ' × ' + gridH + ' stitches · ' + colorCount + ' colors';
  }

  function buildPatternHtml(data) {
    const topAxisCells = Array.from({ length: data.gridW }, (_, x) => '<td class="screen-ax screen-ax-col" style="width:' + data.previewCellPx + 'px;min-width:' + data.previewCellPx + 'px;max-width:' + data.previewCellPx + 'px;height:' + data.axisPx + 'px;min-height:' + data.axisPx + 'px;max-height:' + data.axisPx + 'px">' + (x + 1) + '</td>').join('');
    const leftAxisRows = Array.from({ length: data.gridH }, (_, y) => '<tr><td class="screen-ax screen-ax-row" style="width:' + data.axisPx + 'px;min-width:' + data.axisPx + 'px;max-width:' + data.axisPx + 'px;height:' + data.previewCellPx + 'px;min-height:' + data.previewCellPx + 'px;max-height:' + data.previewCellPx + 'px">' + (y + 1) + '</td></tr>').join('');

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Cross-Stitch Pattern</title>
<style>
html,body{height:100%;overflow:hidden}
*{box-sizing:border-box}
body{margin:0;font-family:"SF Mono","Consolas",monospace;color:#2C2416;background:#F5F0E8}
.view-bar{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #D4CDB8;background:#FFFDF7}
.view-bar h2{font-size:14px;margin:0}
.view-bar .info{font-size:10px;color:#666;margin:0}
.legend-toggle{padding:6px 10px;border:1px solid #D4CDB8;border-radius:999px;background:#FFFDF7;color:#2C2416;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap}
.legend-toggle:hover{background:#F5F0E8}
.view-layout{display:flex;height:calc(100vh - 52px)}
.legend-panel{width:200px;border-left:1px solid #D4CDB8;display:flex;flex-direction:column;overflow:hidden;padding:16px 12px;flex-shrink:0;background:#FFFDF7;min-height:0}
.legend-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.legend-panel h2{font-size:14px;margin:0;color:#2C2416;flex-shrink:0}
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
.grid-sizer{width:${data.previewW}px;height:${data.previewH}px}
.grid-canvas{position:absolute;top:${data.axisPx}px;left:${data.axisPx}px;right:0;bottom:0;display:block;pointer-events:none;background:#fff;z-index:1}
.grid-corner{position:absolute;top:0;left:0;width:${data.axisPx}px;height:${data.axisPx}px;background:#f0f0f0;z-index:40;border-right:1px solid #ccc;border-bottom:1px solid #ccc;pointer-events:none}
.grid-top-axis{position:absolute;top:0;left:${data.axisPx}px;right:0;height:${data.axisPx}px;overflow:hidden;background:#f0f0f0;z-index:39;border-bottom:1px solid #ccc;pointer-events:none}
.grid-left-axis{position:absolute;top:${data.axisPx}px;left:0;bottom:0;width:${data.axisPx}px;overflow:hidden;background:#f0f0f0;z-index:38;border-right:1px solid #ccc;pointer-events:none}
.grid-top-axis-inner,.grid-left-axis-inner{position:relative;overflow:visible;will-change:transform}
.screen-ax{background:#f0f0f0 !important;background-image:none !important;color:#888;font-size:7px;font-weight:600;border:1px solid #ccc;position:relative;z-index:3;background-clip:padding-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
.screen-ax-col{border-bottom:1px solid #ccc}
.screen-ax-row{border-right:1px solid #ccc}
.screen-ax-corner{border-right:1px solid #ccc;border-bottom:1px solid #ccc}
.grid-table-wrap{position:relative;display:inline-block;background:#fff;box-shadow:0 4px 20px rgba(44,36,22,0.12)}
.grid-guides,.axis-guides-x,.axis-guides-y{position:absolute;inset:0;pointer-events:none;z-index:1}
.grid-guides{background-image:repeating-linear-gradient(to right, transparent 0, transparent ${(data.cellPx * 10) - 3}px, rgba(168,154,126,1) ${(data.cellPx * 10) - 3}px, rgba(168,154,126,1) ${data.cellPx * 10}px),repeating-linear-gradient(to bottom, transparent 0, transparent ${(data.cellPx * 10) - 3}px, rgba(168,154,126,1) ${(data.cellPx * 10) - 3}px, rgba(168,154,126,1) ${data.cellPx * 10}px)}
table{border-collapse:collapse;table-layout:fixed;background:#fff}
td{width:${data.cellPx}px;min-width:${data.cellPx}px;max-width:${data.cellPx}px;height:${data.cellPx}px;min-height:${data.cellPx}px;max-height:${data.cellPx}px;text-align:center;vertical-align:middle;font-size:8px;font-weight:700;border:1px solid #bbb;line-height:1;padding:0;overflow:hidden;white-space:nowrap;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
.ax{background:#f0f0f0 !important;background-image:none !important;color:#888;font-size:7px;font-weight:600;border:1px solid #ccc;position:relative;z-index:3;background-clip:padding-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
.ax-col{border-bottom:1px solid #ccc}
.ax-row{border-right:1px solid #ccc}
.ax-corner{border-right:1px solid #ccc;border-bottom:1px solid #ccc}
.print-sections{display:none}
.section{margin-bottom:16px}
.section-title{font-size:10px;font-weight:700;color:#888;margin-bottom:4px}
.print-legend{display:none}
@media (max-width: 820px){
.view-layout{flex-direction:column;height:calc(100vh - 52px)}
.grid-shell{order:1;flex:1 1 auto;min-height:0;background:#fff}
.legend-panel{order:2;align-self:stretch;width:100%;max-height:24vh;border-left:0;border-top:1px solid #D4CDB8;padding:12px 12px 12px;border-radius:0;overflow:hidden;background-clip:padding-box;box-shadow:0 -6px 18px rgba(44,36,22,0.08);transition:max-height 0.18s ease, padding 0.18s ease, opacity 0.18s ease, transform 0.18s ease}
.legend-panel-head{margin-bottom:10px}
.legend-panel h2{font-size:11px;margin:0}
.legend-panel h3{font-size:8px;margin:0 0 6px;padding-bottom:5px}
#legendItems{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;padding-top:6px}
.leg-item{min-width:0;gap:6px;padding:4px 6px;font-size:9px}
.leg-check{width:12px;height:12px}
.leg-swatch{width:14px;height:14px}
.leg-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grid-canvas{top:0;left:0;right:0;bottom:0}
.grid-corner{display:block;width:${data.axisPx}px;height:${data.axisPx}px;background:rgba(240,240,240,0.95)}
.grid-top-axis{left:0;right:0;height:${data.axisPx}px;background:rgba(240,240,240,0.95)}
.grid-left-axis{display:block;width:${data.axisPx}px;top:0;bottom:0;background:rgba(240,240,240,0.95)}
.grid-viewport{inset:0;background:#fff;scrollbar-gutter:auto}
.legend-panel.collapsed{max-height:78px;padding-top:12px;padding-bottom:12px}
.legend-panel.collapsed h3,
.legend-panel.collapsed #legendItems{display:none}
.legend-panel.collapsed .legend-panel-head{margin-bottom:0}
.legend-panel.collapsed .legend-toggle::before{content:'▸ ';font-weight:700}
@media (max-width: 480px){
#legendItems{grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}
}
}
@media print{
.view-bar,.view-layout{display:none!important}
.print-sections{display:block!important}
.print-legend{display:block!important;page-break-before:always;padding:16px}
.section{page-break-inside:avoid}
body{padding:10px}
td,.ax,.leg-swatch{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}
}
</style></head><body>
<div class="view-bar">
  <div><h2>Cross-Stitch Pattern</h2><div class="info">${data.gridW} &times; ${data.gridH} stitches &middot; ${data.sorted.length} colors</div></div>
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
    <div class="legend-panel-head">
      <h2>Progress Tracker</h2>
      <button class="legend-toggle" id="legendToggleBtn" type="button">Close tracker</button>
    </div>
    <h3>Colors <span id="doneCount">0</span>/${data.sorted.length}</h3>
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
  var legendToggleBtn = null;
  var printSections = null;
  var ctx = null;
  var activeColor = null;
  var doneColors = new Set();
  var drawRaf = 0;
  var printBuilt = false;
  var resizeObserver = null;
  var legendCollapsed = false;
  var isCompactLayout = window.matchMedia && window.matchMedia('(max-width: 820px)').matches;

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
    var width = Math.max(1, gridViewport.clientWidth - (isCompactLayout ? 0 : data.axisPx));
    var height = Math.max(1, gridViewport.clientHeight - (isCompactLayout ? 0 : data.axisPx));
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

  function updateLegendToggleLabel() {
    if (!legendToggleBtn) return;
    legendToggleBtn.textContent = legendCollapsed ? 'Open tracker' : 'Close tracker';
    legendToggleBtn.setAttribute('aria-expanded', legendCollapsed ? 'false' : 'true');
  }

  function applyLegendCollapsedState() {
    if (legendPanel) legendPanel.classList.toggle('collapsed', legendCollapsed);
    updateLegendToggleLabel();
    if (gridViewport) {
      setCanvasSize();
      scheduleDraw();
    }
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
        html += '<div class="section">';
        html += '<div class="section-title">Section ' + pageNum + ': Col ' + (startX + 1) + '–' + endX + ', Row ' + (startY + 1) + '–' + endY + '</div>';
        html += '<div class="grid-table-wrap"><div class="grid-guides"></div><table><tr><td class="ax"></td>';
        for (var x = startX; x < endX; x++) {
          html += '<td class="ax" style="' + guideLineStyle(x, startY) + '">' + (x + 1) + '</td>';
        }
        html += '</tr>';
        for (var y = startY; y < endY; y++) {
          html += '<tr><td class="ax" style="' + guideLineStyle(startX, y) + '">' + (y + 1) + '</td>';
          for (var x2 = startX; x2 < endX; x2++) {
            var c = pixels[y][x2];
            var bd = guideLineStyle(x2, y);
            if (c) {
              var dm = usedColors[c] || '';
              var tc = luminance(c) > 140 ? '#000' : '#fff';
              html += '<td style="background:' + c + ';color:' + tc + ';' + bd + '">' + dm + '</td>';
            } else {
              html += '<td style="' + bd + '"></td>';
            }
          }
          html += '</tr>';
        }
        html += '</table></div></div>';
      }
    }

    html += '<div class="print-legend"><h3 style="font-size:13px;margin:0 0 10px">Color Key (' + sorted.length + ' colors)</h3>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px">';
    for (var i = 0; i < sorted.length; i++) {
      var hex = sorted[i][0];
      var dmc = sorted[i][1];
      html += '<div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600"><div class="leg-swatch" style="background:' + hex + '"></div>' + dmc + '</div>';
    }
    html += '</div></div>';

    printSections.innerHTML = html;
  }

  function printPattern() {
    buildPrintSections();
    requestAnimationFrame(function() {
      window.print();
    });
  }

  function initPatternView() {
    data = window.__patternData;
    if (!data) return;

    patternFrameReady = true;
    patternCanvas = document.getElementById('patternCanvas');
    gridViewport = document.getElementById('gridViewport');
    gridSizer = document.getElementById('gridSizer');
    gridTopAxis = document.getElementById('gridTopAxis');
    gridLeftAxis = document.getElementById('gridLeftAxis');
    legendPanel = document.getElementById('legendPanel');
    legendItems = document.getElementById('legendItems');
    doneCount = document.getElementById('doneCount');
    legendToggleBtn = document.getElementById('legendToggleBtn');
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

    if (legendToggleBtn) {
      legendToggleBtn.addEventListener('click', function() {
        legendCollapsed = !legendCollapsed;
        applyLegendCollapsedState();
      });
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
    applyLegendCollapsedState();

    window.addEventListener('beforeprint', buildPrintSections);
  }

  window.initPatternView = initPatternView;
  window.printPattern = printPattern;
})();

  </script></body></html>`;
  }

  function openPatternView() {
    if (!hasArtwork()) return;
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

    const html = buildPatternHtml(printData);
    patternFrameReady = false;
    patternFrame.onload = () => {
      if (patternFrame.contentWindow) {
        patternFrame.contentWindow.__patternData = printData;
        if (typeof patternFrame.contentWindow.initPatternView === 'function') {
          patternFrame.contentWindow.initPatternView();
        }
      }
    };
    patternFrame.srcdoc = html;
    patternOverlay.classList.add('visible');
    patternOverlay.setAttribute('aria-hidden', 'false');
    updatePatternMeta();
  }

  function closePatternView() {
    patternOverlay.classList.remove('visible');
    patternOverlay.setAttribute('aria-hidden', 'true');
    patternFrame.removeAttribute('srcdoc');
    updatePatternMeta();
  }

  function exportPNG() {
    if (!hasArtwork()) return;
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
  }

  function setImportSheetState(visible) {
    setSheetVisible(importOverlay, visible);
    if (!visible && importPreviewRaf) {
      cancelAnimationFrame(importPreviewRaf);
      importPreviewRaf = null;
    }
  }

  function initPixels() {
    ensurePixelGrid(gridW, gridH);
  }

  // Palette controls
  if (colorInput) colorInput.addEventListener('input', (e) => updateColorSelection(e.target.value));
  if (colorHex) colorHex.addEventListener('change', (e) => {
    const v = e.target.value;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) updateColorSelection(v);
  });

  paletteSelect.addEventListener('change', () => {
    if (paletteSelect.value === '__add_custom__') {
      paletteSelect.value = activePaletteKey;
      openNewCustomPalette();
      return;
    }
    activePaletteKey = paletteSelect.value;
    remapArtworkToActivePalette();
    rebuildPaletteSelect();
    renderPalette();
    const [r, g, b] = hexToRgb(currentColor);
    updateColorSelection(closestPalette(r, g, b));
  });

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
    if (e.key === 'Enter') {
      e.preventDefault();
      $('addDmcBtn').click();
    }
  });

  $('addPaletteBtn').addEventListener('click', openNewCustomPalette);
  editPaletteBtn.addEventListener('click', openEditPalette);

  customColorPicker.addEventListener('input', (e) => {
    customColorHex.value = e.target.value;
  });
  customColorHex.addEventListener('change', (e) => {
    if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
      customColorPicker.value = e.target.value;
    }
  });

  $('addDmcBtn').addEventListener('click', () => {
    const result = dmcLookup(dmcInput.value);
    if (!result) {
      dmcInput.style.borderColor = '#c0392b';
      setTimeout(() => dmcInput.style.borderColor = '', 1000);
      return;
    }
    if (!editingColors.includes(result.hex.toLowerCase())) {
      editingColors.push(result.hex.toLowerCase());
      editingLabels.push(result.label);
      renderCustomSwatches();
    }
    dmcInput.value = '';
    dmcPreview.style.background = '#ccc';
    dmcInput.focus();
  });

  $('addColorBtn').addEventListener('click', () => {
    const hex = customColorHex.value;
    if (/^#[0-9a-fA-F]{6}$/.test(hex) && !editingColors.includes(hex.toLowerCase())) {
      editingColors.push(hex.toLowerCase());
      editingLabels.push(null);
      renderCustomSwatches();
    }
  });

  $('paletteCancel').addEventListener('click', () => setSheetVisible(paletteOverlay, false));
  $('paletteSave').addEventListener('click', () => {
    const name = customPaletteName.value.trim();
    if (!name) {
      customPaletteName.focus();
      return;
    }
    if (editingColors.length < 2) return;
    const key = editingKey || ('custom_' + Date.now());
    customPalettes[key] = {
      name,
      colors: [...editingColors],
      labels: editingLabels.some(Boolean) ? [...editingLabels] : null
    };
    saveCustomPalettes();
    activePaletteKey = key;
    remapArtworkToActivePalette();
    editingKey = null;
    rebuildPaletteSelect();
    renderPalette();
    const [r, g, b] = hexToRgb(currentColor);
    updateColorSelection(closestPalette(r, g, b));
    setSheetVisible(paletteOverlay, false);
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
    updateColorSelection(closestPalette(r, g, b));
  });

  previewCard.addEventListener('click', () => {
    if (!hasArtwork() && !importOverlay.classList.contains('visible') && !paletteOverlay.classList.contains('visible') && !patternOverlay.classList.contains('visible')) {
      openImportSheet();
    }
  });
  $('importCancel').addEventListener('click', () => {
    setImportSheetState(false);
    importedImage = null;
  });
  $('snapToggle').addEventListener('click', () => {
    snapToPalette = !snapToPalette;
    snapToggle.classList.toggle('on', snapToPalette);
    scheduleImportPreviewUpdate();
  });
  $('ratioToggle').addEventListener('click', () => {
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

  importFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    function onImageReady(img) {
      importedImage = img;
      const longest = Math.max(gridW, gridH);
      const initialSize = clampImportSize(longest);
      importSizeSelect.value = String(initialSize);
      importSizeInput.value = String(initialSize);
      scheduleImportPreviewUpdate();
      setImportSheetState(true);
    }

    function showImportError() {
      alert('Could not load this image format. Try converting to PNG or JPG first.');
    }

    if (window.createImageBitmap) {
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
    } else {
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
    }

    e.target.value = '';
  });

  $('importConfirm').addEventListener('click', () => {
    if (!importedImage) return;
    const maxEdge = clampImportSize(importSizeSelect.value);
    const dims = getImportDims(maxEdge);

    gridW = dims.w;
    gridH = dims.h;
    paletteSourcePixels = null;
    doneColors.clear();
    ensurePixelGrid(gridW, gridH);

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
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const a = d[i + 3];
        if (a < 128) {
          pixels[y][x] = null;
        } else if (snapToPalette) {
          pixels[y][x] = closestPalette(r, g, b);
        } else {
          pixels[y][x] = rgbToHex(r, g, b);
        }
      }
    }

    importedImage = null;
    setImportSheetState(false);
    syncButtons();
    rebuildPaletteSelect();
    renderPalette();
    resizePreview();
    buildStitchTracker();
    updatePatternMeta();
  });

  $('exportBtn').addEventListener('click', exportPNG);
  $('exportPatternBtn').addEventListener('click', openPatternView);
  $('exitPatternBtn').addEventListener('click', closePatternView);
  $('savePatternBtn').addEventListener('click', () => {
    if (patternFrame.contentWindow && typeof patternFrame.contentWindow.printPattern === 'function') {
      patternFrame.contentWindow.printPattern();
      return;
    }
    if (patternFrame.contentWindow) patternFrame.contentWindow.print();
  });

  // Init
  loadCustomPalettes();
  initPixels();
  rebuildPaletteSelect();
  renderPalette();
  updateColorSelection(currentColor);
  buildStitchTracker();
  syncButtons();
  updatePatternMeta();
  resizePreview();

  window.addEventListener('resize', scheduleResizePreview);
  if (window.ResizeObserver) {
    try {
      new ResizeObserver(() => resizePreview()).observe(previewCard);
    } catch (e) {}
  }

  setImportSheetState(false);
  setSheetVisible(paletteOverlay, false);
  patternOverlay.classList.remove('visible');
  patternOverlay.setAttribute('aria-hidden', 'true');
  updatePatternMeta();
})();
