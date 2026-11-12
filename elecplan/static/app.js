"use strict";

const COLORS = [
  { name: "Symbol default", value: "" },
  { name: "Black", value: "#141414" },
  { name: "Red", value: "#c4271b" },
  { name: "Blue", value: "#1d4e89" },
  { name: "Green", value: "#1f7a3a" },
  { name: "Orange", value: "#d46b08" },
];

const SCALE_STANDARDS = [
  [1, '1" = 1\'-0"'],
  [0.75, '3/4" = 1\'-0"'],
  [0.5, '1/2" = 1\'-0"'],
  [0.375, '3/8" = 1\'-0"'],
  [0.25, '1/4" = 1\'-0"'],
  [0.1875, '3/16" = 1\'-0"'],
  [0.125, '1/8" = 1\'-0"'],
  [0.09375, '3/32" = 1\'-0"'],
  [0.0625, '1/16" = 1\'-0"'],
];

const LAYERS = ["Power", "Lighting", "Low-volt", "Circuitry"];
const SNAP_RADIUS = 12;

const state = {
  doc: null,
  pageIndex: 0,
  placements: [],
  selectedId: null,
  armedId: null,
  ink: "",
  defaultSize: 28,
  calibration: null,
  calibStep: 0,
  calibDraft: null,
  tool: null,
  lineDraft: null,
  arrowDraft: null,
  runDraft: null,
  layoutDraft: null,
  whiteboxDraft: null,
  noteSize: 12,
  snap: false,
  showCircuits: false,
  exportAllLayers: false,
  hiddenLayers: new Set(),
  undo: [],
  redo: [],
  panX: 24,
  panY: 24,
  zoom: 1,
  space: false,
  drag: null,
  imageKey: "",
  imageToken: 0,
  pageUrl: "",
  saveTimer: 0,
  sharpenTimer: 0,
  pendingProject: null,
};

let edgeMap = null;

let library = { categories: [], symbols: [] };
let symbolsById = {};
let sizeUndoArmed = false;
let noteUndoArmed = false;
let circuitUndoArmed = false;
let openCategories = new Set();
const LAYOUT_KEY = "planmarks.layout";

const SVGNS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const scene = $("scene");
const pageImg = $("pageImg");
const marksLayer = $("marks");
const calibLayer = $("calibLayer");

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function normRot(deg) {
  let d = Number(deg) || 0;
  d %= 360;
  if (d < 0) d += 360;
  if (d < 0.05 || d > 359.95) return 0;
  return d;
}

function currentPage() {
  return state.doc ? state.doc.pages[state.pageIndex] : null;
}

function selected() {
  return state.placements.find((item) => item.id === state.selectedId) || null;
}

function placement(id) {
  return state.placements.find((item) => item.id === id) || null;
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 4600);
}

function setBusy(on, label) {
  const veil = $("veil");
  veil.hidden = !on;
  if (label) veil.textContent = label;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function readError(res) {
  try {
    const data = await res.json();
    if (data.error) return data.error;
  } catch (_err) {
    /* response was not JSON */
  }
  return res.statusText || "Request failed";
}

function scaleLabel(inchesPerFoot) {
  let best = null;
  let err = Infinity;
  for (const [value, label] of SCALE_STANDARDS) {
    const delta = Math.abs(value - inchesPerFoot) / value;
    if (delta < err) {
      err = delta;
      best = label;
    }
  }
  if (best && err < 0.08) return best;
  return `${inchesPerFoot.toFixed(3)}" = 1'-0"`;
}

function clientToPdf(cx, cy) {
  const vr = viewport.getBoundingClientRect();
  return {
    x: (cx - vr.left - state.panX) / state.zoom,
    y: (cy - vr.top - state.panY) / state.zoom,
  };
}

function pdfToClient(x, y) {
  const vr = viewport.getBoundingClientRect();
  return {
    x: vr.left + state.panX + x * state.zoom,
    y: vr.top + state.panY + y * state.zoom,
  };
}

function applyTransform() {
  scene.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  const pct = Math.round((state.zoom * 72) / 96 * 100);
  $("zoomLabel").textContent = pct + "%";
  const handle = document.querySelector(".mark.selected .handle");
  const p = selected();
  if (handle && isSymbol(p)) positionHandle(handle, p);
  refreshWireChrome();
  drawCalib();
}

function zoomAt(cx, cy, factor) {
  const vr = viewport.getBoundingClientRect();
  const x = cx - vr.left;
  const y = cy - vr.top;
  const worldX = (x - state.panX) / state.zoom;
  const worldY = (y - state.panY) / state.zoom;
  const next = clamp(state.zoom * factor, 0.05, 10);
  state.zoom = next;
  state.panX = x - worldX * next;
  state.panY = y - worldY * next;
  applyTransform();
  scheduleSharpen();
}

function fitView(attempt = 0) {
  const page = currentPage();
  if (!page) return;
  const vr = viewport.getBoundingClientRect();
  if (vr.width < 40 || vr.height < 40) {
    if (attempt < 6) requestAnimationFrame(() => fitView(attempt + 1));
    return;
  }
  const margin = 56;
  const z = Math.min((vr.width - margin) / page.width, (vr.height - margin) / page.height);
  state.zoom = clamp(z > 0 ? z : 0.2, 0.05, 10);
  state.panX = (vr.width - page.width * state.zoom) / 2;
  state.panY = (vr.height - page.height * state.zoom) / 2;
  applyTransform();
  loadPageImage();
}

function actualSize() {
  const vr = viewport.getBoundingClientRect();
  zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, 96 / 72 / state.zoom);
}

function chooseDpi() {
  const dpr = window.devicePixelRatio || 1;
  let dpi = Math.round(state.zoom * dpr * 72);
  dpi = clamp(dpi, 60, 150);
  return Math.round(dpi / 10) * 10;
}

function scheduleSharpen() {
  clearTimeout(state.sharpenTimer);
  state.sharpenTimer = setTimeout(() => loadPageImage(), 160);
}

async function loadPageImage() {
  if (!state.doc) return;
  const pageIndex = state.pageIndex;
  const dpi = chooseDpi();
  const key = `${state.doc.id}:${pageIndex}:${dpi}`;
  if (key === state.imageKey) return;
  const token = ++state.imageToken;
  try {
    const res = await fetch(`/api/page/${pageIndex}.png?dpi=${dpi}&doc=${state.doc.id}`);
    if (!res.ok) throw new Error(await readError(res));
    const blob = await res.blob();
    if (token !== state.imageToken) return;
    const url = URL.createObjectURL(blob);
    if (state.pageUrl) URL.revokeObjectURL(state.pageUrl);
    state.pageUrl = url;
    state.imageKey = key;
    pageImg.src = url;
  } catch (err) {
    if (token === state.imageToken) toast(err.message);
  }
}

function showWorkspace() {
  $("empty").hidden = true;
  viewport.hidden = false;
}

function updatePager() {
  const pager = $("pager");
  const select = $("pageSelect");
  if (!state.doc) {
    pager.hidden = true;
    $("docTitle").textContent = "No plan open";
    return;
  }
  pager.hidden = false;
  $("docTitle").textContent = state.doc.filename;
  select.innerHTML = "";
  state.doc.pages.forEach((page, index) => {
    const opt = document.createElement("option");
    opt.value = String(index);
    const fallback = `Sheet ${index + 1}`;
    opt.textContent = page.label && page.label !== String(index + 1) ? `${fallback} · ${page.label}` : fallback;
    select.appendChild(opt);
  });
  select.value = String(state.pageIndex);
  $("prevPage").disabled = state.pageIndex <= 0;
  $("nextPage").disabled = state.pageIndex >= state.doc.pageCount - 1;
  $("exportBtn").disabled = false;
  $("reviseBtn").disabled = false;
  $("saveBtn").disabled = false;
  $("addBtn").disabled = false;
  $("legendBtn").disabled = false;
  $("lineBtn").disabled = false;
  $("noteBtn").disabled = false;
  $("arrowBtn").disabled = false;
  $("layoutBtn").disabled = false;
  $("whiteboxBtn").disabled = false;
  $("dropLegendBtn").disabled = false;
}

function showPage(index, { fit = false } = {}) {
  state.pageIndex = index;
  const page = currentPage();
  scene.style.width = page.width + "px";
  scene.style.height = page.height + "px";
  pageImg.style.width = page.width + "px";
  pageImg.style.height = page.height + "px";
  updatePager();
  renderMarks();
  if (fit) requestAnimationFrame(() => fitView());
  else {
    applyTransform();
    loadPageImage();
  }
  setStatus();
}

function goToPage(index) {
  if (!state.doc || index < 0 || index >= state.doc.pageCount || index === state.pageIndex) return;
  const prev = currentPage();
  const next = state.doc.pages[index];
  const refit = Math.abs(prev.width - next.width) > 1 || Math.abs(prev.height - next.height) > 1;
  if (state.calibStep === 1 || state.calibStep === 2) {
    state.calibStep = 0;
    state.calibDraft = null;
    toast("Calibration cancelled because the sheet changed.");
  }
  if (state.lineDraft) {
    state.lineDraft = null;
    toast("Dashed line cancelled because the sheet changed.");
  }
  if (state.arrowDraft) {
    state.arrowDraft = null;
    toast("Arrow cancelled because the sheet changed.");
  }
  if (state.runDraft) {
    state.runDraft = null;
    toast("Run cancelled because the sheet changed.");
  }
  if (state.layoutDraft) {
    state.layoutDraft = null;
    toast("Light layout cancelled because the sheet changed.");
  }
  if (state.whiteboxDraft) {
    state.whiteboxDraft = null;
    toast("White box cancelled because the sheet changed.");
  }
  showPage(index, { fit: refit });
  syncInspector();
}

function spinGroup(svg) {
  for (const child of svg.children) {
    if (child.classList.contains("spin")) return child;
  }
  const spin = svg.ownerDocument.createElementNS(SVGNS, "g");
  spin.setAttribute("class", "spin");
  while (svg.firstChild) spin.appendChild(svg.firstChild);
  svg.appendChild(spin);
  return spin;
}

function setSpin(svg, rotation) {
  const spin = spinGroup(svg);
  const deg = Number(rotation) || 0;
  if (deg) spin.setAttribute("transform", `rotate(${deg} 50 50)`);
  else spin.removeAttribute("transform");
}

function paintSvg(symbolId, rotation, color) {
  const sym = symbolsById[symbolId];
  if (!sym) return null;
  const colored = sym.svg.replaceAll("#141414", color || sym.defaultColor || "#141414");
  const doc = new DOMParser().parseFromString(colored, "image/svg+xml");
  const node = doc.querySelector("svg");
  if (!node || doc.querySelector("parsererror")) return null;
  setSpin(node, rotation);
  return node;
}

function positionMark(el, p) {
  el.style.width = p.size + "px";
  el.style.height = p.size + "px";
  el.style.left = p.x - p.size / 2 + "px";
  el.style.top = p.y - p.size / 2 + "px";
}

function positionHandle(handle, p) {
  const rad = ((p.rotation + 90) * Math.PI) / 180;
  const dist = p.size / 2 + 18 / state.zoom;
  handle.style.left = p.size / 2 + Math.cos(rad) * dist + "px";
  handle.style.top = p.size / 2 + Math.sin(rad) * dist + "px";
  handle.style.transform = `translate(-50%, -50%) scale(${1 / state.zoom})`;
}

function markElement(p) {
  const el = document.createElement("div");
  el.className = "mark" + (p.id === state.selectedId ? " selected" : "");
  el.dataset.id = p.id;
  positionMark(el, p);
  const glyph = document.createElement("div");
  glyph.className = "glyph";
  const svg = paintSvg(p.symbolId, p.rotation, p.color);
  if (svg) glyph.appendChild(document.importNode(svg, true));
  el.appendChild(glyph);
  if (state.showCircuits && p.circuit) {
    const tag = document.createElement("div");
    tag.className = "circuit-tag";
    tag.textContent = p.circuit;
    el.appendChild(tag);
  }
  if (p.id === state.selectedId) {
    const handle = document.createElement("div");
    handle.className = "handle";
    handle.dataset.id = p.id;
    handle.title = "Drag to rotate. Shift snaps to 15°.";
    handle.textContent = "↻";
    positionHandle(handle, p);
    el.appendChild(handle);
  }
  return el;
}

function isSymbol(p) {
  return Boolean(p && (p.kind === "symbol" || (!p.kind && p.symbolId)));
}

function isSegment(p) {
  return Boolean(p && (p.kind === "line" || p.kind === "arrow" || p.kind === "run"));
}

function isWhitebox(p) {
  return Boolean(p && p.kind === "whitebox");
}

function symbolLayerName(sym) {
  if (!sym) return "Power";
  if (sym.category === "lighting" || sym.category === "switches") return "Lighting";
  if (sym.category === "lowvoltage" || sym.category === "safety") return "Low-volt";
  return "Power";
}

function defaultLayer(kind, symbolId, guide) {
  if (kind === "symbol" || kind === "run") return symbolLayerName(symbolsById[symbolId]);
  if (kind === "line") return guide ? "Lighting" : "Circuitry";
  return "Power";
}

function normalizeLayer(value, fallback) {
  if (typeof value !== "string") return fallback;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 40) return fallback;
  if ([...name].some((ch) => ch.charCodeAt(0) < 32)) return fallback;
  return name;
}

function cleanCircuit(value) {
  if (typeof value !== "string") return "";
  const name = value.replace(/\s+/g, " ").trim().slice(0, 24).trim();
  if (!name || [...name].some((ch) => ch.charCodeAt(0) < 32)) return "";
  return name;
}

function layerOf(p) {
  return (p && p.layer) || "Power";
}

function layerVisible(p) {
  return !state.hiddenLayers.has(layerOf(p));
}

