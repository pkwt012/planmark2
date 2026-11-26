"use strict";
// Constants, shared state, view, zoom, and the page image.

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
const WALL_SIDE = 0.36;
const HIT_SCALE = 0.65;
const GANG_PITCH = 0.6;

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
  outletHeight: "",
  equipmentAmps: "",
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
  recoveryTimer: 0,
  pendingProject: null,
  pendingRecovery: null,
  picked: new Set(),
  browserSavedAt: "",
};

let edgeMap = null;

let library = { categories: [], symbols: [] };
let symbolsById = {};
let sizeUndoArmed = false;
let noteUndoArmed = false;
let circuitUndoArmed = false;
let heightUndoArmed = false;
let ampsUndoArmed = false;
let mostUsedKey = "";
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
  state.picked = new Set();
  showPage(index, { fit: refit });
  syncInspector();
}