function layerNames() {
  const names = [...LAYERS];
  for (const item of state.placements) {
    const name = (item.layer || "").trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function symbolSkipsSnap(symbolId, freePlace) {
  if (freePlace) return true;
  const sym = symbolsById[symbolId];
  if (!sym) return false;
  if (sym.id === "floor") return true;
  if (sym.category === "lighting" && sym.wall === false) return true;
  return false;
}

function boxBounds(p) {
  return {
    left: Math.min(p.x1, p.x2),
    top: Math.min(p.y1, p.y2),
    right: Math.max(p.x1, p.x2),
    bottom: Math.max(p.y1, p.y2),
  };
}

function isRunSymbol(sym) {
  return Boolean(sym && sym.place === "run" && sym.runLabel);
}

function runLabelOf(p) {
  const sym = p && symbolsById[p.symbolId];
  return (sym && sym.runLabel) || "";
}

function runGeometry(p) {
  const x1 = Number(p.x1);
  const y1 = Number(p.y1);
  const x2 = Number(p.x2);
  const y2 = Number(p.y2);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const label = runLabelOf(p);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  if (length < 0.5) {
    return { length, bars: [], label, fontSize: 8, textX: midX, textY: midY + 11, angle: 0 };
  }
  const ux = dx / length;
  const uy = dy / length;
  let px = -uy;
  let py = ux;
  if (Math.abs(ux) >= Math.abs(uy)) {
    if (py < 0) {
      px = -px;
      py = -py;
    }
  } else if (px < 0) {
    px = -px;
    py = -py;
  }
  const bar = 5.5;
  const bars = [
    { x1: x1 - px * bar, y1: y1 - py * bar, x2: x1 + px * bar, y2: y1 + py * bar },
    { x1: x2 - px * bar, y1: y2 - py * bar, x2: x2 + px * bar, y2: y2 + py * bar },
  ];
  let fontSize = 8;
  const chars = Math.max(label.length, 1);
  const width = chars * fontSize * 0.62;
  if (width > length * 0.92) fontSize = Math.max(4.5, (length * 0.92) / (chars * 0.62));
  const offset = 2.4 + fontSize * 1.07;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle > 90 || angle <= -90) angle += 180;
  return {
    length,
    bars,
    label,
    fontSize,
    textX: midX + px * offset,
    textY: midY + py * offset,
    angle,
  };
}

function arrowParts(p) {
  const dx = p.x2 - p.x1;
  const dy = p.y2 - p.y1;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) {
    return { length, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, tipX: p.x2, tipY: p.y2 };
  }
  const ux = dx / length;
  const uy = dy / length;
  const head = Math.min(11, length * 0.45);
  const wing = head * (4.2 / 11);
  const bx = p.x2 - ux * head;
  const by = p.y2 - uy * head;
  return {
    length,
    x1: p.x1,
    y1: p.y1,
    x2: bx,
    y2: by,
    tipX: p.x2,
    tipY: p.y2,
    leftX: bx - uy * wing,
    leftY: by + ux * wing,
    rightX: bx + uy * wing,
    rightY: by - ux * wing,
  };
}

function cleanNote(text) {
  let value = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (value.length > 500) value = value.slice(0, 500);
  const lines = value.split("\n");
  if (lines.length > 16) value = lines.slice(0, 16).join("\n");
  return value;
}

function measureText(text, size) {
  if (!measureText.ctx) measureText.ctx = document.createElement("canvas").getContext("2d");
  measureText.ctx.font = `${size}px Helvetica, Arial, sans-serif`;
  return measureText.ctx.measureText(text).width;
}

function layoutLegend(symbols) {
  const nameSize = 9;
  const symSize = 26;
  const gap = 6;
  const slack = 10;
  const rowH = 36;
  const pad = 14;
  const gutter = 14;
  const header = 38;
  const title = { text: "SYMBOL LEGEND", x: pad, y: 26, size: 13, weight: "bold" };
  if (!symbols.length) return { width: 240, height: 72, items: [], labels: [title] };
  const nameW = slack + Math.max(...symbols.map((sym) => measureText(sym.name, nameSize)));
  const colW = symSize + gap + nameW;
  const count = symbols.length;
  let cols = count >= 6 && colW * 3 + gutter * 2 + pad * 2 <= 680 ? 3 : 2;
  cols = Math.max(1, Math.min(cols, count));
  const rows = Math.ceil(count / cols);
  const width = pad * 2 + cols * colW + (cols - 1) * gutter;
  const height = header + rows * rowH + pad;
  const items = [];
  const labels = [title];
  symbols.forEach((sym, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cx = pad + col * (colW + gutter) + symSize / 2;
    const cy = header + row * rowH + rowH / 2;
    items.push({
      id: sym.id,
      name: sym.name,
      x: Math.round(cx * 100) / 100,
      y: Math.round(cy * 100) / 100,
      size: symSize,
      color: sym.defaultColor || "#141414",
    });
    labels.push({
      text: sym.name,
      x: Math.round((cx + symSize / 2 + gap) * 100) / 100,
      y: Math.round((cy + nameSize * 0.35) * 100) / 100,
      size: nameSize,
      weight: "regular",
    });
  });
  return {
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
    items,
    labels,
  };
}

function visibleLegendLayout() {
  const lay = library.legend;
  if (!lay) return null;
  if (!state.hiddenLayers.size) return lay;
  const symbols = library.symbols.filter((sym) => !state.hiddenLayers.has(symbolLayerName(sym)));
  return layoutLegend(symbols);
}

function legendBox(width) {
  const lay = visibleLegendLayout();
  if (!lay || !lay.width) return { width: width || 360, height: 240, scale: 1 };
  const scale = (width || lay.width) / lay.width;
  return { width: lay.width * scale, height: lay.height * scale, scale };
}

function legendElement(p) {
  const lay = visibleLegendLayout();
  const el = document.createElement("div");
  el.className = "mark legend" + (p.id === state.selectedId ? " selected" : "");
  el.dataset.id = p.id;
  const box = legendBox(p.width);
  el.style.width = box.width + "px";
  el.style.height = box.height + "px";
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  const glyph = document.createElement("div");
  glyph.className = "glyph";
  if (lay) {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "legend-svg");
    svg.setAttribute("viewBox", `0 0 ${lay.width} ${lay.height}`);
    const border = document.createElementNS(SVGNS, "rect");
    border.setAttribute("x", "0.6");
    border.setAttribute("y", "0.6");
    border.setAttribute("width", String(lay.width - 1.2));
    border.setAttribute("height", String(lay.height - 1.2));
    border.setAttribute("fill", "#ffffff");
    border.setAttribute("stroke", "#383838");
    border.setAttribute("stroke-width", "1");
    svg.appendChild(border);
    for (const entry of lay.items || []) {
      const node = paintSvg(entry.id, 0, entry.color);
      if (!node) continue;
      const mark = document.importNode(node, true);
      mark.setAttribute("x", String(entry.x - entry.size / 2));
      mark.setAttribute("y", String(entry.y - entry.size / 2));
      mark.setAttribute("width", String(entry.size));
      mark.setAttribute("height", String(entry.size));
      svg.appendChild(mark);
    }
    for (const label of lay.labels || []) {
      const text = document.createElementNS(SVGNS, "text");
      text.setAttribute("x", String(label.x));
      text.setAttribute("y", String(label.y));
      text.setAttribute("font-family", "Helvetica, Arial, sans-serif");
      text.setAttribute("font-size", String(label.size));
      text.setAttribute("font-weight", label.weight === "bold" ? "700" : "400");
      text.setAttribute("fill", "#141414");
      text.textContent = label.text;
      svg.appendChild(text);
    }
    glyph.appendChild(svg);
  }
  el.appendChild(glyph);
  return el;
}

function wireMetrics() {
  return {
    hit: Math.max(10, 14 / state.zoom),
    handle: 5.5 / state.zoom,
  };
}

function wireLayer(id) {
  let svg = document.getElementById(id);
  if (!svg) {
    svg = document.createElementNS(SVGNS, "svg");
    svg.id = id;
    marksLayer.appendChild(svg);
  }
  const page = currentPage();
  if (page) {
    svg.setAttribute("viewBox", `0 0 ${page.width} ${page.height}`);
    svg.setAttribute("width", String(page.width));
    svg.setAttribute("height", String(page.height));
  }
  return svg;
}

function addWireLine(parent, p, className, color, width, events, dashed) {
  const line = document.createElementNS(SVGNS, "line");
  line.setAttribute("class", className);
  line.setAttribute("x1", p.x1);
  line.setAttribute("y1", p.y1);
  line.setAttribute("x2", p.x2);
  line.setAttribute("y2", p.y2);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", String(width));
  if (dashed) line.setAttribute("stroke-dasharray", dashed === true ? "8 6" : String(dashed));
  line.setAttribute("stroke-linecap", "butt");
  line.setAttribute("fill", "none");
  if (events) line.setAttribute("pointer-events", events);
  parent.appendChild(line);
  return line;
}

function addArrowHead(parent, p, color, events) {
  const head = arrowParts(p);
  if (!head.leftX && head.leftX !== 0) return;
  if (head.length < 0.5) return;
  const poly = document.createElementNS(SVGNS, "polygon");
  poly.setAttribute("class", "arrow-head");
  poly.setAttribute("points", `${head.tipX},${head.tipY} ${head.leftX},${head.leftY} ${head.rightX},${head.rightY}`);
  poly.setAttribute("fill", color);
  poly.setAttribute("stroke", color);
  poly.setAttribute("stroke-width", "0.6");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("pointer-events", events || "all");
  parent.appendChild(poly);
}

function addRunLabel(parent, geo, color, events) {
  if (!geo.label) return;
  const text = document.createElementNS(SVGNS, "text");
  text.setAttribute("class", "run-label");
  text.setAttribute("x", "0");
  text.setAttribute("y", "0");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("transform", `translate(${geo.textX} ${geo.textY}) rotate(${geo.angle})`);
  text.setAttribute("font-family", "Helvetica, Arial, sans-serif");
  text.setAttribute("font-size", String(geo.fontSize));
  text.setAttribute("font-weight", "700");
  text.setAttribute("fill", color);
  text.setAttribute("pointer-events", events);
  text.textContent = geo.label;
  parent.appendChild(text);
}

function wireGroup(p, draft) {
  const g = document.createElementNS(SVGNS, "g");
  g.setAttribute("class", draft ? "wire wire-draft" : "wire");
  if (!draft) g.dataset.id = p.id;
  const metrics = wireMetrics();
  const color = p.color || state.ink || "#141414";
  if (p.kind === "run") {
    const geo = runGeometry(p);
    if (!draft && p.id === state.selectedId) {
      addWireLine(g, p, "wire-halo", "#e2a23a", 3.4, "none", false);
      for (const bar of geo.bars) addWireLine(g, bar, "wire-halo", "#e2a23a", 3.4, "none", false);
    }
    addWireLine(g, p, "wire-ink", color, 1.35, "none", false);
    for (const bar of geo.bars) addWireLine(g, bar, "run-bar", color, 1.35, draft ? "none" : "stroke", false);
    addRunLabel(g, geo, color, draft ? "none" : "all");
    if (!draft && state.showCircuits && p.circuit) addCircuitTag(g, p);
    if (!draft) {
      const hit = addWireLine(g, p, "wire-hit", "#141414", metrics.hit, "stroke", false);
      hit.setAttribute("stroke-opacity", "0.01");
    }
    return g;
  }
  const arrow = p.kind === "arrow";
  const shaft = arrow ? arrowParts(p) : p;
  const dash = arrow ? false : (p.guide ? "2.5 2.5" : true);
  const inkWidth = p.guide ? 0.9 : 1.35;
  if (!draft && p.id === state.selectedId) {
    addWireLine(g, p, "wire-halo", "#e2a23a", 3.4, "none", dash);
  }
  addWireLine(g, shaft, "wire-ink", color, inkWidth, "none", dash);
  if (arrow) addArrowHead(g, p, color, draft ? "none" : "all");
  if (!draft && state.showCircuits && p.circuit && !p.guide) addCircuitTag(g, p);
  if (!draft) {
    const hit = addWireLine(g, p, "wire-hit", "#141414", metrics.hit, "stroke", false);
    hit.setAttribute("stroke-opacity", "0.01");
  }
  return g;
}

function addCircuitTag(parent, p) {
  const text = document.createElementNS(SVGNS, "text");
  text.setAttribute("class", "wire-circuit");
  text.setAttribute("x", String((Number(p.x1) + Number(p.x2)) / 2));
  text.setAttribute("y", String(Math.min(Number(p.y1), Number(p.y2)) - 3));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("font-family", "Helvetica, Arial, sans-serif");
  text.setAttribute("font-size", "7");
  text.setAttribute("font-weight", "700");
  text.setAttribute("fill", "#141414");
  text.setAttribute("stroke", "#ffffff");
  text.setAttribute("stroke-width", "2");
  text.setAttribute("paint-order", "stroke");
  text.setAttribute("pointer-events", "none");
  text.textContent = p.circuit;
  parent.appendChild(text);
}

function handleGroup(p) {
  const g = document.createElementNS(SVGNS, "g");
  g.dataset.ends = p.id;
  const radius = wireMetrics().handle;
  for (const [end, x, y] of [
    ["1", p.x1, p.y1],
    ["2", p.x2, p.y2],
  ]) {
    const dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("class", "wire-end");
    dot.dataset.id = p.id;
    dot.dataset.end = end;
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", String(radius));
    const anchored = p.kind === "line" && ((end === "1" && p.a1) || (end === "2" && p.a2));
    dot.setAttribute("fill", anchored ? "#1d4e89" : "#e2a23a");
    dot.setAttribute("stroke", "#2a1c06");
    dot.setAttribute("stroke-width", String(1 / state.zoom));
    g.appendChild(dot);
  }
  return g;
}

function renderWires() {
  if (!marksLayer) return;
  const wires = wireLayer("wires");
  const handles = wireLayer("wireHandles");
  wires.replaceChildren();
  handles.replaceChildren();
  if (!currentPage()) return;
  for (const p of state.placements) {
    if (!isSegment(p) || p.page !== state.pageIndex || !layerVisible(p)) continue;
    wires.appendChild(wireGroup(p, false));
    if (p.id === state.selectedId) handles.appendChild(handleGroup(p));
  }
  const selectedBox = selected();
  if (isWhitebox(selectedBox) && selectedBox.page === state.pageIndex && layerVisible(selectedBox)) {
    handles.appendChild(boxHandleGroup(selectedBox));
  }
  if (state.lineDraft && state.lineDraft.page === state.pageIndex) {
    wires.appendChild(wireGroup(state.lineDraft, true));
  }
  if (state.arrowDraft && state.arrowDraft.page === state.pageIndex) {
    wires.appendChild(wireGroup(state.arrowDraft, true));
  }
  if (state.runDraft && state.runDraft.page === state.pageIndex) {
    wires.appendChild(wireGroup(state.runDraft, true));
  }
  if (state.layoutDraft && state.layoutDraft.page === state.pageIndex) {
    addLayoutDraft(wires);
  }
  if (state.whiteboxDraft && state.whiteboxDraft.page === state.pageIndex) {
    addWhiteboxDraft(wires);
  }
}

function refreshWireChrome() {
  if (!marksLayer) return;
  const metrics = wireMetrics();
  for (const line of marksLayer.querySelectorAll(".wire-hit")) {
    line.setAttribute("stroke-width", String(metrics.hit));
  }
  for (const dot of marksLayer.querySelectorAll(".wire-end, .box-handle")) {
    dot.setAttribute("r", String(metrics.handle));
    dot.setAttribute("stroke-width", String(1 / state.zoom));
  }
}

function renderMarks() {
  marksLayer.innerHTML = "";
  if (!state.doc) {
    renderCounts();
    return;
  }
  for (const p of state.placements) {
    if (p.page !== state.pageIndex || isSegment(p) || !layerVisible(p)) continue;
    if (p.kind === "whitebox") marksLayer.appendChild(whiteboxElement(p));
    else if (p.kind === "legend") marksLayer.appendChild(legendElement(p));
    else if (p.kind === "note") marksLayer.appendChild(noteElement(p));
    else marksLayer.appendChild(markElement(p));
  }
  renderWires();
  drawCalib();
  renderCounts();
}

function updateLine(p) {
  if (p.kind === "run") {
    renderWires();
    return;
  }
  const g = marksLayer.querySelector(`.wire[data-id="${CSS.escape(p.id)}"]`);
  if (!g) {
    renderWires();
    return;
  }
  const arrow = p.kind === "arrow";
  const shaft = arrow ? arrowParts(p) : p;
  const color = p.color || "#141414";
  for (const line of g.querySelectorAll("line")) {
    const useShaft = arrow && line.classList.contains("wire-ink");
    const src = useShaft ? shaft : p;
    line.setAttribute("x1", src.x1);
    line.setAttribute("y1", src.y1);
    line.setAttribute("x2", src.x2);
    line.setAttribute("y2", src.y2);
  }
  const ink = g.querySelector(".wire-ink");
  if (ink) ink.setAttribute("stroke", color);
  const head = g.querySelector(".arrow-head");
  if (head && arrow && shaft.leftX !== undefined) {
    head.setAttribute("points", `${shaft.tipX},${shaft.tipY} ${shaft.leftX},${shaft.leftY} ${shaft.rightX},${shaft.rightY}`);
    head.setAttribute("fill", color);
    head.setAttribute("stroke", color);
  }
  const ends = marksLayer.querySelector(`[data-ends="${CSS.escape(p.id)}"]`);
  if (ends) {
    const first = ends.querySelector('[data-end="1"]');
    const second = ends.querySelector('[data-end="2"]');
    if (first) {
      first.setAttribute("cx", p.x1);
      first.setAttribute("cy", p.y1);
      if (p.kind === "line") first.setAttribute("fill", p.a1 ? "#1d4e89" : "#e2a23a");
    }
    if (second) {
      second.setAttribute("cx", p.x2);
      second.setAttribute("cy", p.y2);
      if (p.kind === "line") second.setAttribute("fill", p.a2 ? "#1d4e89" : "#e2a23a");
    }
  }
}

function updateLegend(p) {
  const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(p.id)}"]`);
  if (!el) {
    renderMarks();
    return;
  }
  const box = legendBox(p.width);
  el.style.width = box.width + "px";
  el.style.height = box.height + "px";
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
}

function noteElement(p) {
  const el = document.createElement("div");
  el.className = "mark note" + (p.id === state.selectedId ? " selected" : "");
  el.dataset.id = p.id;
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  el.style.fontSize = p.size + "px";
  el.style.color = p.color || "#141414";
  const text = document.createElement("div");
  text.className = "note-text";
  const body = p.text || "";
  if (body.trim()) text.textContent = body;
  else {
    text.textContent = "Note";
    text.classList.add("placeholder");
  }
  el.appendChild(text);
  return el;
}

function updateNote(p) {
  const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(p.id)}"]`);
  if (!el || !el.classList.contains("note")) {
    renderMarks();
    return;
  }
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  el.style.fontSize = p.size + "px";
  el.style.color = p.color || "#141414";
  const text = el.querySelector(".note-text");
  if (!text) {
    renderMarks();
    return;
  }
  const body = p.text || "";
  if (body.trim()) {
    text.textContent = body;
    text.classList.remove("placeholder");
  } else {
    text.textContent = "Note";
    text.classList.add("placeholder");
  }
}

function whiteboxElement(p) {
  const b = boxBounds(p);
  const el = document.createElement("div");
  el.className = "mark whitebox" + (p.id === state.selectedId ? " selected" : "");
  el.dataset.id = p.id;
  el.style.left = b.left + "px";
  el.style.top = b.top + "px";
  el.style.width = b.right - b.left + "px";
  el.style.height = b.bottom - b.top + "px";
  return el;
}

function boxHandleGroup(p) {
  const g = document.createElementNS(SVGNS, "g");
  g.dataset.box = p.id;
  const b = boxBounds(p);
  const radius = wireMetrics().handle;
  const corners = [
    [b.left, b.top],
    [b.right, b.top],
    [b.right, b.bottom],
    [b.left, b.bottom],
  ];
  corners.forEach(([x, y], index) => {
    const dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("class", "box-handle");
    dot.dataset.id = p.id;
    dot.dataset.corner = String(index);
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", String(radius));
    dot.setAttribute("fill", "#e2a23a");
    dot.setAttribute("stroke", "#2a1c06");
    dot.setAttribute("stroke-width", String(1 / state.zoom));
    g.appendChild(dot);
  });
  return g;
}

function updateWhitebox(p) {
  const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(p.id)}"]`);
  if (!el || !el.classList.contains("whitebox")) {
    renderMarks();
    return;
  }
  const b = boxBounds(p);
  el.style.left = b.left + "px";
  el.style.top = b.top + "px";
  el.style.width = b.right - b.left + "px";
  el.style.height = b.bottom - b.top + "px";
}

function positionBoxHandles(p) {
  const g = marksLayer.querySelector(`[data-box="${CSS.escape(p.id)}"]`);
  if (!g) {
    renderWires();
    return;
  }
  const b = boxBounds(p);
  const corners = [
    [b.left, b.top],
    [b.right, b.top],
    [b.right, b.bottom],
    [b.left, b.bottom],
  ];
  g.querySelectorAll(".box-handle").forEach((dot, index) => {
    dot.setAttribute("cx", corners[index][0]);
    dot.setAttribute("cy", corners[index][1]);
  });
}

function updateMark(p) {
  if (isWhitebox(p)) {
    updateWhitebox(p);
    positionBoxHandles(p);
    return;
  }
  if (isSegment(p)) {
    updateLine(p);
    return;
  }
  followAnchors(p);
  if (p.kind === "legend") {
    updateLegend(p);
    return;
  }
  if (p.kind === "note") {
    updateNote(p);
    return;
  }
  const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(p.id)}"]`);
  if (!el) {
    renderMarks();
    return;
  }
  positionMark(el, p);
  const svg = el.querySelector("svg");
  if (svg) setSpin(svg, p.rotation);
  const handle = el.querySelector(".handle");
  if (handle) positionHandle(handle, p);
  const rotInput = $("rotInput");
  if (rotInput && document.activeElement !== rotInput && p.id === state.selectedId) {
    rotInput.value = String(Math.round(p.rotation));
  }
}

function drawCalib() {
  const page = currentPage();
  calibLayer.innerHTML = "";
  if (!page) return;
  calibLayer.setAttribute("viewBox", `0 0 ${page.width} ${page.height}`);
  calibLayer.setAttribute("width", String(page.width));
  calibLayer.setAttribute("height", String(page.height));
  if (state.calibration && state.calibration.page === state.pageIndex) {
    addMeasure(state.calibration, false);
  }
  if (state.calibDraft && state.calibDraft.page === state.pageIndex && state.calibStep) {
    addMeasure(state.calibDraft, true);
  }
}

function addMeasure(m, active) {
  const ns = "http://www.w3.org/2000/svg";
  const color = active ? "#e2a23a" : "#1d4e89";
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", m.x1);
  line.setAttribute("y1", m.y1);
  line.setAttribute("x2", m.x2);
  line.setAttribute("y2", m.y2);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", String(1.6 / state.zoom));
  line.setAttribute("stroke-linecap", "round");
  calibLayer.appendChild(line);
  for (const [x, y] of [
    [m.x1, m.y1],
    [m.x2, m.y2],
  ]) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", String(4.5 / state.zoom));
    dot.setAttribute("fill", color);
    calibLayer.appendChild(dot);
  }
}

function snapshot() {
  return JSON.stringify({
    placements: state.placements,
    calibration: state.calibration,
    defaultSize: state.defaultSize,
    selectedId: state.selectedId,
    hiddenLayers: [...state.hiddenLayers],
    showCircuits: state.showCircuits,
  });
}

function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 80) state.undo.shift();
  state.redo.length = 0;
}

function restore(raw) {
  const data = JSON.parse(raw);
  state.placements = data.placements || [];
  state.calibration = data.calibration || null;
  state.defaultSize = data.defaultSize || 28;
  state.selectedId = data.selectedId || null;
  state.hiddenLayers = new Set(Array.isArray(data.hiddenLayers) ? data.hiddenLayers : []);
  state.showCircuits = Boolean(data.showCircuits);
  if (state.selectedId && !selected()) state.selectedId = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restore(state.undo.pop());
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restore(state.redo.pop());
}

function projectData() {
  return {
    app: "plan-marks",
    version: 1,
    pdfName: state.doc ? state.doc.filename : "",
    pdfId: state.doc ? state.doc.id : "",
    defaultSize: state.defaultSize,
    calibration: state.calibration,
    placements: state.placements,
    hiddenLayers: [...state.hiddenLayers],
    showCircuits: state.showCircuits,
  };
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(writeAutosave, 250);
}

function writeAutosave() {
  if (!state.doc) return;
  try {
    localStorage.setItem("planmarks:v1:" + state.doc.id, JSON.stringify(projectData()));
  } catch (_err) {
    /* private mode or a full disk */
  }
}

function applyProject(proj, { quiet = false } = {}) {
  if (!proj || proj.app !== "plan-marks" || proj.version !== 1) {
    toast("That file is not a Plan Marks project.");
    return;
  }
  if (!state.doc) {
    state.pendingProject = proj;
    toast("Open the floor plan PDF and these marks will be placed on it.");
    return;
  }
  pushUndo();
  let skipped = 0;
  const placements = [];
  for (const item of proj.placements || []) {
    const page = Number(item.page);
    if (!Number.isInteger(page) || page < 0 || page >= state.doc.pageCount) {
      skipped += 1;
      continue;
    }
    const color = /^#[0-9a-fA-F]{6}$/.test(item.color || "") ? item.color.toLowerCase() : "#141414";
    if (item.kind === "line" || item.kind === "arrow" || item.kind === "run") {
      const coords = [item.x1, item.y1, item.x2, item.y2].map(Number);
      if (coords.some((n) => !Number.isFinite(n))) {
        skipped += 1;
        continue;
      }
      const length = Math.hypot(coords[2] - coords[0], coords[3] - coords[1]);
      if (item.kind === "arrow" && length < 4) {
        skipped += 1;
        continue;
      }
      if (item.kind === "run" && (length < 8 || !isRunSymbol(symbolsById[item.symbolId]))) {
        skipped += 1;
        continue;
      }
      const mark = {
        id: item.id || uid(),
        kind: item.kind,
        page,
        x1: coords[0],
        y1: coords[1],
        x2: coords[2],
        y2: coords[3],
        color,
      };
      if (item.kind === "run") mark.symbolId = item.symbolId;
      if (item.kind === "line") {
        if (item.guide === true) {
          mark.guide = true;
          mark.a1 = null;
          mark.a2 = null;
        } else {
          mark.a1 = typeof item.a1 === "string" ? item.a1 : null;
          mark.a2 = typeof item.a2 === "string" ? item.a2 : null;
        }
      }
      mark.layer = normalizeLayer(item.layer, defaultLayer(item.kind, item.symbolId, mark.guide));
      const circuit = cleanCircuit(item.circuit);
      if (circuit && !(mark.guide)) mark.circuit = circuit;
      placements.push(mark);
      continue;
    }
    if (item.kind === "whitebox") {
      const coords = [item.x1, item.y1, item.x2, item.y2].map(Number);
      if (coords.some((n) => !Number.isFinite(n)) || Math.abs(coords[2] - coords[0]) < 4 || Math.abs(coords[3] - coords[1]) < 4) {
        skipped += 1;
        continue;
      }
      placements.push({
        id: item.id || uid(),
        kind: "whitebox",
        page,
        x1: coords[0],
        y1: coords[1],
        x2: coords[2],
        y2: coords[3],
        layer: normalizeLayer(item.layer, "Power"),
      });
      continue;
    }
    if (item.kind === "note") {
      const x = Number(item.x);
      const y = Number(item.y);
      const size = Number(item.size);
      const text = cleanNote(item.text);
      if (![x, y, size].every((n) => Number.isFinite(n)) || !text.trim()) {
        skipped += 1;
        continue;
      }
      const note = {
        id: item.id || uid(),
        kind: "note",
        page,
        x,
        y,
        text,
        size: clamp(size, 8, 36),
        color,
        layer: normalizeLayer(item.layer, "Power"),
      };
      const noteCircuit = cleanCircuit(item.circuit);
      if (noteCircuit) note.circuit = noteCircuit;
      placements.push(note);
      continue;
    }
    if (item.kind === "legend") {
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      if (![x, y, width].every((n) => Number.isFinite(n))) {
        skipped += 1;
        continue;
      }
      placements.push({
        id: item.id || uid(),
        kind: "legend",
        page,
        x,
        y,
        width: clamp(width, 40, 2000),
        layer: normalizeLayer(item.layer, "Power"),
      });
      continue;
    }
    if (!symbolsById[item.symbolId] || symbolsById[item.symbolId].place === "run") {
      skipped += 1;
      continue;
    }
    const symbol = {
      id: item.id || uid(),
      kind: "symbol",
      symbolId: item.symbolId,
      page,
      x: Number(item.x),
      y: Number(item.y),
      size: clamp(Number(item.size) || state.defaultSize, 8, 400),
      rotation: normRot(item.rotation),
      color,
      layer: normalizeLayer(item.layer, defaultLayer("symbol", item.symbolId)),
    };
    const symbolCircuit = cleanCircuit(item.circuit);
    if (symbolCircuit) symbol.circuit = symbolCircuit;
    if (item.freePlace === true) symbol.freePlace = true;
    placements.push(symbol);
  }
  state.placements = placements;
  if (Array.isArray(proj.hiddenLayers)) {
    state.hiddenLayers = new Set(
      proj.hiddenLayers.filter((name) => typeof name === "string").map((name) => normalizeLayer(name, "")).filter(Boolean),
    );
  } else {
    state.hiddenLayers = new Set();
  }
  state.showCircuits = proj.showCircuits === true;
  sanitizeAnchors();
  if (proj.defaultSize) state.defaultSize = clamp(Number(proj.defaultSize) || 28, 10, 160);
  state.calibration = proj.calibration || null;
  state.selectedId = null;
  state.calibStep = 0;
  state.calibDraft = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
  if (!quiet && proj.pdfName && proj.pdfName !== state.doc.filename) {
    toast(`Project was saved for ${proj.pdfName}. Marks were applied to this file.`);
  }
  if (skipped) toast("Some marks were skipped because the symbol or sheet is missing.");
}

function renderPalette() {
  const palette = $("palette");
  const scroll = palette.scrollTop;
  const query = ($("filter").value || "").trim().toLowerCase();
  palette.innerHTML = "";
  for (const cat of library.categories) {
    const items = library.symbols.filter((sym) => {
      if (sym.category !== cat.id) return false;
      if (!query) return true;
      const hay = `${sym.name} ${sym.keywords || ""} ${sym.category}`.toLowerCase();
      return hay.includes(query);
    });
    if (!items.length) continue;
    const section = document.createElement("details");
    section.className = "cat";
    section.open = Boolean(query) || openCategories.has(cat.id);
    const title = document.createElement("summary");
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.setAttribute("aria-hidden", "true");
    chev.textContent = "▸";
    const label = document.createElement("span");
    label.textContent = cat.name;
    title.append(chev, label);
    section.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const sym of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sym" + (sym.id === state.armedId ? " active" : "");
      btn.title = sym.hint || sym.name;
      const swatch = document.createElement("div");
      swatch.className = "swatch";
      swatch.innerHTML = sym.svg.replaceAll("#141414", sym.defaultColor || "#141414");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = sym.name;
      btn.appendChild(swatch);
      btn.appendChild(name);
      btn.addEventListener("click", () => toggleArm(sym.id));
      grid.appendChild(btn);
    }
    section.appendChild(grid);
    section.addEventListener("toggle", () => {
      if (($("filter").value || "").trim()) return;
      if (section.open) openCategories.add(cat.id);
      else openCategories.delete(cat.id);
      saveLayout();
    });
    palette.appendChild(section);
  }
  if (!palette.children.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No symbols match that filter.";
    palette.appendChild(empty);
  }
  palette.scrollTop = scroll;
}

function buildSymbolSelect() {
  const select = $("symbolSelect");
  select.innerHTML = "";
  for (const sym of library.symbols) {
    if (sym.place === "run") continue;
    const opt = document.createElement("option");
    opt.value = sym.id;
    opt.textContent = sym.name;
    select.appendChild(opt);
  }
}

function buildColors() {
  const box = $("colors");
  box.innerHTML = "";
  for (const color of COLORS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch-btn";
    btn.dataset.value = color.value;
    btn.title = color.name;
    btn.setAttribute("aria-label", color.name);
    btn.setAttribute("aria-pressed", "false");
    if (color.value) btn.style.background = color.value;
    btn.addEventListener("click", () => applyColor(color.value));
    box.appendChild(btn);
  }
}

function clearDrawingTools() {
  state.tool = null;
  state.lineDraft = null;
  state.arrowDraft = null;
  state.runDraft = null;
  state.layoutDraft = null;
  state.whiteboxDraft = null;
  state.calibStep = 0;
  state.calibDraft = null;
}

function toggleArm(id) {
  const sym = symbolsById[id];
  const was = state.armedId === id;
  clearDrawingTools();
  state.armedId = was ? null : id;
  if (state.armedId && isRunSymbol(sym)) state.tool = "run";
  if (state.armedId && sym) {
    openCategories.add(sym.category);
    saveLayout();
  }
  renderPalette();
  syncInspector();
  renderMarks();
  setStatus();
}

function setTool(name) {
  if (!state.doc) return;
  const next = state.tool === name ? null : name;
  clearDrawingTools();
  state.armedId = null;
  state.tool = next;
  renderPalette();
  syncInspector();
  renderMarks();
  setStatus();
}

function sizeText(pt) {
  let text = `${(pt / 72).toFixed(2)}" on the sheet`;
  if (state.calibration) {
    const feet = pt / state.calibration.pointsPerFoot;
    text += ` · ${feet.toFixed(2)} ft on the plan`;
  }
  return text;
}

function syncInspector() {
  const p = selected();
  const sym = state.armedId ? symbolsById[state.armedId] : null;
  const symbolLike = isSymbol(p);
  const hint = $("toolHint");
  if (state.calibStep === 1) hint.textContent = "Click the first end of a known length.";
  else if (state.calibStep === 2) hint.textContent = "Click the other end.";
  else if (state.calibStep === 3) hint.textContent = "Enter how long that distance is, then Apply.";
  else if (state.tool === "line" && state.lineDraft) hint.textContent = "Click the next point. A point on a symbol stays attached. Esc cancels this segment.";
  else if (state.tool === "line") hint.textContent = "Click the first point of a dashed line. Snap it to a symbol to keep that end attached. Esc puts the tool away.";
  else if (state.tool === "layout" && state.layoutDraft) hint.textContent = "Click the opposite corner. Hold Shift for a square. Esc cancels this rectangle.";
  else if (state.tool === "layout") hint.textContent = "Click one corner, then the opposite corner. This draws a construction line. Symbols snap onto it. Esc puts the tool away.";
  else if (state.tool === "whitebox" && state.whiteboxDraft) hint.textContent = "Click the opposite corner. Hold Shift for a square. Esc cancels this white box.";
  else if (state.tool === "whitebox") hint.textContent = "Click one corner, then the opposite corner. The white box covers the plan under the symbols. Esc puts the tool away.";
  else if (state.tool === "arrow" && state.arrowDraft) hint.textContent = "Click where the arrow points. Esc cancels this arrow.";
  else if (state.tool === "arrow") hint.textContent = "Click the first point, then click where the arrow points. Esc puts the tool away.";
  else if (state.tool === "run" && state.runDraft) hint.textContent = "Click the other end. Esc cancels this run.";
  else if (state.tool === "run") hint.textContent = (sym && sym.hint) || "Click one end, then the other. Esc puts the tool away.";
  else if (state.tool === "note") hint.textContent = "Click the sheet, then type a short label. A note is text, so it stays out of the symbol legend and the counts.";
  else if (state.tool === "legend") hint.textContent = "Click the sheet to drop a legend of every symbol.";
  else if (sym) hint.textContent = sym.hint || `Click the plan to place ${sym.name}. Esc puts the tool away.`;
  else if (p && p.kind === "line" && p.guide) hint.textContent = "Construction line. Click a symbol, then click the line to place it. Drag the line to move it.";
  else if (p && p.kind === "line") hint.textContent = p.a1 || p.a2
    ? "A blue end stays on its symbol. Drag that end away to disconnect it. Dragging the line also disconnects it."
    : "Drag the line to move it. Drag an amber end to change it.";
  else if (p && p.kind === "arrow") hint.textContent = "Drag the arrow to move it. Drag an amber end to change it.";
  else if (p && p.kind === "run") hint.textContent = "Drag the run to move it. Drag an amber end to change its length.";
  else if (p && p.kind === "note") hint.textContent = "Edit the label here. Drag it on the sheet. Notes are not listed in the legend or the counts.";
  else if (p && p.kind === "legend") hint.textContent = "Drag the legend. The slider changes how wide it is.";
  else if (p && p.kind === "whitebox") hint.textContent = "Drag the white box to move it. Drag an amber corner to resize it. Shift keeps a corner square.";
  else if (p) hint.textContent = symbolsById[p.symbolId] ? symbolsById[p.symbolId].hint : "Drag to move. Drag the handle to rotate.";
  else hint.textContent = state.doc ? "Pick a symbol, then click the sheet." : "Open a plan, pick a symbol, then click the sheet to place it.";

  const range = $("sizeRange");
  if (p && p.kind === "legend") {
    range.disabled = false;
    range.min = "120";
    range.max = "800";
    range.step = "2";
    if (document.activeElement !== range) range.value = String(Math.round(p.width));
    $("sizeLabel").textContent = "Legend width";
    $("sizeReadout").textContent = sizeText(p.width);
  } else if (p && p.kind === "line") {
    range.disabled = true;
    $("sizeLabel").textContent = "Dashed line";
    $("sizeReadout").textContent = sizeText(Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
  } else if (p && p.kind === "arrow") {
    range.disabled = true;
    $("sizeLabel").textContent = "Arrow";
    $("sizeReadout").textContent = sizeText(Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
  } else if (p && p.kind === "run") {
    range.disabled = true;
    $("sizeLabel").textContent = "Run length";
    $("sizeReadout").textContent = sizeText(Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
  } else if (p && p.kind === "whitebox") {
    range.disabled = true;
    const w = Math.abs(p.x2 - p.x1);
    const h = Math.abs(p.y2 - p.y1);
    $("sizeLabel").textContent = "White box";
    $("sizeReadout").textContent = `${(w / 72).toFixed(2)}" × ${(h / 72).toFixed(2)}"`;
  } else if ((p && p.kind === "note") || (!p && state.tool === "note")) {
    range.disabled = false;
    range.min = "8";
    range.max = "36";
    range.step = "1";
    const noteSize = p ? p.size : state.noteSize;
    if (document.activeElement !== range) range.value = String(Math.round(noteSize));
    $("sizeLabel").textContent = p ? "Note size" : "Size for new notes";
    $("sizeReadout").textContent = `${Math.round(noteSize)} pt`;
  } else {
    range.disabled = false;
    range.min = "10";
    range.max = "160";
    range.step = "1";
    const activeSize = p ? p.size : state.defaultSize;
    if (document.activeElement !== range) range.value = String(Math.round(activeSize));
    $("sizeLabel").textContent = p ? "Selected size" : "Size for new symbols";
    $("sizeReadout").textContent = sizeText(activeSize);
  }
  const noteSizing = Boolean((p && p.kind === "note") || (!p && state.tool === "note"));
  $("sizeOneFoot").disabled = !state.calibration || noteSizing || (p && !symbolLike);
  for (const btn of document.querySelectorAll(".presets [data-size]")) {
    btn.disabled = noteSizing || Boolean(p && !symbolLike);
  }

  const calibState = $("calibState");
  if (state.calibration) {
    calibState.textContent = `Scale ${state.calibration.label}. It applies to every sheet.`;
    $("calibClear").hidden = false;
  } else {
    calibState.textContent = "Scale not set. Calibrate on a dimension line to read sizes in feet.";
    $("calibClear").hidden = true;
  }
  $("calibForm").hidden = state.calibStep !== 3;
  $("calibBtn").textContent = state.calibStep ? "Cancel" : "Calibrate";
  $("lineBtn").classList.toggle("active", state.tool === "line");
  $("lineBtn").setAttribute("aria-pressed", state.tool === "line" ? "true" : "false");
  $("arrowBtn").classList.toggle("active", state.tool === "arrow");
  $("arrowBtn").setAttribute("aria-pressed", state.tool === "arrow" ? "true" : "false");
  $("noteBtn").classList.toggle("active", state.tool === "note");
  $("noteBtn").setAttribute("aria-pressed", state.tool === "note" ? "true" : "false");
  $("layoutBtn").classList.toggle("active", state.tool === "layout");
  $("layoutBtn").setAttribute("aria-pressed", state.tool === "layout" ? "true" : "false");
  $("whiteboxBtn").classList.toggle("active", state.tool === "whitebox");
  $("whiteboxBtn").setAttribute("aria-pressed", state.tool === "whitebox" ? "true" : "false");
  $("dropLegendBtn").classList.toggle("active", state.tool === "legend");
  $("dropLegendBtn").setAttribute("aria-pressed", state.tool === "legend" ? "true" : "false");
  $("circuitsBtn").classList.toggle("active", state.showCircuits);
  $("circuitsBtn").setAttribute("aria-pressed", state.showCircuits ? "true" : "false");
  $("snapToggle").checked = state.snap;
  $("exportLayers").checked = state.exportAllLayers;

  $("applySizeBox").hidden = !symbolLike;
  if (symbolLike) $("applySizeBtn").textContent = `Apply size to all ${symbolName(p.symbolId)}`;
  $("selectionBox").hidden = !p;
  $("symbolField").hidden = !symbolLike;
  $("noteField").hidden = !(p && p.kind === "note");
  $("rotationField").hidden = !symbolLike;
  if (p && p.kind === "note" && document.activeElement !== $("noteText")) {
    $("noteText").value = p.text || "";
  }
  const circuitable = Boolean(p && (symbolLike || p.kind === "run" || p.kind === "note" || (p.kind === "line" && !p.guide)));
  $("circuitField").hidden = !circuitable;
  if (circuitable && document.activeElement !== $("circuitInput")) {
    $("circuitInput").value = p.circuit || "";
  }
  $("freePlaceField").hidden = !symbolLike;
  if (symbolLike) $("freePlace").checked = p.freePlace === true;
  syncLayerField(p);
  $("colors").hidden = Boolean(p && (p.kind === "legend" || p.kind === "whitebox"));
  if (symbolLike) {
    $("symbolSelect").value = p.symbolId;
    if (document.activeElement !== $("rotInput")) $("rotInput").value = String(Math.round(p.rotation || 0));
  }
  for (const btn of $("colors").querySelectorAll(".swatch-btn")) {
    const match = p && p.kind !== "legend" ? btn.dataset.value === (p.color || "") : btn.dataset.value === state.ink;
    btn.setAttribute("aria-pressed", match ? "true" : "false");
  }
  viewport.classList.toggle("placing", Boolean(state.armedId || state.tool) && !state.calibStep);
}

function syncLayerField(p) {
  const field = $("layerField");
  field.hidden = !p;
  if (!p) return;
  const names = layerNames();
  const select = $("layerSelect");
  const signature = names.join("\n");
  if (select.dataset.sig !== signature) {
    select.dataset.sig = signature;
    select.replaceChildren();
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    const custom = document.createElement("option");
    custom.value = "__custom__";
    custom.textContent = "Custom…";
    select.appendChild(custom);
  }
  const current = layerOf(p);
  const known = names.includes(current);
  if (document.activeElement !== select) select.value = known ? current : "__custom__";
  const customizing = select.value === "__custom__";
  $("layerCustomField").hidden = !customizing;
  if (customizing && document.activeElement !== $("layerCustom")) {
    $("layerCustom").value = known ? "" : current;
  }
}

function renderLayers() {
  const box = $("layerToggles");
  if (!box) return;
  const names = layerNames();
  const signature = names.join("\n");
  if (box.dataset.sig !== signature) {
    box.dataset.sig = signature;
    box.replaceChildren();
    for (const name of names) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.layer = name;
      input.addEventListener("change", () => {
        if (input.checked) state.hiddenLayers.delete(name);
        else state.hiddenLayers.add(name);
        renderMarks();
        syncInspector();
        scheduleSave();
      });
      label.append(input, document.createTextNode(" " + name));
      box.appendChild(label);
    }
  }
  for (const input of box.querySelectorAll("input")) {
    input.checked = !state.hiddenLayers.has(input.dataset.layer);
  }
}

function symbolName(id) {
  const sym = symbolsById[id];
  return (sym && sym.name) || "symbol";
}

function applyScope() {
  const picked = document.querySelector('input[name="applyScope"]:checked');
  return picked && picked.value === "all" ? "all" : "sheet";
}

function applySizeToAll() {
  const p = selected();
  if (!isSymbol(p)) return;
  const scope = applyScope();
  const name = symbolName(p.symbolId);
  const where = scope === "all" ? "" : " on this sheet";
  const others = state.placements.filter((item) => {
    if (item.id === p.id || !isSymbol(item) || item.symbolId !== p.symbolId) return false;
    if (scope === "sheet" && item.page !== p.page) return false;
    return true;
  });
  if (!others.length) {
    toast(`No other ${name} marks${where}.`);
    return;
  }
  const changed = others.filter((item) => item.size !== p.size);
  if (!changed.length) {
    toast(`Those ${name} marks already use this size.`);
    return;
  }
  pushUndo();
  for (const item of changed) item.size = p.size;
  renderMarks();
  syncInspector();
  scheduleSave();
  const n = changed.length;
  toast(`Set size on ${n} ${name} mark${n === 1 ? "" : "s"}.`);
}

function countScope() {
  const picked = document.querySelector('input[name="countScope"]:checked');
  return picked && picked.value === "all" ? "all" : "sheet";
}

function countRows() {
  const scope = countScope();
  const tally = new Map();
  for (const item of state.placements) {
    if (!layerVisible(item)) continue;
    if (item.kind === "note" || item.kind === "arrow" || item.kind === "line" || item.kind === "legend" || item.kind === "whitebox") continue;
    if (!isSymbol(item) && item.kind !== "run") continue;
    if (!item.symbolId) continue;
    if (scope === "sheet" && item.page !== state.pageIndex) continue;
    tally.set(item.symbolId, (tally.get(item.symbolId) || 0) + 1);
  }
  const catIndex = new Map(library.categories.map((cat, index) => [cat.id, index]));
  return [...tally.entries()]
    .map(([id, count]) => {
      const sym = symbolsById[id];
      return { id, count, name: sym ? sym.name : id, category: sym ? sym.category : "" };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        (catIndex.get(a.category) ?? 99) - (catIndex.get(b.category) ?? 99) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

function renderCounts() {
  const list = $("countsList");
  if (!list) return;
  const rows = countRows();
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "count-name";
    name.textContent = row.name;
    const n = document.createElement("span");
    n.className = "count-n";
    n.textContent = String(row.count);
    li.append(name, n);
    list.appendChild(li);
  }
  $("countsEmpty").hidden = rows.length > 0;
  $("countsSheetBtn").disabled = rows.length === 0;
  const schedule = scheduleRows();
  $("scheduleBtn").disabled = schedule.length === 0;
  renderLayers();
}

function scheduleRows() {
  const groups = new Map();
  for (const item of state.placements) {
    if (!layerVisible(item)) continue;
    const circuit = cleanCircuit(item.circuit);
    if (!circuit) continue;
    if (!groups.has(circuit)) groups.set(circuit, { circuit, names: [], notes: [], legs: 0 });
    const group = groups.get(circuit);
    if (isSymbol(item)) group.names.push(symbolName(item.symbolId));
    else if (item.kind === "run") group.names.push(runLabelOf(item) || symbolName(item.symbolId));
    else if (item.kind === "line" && !item.guide) group.legs += 1;
    else if (item.kind === "note") {
      const text = String(item.text || "").replace(/\s+/g, " ").trim();
      if (text && text !== "Note") group.notes.push(text);
    }
  }
  return [...groups.values()]
    .map((group) => {
      const counts = new Map();
      for (const name of group.names) counts.set(name, (counts.get(name) || 0) + 1);
      const parts = [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} (${count})` : name));
      if (group.legs) parts.push(group.legs > 1 ? `Switch leg (${group.legs})` : "Switch leg");
      return {
        circuit: group.circuit,
        description: (parts.join(", ") || "—").slice(0, 160),
        count: group.names.length + group.legs,
        notes: group.notes.join("; ").slice(0, 160),
      };
    })
    .sort((a, b) => a.circuit.localeCompare(b.circuit, undefined, { numeric: true }));
}

async function addScheduleSheet() {
  if (!state.doc) return;
  const rows = scheduleRows();
  if (!rows.length) {
    toast("No circuits to put on a schedule. Type a circuit on a symbol first.");
    return;
  }
  const scope = countScope();
  setBusy(true, "Adding schedule…");
  try {
    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, page: state.pageIndex, rows }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const info = await res.json();
    state.doc = info;
    const start = Math.max(0, info.pageCount - (info.added || 1));
    showPage(start, { fit: true });
    scheduleSave();
    const where = scope === "all" ? "all sheets" : "this sheet";
    toast(`Added a schedule for ${where}.`);
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

async function addCountsSheet() {
  if (!state.doc) return;
  const rows = countRows();
  if (!rows.length) {
    toast("No symbols to put on a counts sheet.");
    return;
  }
  const scope = countScope();
  setBusy(true, "Adding counts…");
  try {
    const res = await fetch("/api/counts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        page: state.pageIndex,
        rows: rows.map((row) => ({ name: row.name, count: row.count })),
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const info = await res.json();
    state.doc = info;
    const start = Math.max(0, info.pageCount - (info.added || 1));
    showPage(start, { fit: true });
    scheduleSave();
    const where = scope === "all" ? "all sheets" : "this sheet";
    toast(`Added a counts sheet for ${where}.`);
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

function setSize(pt, { undo = false } = {}) {
  const p = selected();
  if (p && (p.kind === "line" || p.kind === "arrow" || p.kind === "run" || p.kind === "whitebox")) return;
  if (p && p.kind === "note") {
    pt = clamp(pt, 8, 36);
    if (undo) pushUndo();
    p.size = pt;
    state.noteSize = pt;
    updateMark(p);
    syncInspector();
    scheduleSave();
    return;
  }
  if (!p && state.tool === "note") {
    state.noteSize = clamp(pt, 8, 36);
    syncInspector();
    return;
  }
  if (p && p.kind === "legend") {
    pt = clamp(pt, 120, 800);
    if (undo) pushUndo();
    p.width = pt;
    updateMark(p);
    syncInspector();
    scheduleSave();
    return;
  }
  pt = clamp(pt, 10, 160);
  if (undo) pushUndo();
  if (p) p.size = pt;
  else state.defaultSize = pt;
  if (p) updateMark(p);
  syncInspector();
  scheduleSave();
}

function applyColor(value) {
  const p = selected();
  if (p && (p.kind === "legend" || p.kind === "whitebox")) return;
  if (p) pushUndo();
  state.ink = value;
  const ink = value || "#141414";
  if (state.lineDraft) state.lineDraft.color = ink;
  if (state.arrowDraft) state.arrowDraft.color = ink;
  if (state.runDraft) state.runDraft.color = ink;
  if (p && (p.kind === "line" || p.kind === "arrow" || p.kind === "note")) p.color = ink;
  else if (p) {
    const sym = symbolsById[p.symbolId];
    p.color = value || (sym && sym.defaultColor) || "#141414";
  }
  if (p && p.kind === "note") updateNote(p);
  else if (p && !isSegment(p)) renderMarks();
  else if ((p && isSegment(p)) || state.lineDraft || state.arrowDraft || state.runDraft) renderWires();
  syncInspector();
  scheduleSave();
}

function bumpRotation(delta) {
  const p = selected();
  if (!isSymbol(p)) return;
  pushUndo();
  p.rotation = normRot(p.rotation + delta);
  updateMark(p);
  scheduleSave();
}

function duplicatePlacement(p, dx, dy) {
  const copy = { ...p, id: uid() };
  if (isSegment(p) || isWhitebox(p)) {
    copy.x1 = p.x1 + dx;
    copy.y1 = p.y1 + dy;
    copy.x2 = p.x2 + dx;
    copy.y2 = p.y2 + dy;
    if (copy.kind === "line") {
      copy.a1 = null;
      copy.a2 = null;
    }
  } else {
    copy.x = p.x + dx;
    copy.y = p.y + dy;
  }
  state.placements.push(copy);
  return copy;
}

function duplicateShift(p) {
  if (isSegment(p) || isWhitebox(p)) return 16;
  if (p.kind === "note") return Math.max(18, p.size * 1.6);
  if (p.kind === "legend") return 24;
  return p.size * 0.35;
}

function duplicateSelected() {
  const p = selected();
  if (!p) return;
  pushUndo();
  const shift = duplicateShift(p);
  const copy = duplicatePlacement(p, shift, shift);
  state.selectedId = copy.id;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function deleteSelected() {
  const p = selected();
  if (!p) return;
  pushUndo();
  releaseAnchors(p.id);
  state.placements = state.placements.filter((item) => item.id !== p.id);
  state.selectedId = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function placeAt(cx, cy, shift) {
  const sym = symbolsById[state.armedId];
  const page = currentPage();
  if (!sym || !page) return;
  const pt = clientToPdf(cx, cy);
  if (pt.x < -40 || pt.y < -40 || pt.x > page.width + 40 || pt.y > page.height + 40) return;
  const snapped = snapPlacement(pt, sym.id, false, shift);
  pushUndo();
  const mark = {
    id: uid(),
    kind: "symbol",
    symbolId: sym.id,
    page: state.pageIndex,
    x: snapped.x,
    y: snapped.y,
    size: state.defaultSize,
    rotation: 0,
    color: state.ink || sym.defaultColor || "#141414",
    layer: defaultLayer("symbol", sym.id),
  };
  state.placements.push(mark);
  state.selectedId = mark.id;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function calibClick(pt) {
  if (state.calibStep === 1) {
    state.calibDraft = { page: state.pageIndex, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    state.calibStep = 2;
  } else if (state.calibStep === 2) {
    state.calibDraft.x2 = pt.x;
    state.calibDraft.y2 = pt.y;
    const length = Math.hypot(state.calibDraft.x2 - state.calibDraft.x1, state.calibDraft.y2 - state.calibDraft.y1);
    if (length < 2) {
      toast("Those points are too close. Click two ends of the dimension.");
      return;
    }
    state.calibStep = 3;
    requestAnimationFrame(() => $("calibLen").focus());
  }
  syncInspector();
  drawCalib();
  setStatus();
}

function applyCalibration() {
  const draft = state.calibDraft;
  if (!draft) return;
  const distance = Number($("calibLen").value);
  const unit = $("calibUnit").value;
  const pt = Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1);
  if (!(distance > 0) || !Number.isFinite(distance)) {
    toast("Enter a length greater than zero.");
    return;
  }
  let feet = distance;
  if (unit === "in") feet = distance / 12;
  if (unit === "m") feet = distance * 3.280839895;
  const pointsPerFoot = pt / feet;
  const inchesPerFoot = pt / 72 / feet;
  pushUndo();
  state.calibration = {
    page: draft.page,
    x1: draft.x1,
    y1: draft.y1,
    x2: draft.x2,
    y2: draft.y2,
    distance,
    unit,
    pointsPerFoot,
    label: scaleLabel(inchesPerFoot),
  };
  state.calibStep = 0;
  state.calibDraft = null;
  syncInspector();
  drawCalib();
  scheduleSave();
  setStatus();
  toast(`Scale set to ${state.calibration.label}.`);
}

function cancelCalib() {
  state.calibStep = 0;
  state.calibDraft = null;
  syncInspector();
  drawCalib();
  setStatus();
}

function capturePointer(e) {
  try {
    viewport.setPointerCapture(e.pointerId);
  } catch (_err) {
    // The pointer can already be gone. Move and up listeners on window still run.
  }
}

function startPan(e) {
  state.drag = {
    type: "pan",
    x: e.clientX,
    y: e.clientY,
    panX: state.panX,
    panY: state.panY,
  };
  viewport.classList.add("panning");
  capturePointer(e);
}

function placementOrigin(p) {
  if (isSegment(p) || isWhitebox(p)) return { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 };
  return { x: p.x, y: p.y };
}

function ensureEdgeMap() {
  const page = currentPage();
  if (!page || !pageImg.complete || !pageImg.naturalWidth) return null;
  if (edgeMap && edgeMap.key === state.imageKey) return edgeMap;
  const canvas = document.createElement("canvas");
  canvas.width = pageImg.naturalWidth;
  canvas.height = pageImg.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(pageImg, 0, 0);
  let data;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch (_err) {
    return null;
  }
  edgeMap = { key: state.imageKey, data, w: canvas.width, h: canvas.height };
  return edgeMap;
}

function snapToUnderlay(pt) {
  const map = ensureEdgeMap();
  const page = currentPage();
  if (!map || !page) return null;
  const sx = map.w / page.width;
  const sy = map.h / page.height;
  const cx = pt.x * sx;
  const cy = pt.y * sy;
  const radius = SNAP_RADIUS * Math.max(sx, sy);
  const x0 = Math.max(1, Math.floor(cx - radius));
  const y0 = Math.max(1, Math.floor(cy - radius));
  const x1 = Math.min(map.w - 2, Math.ceil(cx + radius));
  const y1 = Math.min(map.h - 2, Math.ceil(cy + radius));
  if (x1 <= x0 || y1 <= y0) return null;
  const lumAt = (x, y) => {
    const i = (y * map.w + x) * 4;
    return map.data[i] * 0.299 + map.data[i + 1] * 0.587 + map.data[i + 2] * 0.114;
  };
  let best = null;
  let bestScore = Infinity;
  const r2 = radius * radius;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const gradient = Math.hypot(lumAt(x + 1, y) - lumAt(x - 1, y), lumAt(x, y + 1) - lumAt(x, y - 1));
      if (gradient < 55) continue;
      const score = Math.sqrt(d2) - Math.min(gradient, 180) / 1000;
      if (score < bestScore) {
        bestScore = score;
        best = { x: x / sx, y: y / sy };
      }
    }
  }
  return best;
}

function snapPlacement(pt, symbolId, freePlace, shift) {
  const guide = snapToGuide(pt, state.pageIndex);
  if (guide) return guide;
  if (!state.snap || shift || symbolSkipsSnap(symbolId, freePlace)) return pt;
  return snapToUnderlay(pt) || pt;
}

function snapPoint(pt, excludeId) {
  let best = null;
  let bestD = 14;
  for (const item of state.placements) {
    if (item.page !== state.pageIndex || item.id === excludeId) continue;
    if (isSegment(item)) {
      for (const [x, y] of [[item.x1, item.y1], [item.x2, item.y2]]) {
        const dist = Math.hypot(pt.x - x, pt.y - y);
        if (dist < bestD) {
          bestD = dist;
          best = { x, y, anchorId: null };
        }
      }
      continue;
    }
    if (item.kind === "legend" || !Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
    const dist = Math.hypot(pt.x - item.x, pt.y - item.y);
    if (dist < bestD) {
      bestD = dist;
      best = { x: item.x, y: item.y, anchorId: item.id };
    }
  }
  return best || { x: pt.x, y: pt.y, anchorId: null };
}

function projectOnSegment(pt, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.01) return { x: x1, y: y1, dist: Math.hypot(pt.x - x1, pt.y - y1) };
  const t = Math.max(0, Math.min(1, ((pt.x - x1) * dx + (pt.y - y1) * dy) / len2));
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return { x, y, dist: Math.hypot(pt.x - x, pt.y - y) };
}

function snapToGuide(pt, page) {
  let best = null;
  let bestD = 14;
  for (const item of state.placements) {
    if (item.kind !== "line" || !item.guide || item.page !== page) continue;
    const hit = projectOnSegment(pt, item.x1, item.y1, item.x2, item.y2);
    if (hit.dist < bestD) {
      bestD = hit.dist;
      best = { x: hit.x, y: hit.y };
    }
  }
  return best;
}

function anchorTarget(id, line) {
  if (typeof id !== "string" || !id || id.length > 80 || !line) return null;
  const target = state.placements.find((item) => item.id === id);
  if (!target || target.id === line.id || target.page !== line.page) return null;
  if (isSegment(target) || target.kind === "legend" || target.kind === "whitebox") return null;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
  return target;
}

function sanitizeAnchors() {
  for (const line of state.placements) {
    if (line.kind !== "line" || line.guide) continue;
    const first = anchorTarget(line.a1, line);
    const second = anchorTarget(line.a2, line);
    line.a1 = first ? first.id : null;
    line.a2 = second ? second.id : null;
    if (first) {
      line.x1 = first.x;
      line.y1 = first.y;
    }
    if (second) {
      line.x2 = second.x;
      line.y2 = second.y;
    }
  }
}

function followAnchors(mark) {
  if (!mark || isSegment(mark) || mark.kind === "legend" || mark.kind === "whitebox") return;
  for (const line of state.placements) {
    if (line.kind !== "line" || line.guide || line.page !== mark.page) continue;
    let hit = false;
    if (line.a1 === mark.id) {
      line.x1 = mark.x;
      line.y1 = mark.y;
      hit = true;
    }
    if (line.a2 === mark.id) {
      line.x2 = mark.x;
      line.y2 = mark.y;
      hit = true;
    }
    if (hit) updateLine(line);
  }
}

function releaseAnchors(id) {
  for (const line of state.placements) {
    if (line.kind !== "line") continue;
    if (line.a1 === id) line.a1 = null;
    if (line.a2 === id) line.a2 = null;
  }
}

function squareCorner(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx === 0 ? 1 : Math.sign(dx);
  const sy = dy === 0 ? 1 : Math.sign(dy);
  return { x: x1 + sx * side, y: y1 + sy * side };
}

function addLayoutDraft(parent) {
  const draft = state.layoutDraft;
  if (!draft) return;
  let x2 = draft.x2;
  let y2 = draft.y2;
  if (draft.square) {
    const corner = squareCorner(draft.x1, draft.y1, x2, y2);
    x2 = corner.x;
    y2 = corner.y;
  }
  const corners = [
    [draft.x1, draft.y1],
    [x2, draft.y1],
    [x2, y2],
    [draft.x1, y2],
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const start = corners[index];
    const end = corners[(index + 1) % corners.length];
    addWireLine(parent, { x1: start[0], y1: start[1], x2: end[0], y2: end[1] }, "wire-ink", "#5c6570", 0.9, "none", "2.5 2.5");
  }
}

function layoutClick(pt, shift) {
  const page = currentPage();
  if (!page || !onSheet(pt, page)) return;
  if (!state.layoutDraft) {
    state.layoutDraft = { page: state.pageIndex, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, square: false };
    renderWires();
    syncInspector();
    setStatus();
    return;
  }
  let x2 = pt.x;
  let y2 = pt.y;
  if (shift) {
    const corner = squareCorner(state.layoutDraft.x1, state.layoutDraft.y1, x2, y2);
    x2 = corner.x;
    y2 = corner.y;
  }
  const left = Math.min(state.layoutDraft.x1, x2);
  const right = Math.max(state.layoutDraft.x1, x2);
  const top = Math.min(state.layoutDraft.y1, y2);
  const bottom = Math.max(state.layoutDraft.y1, y2);
  if (right - left < 8 || bottom - top < 8) {
    toast("That layout is too small. Click the opposite corner.");
    return;
  }
  pushUndo();
  const corners = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const start = corners[index];
    const end = corners[(index + 1) % corners.length];
    state.placements.push({
      id: uid(),
      kind: "line",
      page: state.layoutDraft.page,
      x1: start[0],
      y1: start[1],
      x2: end[0],
      y2: end[1],
      color: "#5c6570",
      a1: null,
      a2: null,
      guide: true,
      layer: "Lighting",
    });
  }
  state.layoutDraft = null;
  state.selectedId = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
  toast("Construction rectangle added. Click a symbol, then click the line to place it.");
}

function addWhiteboxDraft(parent) {
  const draft = state.whiteboxDraft;
  if (!draft) return;
  let x2 = draft.x2;
  let y2 = draft.y2;
  if (draft.square) {
    const corner = squareCorner(draft.x1, draft.y1, x2, y2);
    x2 = corner.x;
    y2 = corner.y;
  }
  const rect = document.createElementNS(SVGNS, "rect");
  rect.setAttribute("x", String(Math.min(draft.x1, x2)));
  rect.setAttribute("y", String(Math.min(draft.y1, y2)));
  rect.setAttribute("width", String(Math.abs(x2 - draft.x1)));
  rect.setAttribute("height", String(Math.abs(y2 - draft.y1)));
  rect.setAttribute("fill", "#ffffff");
  rect.setAttribute("stroke", "#e2a23a");
  rect.setAttribute("stroke-width", "1");
  rect.setAttribute("stroke-dasharray", "4 3");
  rect.setAttribute("pointer-events", "none");
  parent.appendChild(rect);
}

function whiteboxClick(pt, shift) {
  const page = currentPage();
  if (!page || !onSheet(pt, page)) return;
  if (!state.whiteboxDraft) {
    state.whiteboxDraft = { page: state.pageIndex, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, square: false };
    renderWires();
    syncInspector();
    setStatus();
    return;
  }
  let x2 = pt.x;
  let y2 = pt.y;
  if (shift) {
    const corner = squareCorner(state.whiteboxDraft.x1, state.whiteboxDraft.y1, x2, y2);
    x2 = corner.x;
    y2 = corner.y;
  }
  if (Math.abs(x2 - state.whiteboxDraft.x1) < 8 || Math.abs(y2 - state.whiteboxDraft.y1) < 8) {
    toast("That white box is too small. Click the opposite corner.");
    return;
  }
  pushUndo();
  const mark = {
    id: uid(),
    kind: "whitebox",
    page: state.whiteboxDraft.page,
    x1: state.whiteboxDraft.x1,
    y1: state.whiteboxDraft.y1,
    x2,
    y2,
    layer: "Power",
  };
  state.placements.push(mark);
  state.selectedId = mark.id;
  state.whiteboxDraft = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function onSheet(pt, page) {
  return pt.x >= -80 && pt.y >= -80 && pt.x <= page.width + 80 && pt.y <= page.height + 80;
}

function segmentClick(pt, kind) {
  const page = currentPage();
  if (!page || !onSheet(pt, page)) return;
  const key = kind === "arrow" ? "arrowDraft" : kind === "run" ? "runDraft" : "lineDraft";
  const snapped = snapPoint(pt);
  const draft = state[key];
  if (!draft) {
    const sym = kind === "run" ? symbolsById[state.armedId] : null;
    if (kind === "run" && !isRunSymbol(sym)) return;
    state[key] = {
      kind,
      page: state.pageIndex,
      x1: snapped.x,
      y1: snapped.y,
      x2: snapped.x,
      y2: snapped.y,
      color: state.ink || (sym && sym.defaultColor) || "#141414",
    };
    if (kind === "run") state[key].symbolId = sym.id;
    if (kind === "line") state[key].a1 = snapped.anchorId || null;
    if (kind === "line" || kind === "run") state[key].anchorStart = snapped.anchorId || null;
    renderWires();
    syncInspector();
    setStatus();
    return;
  }
  draft.x2 = snapped.x;
  draft.y2 = snapped.y;
  const length = Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1);
  const minLength = kind === "run" ? 8 : 4;
  if (length < minLength) {
    if (kind === "arrow") toast("That arrow is too short. Click where it points.");
    else if (kind === "run") toast("That run is too short. Click the other end.");
    else toast("That line is too short. Click a second point.");
    return;
  }
  pushUndo();
  const mark = {
    id: uid(),
    kind,
    page: draft.page,
    x1: draft.x1,
    y1: draft.y1,
    x2: draft.x2,
    y2: draft.y2,
    color: draft.color,
  };
  if (kind === "run") mark.symbolId = draft.symbolId;
  if (kind === "line") {
    mark.a1 = draft.a1 || null;
    mark.a2 = snapped.anchorId || null;
  }
  mark.layer = defaultLayer(kind, mark.symbolId, false);
  if (kind === "line" || kind === "run") {
    const inherited = circuitFromAnchor(snapped.anchorId) || circuitFromAnchor(draft.anchorStart);
    if (inherited) mark.circuit = inherited;
  }
  state.placements.push(mark);
  state.selectedId = mark.id;
  state[key] = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function circuitFromAnchor(id) {
  if (!id) return "";
  const target = placement(id);
  if (!target || isSegment(target)) return "";
  return cleanCircuit(target.circuit);
}

function placeNote(pt) {
  const page = currentPage();
  if (!page || !onSheet(pt, page)) return;
  const snapped = snapPoint(pt);
  pushUndo();
  const mark = {
    id: uid(),
    kind: "note",
    page: state.pageIndex,
    x: snapped.x,
    y: snapped.y,
    text: "Note",
    size: state.noteSize || 12,
    color: state.ink || "#141414",
    layer: "Power",
  };
  state.placements.push(mark);
  state.selectedId = mark.id;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
  requestAnimationFrame(() => {
    const box = $("noteText");
    if (!box || selected() !== mark) return;
    box.focus();
    box.select();
  });
}

function placeLegend(pt) {
  const page = currentPage();
  const lay = visibleLegendLayout();
  if (!page || !lay) {
    toast("The legend is not available. Restart the app and try again.");
    return;
  }
  if (!onSheet(pt, page)) return;
  let width = lay.width;
  let height = lay.height;
  const maxW = Math.max(120, page.width - 24);
  const maxH = Math.max(80, page.height - 24);
  if (width > maxW) {
    height *= maxW / width;
    width = maxW;
  }
  if (height > maxH) {
    width *= maxH / height;
    height = maxH;
  }
  const x = clamp(pt.x, 8, Math.max(8, page.width - width - 8));
  const y = clamp(pt.y, 8, Math.max(8, page.height - height - 8));
  pushUndo();
  const mark = { id: uid(), kind: "legend", page: state.pageIndex, x, y, width, layer: "Power" };
  state.placements.push(mark);
  state.selectedId = mark.id;
  state.tool = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
  toast("Legend placed. Drag it where the crew can read it.");
}

function startMove(e, id) {
  let p = placement(id);
  if (!p) return;
  state.selectedId = id;
  let undoOnMove = true;
  if (e.altKey) {
    pushUndo();
    p = duplicatePlacement(p, 0, 0);
    state.selectedId = p.id;
    undoOnMove = false;
  }
  const pdf = clientToPdf(e.clientX, e.clientY);
  state.drag = {
    type: "move",
    id: p.id,
    startX: pdf.x,
    startY: pdf.y,
    origin: placementOrigin(p),
    moved: false,
    alt: e.altKey,
    undo: undoOnMove,
  };
  capturePointer(e);
  renderMarks();
  syncInspector();
  setStatus();
}

function startEnd(e, id, end) {
  state.selectedId = id;
  state.drag = { type: "end", id, end, undo: true, moved: false };
  capturePointer(e);
  renderMarks();
  syncInspector();
  setStatus();
}

function startBoxResize(e, id, corner) {
  const p = placement(id);
  if (!isWhitebox(p)) return;
  state.selectedId = id;
  const b = boxBounds(p);
  const fixed = [
    [b.right, b.bottom],
    [b.left, b.bottom],
    [b.left, b.top],
    [b.right, b.top],
  ][corner] || [b.left, b.top];
  state.drag = { type: "box", id, fixedX: fixed[0], fixedY: fixed[1], undo: true, moved: false };
  capturePointer(e);
  renderMarks();
  syncInspector();
  setStatus();
}

function startRotate(e, id) {
  state.selectedId = id;
  state.drag = { type: "rotate", id, undo: true };
  capturePointer(e);
  renderMarks();
  syncInspector();
}

function onPointerDown(e) {
  if (!state.doc) return;
  if (e.button === 1 || e.button === 2 || state.space) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  const pt = clientToPdf(e.clientX, e.clientY);
  if (state.tool === "line" || state.tool === "arrow" || state.tool === "run" || state.tool === "layout" || state.tool === "whitebox") {
    e.preventDefault();
    if (state.tool === "layout") layoutClick(pt, e.shiftKey);
    else if (state.tool === "whitebox") whiteboxClick(pt, e.shiftKey);
    else segmentClick(pt, state.tool);
    return;
  }
  const boxHandle = e.target.closest(".box-handle");
  if (boxHandle) {
    e.preventDefault();
    startBoxResize(e, boxHandle.dataset.id, Number(boxHandle.dataset.corner));
    return;
  }
  const end = e.target.closest(".wire-end");
  if (end) {
    e.preventDefault();
    startEnd(e, end.dataset.id, end.dataset.end);
    return;
  }
  const wire = e.target.closest(".wire");
  if (wire && wire.dataset.id) {
    e.preventDefault();
    startMove(e, wire.dataset.id);
    return;
  }
  const handle = e.target.closest(".handle");
  if (handle) {
    e.preventDefault();
    startRotate(e, handle.dataset.id);
    return;
  }
  const mark = e.target.closest(".mark");
  if (mark) {
    e.preventDefault();
    startMove(e, mark.dataset.id);
    return;
  }
  if (state.calibStep === 1 || state.calibStep === 2) {
    calibClick(pt);
    return;
  }
  if (state.calibStep === 3) return;
  if (state.tool === "legend") {
    placeLegend(pt);
    return;
  }
  if (state.tool === "note") {
    placeNote(pt);
    return;
  }
  if (state.armedId) {
    placeAt(e.clientX, e.clientY, e.shiftKey);
    return;
  }
  if (state.selectedId) {
    state.selectedId = null;
    renderMarks();
    syncInspector();
    setStatus();
  }
}

function onPointerMove(e) {
  const target = e.target;
  const overSheet = target === viewport || (target instanceof Node && viewport.contains(target));
  if (state.doc && (overSheet || state.drag)) {
    const pt = clientToPdf(e.clientX, e.clientY);
    $("statusMid").textContent = `${(pt.x / 72).toFixed(2)}" from left · ${(pt.y / 72).toFixed(2)}" from top`;
    if (state.calibStep === 2 && state.calibDraft && !state.drag) {
      state.calibDraft.x2 = pt.x;
      state.calibDraft.y2 = pt.y;
      drawCalib();
    }
    const draft = state.tool === "line" ? state.lineDraft : state.tool === "arrow" ? state.arrowDraft : state.tool === "run" ? state.runDraft : null;
    if (draft && !state.drag) {
      const snapped = snapPoint(pt);
      draft.x2 = snapped.x;
      draft.y2 = snapped.y;
      renderWires();
    }
    if (state.layoutDraft && state.layoutDraft.page === state.pageIndex && !state.drag) {
      state.layoutDraft.x2 = pt.x;
      state.layoutDraft.y2 = pt.y;
      state.layoutDraft.square = e.shiftKey;
      renderWires();
    }
    if (state.whiteboxDraft && state.whiteboxDraft.page === state.pageIndex && !state.drag) {
      state.whiteboxDraft.x2 = pt.x;
      state.whiteboxDraft.y2 = pt.y;
      state.whiteboxDraft.square = e.shiftKey;
      renderWires();
    }
  }
  const drag = state.drag;
  if (!drag) return;
  if (drag.type === "pan") {
    state.panX = drag.panX + (e.clientX - drag.x);
    state.panY = drag.panY + (e.clientY - drag.y);
    applyTransform();
    return;
  }
  if (drag.type === "end") {
    const p = placement(drag.id);
    if (!isSegment(p)) return;
    const pdf = snapPoint(clientToPdf(e.clientX, e.clientY), p.id);
    if (p.kind === "line" && !p.guide && pdf.anchorId && pdf.anchorId === (drag.end === "1" ? p.a2 : p.a1)) return;
    const nextX1 = drag.end === "1" ? pdf.x : p.x1;
    const nextY1 = drag.end === "1" ? pdf.y : p.y1;
    const nextX2 = drag.end === "1" ? p.x2 : pdf.x;
    const nextY2 = drag.end === "1" ? p.y2 : pdf.y;
    const minLen = p.kind === "arrow" ? 4 : p.kind === "run" ? 8 : 0;
    if (minLen && Math.hypot(nextX2 - nextX1, nextY2 - nextY1) < minLen) return;
    if (drag.undo) {
      pushUndo();
      drag.undo = false;
    }
    p.x1 = nextX1;
    p.y1 = nextY1;
    p.x2 = nextX2;
    p.y2 = nextY2;
    if (p.kind === "line" && !p.guide) {
      if (drag.end === "1") p.a1 = pdf.anchorId || null;
      else p.a2 = pdf.anchorId || null;
    }
    if ((p.kind === "line" && !p.guide) || p.kind === "run") {
      if (!p.circuit) {
        const inherited = circuitFromAnchor(pdf.anchorId);
        if (inherited) p.circuit = inherited;
      }
    }
    drag.moved = true;
    updateLine(p);
    return;
  }
  if (drag.type === "move") {
    const pdf = clientToPdf(e.clientX, e.clientY);
    const p = placement(drag.id);
    if (!p) return;
    const dx = pdf.x - drag.startX;
    const dy = pdf.y - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 0.6) return;
    if (drag.undo) {
      pushUndo();
      drag.undo = false;
    }
    drag.moved = true;
    if (isSegment(p) || isWhitebox(p)) {
      p.x1 = drag.origin.x1 + dx;
      p.y1 = drag.origin.y1 + dy;
      p.x2 = drag.origin.x2 + dx;
      p.y2 = drag.origin.y2 + dy;
      if (p.kind === "line") {
        p.a1 = null;
        p.a2 = null;
      }
    } else {
      let x = drag.origin.x + dx;
      let y = drag.origin.y + dy;
      if (isSymbol(p)) {
        const snapped = snapPlacement({ x, y }, p.symbolId, p.freePlace, e.shiftKey);
        x = snapped.x;
        y = snapped.y;
      }
      p.x = x;
      p.y = y;
    }
    updateMark(p);
    return;
  }
  if (drag.type === "box") {
    const p = placement(drag.id);
    if (!isWhitebox(p)) return;
    const pdf = clientToPdf(e.clientX, e.clientY);
    let x = pdf.x;
    let y = pdf.y;
    if (e.shiftKey) {
      const corner = squareCorner(drag.fixedX, drag.fixedY, x, y);
      x = corner.x;
      y = corner.y;
    }
    if (Math.abs(x - drag.fixedX) < 8 || Math.abs(y - drag.fixedY) < 8) return;
    if (drag.undo) {
      pushUndo();
      drag.undo = false;
    }
    p.x1 = drag.fixedX;
    p.y1 = drag.fixedY;
    p.x2 = x;
    p.y2 = y;
    drag.moved = true;
    updateMark(p);
    const width = Math.abs(p.x2 - p.x1);
    const height = Math.abs(p.y2 - p.y1);
    $("sizeReadout").textContent = `${(width / 72).toFixed(2)}" × ${(height / 72).toFixed(2)}"`;
    return;
  }
  if (drag.type === "rotate") {
    const p = placement(drag.id);
    if (!isSymbol(p)) return;
    if (drag.undo) {
      pushUndo();
      drag.undo = false;
    }
    const c = pdfToClient(p.x, p.y);
    const ang = Math.atan2(e.clientY - c.y, e.clientX - c.x);
    let deg = (ang * 180) / Math.PI - 90;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    p.rotation = normRot(deg);
    updateMark(p);
  }
}

function onPointerUp() {
  const drag = state.drag;
  if (!drag) return;
  if (drag.type === "move" && drag.alt && !drag.moved) {
    const p = placement(drag.id);
    if (p) {
      const shift = duplicateShift(p);
      if (isSegment(p) || isWhitebox(p)) {
        p.x1 += shift;
        p.y1 += shift;
        p.x2 += shift;
        p.y2 += shift;
      } else {
        p.x += shift;
        p.y += shift;
      }
      updateMark(p);
    }
  }
  const changed = drag.moved || drag.type === "rotate";
  state.drag = null;
  viewport.classList.remove("panning");
  if (changed) scheduleSave();
}

function setStatus() {
  let left = "No plan open";
  if (state.doc) {
    if (state.calibStep === 1) left = "Calibrate: click the first point of a known length";
    else if (state.calibStep === 2) left = "Calibrate: click the second point";
    else if (state.calibStep === 3) left = "Enter that length, then Apply";
    else if (state.tool === "line" && state.lineDraft) left = "Dashed line: click the next point. Esc cancels this segment.";
    else if (state.tool === "line") left = "Dashed line: click the first point. Snap to a symbol to stay attached.";
    else if (state.tool === "layout" && state.layoutDraft) left = "Light layout: click the opposite corner. Shift makes a square.";
    else if (state.tool === "layout") left = "Light layout: click two corners to draw a construction rectangle.";
    else if (state.tool === "whitebox" && state.whiteboxDraft) left = "White box: click the opposite corner. Shift makes a square.";
    else if (state.tool === "whitebox") left = "White box: click two corners to cover the plan.";
    else if (state.tool === "arrow" && state.arrowDraft) left = "Arrow: click where it points. Esc cancels this arrow.";
    else if (state.tool === "arrow") left = "Arrow: click the first point, then where it points.";
    else if (state.tool === "run" && state.runDraft) left = "Run: click the other end. Esc cancels this run.";
    else if (state.tool === "run") {
      const sym = symbolsById[state.armedId];
      left = sym ? `${sym.name}: click one end, then the other.` : "Click one end, then the other.";
    }
    else if (state.tool === "note") left = "Note: click the sheet, then type. Esc puts the tool away.";
    else if (state.tool === "legend") left = "Click the sheet to drop the legend.";
    else if (state.armedId) {
      const sym = symbolsById[state.armedId];
      const name = sym ? sym.name : "symbol";
      const guides = state.placements.some((item) => item.kind === "line" && item.guide && item.page === state.pageIndex);
      left = guides
        ? `Placing ${name}. Click the plan. A click near a construction line snaps onto it.`
        : `Placing ${name}. Click the plan. Esc cancels.`;
    } else if (selected() && selected().kind === "line" && selected().guide) left = "Construction line. Place a symbol on it, or drag the line to move it.";
    else if (selected() && selected().kind === "line") left = selected().a1 || selected().a2
      ? "Blue ends stay attached. Drag an end off its symbol to disconnect it."
      : "Drag the line to move it. Drag an end to reshape it.";
    else if (selected() && selected().kind === "arrow") left = "Drag the arrow to move it. Drag an end to reshape it.";
    else if (selected() && selected().kind === "run") left = "Drag the run to move it. Drag an end to change its length.";
    else if (selected() && selected().kind === "note") left = "Edit the note in the side panel. Drag it on the sheet.";
    else if (selected() && selected().kind === "legend") left = "Drag the legend. The slider changes its width.";
    else if (selected() && selected().kind === "whitebox") left = "Drag the white box to move it. Drag a corner to resize it.";
    else if (selected()) left = "Drag to move. Drag the amber handle to rotate.";
    else left = "Pick a symbol, then click the plan.";
  }
  $("statusLeft").textContent = left;
  if (!state.doc) $("statusMid").textContent = "";
  if (!state.doc) {
    $("statusRight").textContent = "";
    return;
  }
  const here = state.placements.filter((item) => item.page === state.pageIndex).length;
  const scale = state.calibration ? state.calibration.label : "scale not set";
  $("statusRight").textContent = `${here} on this sheet · ${state.placements.length} total · ${scale}`;
}

async function openPdfBytes(buf, filename, { append = false } = {}) {
  setBusy(true, append ? "Adding sheets…" : "Opening plan…");
  try {
    const url = append ? "/api/append" : "/api/open?name=" + encodeURIComponent(filename);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: buf,
    });
    if (!res.ok) throw new Error(await readError(res));
    const info = await res.json();
    if (append) {
      const had = state.doc ? state.doc.pageCount : 0;
      state.doc = info;
      updatePager();
      scheduleSave();
      toast(`Added ${info.added || info.pageCount - had} sheet${info.added === 1 ? "" : "s"}.`);
      return;
    }
    const previousMarks = state.placements.length;
    state.doc = info;
    state.placements = [];
    state.selectedId = null;
    state.armedId = null;
    state.tool = null;
    state.lineDraft = null;
    state.arrowDraft = null;
    state.runDraft = null;
    state.layoutDraft = null;
    state.whiteboxDraft = null;
    state.hiddenLayers = new Set();
    state.showCircuits = false;
    state.calibration = null;
    state.calibStep = 0;
    state.calibDraft = null;
    state.undo = [];
    state.redo = [];
    state.imageKey = "";
    state.imageToken += 1;
    showWorkspace();
    showPage(0, { fit: true });
    renderPalette();
    const pending = state.pendingProject;
    state.pendingProject = null;
    if (pending) {
      applyProject(pending);
      toast("Loaded the marks file onto this plan.");
    } else if (info.project) {
      applyProject(info.project, { quiet: true });
      toast("Opened a revision file. The marks are editable.");
    } else if (info.revisionWarning) {
      toast(info.revisionWarning);
    } else {
      const raw = localStorage.getItem("planmarks:v1:" + info.id);
      if (raw) {
        try {
          const saved = JSON.parse(raw);
          const hasMarks = (saved.placements || []).length || saved.calibration;
          if (hasMarks) {
            applyProject(saved, { quiet: true });
            toast("Restored marks saved in this browser for this PDF.");
          }
        } catch (_err) {
          /* ignore a damaged autosave */
        }
      } else if (previousMarks) {
        toast("Opened a new plan. Marks on the previous file stay in this browser.");
      }
    }
    syncInspector();
    setStatus();
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

async function openFile(file, { append = false } = {}) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  await openPdfBytes(buf, file.name, { append });
}

async function addLegend() {
  if (!state.doc) return;
  setBusy(true, "Adding legend…");
  try {
    const res = await fetch("/api/legend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiddenLayers: [...state.hiddenLayers] }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const info = await res.json();
    state.doc = info;
    const start = Math.max(0, info.pageCount - (info.added || 1));
    showPage(start, { fit: true });
    scheduleSave();
    toast("Added a legend sheet.");
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

async function openSample() {
  setBusy(true, "Opening sample…");
  try {
    const res = await fetch("/api/sample.pdf");
    if (!res.ok) throw new Error(await readError(res));
    const buf = await res.arrayBuffer();
    setBusy(false);
    await openPdfBytes(buf, "sample-plan.pdf");
  } catch (err) {
    setBusy(false);
    toast(err.message);
  }
}

function saveProject() {
  if (!state.doc) return;
  const base = state.doc.filename.replace(/\.pdf$/i, "") || "plan";
  const blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: "application/json" });
  download(blob, base + "-marks.json");
}

function loadProjectFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyProject(JSON.parse(String(reader.result)));
    } catch (_err) {
      toast("Could not read that project file.");
    }
  };
  reader.readAsText(file);
}

async function exportPdf(revise) {
  if (!state.doc) return;
  const reviseBtn = $("reviseBtn");
  const finalBtn = $("exportBtn");
  reviseBtn.disabled = true;
  finalBtn.disabled = true;
  (revise ? reviseBtn : finalBtn).textContent = "Exporting…";
  try {
    const body = {
      placements: state.exportAllLayers ? state.placements : state.placements.filter(layerVisible),
      ocg: state.exportAllLayers,
      hiddenLayers: [...state.hiddenLayers],
      showCircuits: state.showCircuits,
    };
    if (revise) {
      body.revise = true;
      body.project = projectData();
    }
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await readError(res));
    const blob = await res.blob();
    let name = state.doc.filename.replace(/\.pdf$/i, "") + (revise ? "-revise.pdf" : "-marked.pdf");
    const disp = res.headers.get("Content-Disposition") || "";
    const star = /filename\*=UTF-8''([^;]+)/.exec(disp);
    if (star) name = decodeURIComponent(star[1]);
    download(blob, name);
    if (!state.placements.length) toast("No symbols yet. Exported the plan unchanged.");
  } catch (err) {
    toast(err.message);
  } finally {
    reviseBtn.disabled = !state.doc;
    finalBtn.disabled = !state.doc;
    reviseBtn.textContent = "Export to revise";
    finalBtn.textContent = "Export final";
  }
}

function isTyping() {
  const tag = document.activeElement && document.activeElement.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function onKeyDown(e) {
  if (e.key === "Escape" && isTyping()) {
    document.activeElement.blur();
    return;
  }
  if (isTyping()) return;
  const meta = e.ctrlKey || e.metaKey;
  if (e.code === "Space") {
    state.space = true;
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    if (state.calibStep) cancelCalib();
    else if (state.lineDraft || state.arrowDraft || state.runDraft || state.layoutDraft || state.whiteboxDraft) {
      state.lineDraft = null;
      state.arrowDraft = null;
      state.runDraft = null;
      state.layoutDraft = null;
      state.whiteboxDraft = null;
      renderWires();
      syncInspector();
      setStatus();
    } else if (state.tool) setTool(state.tool);
    else if (state.armedId) toggleArm(state.armedId);
    else if (state.selectedId) {
      state.selectedId = null;
      renderMarks();
      syncInspector();
      setStatus();
    }
    return;
  }
  if (meta && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
    return;
  }
  if (meta && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (meta && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject();
    return;
  }
  if (meta && e.key.toLowerCase() === "o") {
    e.preventDefault();
    $("filePdf").click();
    return;
  }
  if (meta && e.key === "0") {
    e.preventDefault();
    fitView();
    return;
  }
  if (meta && e.key === "1") {
    e.preventDefault();
    actualSize();
    return;
  }
  if (meta && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    const vr = viewport.getBoundingClientRect();
    zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, 1.15);
    return;
  }
  if (meta && e.key === "-") {
    e.preventDefault();
    const vr = viewport.getBoundingClientRect();
    zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, 1 / 1.15);
    return;
  }
  if (e.key === "?" || e.key === "F1") {
    e.preventDefault();
    $("help").showModal();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key === "PageUp") {
    goToPage(state.pageIndex - 1);
    return;
  }
  if (e.key === "PageDown") {
    goToPage(state.pageIndex + 1);
    return;
  }
  if (!meta && (e.key === "r" || e.key === "R")) {
    const p = selected();
    if (!isSymbol(p)) return;
    if (!e.repeat) pushUndo();
    p.rotation = normRot(p.rotation + (e.shiftKey ? -15 : 15));
    updateMark(p);
    scheduleSave();
    return;
  }
  const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!meta && nudge[e.key]) {
    const p = selected();
    if (!p) return;
    e.preventDefault();
    if (!e.repeat) pushUndo();
    const step = e.shiftKey ? 8 : 1;
    const dx = nudge[e.key][0] * step;
    const dy = nudge[e.key][1] * step;
    if (isSegment(p) || isWhitebox(p)) {
      p.x1 += dx;
      p.y1 += dy;
      p.x2 += dx;
      p.y2 += dy;
      if (p.kind === "line") {
        p.a1 = null;
        p.a2 = null;
      }
    } else {
      p.x += dx;
      p.y += dy;
    }
    updateMark(p);
    scheduleSave();
  }
}

function onKeyUp(e) {
  if (e.code === "Space") {
    state.space = false;
    if (!state.drag) viewport.classList.remove("panning");
  }
}

function bind() {
  $("openBtn").addEventListener("click", () => $("filePdf").click());
  $("emptyOpen").addEventListener("click", () => $("filePdf").click());
  $("sampleBtn").addEventListener("click", () => openSample());
  $("addBtn").addEventListener("click", () => $("fileAdd").click());
  $("legendBtn").addEventListener("click", () => addLegend());
  $("lineBtn").addEventListener("click", () => setTool("line"));
  $("layoutBtn").addEventListener("click", () => setTool("layout"));
  $("whiteboxBtn").addEventListener("click", () => setTool("whitebox"));
  $("arrowBtn").addEventListener("click", () => setTool("arrow"));
  $("noteBtn").addEventListener("click", () => setTool("note"));
  $("dropLegendBtn").addEventListener("click", () => setTool("legend"));
  $("noteText").addEventListener("focus", () => {
    noteUndoArmed = true;
  });
  $("noteText").addEventListener("input", () => {
    const p = selected();
    if (!p || p.kind !== "note") return;
    if (noteUndoArmed) {
      pushUndo();
      noteUndoArmed = false;
    }
    const next = cleanNote($("noteText").value);
    if (next !== $("noteText").value) $("noteText").value = next;
    p.text = next;
    updateNote(p);
    scheduleSave();
  });
  $("circuitsBtn").addEventListener("click", () => {
    state.showCircuits = !state.showCircuits;
    renderMarks();
    syncInspector();
    scheduleSave();
  });
  $("snapToggle").addEventListener("change", () => {
    state.snap = $("snapToggle").checked;
    saveLayout();
  });
  $("exportLayers").addEventListener("change", () => {
    state.exportAllLayers = $("exportLayers").checked;
    saveLayout();
  });
  $("layerSelect").addEventListener("change", () => {
    const p = selected();
    if (!p) return;
    if ($("layerSelect").value === "__custom__") {
      $("layerCustomField").hidden = false;
      $("layerCustom").focus();
      $("layerCustom").select();
      return;
    }
    pushUndo();
    p.layer = $("layerSelect").value;
    $("layerCustomField").hidden = true;
    renderMarks();
    syncInspector();
    scheduleSave();
  });
  $("layerCustom").addEventListener("change", () => {
    const p = selected();
    if (!p) return;
    const name = normalizeLayer($("layerCustom").value, "");
    if (!name) {
      toast("Type a layer name.");
      return;
    }
    pushUndo();
    p.layer = name;
    renderMarks();
    syncInspector();
    scheduleSave();
  });
  $("circuitInput").addEventListener("focus", () => {
    circuitUndoArmed = true;
  });
  $("circuitInput").addEventListener("input", () => {
    const p = selected();
    if (!p) return;
    if (circuitUndoArmed) {
      pushUndo();
      circuitUndoArmed = false;
    }
    const next = cleanCircuit($("circuitInput").value);
    if (next) p.circuit = next;
    else delete p.circuit;
    if (isSymbol(p) && p.circuit) {
      for (const line of state.placements) {
        if (line.kind !== "line" || line.guide || line.circuit) continue;
        if (line.a1 === p.id || line.a2 === p.id) line.circuit = p.circuit;
      }
    }
    if (state.showCircuits) renderMarks();
    scheduleSave();
  });
  $("freePlace").addEventListener("change", () => {
    const p = selected();
    if (!isSymbol(p)) return;
    pushUndo();
    if ($("freePlace").checked) p.freePlace = true;
    else delete p.freePlace;
    scheduleSave();
  });
  $("reviseBtn").addEventListener("click", () => exportPdf(true));
  $("exportBtn").addEventListener("click", () => exportPdf(false));
  $("saveBtn").addEventListener("click", () => saveProject());
  $("loadBtn").addEventListener("click", () => $("fileProj").click());
  $("helpBtn").addEventListener("click", () => $("help").showModal());
  $("filePdf").addEventListener("change", () => {
    const file = $("filePdf").files[0];
    $("filePdf").value = "";
    if (file) openFile(file);
  });
  $("fileAdd").addEventListener("change", () => {
    const file = $("fileAdd").files[0];
    $("fileAdd").value = "";
    if (file) openFile(file, { append: true });
  });
  $("fileProj").addEventListener("change", () => {
    const file = $("fileProj").files[0];
    $("fileProj").value = "";
    if (file) loadProjectFile(file);
  });
  $("prevPage").addEventListener("click", () => goToPage(state.pageIndex - 1));
  $("nextPage").addEventListener("click", () => goToPage(state.pageIndex + 1));
  $("pageSelect").addEventListener("change", () => goToPage(Number($("pageSelect").value)));
  $("zoomIn").addEventListener("click", () => {
    const vr = viewport.getBoundingClientRect();
    zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, 1.15);
  });
  $("zoomOut").addEventListener("click", () => {
    const vr = viewport.getBoundingClientRect();
    zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, 1 / 1.15);
  });
  $("zoomLabel").addEventListener("click", () => actualSize());
  $("fitBtn").addEventListener("click", () => fitView());
  $("filter").addEventListener("input", () => renderPalette());
  $("sizeRange").addEventListener("pointerdown", () => {
    sizeUndoArmed = true;
  });
  $("sizeRange").addEventListener("input", () => {
    setSize(Number($("sizeRange").value), { undo: sizeUndoArmed });
    sizeUndoArmed = false;
  });
  for (const btn of document.querySelectorAll(".presets [data-size]")) {
    btn.addEventListener("click", () => setSize(Number(btn.dataset.size), { undo: true }));
  }
  $("applySizeBtn").addEventListener("click", () => applySizeToAll());
  for (const input of document.querySelectorAll('input[name="countScope"]')) {
    input.addEventListener("change", () => renderCounts());
  }
  $("countsSheetBtn").addEventListener("click", () => addCountsSheet());
  $("scheduleBtn").addEventListener("click", () => addScheduleSheet());
  $("countsPanel").addEventListener("toggle", () => saveLayout());
  $("sizeOneFoot").addEventListener("click", () => {
    if (!state.calibration) return;
    const raw = state.calibration.pointsPerFoot;
    const pt = clamp(raw, 10, 160);
    if (Math.abs(pt - raw) > 0.5) toast("One foot is outside the slider range, so the size was limited.");
    setSize(pt, { undo: true });
  });
  $("calibBtn").addEventListener("click", () => {
    if (state.calibStep) cancelCalib();
    else {
      state.armedId = null;
      state.tool = null;
      state.lineDraft = null;
      state.arrowDraft = null;
      state.runDraft = null;
      state.layoutDraft = null;
      state.whiteboxDraft = null;
      state.calibStep = 1;
      state.calibDraft = null;
      renderPalette();
      syncInspector();
      renderMarks();
      setStatus();
    }
  });
  $("calibClear").addEventListener("click", () => {
    pushUndo();
    state.calibration = null;
    syncInspector();
    drawCalib();
    scheduleSave();
    setStatus();
  });
  $("calibApply").addEventListener("click", () => applyCalibration());
  $("calibLen").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyCalibration();
    }
  });
  $("symbolSelect").addEventListener("change", () => {
    const p = selected();
    if (!isSymbol(p)) return;
    pushUndo();
    p.symbolId = $("symbolSelect").value;
    if (!state.ink) p.color = (symbolsById[p.symbolId] && symbolsById[p.symbolId].defaultColor) || "#141414";
    renderMarks();
    syncInspector();
    scheduleSave();
  });
  $("rotMinus").addEventListener("click", () => bumpRotation(-15));
  $("rotPlus").addEventListener("click", () => bumpRotation(15));
  $("rot90").addEventListener("click", () => bumpRotation(90));
  $("rot0").addEventListener("click", () => {
    const p = selected();
    if (!isSymbol(p)) return;
    pushUndo();
    p.rotation = 0;
    updateMark(p);
    scheduleSave();
  });
  $("rotInput").addEventListener("change", () => {
    const p = selected();
    if (!isSymbol(p)) return;
    pushUndo();
    p.rotation = normRot($("rotInput").value);
    updateMark(p);
    scheduleSave();
  });
  $("dupBtn").addEventListener("click", () => duplicateSelected());
  $("delBtn").addEventListener("click", () => deleteSelected());

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("contextmenu", (e) => e.preventDefault());
  viewport.addEventListener("wheel", (e) => {
    if (!state.doc) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 0.04 : 0.0015;
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * scale));
  }, { passive: false });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  bindSplitters();
  window.addEventListener("blur", () => {
    state.space = false;
    viewport.classList.remove("panning");
  });
  window.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    document.body.classList.add("dropping");
  });
  window.addEventListener("dragleave", (e) => {
    if (e.target === document.body || e.target === document.documentElement) {
      document.body.classList.remove("dropping");
    }
  });
  window.addEventListener("drop", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    document.body.classList.remove("dropping");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (name.endsWith(".json")) loadProjectFile(file);
    else openFile(file);
  });
  $("help").addEventListener("click", (e) => {
    if (e.target === $("help")) $("help").close();
  });
}

function readLen(name, fallback) {
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(n) ? n : fallback;
}

function setLen(name, value, min, max) {
  const next = clamp(value, min, max);
  document.documentElement.style.setProperty(name, next + "px");
  return next;
}

function loadLayout() {
  try {
    const data = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    if (Array.isArray(data.open)) openCategories = new Set(data.open.filter((id) => typeof id === "string"));
    if (typeof data.countsOpen === "boolean") $("countsPanel").open = data.countsOpen;
    if (data.sideWidth) setLen("--side-width", data.sideWidth, 220, 560);
    if (data.toolsHeight) setLen("--tools-height", data.toolsHeight, 140, 720);
    if (data.toolsWidth) setLen("--tools-width", data.toolsWidth, 180, 480);
    if (typeof data.snap === "boolean") state.snap = data.snap;
    if (typeof data.exportAllLayers === "boolean") state.exportAllLayers = data.exportAllLayers;
  } catch (_err) {
    /* keep the built-in sizes */
  }
}

function saveLayout() {
  const data = {
    open: [...openCategories],
    sideWidth: readLen("--side-width", 300),
    toolsHeight: readLen("--tools-height", 340),
    toolsWidth: readLen("--tools-width", 260),
    countsOpen: $("countsPanel").open,
    snap: state.snap,
    exportAllLayers: state.exportAllLayers,
  };
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
  } catch (_err) {
    /* private mode can refuse storage */
  }
}

function panelAxis() {
  return window.matchMedia("(max-width: 860px) and (min-width: 561px)").matches ? "x" : "y";
}

function dragSplitter(el, apply) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const axis = apply.axis ? apply.axis() : "y";
    const start = { x: e.clientX, y: e.clientY, ...apply.start() };
    el.classList.add("dragging");
    document.body.classList.add(axis === "x" ? "col-resize" : "row-resize");
    const move = (ev) => apply.move(ev.clientX - start.x, ev.clientY - start.y, start);
    const up = () => {
      el.classList.remove("dragging");
      document.body.classList.remove("col-resize", "row-resize");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveLayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 24 : 12;
    const key = e.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = key === "ArrowLeft" || key === "ArrowUp" ? -step : step;
    apply.nudge(dir, key);
    saveLayout();
  });
  el.addEventListener("dblclick", () => {
    apply.reset();
    saveLayout();
  });
}

function bindSplitters() {
  const aside = document.querySelector("aside");
  dragSplitter($("panelSplit"), {
    axis: panelAxis,
    start() {
      return panelAxis() === "x"
        ? { size: readLen("--tools-width", 260) }
        : { size: readLen("--tools-height", 340) };
    },
    move(dx, dy, start) {
      if (panelAxis() === "x") {
        const max = Math.max(180, aside.clientWidth - 160);
        setLen("--tools-width", start.size - dx, 180, Math.min(480, max));
      } else {
        const max = Math.max(140, aside.clientHeight - 100);
        setLen("--tools-height", start.size - dy, 140, Math.min(720, max));
      }
    },
    nudge(dir) {
      if (panelAxis() === "x") setLen("--tools-width", readLen("--tools-width", 260) - dir, 180, 480);
      else setLen("--tools-height", readLen("--tools-height", 340) - dir, 140, 720);
    },
    reset() {
      document.documentElement.style.removeProperty("--tools-height");
      document.documentElement.style.removeProperty("--tools-width");
    },
  });
  dragSplitter($("sideSplit"), {
    axis: () => "x",
    start: () => ({ size: readLen("--side-width", 300) }),
    move(dx, _dy, start) {
      const max = Math.min(560, window.innerWidth - 320);
      setLen("--side-width", start.size + dx, 220, Math.max(220, max));
    },
    nudge(dir, key) {
      if (key === "ArrowUp" || key === "ArrowDown") return;
      setLen("--side-width", readLen("--side-width", 300) + dir, 220, 560);
    },
    reset() {
      document.documentElement.style.removeProperty("--side-width");
    },
  });
}

async function init() {
  loadLayout();
  const res = await fetch("/api/symbols");
  if (!res.ok) {
    toast("Could not load the symbol library.");
    return;
  }
  library = await res.json();
  symbolsById = Object.fromEntries(library.symbols.map((sym) => [sym.id, sym]));
  buildSymbolSelect();
  buildColors();
  renderPalette();
  renderCounts();
  syncInspector();
  setStatus();
  bind();
}

init();
